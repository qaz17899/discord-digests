package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The dashboard is otherwise read-only; this is the one place it writes. It
// only ever touches this project's own config.json — never Discord, never
// another app's files.

const defaultMaxChars = 120000

// settingsView is the redacted form the browser gets: secrets are never sent
// back, only whether they exist and a short hint so you can tell which key is
// installed.
type settingsView struct {
	LLM struct {
		BaseURL     string   `json:"baseUrl"`
		Model       string   `json:"model"`
		MaxChars    int      `json:"maxChars"`
		APIKeySet   bool     `json:"apiKeySet"`
		APIKeyTag   string   `json:"apiKeyTag"`
		APIKeyEnv   bool     `json:"apiKeyEnv"`
		Temperature *float64 `json:"temperature"`
		MaxTokens   int      `json:"maxTokens,omitempty"`
	} `json:"llm"`
	Prompts        Prompts `json:"prompts"`
	DefaultPrompts struct {
		System string `json:"system"`
		User   string `json:"user"`
		Reduce string `json:"reduce"`
	} `json:"defaultPrompts"`
	Schedule       Schedule `json:"schedule"`
	BotTokenSet    bool     `json:"botTokenSet"`
	BotTokenTag    string   `json:"botTokenTag"`
	BotTokenEnv    bool     `json:"botTokenEnv"`
	UserTokenSet   bool     `json:"userTokenSet"`
	Watch          []string `json:"watch"`
	Home           string   `json:"home"`
	DefaultMaxChar int      `json:"defaultMaxChars"`
	DefaultTime    string   `json:"defaultScheduleTime"`
}

// tag renders the tail of a secret so two different keys are distinguishable
// without revealing either.
func tag(secret string) string {
	if secret == "" {
		return ""
	}
	if len(secret) <= 6 {
		return "••••"
	}
	return "••••" + secret[len(secret)-4:]
}

func (s *Server) settingsView() settingsView {
	s.cfgMu.RLock()
	st := s.cfg.Settings
	botEnv := os.Getenv("DISCORD_BOT_TOKEN") != ""
	bot := s.cfg.BotToken
	user := s.cfg.UserToken
	s.cfgMu.RUnlock()

	var v settingsView
	v.LLM.BaseURL = st.LLM.BaseURL
	v.LLM.Model = st.LLM.Model
	v.LLM.MaxChars = st.LLM.MaxChars
	v.LLM.Temperature = st.LLM.Temperature
	v.LLM.MaxTokens = st.LLM.MaxTokens
	if v.LLM.MaxChars == 0 {
		v.LLM.MaxChars = defaultMaxChars
	}
	v.LLM.APIKeySet = st.LLM.APIKey != ""
	v.LLM.APIKeyTag = tag(st.LLM.APIKey)
	v.LLM.APIKeyEnv = os.Getenv("DM_LLM_API_KEY") != ""
	v.BotTokenSet = bot != ""
	v.BotTokenTag = tag(bot)
	v.BotTokenEnv = botEnv
	v.UserTokenSet = user != ""
	v.Watch = st.Watch
	v.Home = s.cfg.Home
	v.DefaultMaxChar = defaultMaxChars
	v.DefaultTime = defaultScheduleTime
	v.Prompts = st.Prompts
	v.DefaultPrompts.System = mapPrompt
	v.DefaultPrompts.User = defaultUserTemplate
	v.DefaultPrompts.Reduce = defaultReduceTemplate
	v.Schedule = st.Schedule
	return v
}

func (s *Server) handleSettingsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, s.settingsView())
}

func (s *Server) handleSettingsPut(w http.ResponseWriter, r *http.Request) {
	var body struct {
		LLM struct {
			BaseURL     string   `json:"baseUrl"`
			Model       string   `json:"model"`
			MaxChars    int      `json:"maxChars"`
			APIKey      string   `json:"apiKey"`
			Temperature *float64 `json:"temperature"`
			MaxTokens   int      `json:"maxTokens"`
		} `json:"llm"`
		Prompts       *Prompts  `json:"prompts"`
		Watch         *[]string `json:"watch"`
		BotToken      string    `json:"botToken"`
		ClearAPIKey   bool      `json:"clearApiKey"`
		ClearBotToken bool      `json:"clearBotToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad body: %v", err)
		return
	}

	base := strings.TrimSpace(body.LLM.BaseURL)
	model := strings.TrimSpace(body.LLM.Model)
	if base != "" {
		u, err := url.Parse(base)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			writeErr(w, 400, "baseUrl 必須是 http(s)://... 的完整網址")
			return
		}
		if model == "" {
			writeErr(w, 400, "設定 baseUrl 時必須同時指定模型名稱")
			return
		}
	}
	maxChars := body.LLM.MaxChars
	if maxChars == 0 {
		maxChars = defaultMaxChars
	}
	if maxChars < 2000 {
		writeErr(w, 400, "每批字元數至少要 2000")
		return
	}

	// Read the file fresh so a `channels -add` typed in a terminal between two
	// saves is not silently dropped.
	path := filepath.Join(s.cfg.Home, "config.json")
	st := Settings{}
	if raw, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(raw, &st); err != nil {
			writeErr(w, 500, "無法讀取 config.json：%v", err)
			return
		}
	}

	st.LLM.BaseURL = base
	st.LLM.Model = model
	st.LLM.MaxChars = maxChars
	if body.LLM.Temperature != nil {
		t := *body.LLM.Temperature
		if t < 0 || t > 2 {
			writeErr(w, 400, "temperature 必須在 0~2 之間")
			return
		}
		st.LLM.Temperature = &t
	}
	if body.LLM.MaxTokens > 0 {
		st.LLM.MaxTokens = body.LLM.MaxTokens
	}
	if body.Prompts != nil {
		st.Prompts = *body.Prompts
	}
	if body.Watch != nil {
		// The collector re-reads this list every few seconds, so the change is
		// live without a restart.
		st.Watch = cleanIDs(*body.Watch)
	}
	switch {
	case body.ClearAPIKey:
		st.LLM.APIKey = ""
	case strings.TrimSpace(body.LLM.APIKey) != "":
		st.LLM.APIKey = strings.TrimSpace(body.LLM.APIKey)
	}
	switch {
	case body.ClearBotToken:
		st.BotToken = ""
	case strings.TrimSpace(body.BotToken) != "":
		st.BotToken = strings.TrimSpace(body.BotToken)
	}

	if err := writeSettingsFile(path, st); err != nil {
		writeErr(w, 500, "%v", err)
		return
	}

	// Writing the file never leaves the process without a usable secret: .env and
	// the real environment still win over whatever is stored here.
	eff := st
	eff.applyEnv()

	s.cfgMu.Lock()
	s.cfg.Settings = eff
	s.cfg.Settings.normalize()
	s.cfg.BotToken = eff.BotToken
	s.client.SetBotToken(s.cfg.BotToken)
	s.llm = NewLLMClient(eff.LLM)
	s.cfgMu.Unlock()

	log.Printf("settings saved: llm=%q model=%q key=%v bot=%v", base, model, eff.LLM.APIKey != "", s.cfg.BotToken != "")
	writeJSON(w, s.settingsView())
}

// handleSettingsTest proves the credentials work instead of just claiming they
// are saved: one tiny completion for the model, one GET /users/@me for the bot.
func (s *Server) handleSettingsTest(w http.ResponseWriter, r *http.Request) {
	var body struct {
		What     string `json:"what"` // llm | bot | both
		APIKey   string `json:"apiKey"`
		BotToken string `json:"botToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad body: %v", err)
		return
	}

	out := map[string]any{}
	wantLLM := body.What == "llm" || body.What == "both" || body.What == ""
	wantBot := body.What == "bot" || body.What == "both" || body.What == ""

	if wantLLM {
		s.cfgMu.RLock()
		st := s.cfg.Settings
		llm := s.llm
		s.cfgMu.RUnlock()
		if key := strings.TrimSpace(body.APIKey); key != "" {
			st.LLM.APIKey = key
			llm = NewLLMClient(st.LLM)
		}
		out["llm"] = probeLLM(llm)
	}
	if wantBot {
		s.cfgMu.RLock()
		token := s.cfg.BotToken
		s.cfgMu.RUnlock()
		if t := strings.TrimSpace(body.BotToken); t != "" {
			token = t
		}
		out["bot"] = s.probeBot(token)
	}
	writeJSON(w, out)
}

type probeResult struct {
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

func probeLLM(llm *LLMClient) probeResult {
	if llm == nil {
		return probeResult{false, "尚未設定 baseUrl 或 API key"}
	}
	start := time.Now()
	reply, err := llm.Generate("You are a connectivity probe. Reply with the single word: ok", "ping")
	if err != nil {
		return probeResult{false, err.Error()}
	}
	return probeResult{true, fmt.Sprintf("%s 回應中（%.1fs）：%s", llm.model, time.Since(start).Seconds(), strings.TrimSpace(reply))}
}

func (s *Server) probeBot(token string) probeResult {
	if token == "" {
		return probeResult{false, "尚未設定 bot token"}
	}
	name, id, err := s.client.BotIdentity(token)
	if err != nil {
		return probeResult{false, err.Error()}
	}
	return probeResult{true, fmt.Sprintf("bot 身分有效：%s (%s)", name, id)}
}

// writeSettingsFile writes atomically with 0600 so a crash mid-write cannot
// leave a half-parsed config behind.
func writeSettingsFile(path string, st Settings) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
