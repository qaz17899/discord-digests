package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// LLM is the summarizer endpoint. Any OpenAI-compatible /chat/completions works.
type LLM struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
	Model   string `json:"model"`
	// MaxChars is the per-batch character budget. Messages are packed by
	// characters, not by count, so long posts and short lines batch evenly.
	MaxChars int `json:"maxChars"`
	// Temperature and MaxTokens are optional request parameters; a nil
	// temperature means "leave it to the provider".
	Temperature *float64 `json:"temperature,omitempty"`
	MaxTokens   int      `json:"maxTokens,omitempty"`
}

// Prompts overrides the summarizer's built-in prompts. An empty field falls back
// to the default in digest.go, so config.json only ever holds the differences.
// Templates may use {{channel}}, {{range}}, {{count}}, {{index}}, {{total}},
// {{body}} (map stage) and {{partials}} (reduce stage).
type Prompts struct {
	System string `json:"system,omitempty"`
	User   string `json:"user,omitempty"`
	Reduce string `json:"reduce,omitempty"`
}

// Schedule drives the summarizer timer inside `serve`.
type Schedule struct {
	Enabled      bool     `json:"enabled"`
	Mode         string   `json:"mode"`      // daily | interval
	Time         string   `json:"time"`      // HH:MM (GMT+8) for daily
	IntervalH    int      `json:"intervalH"` // hours between runs for interval
	WeekdaysOnly bool     `json:"weekdaysOnly"`
	OffsetDays   int      `json:"offsetDays"` // which day to summarize; 1 = yesterday
	Targets      []string `json:"targets"`    // channel ids; empty = everything being watched
}

// Settings is the user-editable part, stored at <home>/config.json.
type Settings struct {
	// Watch is the channel whitelist. The gateway pushes every message from every
	// guild the account is in; only channels listed here get written.
	Watch    []string `json:"watch"`
	LLM      LLM      `json:"llm"`
	Prompts  Prompts  `json:"prompts,omitempty"`
	Schedule Schedule `json:"schedule,omitempty"`
	// BotToken re-signs expired CDN links. The dashboard writes it here; .env and
	// the environment are read first as overrides.
	BotToken string `json:"botToken,omitempty"`
}

// applyEnv overlays the settings the environment provides, so .env can hold the
// endpoint, the keys and the tokens instead of config.json.
func (s *Settings) applyEnv() {
	if v := os.Getenv("DM_LLM_BASE_URL"); v != "" {
		s.LLM.BaseURL = v
	}
	if v := os.Getenv("DM_LLM_API_KEY"); v != "" {
		s.LLM.APIKey = v
	}
	if v := os.Getenv("DM_LLM_MODEL"); v != "" {
		s.LLM.Model = v
	}
	if v := os.Getenv("DISCORD_BOT_TOKEN"); v != "" {
		s.BotToken = v
	}
}

// normalize fills in the defaults a hand-written config.json may leave out.
func (s *Settings) normalize() {
	if s.Schedule.Mode == "" {
		s.Schedule.Mode = "daily"
	}
	if s.Schedule.Time == "" {
		s.Schedule.Time = defaultScheduleTime
	}
	if s.Schedule.IntervalH <= 0 {
		s.Schedule.IntervalH = 6
	}
	if s.Schedule.OffsetDays <= 0 {
		s.Schedule.OffsetDays = 1
	}
}

// Config is the resolved runtime configuration.
type Config struct {
	Home      string
	UserToken string // reads channels
	BotToken  string // refreshes CDN urls; never has to join a guild
	Settings  Settings
}

// loadEnvFile applies <home>/.env to the process environment so secrets can stay
// out of config.json. Variables already set in the real environment win, and a
// missing file is not an error.
func loadEnvFile(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.Trim(strings.TrimSpace(value), `"'`)
		if key == "" {
			continue
		}
		if _, set := os.LookupEnv(key); !set {
			os.Setenv(key, value)
		}
	}
}

// readWatchList re-reads just the watch list out of config.json. The collector
// uses it to pick up dashboard edits while it is running, so adding or removing
// a channel no longer needs a restart.
func readWatchList(home string) ([]string, error) {
	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		return nil, err
	}
	var s struct {
		Watch []string `json:"watch"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, err
	}
	return s.Watch, nil
}

func resolveHome() string {
	if v := os.Getenv("DM_HOME"); v != "" {
		return v
	}
	wd, err := os.Getwd()
	if err != nil {
		fatal("cannot determine working directory: %v", err)
	}
	return wd
}

// loadConfig reads .env, then config.json, then resolves the tokens. Tokens only
// ever come from .env or the real environment; they are never stored in
// config.json unless you type one into the dashboard yourself.
func loadConfig() *Config {
	home := resolveHome()
	if err := os.MkdirAll(home, 0o755); err != nil {
		fatal("create home %s: %v", home, err)
	}

	cfg := &Config{Home: home}
	loadEnvFile(filepath.Join(home, ".env"))
	if raw, err := os.ReadFile(filepath.Join(home, "config.json")); err == nil {
		if err := json.Unmarshal(raw, &cfg.Settings); err != nil {
			fatal("parse config.json: %v", err)
		}
	}
	cfg.UserToken, cfg.BotToken = os.Getenv("DISCORD_TOKEN"), os.Getenv("DISCORD_BOT_TOKEN")
	cfg.Settings.applyEnv()
	cfg.Settings.normalize()
	if cfg.BotToken == "" {
		cfg.BotToken = cfg.Settings.BotToken
	}
	if cfg.UserToken == "" {
		fatal("no DISCORD_TOKEN (put it in .env or the environment)")
	}
	return cfg
}

func (c *Config) SaveSettings() {
	if err := writeSettingsFile(filepath.Join(c.Home, "config.json"), c.Settings); err != nil {
		fatal("write config: %v", err)
	}
}

func (c *Config) watching(channelID string) bool {
	for _, id := range c.Settings.Watch {
		if id == channelID {
			return true
		}
	}
	return false
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}
