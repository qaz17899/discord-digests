package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

const apiBase = "https://discord.com/api/v9"

// userAgent must look like the official desktop client. Discord fingerprints
// non-standard clients (TLS/JA3 and headers), so this is not cosmetic.
const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) discord/1.0.9181 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36"

// botUserAgent is the opposite: /attachments/refresh-urls answers 403 (code
// 40333 "internal network error") to anything that looks like a desktop client,
// no matter how correct the bot token is. Bot calls must announce themselves.
const botUserAgent = "DiscordBot (https://github.com/discord/discord-api-docs, 1.0)"

type rawUser struct {
	ID         string `json:"id"`
	Username   string `json:"username"`
	GlobalName string `json:"global_name"`
}

type rawAttachment struct {
	Filename    string `json:"filename"`
	URL         string `json:"url"`
	ContentType string `json:"content_type"`
	Width       int    `json:"width"`
	Height      int    `json:"height"`
	Size        int    `json:"size"`
}

type rawEmbed struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	URL         string `json:"url"`
	Image       *struct {
		URL string `json:"url"`
	} `json:"image"`
	Thumbnail *struct {
		URL string `json:"url"`
	} `json:"thumbnail"`
}

type rawReaction struct {
	Emoji struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"emoji"`
	Count int `json:"count"`
}

type rawMessage struct {
	ID              string          `json:"id"`
	ChannelID       string          `json:"channel_id"`
	GuildID         string          `json:"guild_id"`
	Content         string          `json:"content"`
	Timestamp       string          `json:"timestamp"`
	EditedTimestamp *string         `json:"edited_timestamp"`
	Author          rawUser         `json:"author"`
	Attachments     []rawAttachment `json:"attachments"`
	Embeds          []rawEmbed      `json:"embeds"`
	Reactions       []rawReaction   `json:"reactions"`
	Referenced      *struct {
		ID     string  `json:"id"`
		Author rawUser `json:"author"`
	} `json:"referenced_message"`
	MessageReference *struct {
		MessageID string `json:"message_id"`
		ChannelID string `json:"channel_id"`
	} `json:"message_reference"`
}

type Guild struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Channel struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Type     int    `json:"type"`
	ParentID string `json:"parent_id"`
	GuildID  string `json:"guild_id"`
	Topic    string `json:"topic"`
}

// channelKind turns a Discord channel type into a stable label used by the
// frontend and by _state.json.
func channelKind(t int) string {
	switch t {
	case 0:
		return "text"
	case 2:
		return "voice"
	case 4:
		return "category"
	case 5:
		return "news"
	case 10, 11, 12:
		return "thread"
	case 13:
		return "stage"
	case 15:
		return "forum"
	case 16:
		return "media"
	default:
		return fmt.Sprintf("type%d", t)
	}
}

// Client is a thin Discord REST client. It serialises nothing: the collector is
// the only writer of the message pipeline, and rate limits are handled inline.
type Client struct {
	userToken string
	// botToken is swapped at runtime from the dashboard, so it is guarded.
	botMu    sync.RWMutex
	botToken string
	hc       *http.Client
}

func (c *Client) SetBotToken(token string) {
	c.botMu.Lock()
	c.botToken = token
	c.botMu.Unlock()
}

func (c *Client) BotToken() string {
	c.botMu.RLock()
	defer c.botMu.RUnlock()
	return c.botToken
}

// BotIdentity proves a bot token is alive with a GET that needs no guild.
func (c *Client) BotIdentity(token string) (name, id string, err error) {
	var u rawUser
	if err := c.do("GET", "/users/@me", "Bot "+token, nil, &u); err != nil {
		return "", "", err
	}
	return u.Username, u.ID, nil
}

func NewClient(userToken, botToken string) *Client {
	return &Client{
		userToken: userToken,
		botToken:  botToken,
		hc:        &http.Client{Timeout: 30 * time.Second},
	}
}

var (
	superPropsOnce sync.Once
	superProps     string
)

func superProperties() string {
	superPropsOnce.Do(func() {
		props := map[string]any{
			"os":                  "Windows",
			"browser":             "Discord Client",
			"device":              "",
			"system_locale":       "zh-TW",
			"browser_user_agent":  userAgent,
			"browser_version":     "32.2.7",
			"os_version":          "10",
			"referrer":            "",
			"referring_domain":    "",
			"release_channel":     "stable",
			"client_build_number": 348000,
		}
		raw, _ := json.Marshal(props)
		superProps = base64.StdEncoding.EncodeToString(raw)
	})
	return superProps
}

// do performs one REST call, retrying on 429 using the server's retry_after.
// auth is the full Authorization header value.
func (c *Client) do(method, path, auth string, body any, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}

	for attempt := 0; ; attempt++ {
		var rdr io.Reader
		if payload != nil {
			rdr = bytes.NewReader(payload)
		}
		req, err := http.NewRequest(method, apiBase+path, rdr)
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", auth)
		if strings.HasPrefix(auth, "Bot ") {
			req.Header.Set("User-Agent", botUserAgent)
		} else {
			req.Header.Set("User-Agent", userAgent)
			req.Header.Set("X-Super-Properties", superProperties())
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := c.hc.Do(req)
		if err != nil {
			return err
		}
		data, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}

		switch {
		case resp.StatusCode == http.StatusTooManyRequests:
			// Never hammer a 429: invalid requests are counted and enough of them
			// inside ten minutes gets the IP banned at the edge.
			if attempt >= 5 {
				return fmt.Errorf("%s %s: rate limited five times in a row", method, path)
			}
			wait := 1.0
			var rl struct {
				RetryAfter float64 `json:"retry_after"`
			}
			if json.Unmarshal(data, &rl) == nil && rl.RetryAfter > 0 {
				wait = rl.RetryAfter
			}
			time.Sleep(time.Duration(wait*1000+300) * time.Millisecond)
			continue
		case resp.StatusCode < 200 || resp.StatusCode >= 300:
			return fmt.Errorf("%s %s: HTTP %d: %s", method, path, resp.StatusCode, truncate(string(data), 300))
		}

		if out == nil {
			return nil
		}
		return json.Unmarshal(data, out)
	}
}

func (c *Client) user(method, path string, body, out any) error {
	return c.do(method, path, c.userToken, body, out)
}

func (c *Client) Me() (rawUser, error) {
	var u rawUser
	err := c.user("GET", "/users/@me", nil, &u)
	return u, err
}

func (c *Client) Guilds() ([]Guild, error) {
	var g []Guild
	err := c.user("GET", "/users/@me/guilds", nil, &g)
	return g, err
}

func (c *Client) GuildChannels(guildID string) ([]Channel, error) {
	var ch []Channel
	err := c.user("GET", "/guilds/"+guildID+"/channels", nil, &ch)
	return ch, err
}

func (c *Client) ChannelInfo(channelID string) (Channel, error) {
	var ch Channel
	err := c.user("GET", "/channels/"+channelID, nil, &ch)
	return ch, err
}

// Messages pages a channel. Exactly one of after/before may be set.
func (c *Client) Messages(channelID, after, before string, limit int) ([]rawMessage, error) {
	q := url.Values{}
	q.Set("limit", strconv.Itoa(limit))
	if after != "" {
		q.Set("after", after)
	}
	if before != "" {
		q.Set("before", before)
	}
	var msgs []rawMessage
	path := "/channels/" + channelID + "/messages?" + q.Encode()
	err := c.user("GET", path, nil, &msgs)
	return msgs, err
}

// RefreshURLs exchanges expired signed CDN links for fresh ones. It needs a bot
// token and works even when that bot is in no guild at all. Discord caps the
// batch at 50 and refuses ephemeral-attachment URLs.
//
// A link that cannot be refreshed (deleted message, attachment Discord no
// longer holds) must not take the whole batch down, so failures fall back to
// one-by-one and are reported rather than fatal.
func (c *Client) RefreshURLs(urls []string) (map[string]string, []string, error) {
	token := c.BotToken()
	if token == "" {
		return nil, nil, fmt.Errorf("no bot token; set it on the settings page or DISCORD_BOT_TOKEN")
	}
	out := map[string]string{}
	var failed []string
	var firstErr error

	batch := func(chunk []string) error {
		var resp struct {
			Refreshed []struct {
				Original  string `json:"original"`
				Refreshed string `json:"refreshed"`
			} `json:"refreshed_urls"`
		}
		body := map[string]any{"attachment_urls": chunk}
		if err := c.do("POST", "/attachments/refresh-urls", "Bot "+token, body, &resp); err != nil {
			return err
		}
		for _, r := range resp.Refreshed {
			out[r.Original] = r.Refreshed
		}
		return nil
	}

	for start := 0; start < len(urls); start += 50 {
		end := min(start+50, len(urls))
		chunk := urls[start:end]
		if err := batch(chunk); err == nil {
			continue
		}
		for _, u := range chunk {
			if err := batch([]string{u}); err != nil {
				failed = append(failed, u)
				if firstErr == nil {
					firstErr = err
				}
			}
		}
	}
	if len(out) == 0 && firstErr != nil {
		return nil, failed, firstErr
	}
	return out, failed, nil
}

// truncate cuts to n runes, not bytes: channel and author names are usually CJK,
// and slicing bytes would split a character in half.
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
