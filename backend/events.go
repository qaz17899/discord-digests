package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// The event layer exists so a human can see the shape of a 20k-message day
// without reading it. It is a signal detector, not a summarizer: every event is
// a cluster of messages that stood out from the day's own baseline, and it
// always carries the messages that triggered it. Nothing here is written in
// prose the data does not support, and nothing here is ever fed to the
// summarizer.

// evKeywords maps an event kind to the words that vote for it. A keyword votes
// once per window, so repeating it cannot manufacture an event.
var evKeywords = map[string][]string{
	"outage": {
		"掛了", "掛掉", "崩了", "炸了", "斷線", "連不上", "逾時", "超時", "報錯", "錯誤",
		"異常", "失敗", "卡住", "卡死", "沒回應", "502", "503", "500", "timeout", "error",
		"refused", "unavailable", "rate limit", "429",
	},
	"release": {
		"發布", "發佈", "上線", "上架", "開放", "更新", "改版", "新模型", "新版", "灰度",
		"開源", "更新日誌", "changelog", "release", "版本", "api-docs",
	},
	"announce": {
		"公告", "通知", "維護", "停機", "規範", "官方", "提醒", "重要", "請注意", "條款",
		"禁止", "封禁", "處分",
	},
	"drop": {
		"抽獎", "空投", "白名單", "快照", "領取", "免費", "限時", "資格", "快搶", "紅包",
		"優惠", "折價", "開獎",
	},
	"raid": {
		"刷屏", "洗版", "灌水", "簽到", "加群", "拉群", "廣告", "機器人", "腳本號", "新人進",
		"互關", "引流",
	},
	"debate": {
		"吵", "爭議", "反駁", "質疑", "護航", "指控", "起訴", "抄襲", "舉報", "陰陽",
		"嘴", "雙標", "誤導", "破防", "打臉", "道歉", "炎上", "翻車",
	},
	"milestone": {
		"里程碑", "突破", "達成", "新高", "紀錄", "破紀錄", "榜", "第一", "滿分", "SOTA",
		"超越",
	},
	"ama": {
		"問答", "提問", "訪談", "直播", "AMA", "分享會", "開講", "報名", "講座",
	},
}

// evPairs is the flattened keyword table, built once. Order is stable so a tie
// never depends on map iteration.
var evPairs = func() []struct{ kw, kind string } {
	var out []struct{ kw, kind string }
	for kind, kws := range evKeywords {
		for _, kw := range kws {
			out = append(out, struct{ kw, kind string }{kw, kind})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].kw != out[j].kw {
			return out[i].kw < out[j].kw
		}
		return out[i].kind < out[j].kind
	})
	return out
}()

// evKindOf maps a keyword to the kind it belongs to.
var evKindOf = func() map[string]string {
	m := make(map[string]string, len(evPairs))
	for _, p := range evPairs {
		m[p.kw] = p.kind
	}
	return m
}()

// EventEvidence is one message that supports an event, quoted verbatim.
type EventEvidence struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	TS        string `json:"ts"`
	Content   string `json:"content"`
	Reactions int    `json:"reactions"`
}

// EventSignal is a cluster of messages that stood out from the day's baseline.
type EventSignal struct {
	ID         string          `json:"id"`
	Kind       string          `json:"kind"`
	Title      string          `json:"title"`
	Desc       string          `json:"desc"`
	StartMin   int             `json:"startMin"`
	EndMin     int             `json:"endMin"`
	Messages   int             `json:"messages"`
	Reactions  int             `json:"reactions"`
	Authors    int             `json:"authors"`
	Links      int             `json:"links"`
	Keywords   []string        `json:"keywords"`
	Importance int             `json:"importance"`
	Score      float64         `json:"score"`
	PeakID     string          `json:"peakId"`
	PeakMin    int             `json:"peakMin"`
	Evidence   []EventEvidence `json:"evidence"`
}

const (
	evWindowMin       = 10                 // buckets are 10 minutes
	evWins            = 1440 / evWindowMin // 144 buckets a day
	evMinScore        = 1.5                // a window below this is white noise
	evMinKeywordHits  = 2                  // one mention is a coincidence
	evMaxKeywordBurst = 4.0                // a word can only shout so loud
	evTopFraction     = 0.1                // the day's most unusual tenth of windows
	evMinWindows      = 3                  // ...but never fewer than three
	evMaxWindows      = 15                 // ...and never more than fifteen
	evMaxGap          = 1                  // buckets this far apart still merge
	evMaxSpan         = 4                  // a cluster never spans more than 40 minutes
	evPerDay          = 20                 // hard ceiling, highest score first
	evQuoteRune       = 140                // evidence messages are quoted this far
)

type evWin struct {
	msgs      []MessageRecord
	reactions int
	links     int
	authors   map[string]struct{}
	kwHits    map[string]int     // keyword → messages in this window that used it
	kwBurst   map[string]float64 // keyword → how far above its daily rate this window is
	score     float64
}

func minuteOfTS(ts string) (int, bool) {
	t, err := time.ParseInLocation(tsLayout, ts, gmt8)
	if err != nil {
		return 0, false
	}
	return t.Hour()*60 + t.Minute(), true
}

// BuildEvents clusters one day of messages into events.
//
// The unit of surprise is a rate, not a count. A channel that posts 20k
// messages a day mentions almost every keyword in almost every window, so
// counting keywords (or even weighting them by rarity) says nothing; what says
// something is a word suddenly being used far more often per message than it
// was used all day. Each window is therefore scored against the day's own
// per-message rate for that word, its own volume, and its own reaction rate.
func BuildEvents(recs []MessageRecord) []EventSignal {
	if len(recs) == 0 {
		return nil
	}

	total := len(recs)
	wins := make([]*evWin, evWins)
	kwDay := map[string]int{}
	for i := range recs {
		r := &recs[i]
		minute, ok := minuteOfTS(r.TS)
		if !ok {
			continue
		}
		w := wins[minute/evWindowMin]
		if w == nil {
			w = &evWin{authors: map[string]struct{}{}, kwHits: map[string]int{}}
			wins[minute/evWindowMin] = w
		}
		w.msgs = append(w.msgs, *r)
		w.authors[r.Author] = struct{}{}
		for _, x := range r.Reactions {
			w.reactions += x.Count
		}
		w.links += len(urlsIn(*r))
		text := strings.ToLower(r.Content)
		for _, p := range evPairs {
			if strings.Contains(text, p.kw) {
				w.kwHits[p.kw]++
				kwDay[p.kw]++
			}
		}
	}

	var vols, reacts []int
	for _, w := range wins {
		if w == nil {
			continue
		}
		vols = append(vols, len(w.msgs))
		reacts = append(reacts, w.reactions)
	}
	if len(vols) == 0 {
		return nil
	}
	baseMsgs := math.Max(1, float64(percentile(vols, 0.9)))
	baseReact := math.Max(1, float64(percentile(reacts, 0.9)))

	for _, w := range wins {
		if w == nil {
			continue
		}
		w.kwBurst = make(map[string]float64, len(w.kwHits))
		kw := 0.0
		for k, hits := range w.kwHits {
			// One mention is a coincidence, not a burst.
			if hits < evMinKeywordHits {
				continue
			}
			winRate := float64(hits) / float64(len(w.msgs))
			dayRate := float64(kwDay[k]) / float64(total)
			burst := math.Log2(winRate / dayRate)
			if burst <= 0 {
				continue
			}
			if burst > evMaxKeywordBurst {
				burst = evMaxKeywordBurst
			}
			w.kwBurst[k] = burst
			kw += burst
		}
		volRatio := float64(len(w.msgs)) / baseMsgs
		reactRatio := float64(w.reactions) / baseReact
		w.score = kw*1.5 + math.Max(0, math.Log2(volRatio))*3 + math.Max(0, math.Log2(reactRatio))*2
	}

	// Hot windows are the day's most unusual tenth, not everything above an
	// absolute number: a busy channel and a quiet one both get a usable list,
	// and the floor keeps a flat day from reporting trivia.
	type scored struct {
		idx   int
		score float64
	}
	all := make([]scored, 0, len(vols))
	for i, w := range wins {
		if w != nil && w.score > 0 {
			all = append(all, scored{i, w.score})
		}
	}
	if len(all) == 0 {
		return nil
	}
	sort.Slice(all, func(i, j int) bool { return all[i].score > all[j].score })
	k := clampInt(int(math.Ceil(float64(len(all))*evTopFraction)), evMinWindows, evMaxWindows)
	k = clampInt(k, 1, len(all))
	cut := math.Max(evMinScore, all[k-1].score)

	var hot []int
	for i, w := range wins {
		if w != nil && w.score >= cut {
			hot = append(hot, i)
		}
	}
	if len(hot) == 0 {
		return nil
	}

	type span struct{ from, to int }
	var spans []span
	for _, i := range hot {
		last := len(spans) - 1
		if last >= 0 && i-spans[last].to <= evMaxGap && spans[last].to-spans[last].from+1 < evMaxSpan {
			spans[last].to = i
			continue
		}
		spans = append(spans, span{i, i})
	}

	out := make([]EventSignal, 0, len(spans))
	for _, s := range spans {
		if ev := buildEvent(wins, s.from, s.to); ev != nil {
			out = append(out, *ev)
		}
	}
	if len(out) == 0 {
		return nil
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Score > out[j].Score })
	if len(out) > evPerDay {
		out = out[:evPerDay]
	}
	maxScore := out[0].Score
	for i := range out {
		out[i].Importance = clampInt(1+int(4*out[i].Score/maxScore), 1, 5)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].StartMin < out[j].StartMin })
	return out
}

// buildEvent turns a run of hot windows into one signal. Its evidence is always
// the messages themselves, never a description of them.
func buildEvent(wins []*evWin, from, to int) *EventSignal {
	ev := &EventSignal{
		ID:       fmt.Sprintf("w%d-%d", from, to),
		StartMin: from * evWindowMin,
		EndMin:   to*evWindowMin + evWindowMin - 1,
	}
	kwBurst := map[string]float64{}
	authors := map[string]struct{}{}
	var all []MessageRecord
	for i := from; i <= to; i++ {
		w := wins[i]
		if w == nil {
			continue
		}
		all = append(all, w.msgs...)
		ev.Messages += len(w.msgs)
		ev.Reactions += w.reactions
		ev.Links += w.links
		ev.Score += w.score
		for a := range w.authors {
			authors[a] = struct{}{}
		}
		for k, burst := range w.kwBurst {
			if burst > kwBurst[k] {
				kwBurst[k] = burst
			}
		}
	}
	if len(all) == 0 {
		return nil
	}
	ev.Authors = len(authors)
	ev.Score /= float64(to - from + 1)

	// Kind comes from the single loudest keyword: what burst hardest is what the
	// cluster is about. With no keyword at all it is a pure traffic spike.
	for kw := range kwBurst {
		ev.Keywords = append(ev.Keywords, kw)
	}
	sort.Slice(ev.Keywords, func(i, j int) bool {
		if kwBurst[ev.Keywords[i]] != kwBurst[ev.Keywords[j]] {
			return kwBurst[ev.Keywords[i]] > kwBurst[ev.Keywords[j]]
		}
		return ev.Keywords[i] < ev.Keywords[j]
	})
	if len(ev.Keywords) > 6 {
		ev.Keywords = ev.Keywords[:6]
	}

	ev.Kind = "spike"
	for _, kw := range ev.Keywords {
		if kind, ok := evKindOf[kw]; ok {
			ev.Kind = kind
			break
		}
	}

	// Evidence: the messages that carried the window. Reactions first, then
	// length, so a long post with no reactions still beats one-word noise.
	sorted := append([]MessageRecord(nil), all...)
	sort.SliceStable(sorted, func(i, j int) bool {
		ri, rj := reactionTotal(sorted[i]), reactionTotal(sorted[j])
		if ri != rj {
			return ri > rj
		}
		return len([]rune(sorted[i].Content)) > len([]rune(sorted[j].Content))
	})
	for _, m := range sorted {
		if len(ev.Evidence) >= 3 {
			break
		}
		if strings.TrimSpace(m.Content) == "" && len(m.Attachments) == 0 {
			continue
		}
		ev.Evidence = append(ev.Evidence, EventEvidence{
			ID: m.ID, Author: m.Author, TS: m.TS,
			Content: truncate(cleanBody(m.Content), evQuoteRune), Reactions: reactionTotal(m),
		})
	}
	if len(ev.Evidence) == 0 {
		return nil
	}
	peak := ev.Evidence[0]
	ev.PeakID = peak.ID
	if m, ok := minuteOfTS(peak.TS); ok {
		ev.PeakMin = m
	} else {
		ev.PeakMin = ev.StartMin
	}

	switch {
	case len(ev.Keywords) > 1:
		ev.Title = fmt.Sprintf("「%s」等關鍵字密集討論", ev.Keywords[0])
	case len(ev.Keywords) == 1:
		ev.Title = fmt.Sprintf("「%s」主題討論", ev.Keywords[0])
	default:
		ev.Title = "訊息流量暴增"
	}
	ev.Desc = descOf(ev)
	return ev
}

// descOf states only what the signal layer measured.
func descOf(ev *EventSignal) string {
	window := ev.EndMin - ev.StartMin + 1
	var b strings.Builder
	fmt.Fprintf(&b, "%d 分鐘內 %d 則訊息、%d 位作者", window, ev.Messages, ev.Authors)
	if ev.Reactions > 0 {
		fmt.Fprintf(&b, "、%d 次表情反應", ev.Reactions)
	}
	if ev.Links > 0 {
		fmt.Fprintf(&b, "、%d 個連結", ev.Links)
	}
	if len(ev.Keywords) > 0 {
		fmt.Fprintf(&b, "；觸發關鍵字「%s」", strings.Join(ev.Keywords, "」「"))
	}
	b.WriteString("。")
	return b.String()
}

func reactionTotal(r MessageRecord) int {
	n := 0
	for _, x := range r.Reactions {
		n += x.Count
	}
	return n
}

// percentile returns the p-quantile of vals (p in [0,1]) using nearest-rank.
func percentile(vals []int, p float64) int {
	if len(vals) == 0 {
		return 0
	}
	sorted := append([]int(nil), vals...)
	sort.Ints(sorted)
	idx := int(math.Ceil(p*float64(len(sorted)))) - 1
	return sorted[clampInt(idx, 0, len(sorted)-1)]
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
