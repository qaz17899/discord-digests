package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Server is the read-only API the workbench talks to. It never touches Discord:
// everything it serves is already on disk. The only exceptions are the media
// refresh endpoint, which exchanges stale CDN links using the bot token, and the
// settings endpoint, which edits this project's own config.json.
type Server struct {
	cfg    *Config
	store  *Store
	client *Client
	llm    *LLMClient

	// cfgMu guards client/llm/cfg.Settings, which the settings page swaps at
	// runtime while jobs and requests are reading them.
	cfgMu sync.RWMutex

	cacheMu sync.Mutex
	cache   map[string]cachedSummary

	jobMu sync.Mutex
	jobs  []*DigestJob
}

func (s *Server) digestClient() *LLMClient {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.llm
}

func (s *Server) mediaRefreshReady() bool {
	return s.client != nil && s.client.BotToken() != ""
}

// watching is cfg.watching under the lock the settings page writes with.
func (s *Server) watching(channelID string) bool {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg.watching(channelID)
}

func (s *Server) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("GET /api/channels", s.handleChannels)
	mux.HandleFunc("GET /api/overview", s.handleOverview)
	mux.HandleFunc("GET /api/settings", s.handleSettingsGet)
	mux.HandleFunc("PUT /api/settings", s.handleSettingsPut)
	mux.HandleFunc("POST /api/settings/test", s.handleSettingsTest)
	mux.HandleFunc("GET /api/channels/{id}/summary", s.handleSummary)
	mux.HandleFunc("GET /api/channels/{id}/messages", s.handleMessages)
	mux.HandleFunc("GET /api/channels/{id}/stats", s.handleStats)
	mux.HandleFunc("GET /api/channels/{id}/input", s.handleInput)
	mux.HandleFunc("POST /api/channels/{id}/digest", s.handleDigestStart)
	mux.HandleFunc("GET /api/jobs", s.handleJobs)
	mux.HandleFunc("GET /api/jobs/{id}", s.handleJob)
	mux.HandleFunc("GET /api/reports", s.handleReportList)
	mux.HandleFunc("GET /api/reports/{name}", s.handleReport)
	mux.HandleFunc("DELETE /api/reports/{name}", s.handleReportDelete)
	mux.HandleFunc("POST /api/channels/{id}/media/refresh", s.handleMediaRefresh)
	mux.HandleFunc("GET /api/channels/{id}/lab", s.handleLab)
	mux.HandleFunc("POST /api/backfill", s.handleBackfillStart)
	mux.HandleFunc("GET /api/backfill", s.handleBackfillList)
	mux.HandleFunc("GET /api/backfill/{id}", s.handleBackfillGet)
	mux.HandleFunc("POST /api/backfill/{id}/cancel", s.handleBackfillCancel)
	mux.HandleFunc("GET /api/schedule", s.handleSchedule)
	mux.HandleFunc("PUT /api/schedule", s.handleSchedulePut)
	mux.HandleFunc("GET /api/resolve", s.handleResolve)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		log.Printf("encode: %v", err)
	}
}

func writeErr(w http.ResponseWriter, code int, format string, args ...any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": fmt.Sprintf(format, args...)})
}

// rangeFromQuery reads ?from=&to=, accepting a day or a full timestamp.
// The defaults are "today so far".
func rangeFromQuery(r *http.Request) (time.Time, time.Time, string, string, error) {
	now := time.Now().In(gmt8)
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, gmt8)
	to := now

	if v := r.URL.Query().Get("from"); v != "" {
		t, err := parseWhen(v)
		if err != nil {
			return from, to, "", "", err
		}
		from = t
	}
	if v := r.URL.Query().Get("to"); v != "" {
		t, err := parseWhen(v)
		if err != nil {
			return from, to, "", "", err
		}
		if len(v) == len(dayLayout) {
			t = t.Add(24*time.Hour - time.Second)
		}
		to = t
	}
	return from, to, from.In(gmt8).Format(dayLayout), to.In(gmt8).Format(dayLayout), nil
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	channels, err := s.store.Channels()
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}
	type chanStatus struct {
		ID       string `json:"id"`
		Name     string `json:"name"`
		Type     string `json:"type"`
		GuildID  string `json:"guildId"`
		LastTS   string `json:"lastTs"`
		Total    int    `json:"total"`
		Watching bool   `json:"watching"`
	}
	out := make([]chanStatus, 0, len(channels))
	for _, ch := range channels {
		st := s.store.State(ch)
		out = append(out, chanStatus{
			ID: ch, Name: st.ChannelName, Type: st.ChannelType, GuildID: st.GuildID,
			LastTS: st.LastTS, Total: st.TotalFetched, Watching: s.watching(ch),
		})
	}
	sess := s.store.Session()
	hb, online := ReadHeartbeat(s.cfg.Home)
	writeJSON(w, map[string]any{
		"channels": out,
		"session": map[string]any{
			"userId":    sess.UserID,
			"resumeUrl": sess.ResumeURL,
			"seq":       sess.Seq,
		},
		"watch": map[string]any{
			"online":    online,
			"pid":       hb.PID,
			"at":        hb.At,
			"channels":  hb.Channels,
			"received":  hb.Received,
			"connected": hb.Connected,
		},
		"llmConfigured": s.digestClient() != nil,
		"mediaRefresh":  s.mediaRefreshReady(),
		"now":           time.Now().In(gmt8).Format(tsLayout),
	})
}

func (s *Server) handleChannels(w http.ResponseWriter, r *http.Request) {
	s.handleStatus(w, r)
}

// handleOverview is what the status wall reads: one summary per channel, no
// messages. It is the only endpoint the wall needs.
func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	_, _, fromDay, toDay, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	channels, err := s.store.Channels()
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}
	refresh := r.URL.Query().Get("refresh") != ""
	sums := make([]*ChannelSummary, 0, len(channels))
	for _, id := range channels {
		sum, err := s.summaryFor(id, fromDay, toDay, refresh)
		if err != nil {
			log.Printf("summary %s: %v", id, err)
			continue
		}
		sums = append(sums, sum)
	}
	writeJSON(w, map[string]any{
		"from": fromDay, "to": toDay,
		"channels":      sums,
		"generatedAt":   time.Now().In(gmt8).Format(tsLayout),
		"llmConfigured": s.digestClient() != nil,
		"mediaRefresh":  s.mediaRefreshReady(),
	})
}

func (s *Server) handleSummary(w http.ResponseWriter, r *http.Request) {
	_, _, fromDay, toDay, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	sum, err := s.summaryFor(r.PathValue("id"), fromDay, toDay, r.URL.Query().Get("refresh") != "")
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}
	writeJSON(w, sum)
}

// handleDigestStart kicks off a summarizer run and returns the job immediately.
func (s *Server) handleDigestStart(w http.ResponseWriter, r *http.Request) {
	from, to, _, _, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	job, err := s.startDigest(r.PathValue("id"), from, to)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	writeJSON(w, job)
}

// handleJobs lists the digest jobs this process still remembers. They live in
// memory, so a page switch or a reload can pick the running one back up instead
// of showing an idle button while the model is still working.
func (s *Server) handleJobs(w http.ResponseWriter, r *http.Request) {
	s.jobMu.Lock()
	out := make([]*DigestJob, len(s.jobs))
	copy(out, s.jobs)
	s.jobMu.Unlock()
	// Newest first, so the dashboard can take the first match.
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	writeJSON(w, out)
}

func (s *Server) handleJob(w http.ResponseWriter, r *http.Request) {
	job, ok := s.job(r.PathValue("id"))
	if !ok {
		writeErr(w, 404, "no such job")
		return
	}
	writeJSON(w, job)
}

// freshURLs returns the refreshed link for every attachment URL that has one.
// The frontend renders fresh[url] when present, otherwise url.
func (s *Server) freshURLs(channelID string, recs []MessageRecord) map[string]string {
	media := NewMediaCache(s.cfg.Home, channelID)
	out := map[string]string{}
	for _, rec := range recs {
		for _, a := range rec.Attachments {
			if _, seen := out[a.URL]; seen {
				continue
			}
			if fresh, ok := media.Get(a.URL); ok {
				out[a.URL] = fresh
			}
		}
	}
	return out
}

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request) {
	from, to, fromDay, toDay, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	channelID := r.PathValue("id")
	recs, err := s.store.LoadRangeWithReactions(channelID, fromDay, toDay)
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}

	total := len(recs)
	limit := 0
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 0 && total > limit {
		// A limit trims from the end: the interesting end of a log is the newest.
		recs = recs[total-limit:]
	}
	if v := r.URL.Query().Get("after"); v != "" {
		kept := recs[:0]
		for _, rec := range recs {
			if lessID(v, rec.ID) {
				kept = append(kept, rec)
			}
		}
		recs = kept
	}

	writeJSON(w, map[string]any{
		"channelId":   channelID,
		"from":        from.Format(tsLayout),
		"to":          to.Format(tsLayout),
		"total":       total,
		"count":       len(recs),
		"messages":    recs,
		"freshMedia":  s.freshURLs(channelID, recs),
		"generatedAt": time.Now().In(gmt8).Format(tsLayout),
	})
}

// handleLab answers everything the digest workbench needs for one window:
// the real statistics, the real event signals, the exact prompt that would be
// sent, and the same character budget the digest pipeline would use. It never
// calls a model — it is a preview of work, not the work.
func (s *Server) handleLab(w http.ResponseWriter, r *http.Request) {
	from, to, fromDay, toDay, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	channelID := r.PathValue("id")
	recs, err := s.store.LoadRangeWithReactions(channelID, fromDay, toDay)
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}
	recs = filterRange(recs, from, to)
	if len(recs) == 0 {
		writeJSON(w, map[string]any{
			"channelId": channelID, "from": from.Format(tsLayout), "to": to.Format(tsLayout),
			"messages": 0, "hourly": make([]int, 24), "events": []EventSignal{},
			"empty": true,
		})
		return
	}

	hourly := make([]int, 24)
	minute := make([]int, 1440)
	authors := map[string]int{}
	links, media, reactions := 0, 0, 0
	for i := range recs {
		rec := &recs[i]
		if m, ok := minuteOfTS(rec.TS); ok {
			hourly[m/60]++
			minute[m]++
		}
		authors[rec.Author]++
		links += len(urlsIn(*rec))
		media += len(rec.Attachments)
		reactions += reactionTotal(*rec)
	}

	peakMin, peakCount := 0, 0
	for m, n := range minute {
		if n > peakCount {
			peakMin, peakCount = m, n
		}
	}

	text := Compress(recs)
	maxChars := s.maxChars()
	chunks := chunkByRunes(text, maxChars)

	s.cfgMu.RLock()
	system, userTpl, reduceTpl := s.cfg.promptSystem(), s.cfg.promptUser(), s.cfg.promptReduce()
	name := s.store.State(channelID).ChannelName
	s.cfgMu.RUnlock()
	if name == "" {
		name = channelID
	}
	vars := map[string]string{
		"channel": name,
		"range":   rangeLabel(from, to),
		"count":   strconv.Itoa(len(recs)),
		"total":   strconv.Itoa(len(chunks)),
		"index":   "1",
		"body":    text,
	}
	userPrompt := renderTemplate(userTpl, vars)

	// The body is what makes the prompt long; the preview carries its head so the
	// panel can show what really goes out without sending the whole thing twice.
	// full=1 送出整份（「展開全部」用），其餘只給開頭。
	const previewChars = 20000
	userOut, truncated := userPrompt, false
	if r.URL.Query().Get("full") == "" && utf8.RuneCountInString(userPrompt) > previewChars {
		userOut, truncated = truncateRunes(userPrompt, previewChars), true
	}
	writeJSON(w, map[string]any{
		"channelId":       channelID,
		"name":            name,
		"from":            from.Format(tsLayout),
		"to":              to.Format(tsLayout),
		"range":           rangeLabel(from, to),
		"messages":        len(recs),
		"authors":         len(authors),
		"links":           links,
		"media":           media,
		"reactions":       reactions,
		"hourly":          hourly,
		"peakHour":        peakOf(hourly),
		"peakMinute":      fmt.Sprintf("%02d:%02d", peakMin/60, peakMin%60),
		"peakMinuteCount": peakCount,
		"events":          nonNilEvents(BuildEvents(recs)),
		"compressedChars": utf8.RuneCountInString(text),
		"batches":         len(chunks),
		"maxChars":        maxChars,
		"prompts": map[string]any{
			"system":       system,
			"userTemplate": userTpl,
			"reduce":       reduceTpl,
			"user":         userOut,
			"userChars":    utf8.RuneCountInString(userPrompt),
			"userLines":    strings.Count(userPrompt, "\n") + 1,
			"truncated":    truncated,
		},
		"tokens": map[string]any{
			"system":    estimateTokens(system),
			"user":      estimateTokens(userPrompt),
			"body":      estimateTokens(text),
			"perBatch":  estimateTokens(system) + estimateTokens(text)/max(1, len(chunks)),
			"estimated": true,
		},
		"included": len(recs), // 送出的訊息數（等於這個範圍的全部訊息，沒有抽樣）
	})
}

func (s *Server) maxChars() int {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	if n := s.cfg.Settings.LLM.MaxChars; n > 0 {
		return n
	}
	return defaultMaxChars
}

func peakOf(hourly []int) int {
	peak := 0
	for h := 1; h < len(hourly); h++ {
		if hourly[h] > hourly[peak] {
			peak = h
		}
	}
	return peak
}

func nonNilEvents(events []EventSignal) []EventSignal {
	if events == nil {
		return []EventSignal{}
	}
	return events
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	_, _, fromDay, toDay, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	channelID := r.PathValue("id")
	recs, err := s.store.LoadRange(channelID, fromDay, toDay)
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}

	hourly := make([]int, 24)
	authors := map[string]int{}
	domains := map[string]int{}
	for _, rec := range recs {
		if len(rec.TS) >= 13 {
			if h, err := strconv.Atoi(rec.TS[11:13]); err == nil && h >= 0 && h < 24 {
				hourly[h]++
			}
		}
		authors[rec.Author]++
		for _, u := range urlsIn(rec) {
			if parsed, err := url.Parse(u); err == nil && parsed.Host != "" {
				domains[parsed.Host]++
			}
		}
	}
	writeJSON(w, map[string]any{
		"channelId":  channelID,
		"from":       fromDay,
		"to":         toDay,
		"messages":   len(recs),
		"hourly":     hourly,
		"topAuthors": topN(authors, 20),
		"topDomains": topN(domains, 20),
	})
}

func urlsIn(rec MessageRecord) []string {
	var out []string
	out = append(out, reURL.FindAllString(rec.Content, -1)...)
	for _, e := range rec.Embeds {
		if e.URL != "" {
			out = append(out, e.URL)
		}
	}
	return out
}

func topN(counts map[string]int, n int) []map[string]any {
	type kv struct {
		k string
		v int
	}
	all := make([]kv, 0, len(counts))
	for k, v := range counts {
		all = append(all, kv{k, v})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].v != all[j].v {
			return all[i].v > all[j].v
		}
		return all[i].k < all[j].k
	})
	if len(all) > n {
		all = all[:n]
	}
	out := make([]map[string]any, 0, len(all))
	for _, e := range all {
		out = append(out, map[string]any{"key": e.k, "count": e.v})
	}
	return out
}

// handleInput returns exactly the text the summarizer would read. Useful for a
// frontend that wants to show "what the model sees".
func (s *Server) handleInput(w http.ResponseWriter, r *http.Request) {
	_, _, fromDay, toDay, err := rangeFromQuery(r)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	recs, err := s.store.LoadRange(r.PathValue("id"), fromDay, toDay)
	if err != nil {
		writeErr(w, 500, "%v", err)
		return
	}
	text := Compress(recs)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	fmt.Fprint(w, text)
}

func (s *Server) handleReportList(w http.ResponseWriter, r *http.Request) {
	dir := filepath.Join(s.cfg.Home, "reports")
	entries, err := os.ReadDir(dir)
	if err != nil {
		writeJSON(w, []any{})
		return
	}
	type report struct {
		Name      string `json:"name"`
		ChannelID string `json:"channelId"`
		Day       string `json:"day"`   // YYYY-MM-DD, empty for an all-history report
		Range     string `json:"range"` // HH:MM-HH:MM, empty for a full day
		Whole     bool   `json:"whole"` // true for the channel's all-history report
		Report    bool   `json:"report"`
		Size      int64  `json:"size"`
		Modified  string `json:"modified"`
	}
	out := []report{}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".md") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		stem := strings.TrimSuffix(name, ".md")
		channelID, day, span := stem, "", ""
		if i := strings.Index(stem, "-"); i > 0 {
			channelID = stem[:i]
			rest := stem[i+1:]
			// <id>-all | <id>-YYYY-MM-DD | <id>-YYYY-MM-DD_HHMM-HHMM | <id>-YYYY-MM-DD-HHMMtoHHMM
			if len(rest) >= 10 && rest[:4] >= "2000" && rest[:4] <= "2100" {
				day = rest[:10]
				tail := strings.TrimPrefix(rest[10:], "_")
				tail = strings.TrimPrefix(tail, "-")
				if tail != "" {
					span = strings.Replace(tail, "to", "-", 1)
				}
			}
		}
		out = append(out, report{
			Name: name, ChannelID: channelID, Day: day, Range: span, Whole: day == "", Report: true,
			Size: info.Size(), Modified: info.ModTime().In(gmt8).Format(tsLayout),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Modified > out[j].Modified })
	writeJSON(w, out)
}

// validReportName accepts a bare file name inside reports/. filepath.Base has
// already removed any directory part; this rejects what is left that could reach
// outside the folder or name something we do not own.
func validReportName(name string) bool {
	if !strings.HasSuffix(name, ".md") || strings.HasPrefix(name, ".") {
		return false
	}
	return !strings.ContainsAny(name, `/\:*?"<>|`)
}

func (s *Server) handleReport(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.PathValue("name"))
	if !strings.HasSuffix(name, ".md") {
		writeErr(w, 400, "not a report")
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.cfg.Home, "reports", name))
	if err != nil {
		writeErr(w, 404, "no such report")
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Write(raw)
}

// handleReportDelete removes a report and the prepared input that came with it.
// Only files inside reports/ whose name matches the report naming pattern can
// be removed, so a crafted name cannot reach anything else on disk.
func (s *Server) handleReportDelete(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.PathValue("name"))
	if !validReportName(name) {
		writeErr(w, 400, "not a report name")
		return
	}
	dir := filepath.Join(s.cfg.Home, "reports")
	removed := []string{}
	for _, f := range []string{name, strings.TrimSuffix(name, ".md") + ".input.txt"} {
		p := filepath.Join(dir, f)
		if err := os.Remove(p); err == nil {
			removed = append(removed, f)
		} else if !os.IsNotExist(err) {
			writeErr(w, 500, "delete %s: %v", f, err)
			return
		}
	}
	if len(removed) == 0 {
		writeErr(w, 404, "no such report")
		return
	}
	writeJSON(w, map[string]any{"removed": removed})
}

// handleMediaRefresh exchanges stale attachment links for fresh ones. It is the
// only endpoint that reaches Discord, and it uses the bot token, which never
// joins a guild. Fresh links are cached on disk: Discord signs them for about
// 24 hours, so without the cache a reload would show dead images again.
func (s *Server) handleMediaRefresh(w http.ResponseWriter, r *http.Request) {
	channelID := r.PathValue("id")
	var body struct {
		URLs []string `json:"urls"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad body: %v", err)
		return
	}
	if len(body.URLs) == 0 {
		writeErr(w, 400, "urls is empty")
		return
	}
	if len(body.URLs) > 500 {
		body.URLs = body.URLs[:500]
	}
	fresh, failed, err := s.client.RefreshURLs(body.URLs)
	if err != nil {
		writeErr(w, 502, "%v", err)
		return
	}
	cache := NewMediaCache(s.cfg.Home, channelID)
	for original, signed := range fresh {
		cache.put(original, signed)
	}
	if err := cache.Save(); err != nil {
		writeErr(w, 500, "refresh worked but the cache could not be saved: %v", err)
		return
	}
	writeJSON(w, map[string]any{"urls": fresh, "failed": failed})
}

// Serve starts the API and, when a built frontend exists, serves it too.
func Serve(cfg *Config, store *Store, client *Client, addr string) error {
	srv := &Server{
		cfg: cfg, store: store, client: client,
		llm:   NewLLMClient(cfg.Settings.LLM),
		cache: map[string]cachedSummary{},
	}
	mux := http.NewServeMux()
	srv.routes(mux)

	webRoot := filepath.Join(cfg.Home, "webui", "dist")
	if _, err := os.Stat(webRoot); err == nil {
		mux.Handle("/", http.FileServer(http.Dir(webRoot)))
		log.Printf("serving frontend from %s", webRoot)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			fmt.Fprint(w, "discordwatch api. no frontend build found at webui/dist\n")
		})
	}

	log.Printf("listening on http://%s", addr)
	srv.startScheduler()
	return http.ListenAndServe(addr, mux)
}

// --- history fetch (backfill) ---

type backfillRequest struct {
	Channels []string `json:"channels"`
	From     string   `json:"from"`
	To       string   `json:"to"`
}

// validJobID keeps a URL path segment from reaching outside the jobs folder.
func validJobID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}

// handleBackfillStart queues a history fetch. The collector does the work, because
// this process must never write message files (see backfilljob.go).
func (s *Server) handleBackfillStart(w http.ResponseWriter, r *http.Request) {
	var body backfillRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad body: %v", err)
		return
	}
	from, err := parseWhen(body.From)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	to, err := parseWhen(body.To)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	job, err := CreateBackfillJob(s.cfg.Home, body.Channels, from, to)
	if err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	writeJSON(w, job)
}

func (s *Server) handleBackfillList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, listJobs(s.cfg.Home, 20))
}

func (s *Server) handleBackfillGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validJobID(id) {
		writeErr(w, 400, "不是有效的工作編號")
		return
	}
	job, ok := findJob(s.cfg.Home, id)
	if !ok {
		writeErr(w, 404, "找不到這個回補工作")
		return
	}
	writeJSON(w, job)
}

func (s *Server) handleBackfillCancel(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validJobID(id) {
		writeErr(w, 400, "不是有效的工作編號")
		return
	}
	if err := CancelBackfillJob(s.cfg.Home, id); err != nil {
		writeErr(w, 400, "%v", err)
		return
	}
	job, _ := findJob(s.cfg.Home, id)
	writeJSON(w, job)
}

// handleResolve looks a channel up before it is added to the watch list, so the
// console can show a real name instead of asking the user to trust an id. It is
// the same read-only GET the collector uses, on the user token.
func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" || strings.ContainsAny(id, "/?# ") {
		writeErr(w, 400, "id 必須是頻道 ID（純數字）")
		return
	}
	for _, c := range id {
		if c < '0' || c > '9' {
			writeErr(w, 400, "id 必須是頻道 ID（純數字）")
			return
		}
	}
	ch, err := s.client.ChannelInfo(id)
	if err != nil {
		writeErr(w, 502, "%v", err)
		return
	}
	writeJSON(w, map[string]any{
		"id": ch.ID, "name": ch.Name, "type": ch.Type, "guildId": ch.GuildID,
		"watching": s.watching(ch.ID),
	})
}
