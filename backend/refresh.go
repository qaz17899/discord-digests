package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// MediaCache maps an original attachment URL to a freshly signed one. Signed
// Discord CDN links carry an `ex` expiry, so a cached entry is reused until it
// is about to lapse.
type MediaCache struct {
	mu   sync.Mutex
	path string
	data map[string]MediaEntry
}

type MediaEntry struct {
	URL string `json:"url"`
	Exp int64  `json:"exp"` // unix seconds; 0 means unknown
}

func NewMediaCache(home, channelID string) *MediaCache {
	path := filepath.Join(home, "raw", channelID, "media.json")
	mc := &MediaCache{path: path, data: map[string]MediaEntry{}}
	if raw, err := os.ReadFile(path); err == nil {
		json.Unmarshal(raw, &mc.data)
	}
	return mc
}

func (m *MediaCache) Get(original string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	e, ok := m.data[original]
	if !ok || e.URL == "" {
		return "", false
	}
	if e.Exp > 0 && time.Now().Unix() > e.Exp-120 {
		return "", false // about to lapse; caller should refresh
	}
	return e.URL, true
}

func (m *MediaCache) put(original, refreshed string) {
	exp := int64(0)
	if t, ok := urlExpiry(refreshed); ok {
		exp = t.Unix()
	}
	m.data[original] = MediaEntry{URL: refreshed, Exp: exp}
}

func (m *MediaCache) Save() error {
	m.mu.Lock()
	raw, err := json.MarshalIndent(m.data, "", "  ")
	m.mu.Unlock()
	if err != nil {
		return err
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, m.path)
}

// urlExpiry reads Discord's `ex` parameter, which is a hex unix timestamp.
func urlExpiry(raw string) (time.Time, bool) {
	u, err := url.Parse(raw)
	if err != nil {
		return time.Time{}, false
	}
	ex := u.Query().Get("ex")
	if ex == "" {
		return time.Time{}, false
	}
	n, err := strconv.ParseInt(ex, 16, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.Unix(n, 0), true
}

// NeedsRefresh reports whether a CDN link is expired or expiring soon. Links
// without an `ex` parameter are left alone: they are usually permanent
// (avatars, emojis) rather than signed attachments.
func NeedsRefresh(raw string) bool {
	if raw == "" {
		return false
	}
	t, ok := urlExpiry(raw)
	if !ok {
		return false
	}
	return time.Now().Add(2 * time.Minute).After(t)
}

// RefreshChannel exchanges every stale attachment link for a fresh one using the
// bot token. The bot never joins a guild; the endpoint is not guild-scoped.
func RefreshChannel(client *Client, store *Store, home, channelID, from, to string, dryRun bool) (refreshed, candidates int, err error) {
	recs, err := store.LoadRange(channelID, from, to)
	if err != nil {
		return 0, 0, err
	}

	cache := NewMediaCache(home, channelID)
	seen := map[string]bool{}
	var stale []string
	for _, r := range recs {
		for _, a := range r.Attachments {
			if a.URL == "" || seen[a.URL] {
				continue
			}
			seen[a.URL] = true
			if _, ok := cache.Get(a.URL); ok {
				continue
			}
			if NeedsRefresh(a.URL) {
				stale = append(stale, a.URL)
			}
		}
	}
	candidates = len(stale)
	if candidates == 0 || dryRun {
		return 0, candidates, nil
	}

	mapping, failed, err := client.RefreshURLs(stale)
	if err != nil {
		return refreshed, candidates, err
	}
	for original, fresh := range mapping {
		cache.put(original, fresh)
		refreshed++
	}
	log.Printf("refreshed %d/%d (%d failed)", refreshed, candidates, len(failed))
	if err := cache.Save(); err != nil {
		return refreshed, candidates, err
	}
	return refreshed, candidates, nil
}

func RefreshAll(client *Client, store *Store, home, from, to string, dryRun bool) error {
	if client.botToken == "" {
		return fmt.Errorf("no bot token: put DISCORD_BOT_TOKEN in .env or the environment")
	}
	channels, err := store.Channels()
	if err != nil {
		return err
	}
	for _, ch := range channels {
		n, candidates, err := RefreshChannel(client, store, home, ch, from, to, dryRun)
		if err != nil {
			log.Printf("%s: %v", ch, err)
			continue
		}
		log.Printf("%s: %d refreshed (%d stale found)", ch, n, candidates)
	}
	return nil
}
