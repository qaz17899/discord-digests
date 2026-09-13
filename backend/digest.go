package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const mapPrompt = `你是 Discord 頻道的摘要整理者。請將輸入的訊息整理為繁體中文重點摘要，讓未跟隨對話的讀者能快速掌握核心重點與脈絡。

結構：
- 開頭一段 TL;DR（3~5 句），統整最重要的幾件事
- 接著依主題分節，每節使用「### 主題名」標題，節內先簡述概要，再以 - 條列重點
- 最後一節使用「### 其他」，收錄零散但具資訊量的內容

撰寫原則：
- 每項重點需包含具體事實：時間、數據、版本／型號、價格、人名或暱稱、專有名詞
- 若有重要原話請以「」標註引用，避免過度改寫
- 具爭議之主題請客觀呈現各方觀點，不單列單一結論
- 傳聞、猜測或尚未證實之內容請加註「（未證實）」；未確定事項切勿斷言
- 避免「多人討論了 X」「有人提到 X」等無實質資訊的空泛描述，需具體說明討論內容

內容務求完整精確：請確保涵蓋該時段內的所有核心主題與關鍵資訊。
直接輸出 Markdown，不要用 ` + "```" + ` 把整份摘要包起來。`

const reducePrompt = `你會收到同一個 Discord 頻道、依時間切成數批後各自產生的「部分摘要」。
請合併成一份連貫、不重複的繁體中文摘要。

- 開頭給一段統整全部內容的 TL;DR（3~5 句）
- 相同主題合併成同一節，保留資訊最完整的那個版本
- **不得刪掉任何具體事實**：人名、數字、時間、版本／型號、價格、引用的原話
- 同一件事在不同批次出現不同數字時，兩個都保留並註明差異
- 部分摘要很長時，寧可讓摘要長一點，也不要壓縮掉資訊
- 直接輸出 Markdown 內容本身，不要用 ` + "```" + ` 包起來`

// userPrefix 解釋輸入的標記。模型看不懂 〔連結12〕、↪、[圖片] 是什麼，
// 就會把它們當成內文照抄或忽略，所以這些約定必須先講清楚。
const userPrefix = `以下是同一個 Discord 頻道的訊息，按時間排序（行首 HH:MM）。` +
	`「── 日期 ──」是日期分隔線；「↪」表示這則在回覆某則訊息；` +
	`「[圖片]」「[影片]」「[檔案]」代表附件；` +
	`「〔連結N〕」是網址，實際網址列在最後的「連結N: …」清單；` +
	`「（同一句 ×3）」表示連續多則相同的短訊息。` + "\n\n"

// defaultUserTemplate is the built-in map-stage user message. The body carries
// the compressed messages; the header block (channel / range / counts) is
// rendered by Compress, so the template only wraps it with instructions.
const defaultUserTemplate = userPrefix + "{{body}}"

// defaultReduceTemplate is the reduce-stage user message.
const defaultReduceTemplate = "{{partials}}"

var reTemplateVar = regexp.MustCompile(`\{\{([a-zA-Z]+)\}\}`)

// renderTemplate substitutes {{name}} placeholders. An unknown name is left
// alone so a typo shows up in the output instead of silently vanishing.
func renderTemplate(tpl string, vars map[string]string) string {
	return reTemplateVar.ReplaceAllStringFunc(tpl, func(m string) string {
		if v, ok := vars[m[2:len(m)-2]]; ok {
			return v
		}
		return m
	})
}

func (c *Config) promptSystem() string {
	if c.Settings.Prompts.System != "" {
		return c.Settings.Prompts.System
	}
	return mapPrompt
}

func (c *Config) promptUser() string {
	if c.Settings.Prompts.User != "" {
		return c.Settings.Prompts.User
	}
	return defaultUserTemplate
}

func (c *Config) promptReduce() string {
	if c.Settings.Prompts.Reduce != "" {
		return c.Settings.Prompts.Reduce
	}
	return defaultReduceTemplate
}

// filterRange keeps the messages whose timestamp falls inside [from, to).
// LoadRangeWithReactions works in whole days, so an hour-level window is applied
// here.
func filterRange(recs []MessageRecord, from, to time.Time) []MessageRecord {
	out := recs[:0]
	for _, rec := range recs {
		t, err := parseWhen(rec.TS)
		if err != nil {
			continue
		}
		if !t.Before(from) && t.Before(to) {
			out = append(out, rec)
		}
	}
	return out
}

// rangeLabel renders the window the way a report header should read it.
func rangeLabel(from, to time.Time) string {
	f, t := from.In(gmt8), to.In(gmt8)
	if f.Format(dayLayout) == t.Format(dayLayout) {
		return fmt.Sprintf("%s %s ~ %s", f.Format(dayLayout), f.Format("15:04"), t.Format("15:04"))
	}
	return fmt.Sprintf("%s %s ~ %s %s", f.Format(dayLayout), f.Format("15:04"), t.Format(dayLayout), t.Format("15:04"))
}

// reportStem names the report file. Full days keep the plain
// "<channel>-<day>" name so the day view finds them without guessing; a partial
// day gets its hours appended.
func reportStem(channelID string, from, to time.Time) string {
	f, t := from.In(gmt8), to.In(gmt8)
	fullDay := f.Format("15:04:05") == "00:00:00" && t.Format("15:04:05") == "23:59:59"
	switch {
	case fullDay && f.Format(dayLayout) == t.Format(dayLayout):
		return fmt.Sprintf("%s-%s", channelID, f.Format(dayLayout))
	case fullDay:
		return fmt.Sprintf("%s-%s_%s", channelID, f.Format(dayLayout), t.Format(dayLayout))
	case f.Format(dayLayout) == t.Format(dayLayout):
		return fmt.Sprintf("%s-%s_%s-%s", channelID, f.Format(dayLayout), f.Format("1504"), t.Format("1504"))
	default:
		return fmt.Sprintf("%s-%s_%s_%s-%s", channelID, f.Format(dayLayout), f.Format("1504"), t.Format(dayLayout), t.Format("1504"))
	}
}

// estimateTokens is a byte-free approximation for the token budget readout:
// CJK runs about one token per character, latin text about one per four. It is
// a UI hint for comparing prompt sizes, not an accounting number.
func estimateTokens(s string) int {
	cjk, other := 0, 0
	for _, r := range s {
		switch {
		case r >= 0x2e80 && r <= 0x9fff, r >= 0xac00 && r <= 0xd7ff, r >= 0xf900 && r <= 0xfaff, r >= 0xff00 && r <= 0xffef:
			cjk++
		default:
			other++
		}
	}
	return cjk + (other+3)/4
}

// LLMClient talks to any OpenAI-compatible /chat/completions endpoint.
type LLMClient struct {
	baseURL     string
	apiKey      string
	model       string
	temperature *float64
	maxTokens   int
	hc          *http.Client
}

func NewLLMClient(cfg LLM) *LLMClient {
	if cfg.BaseURL == "" || cfg.APIKey == "" {
		return nil
	}
	return &LLMClient{
		baseURL:     strings.TrimRight(cfg.BaseURL, "/"),
		apiKey:      cfg.APIKey,
		model:       cfg.Model,
		temperature: cfg.Temperature,
		maxTokens:   cfg.MaxTokens,
		hc:          &http.Client{Timeout: 10 * time.Minute},
	}
}

func (l *LLMClient) Generate(system, user string) (string, error) {
	payload := map[string]any{
		"model": l.model,
		"messages": []map[string]string{
			{"role": "system", "content": system},
			{"role": "user", "content": user},
		},
	}
	if l.temperature != nil {
		payload["temperature"] = *l.temperature
	}
	if l.maxTokens > 0 {
		payload["max_tokens"] = l.maxTokens
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest("POST", l.baseURL+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+l.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := l.hc.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("llm HTTP %d: %s", resp.StatusCode, truncate(string(raw), 400))
	}
	var out struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("llm decode: %w", err)
	}
	if len(out.Choices) == 0 {
		return "", fmt.Errorf("llm returned no choices")
	}
	text := strings.TrimSpace(out.Choices[0].Message.Content)
	if text == "" {
		return "", fmt.Errorf("llm returned empty content")
	}
	return text, nil
}

// chunkByRunes splits on line boundaries so the model never sees half a message.
// The limit is characters, not message count: a batch of short lines can hold
// thousands, while a batch of long posts holds a few dozen.
func chunkByRunes(text string, maxChars int) []string {
	if maxChars <= 0 || utf8.RuneCountInString(text) <= maxChars {
		return []string{text}
	}
	var chunks []string
	var cur strings.Builder
	curLen := 0
	for _, line := range strings.SplitAfter(text, "\n") {
		n := utf8.RuneCountInString(line)
		if curLen > 0 && curLen+n > maxChars {
			chunks = append(chunks, strings.TrimRight(cur.String(), "\n"))
			cur.Reset()
			curLen = 0
		}
		cur.WriteString(line)
		curLen += n
	}
	if strings.TrimSpace(cur.String()) != "" {
		chunks = append(chunks, strings.TrimRight(cur.String(), "\n"))
	}
	return chunks
}

// DigestResult reports what a run produced.
type DigestResult struct {
	Messages int
	Batches  int
	Report   string
	Input    string
}

// Digest compresses a range, batches it, asks the model, and writes the report.
// When no LLM is configured it writes the prepared input instead, so a human or
// an external agent can produce the report from exactly the same text.
// progress, when given, receives (batches finished, batches total).
func Digest(llm *LLMClient, store *Store, cfg *Config, channelID string, from, to time.Time, progress func(done, total int)) (*DigestResult, error) {
	fromDay := from.In(gmt8).Format(dayLayout)
	toDay := to.In(gmt8).Format(dayLayout)

	recs, err := store.LoadRangeWithReactions(channelID, fromDay, toDay)
	if err != nil {
		return nil, err
	}
	recs = filterRange(recs, from, to)
	if len(recs) == 0 {
		return nil, fmt.Errorf("no messages in %s", rangeLabel(from, to))
	}

	text := Compress(recs)
	out := &DigestResult{Messages: len(recs)}

	reportsDir := filepath.Join(cfg.Home, "reports")
	if err := os.MkdirAll(reportsDir, 0o755); err != nil {
		return nil, err
	}
	stem := reportStem(channelID, from, to)
	out.Input = filepath.Join(reportsDir, stem+".input.txt")
	if err := os.WriteFile(out.Input, []byte(text), 0o644); err != nil {
		return nil, err
	}

	if llm == nil {
		return out, nil
	}

	maxChars := cfg.Settings.LLM.MaxChars
	if maxChars <= 0 {
		maxChars = defaultMaxChars
	}
	chunks := chunkByRunes(text, maxChars)
	out.Batches = len(chunks)
	if progress != nil {
		progress(0, len(chunks))
	}

	st := store.State(channelID)
	vars := map[string]string{
		"channel": orUnknown(st.ChannelName),
		"range":   rangeLabel(from, to),
		"count":   strconv.Itoa(len(recs)),
		"total":   strconv.Itoa(len(chunks)),
	}
	system, userTemplate := cfg.promptSystem(), cfg.promptUser()
	partials := make([]string, 0, len(chunks))
	for i, chunk := range chunks {
		vars["body"] = chunk
		vars["index"] = strconv.Itoa(i + 1)
		part, err := llm.Generate(system, renderTemplate(userTemplate, vars))
		if err != nil {
			return out, fmt.Errorf("batch %d/%d: %w", i+1, len(chunks), err)
		}
		partials = append(partials, part)
		if progress != nil {
			progress(i+1, len(chunks))
		}
	}

	final := partials[0]
	if len(partials) > 1 {
		var joined strings.Builder
		for i, p := range partials {
			fmt.Fprintf(&joined, "# 部分摘要 %d\n\n%s\n\n---\n\n", i+1, p)
		}
		merged, err := llm.Generate(system, renderTemplate(cfg.promptReduce(), map[string]string{"partials": joined.String()}))
		if err != nil {
			return out, fmt.Errorf("merge: %w", err)
		}
		final = merged
	}

	header := fmt.Sprintf("# %s 每日摘要\n\n- 頻道：%s\n- 範圍：%s（GMT+8）\n- 訊息數：%d\n- 分批：%d\n\n---\n\n",
		vars["channel"], channelID, rangeLabel(from, to), len(recs), len(chunks))

	report := header + final + "\n"
	out.Report = filepath.Join(reportsDir, stem+".md")
	return out, os.WriteFile(out.Report, []byte(report), 0o644)
}

func orUnknown(s string) string {
	if s == "" {
		return "(未命名頻道)"
	}
	return s
}
