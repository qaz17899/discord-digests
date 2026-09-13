package main

import (
	"compress/zlib"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// gatewayBase has no compress params: the resume URL returned by Discord needs
// them appended too, so the query is built once and reused.
const gatewayBase = "wss://gateway.discord.gg"
const gatewayQuery = "/?v=9&encoding=json&compress=zlib-stream"

// clientBuildNumber and clientVersion must look like a real desktop build. The
// UA string and X-Super-Properties REST headers use the same values.
const (
	clientVersion     = "32.2.7"
	clientBuildNumber = 348000
)

// debugEvents logs every dispatch event name. Off by default; the gateway emits
// a lot of traffic that is irrelevant to collecting messages.
var debugEvents bool

type payload struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
	S  *int64          `json:"s"`
	T  string          `json:"t"`
}

type cursorState struct {
	lastID string
	lastTS string
	total  int
}

// Collector owns the gateway connection. It is the only writer of message data.
type Collector struct {
	cfg    *Config
	store  *Store
	client *Client

	mu        sync.Mutex
	sessionID string
	seq       int64
	resumeURL string
	selfID    string
	conn      *websocket.Conn // set per connection; used for mid-stream subscriptions
	wmu       sync.Mutex      // gorilla allows a single concurrent writer
	cursors   map[string]*cursorState
	recv      int64
	seenChans map[string]int

	// watch is the live watch list. It starts as config.json had it and follows
	// later edits; the gateway read loop consults it on every message, so it is
	// only ever touched through isWatched/watchIDs/setWatch.
	watchMu sync.RWMutex
	watch   []string

	// ready is set on READY and cleared on disconnect. It is what the heartbeat
	// reports, so the dashboard can tell "connected and collecting" from "process
	// alive but reconnecting".
	ready atomic.Bool

	// needGapFill is set when Discord rejects a resume. A rejected session means
	// the outage window exists only in REST; nothing will replay it.
	needGapFill atomic.Bool
}

func NewCollector(cfg *Config, store *Store, client *Client) *Collector {
	c := &Collector{
		cfg:       cfg,
		store:     store,
		client:    client,
		cursors:   map[string]*cursorState{},
		seenChans: map[string]int{},
		watch:     cleanIDs(cfg.Settings.Watch),
	}
	sess := store.Session()
	c.sessionID = sess.SessionID
	c.seq = sess.Seq
	c.resumeURL = sess.ResumeURL
	c.selfID = sess.UserID

	// Seed totals from disk so a restart does not reset the counter.
	for _, ch := range cfg.Settings.Watch {
		st := store.State(ch)
		c.cursors[ch] = &cursorState{lastID: st.LastID, lastTS: st.LastTS, total: st.TotalFetched}
	}
	return c
}

// isWatched reports whether a channel is in the live watch list.
func (c *Collector) isWatched(channelID string) bool {
	c.watchMu.RLock()
	defer c.watchMu.RUnlock()
	for _, id := range c.watch {
		if id == channelID {
			return true
		}
	}
	return false
}

func (c *Collector) watchIDs() []string {
	c.watchMu.RLock()
	defer c.watchMu.RUnlock()
	return append([]string(nil), c.watch...)
}

// setWatch swaps in a new list and reports what changed.
func (c *Collector) setWatch(ids []string) (added, removed []string) {
	next := cleanIDs(ids)
	c.watchMu.Lock()
	defer c.watchMu.Unlock()
	cur := map[string]bool{}
	for _, id := range c.watch {
		cur[id] = true
	}
	keep := map[string]bool{}
	for _, id := range next {
		keep[id] = true
		if !cur[id] {
			added = append(added, id)
		}
	}
	for _, id := range c.watch {
		if !keep[id] {
			removed = append(removed, id)
		}
	}
	c.watch = next
	return added, removed
}

// syncWatch applies a watch list edited from the dashboard or the CLI. Adding a
// channel is not enough on its own: the subscription lives in the open socket,
// so op 14 has to be sent again or Discord never pushes that channel's messages.
// Removing one only stops the writing — the subscription is simply ignored.
func (c *Collector) syncWatch() {
	ids, err := readWatchList(c.cfg.Home)
	if err != nil {
		// config.json is written atomically, so a failed read means a transient
		// filesystem problem, not an empty list. Keep what we have.
		return
	}
	added, removed := c.setWatch(ids)
	if len(added) == 0 && len(removed) == 0 {
		return
	}
	for _, id := range added {
		log.Printf("now watching %s", id)
	}
	for _, id := range removed {
		log.Printf("no longer watching %s", id)
	}
	c.subscribe()
	// A channel added mid-session may have been watched before (removed and put
	// back), in which case REST knows about messages the gateway never pushed.
	for _, id := range added {
		go func(id string) {
			n, err := GapFill(c.client, c.store, id, time.Now())
			if err != nil {
				log.Printf("gap fill %s: %v", id, err)
			} else if n > 0 {
				log.Printf("gap-filled %d message(s) for %s", n, id)
			}
		}(id)
	}
}

// subscribe sends the lazy-request (op 14) that a real client sends when it opens
// a guild. Without it Discord does not push MESSAGE_CREATE for that guild's
// channels, and a headless client sits connected and silent forever.
func (c *Collector) subscribe() {
	if c.conn == nil {
		return
	}
	byGuild := map[string]map[string]any{}
	for _, ch := range c.watchIDs() {
		st := c.store.State(ch)
		if st.GuildID == "" {
			info, err := c.client.ChannelInfo(ch)
			if err != nil {
				log.Printf("subscribe: resolve %s: %v", ch, err)
				continue
			}
			st.ChannelName = info.Name
			st.ChannelType = channelKind(info.Type)
			st.GuildID = info.GuildID
			st.ParentID = info.ParentID
			if st.CurrentFileStart == "" {
				st.CurrentFileStart = time.Now().In(gmt8).Format(dayLayout)
			}
			c.store.SaveState(ch, st)
		}
		if byGuild[st.GuildID] == nil {
			byGuild[st.GuildID] = map[string]any{}
		}
		byGuild[st.GuildID][ch] = []any{[]int{0, 99}}
	}
	for guild, channels := range byGuild {
		err := c.send(c.conn, map[string]any{
			"op": 14,
			"d": map[string]any{
				"guild_id":            guild,
				"typing":              true,
				"threads":             true,
				"activities":          true,
				"members":             []any{},
				"channels":            channels,
				"thread_member_lists": []any{},
			},
		})
		if err != nil {
			log.Printf("subscribe %s: %v", guild, err)
			continue
		}
		log.Printf("subscribed to guild %s (%d channel(s))", guild, len(channels))
	}
}

func (c *Collector) send(conn *websocket.Conn, v any) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	return conn.WriteJSON(v)
}

// Run reconnects forever with exponential backoff. Every failure path returns an
// error and the session cursor decides whether the next attempt resumes or
// re-identifies.
func (c *Collector) Run() {
	backoff := time.Second
	go c.flushStatesLoop()
	go c.statsLoop()
	go c.watchHeartbeatLoop()
	go c.runMaintenance()

	for {
		start := time.Now()
		err := c.connectOnce()
		if err != nil {
			log.Printf("gateway: %v", err)
		}
		if time.Since(start) > 2*time.Minute {
			backoff = time.Second // a long healthy session resets the backoff
		}
		jitter := time.Duration(rand.Int63n(int64(backoff/2 + 1)))
		wait := backoff + jitter
		log.Printf("reconnecting in %s", wait.Round(time.Millisecond))
		time.Sleep(wait)
		if backoff < time.Minute {
			backoff *= 2
			if backoff > time.Minute {
				backoff = time.Minute
			}
		}
	}
}

func (c *Collector) connectOnce() error {
	c.mu.Lock()
	resumeURL, sessionID := c.resumeURL, c.sessionID
	c.mu.Unlock()

	url := gatewayBase + gatewayQuery
	if sessionID != "" && resumeURL != "" {
		url = resumeURL + gatewayQuery
	}

	dialer := websocket.Dialer{HandshakeTimeout: 20 * time.Second}
	if sessionID != "" {
		log.Printf("connecting (resume)")
	} else {
		log.Printf("connecting")
	}
	conn, _, err := dialer.Dial(url, http.Header{"User-Agent": []string{userAgent}})
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	defer c.ready.Store(false)
	c.conn = conn

	// zlib-stream is one continuous deflate stream shared by every payload, and
	// each payload ends on a Z_SYNC_FLUSH, which is what lets the reader emit it.
	//
	// The socket pump must start before zlib.NewReader: creating the reader reads
	// the two-byte zlib header eagerly and would block forever on an empty pipe.
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			if _, err := pw.Write(data); err != nil {
				return
			}
		}
	}()

	zr, err := zlib.NewReader(pr)
	if err != nil {
		return fmt.Errorf("zlib: %w", err)
	}
	defer zr.Close()

	dec := json.NewDecoder(zr)
	var (
		hb       *time.Ticker
		hbDone   = make(chan struct{})
		interval = 45 * time.Second
		lastAck  = time.Now()
		acked    = sync.Mutex{}
	)
	defer func() {
		if hb != nil {
			hb.Stop()
		}
		close(hbDone)
	}()

	for {
		var p payload
		if err := dec.Decode(&p); err != nil {
			return fmt.Errorf("read: %w", err)
		}

		switch p.Op {
		case 10: // HELLO
			var hello struct {
				HeartbeatInterval int `json:"heartbeat_interval"`
			}
			if err := json.Unmarshal(p.D, &hello); err != nil || hello.HeartbeatInterval == 0 {
				return fmt.Errorf("bad HELLO payload")
			}
			interval = time.Duration(hello.HeartbeatInterval) * time.Millisecond
			if hb != nil {
				hb.Stop()
			}
			hb = time.NewTicker(interval)
			go c.heartbeatLoop(conn, hb.C, interval, &lastAck, &acked)

			c.mu.Lock()
			haveSession := c.sessionID != ""
			c.mu.Unlock()
			if haveSession {
				if err := c.resume(conn); err != nil {
					return err
				}
			} else if err := c.identify(conn); err != nil {
				return err
			}

		case 11: // HEARTBEAT_ACK
			acked.Lock()
			lastAck = time.Now()
			acked.Unlock()

		case 1: // server wants a heartbeat right now
			c.beat(conn)

		case 0: // dispatch
			if p.S != nil {
				c.mu.Lock()
				c.seq = *p.S
				c.mu.Unlock()
			}
			c.dispatch(p.T, p.D)

		case 7: // RECONNECT: the session is still resumable
			return fmt.Errorf("server requested reconnect")

		case 9: // INVALID_SESSION
			var resumable bool
			json.Unmarshal(p.D, &resumable)
			log.Printf("invalid session (resumable=%v)", resumable)
			time.Sleep(time.Duration(1000+rand.Intn(4000)) * time.Millisecond)
			if resumable {
				if err := c.resume(conn); err != nil {
					return err
				}
			} else {
				c.mu.Lock()
				had := c.sessionID != ""
				c.sessionID = ""
				c.seq = 0
				c.mu.Unlock()
				if had {
					c.needGapFill.Store(true)
				}
				if err := c.identify(conn); err != nil {
					return err
				}
			}
		}
	}
}

// gapFillAll closes the hole left by a resume Discord refused. Doing it after
// READY rather than before connecting means the window is only ever seconds
// wide, and anything the gateway has already stored is deduplicated on read.
func (c *Collector) gapFillAll() {
	for _, ch := range c.watchIDs() {
		n, err := GapFill(c.client, c.store, ch, time.Now())
		if err != nil {
			log.Printf("gap fill %s: %v", ch, err)
			continue
		}
		if n > 0 {
			log.Printf("gap-filled %d message(s) for %s", n, ch)
		}
	}
}

func (c *Collector) heartbeatLoop(conn *websocket.Conn, tick <-chan time.Time, interval time.Duration, lastAck *time.Time, acked *sync.Mutex) {
	for range tick {
		acked.Lock()
		dead := time.Since(*lastAck) > 2*interval
		acked.Unlock()
		if dead {
			// Zombie connection: the socket is open but Discord stopped answering.
			log.Printf("no heartbeat ack in %s, forcing reconnect", (2 * interval).Round(time.Second))
			conn.Close()
			return
		}
		if err := c.beat(conn); err != nil {
			conn.Close()
			return
		}
	}
}

func (c *Collector) beat(conn *websocket.Conn) error {
	c.mu.Lock()
	seq := c.seq
	c.mu.Unlock()
	return c.send(conn, map[string]any{"op": 1, "d": seq})
}

// identify deliberately carries no "intents" field. User accounts that send
// intents get restricted and then receive messages with an empty content, which
// silently blinds the whole collector.
func (c *Collector) identify(conn *websocket.Conn) error {
	return c.send(conn, map[string]any{
		"op": 2,
		"d": map[string]any{
			"token":        c.cfg.UserToken,
			"capabilities": 30717,
			"properties": map[string]any{
				"os":                  "Windows",
				"browser":             "Discord Client",
				"device":              "",
				"system_locale":       "zh-TW",
				"browser_user_agent":  userAgent,
				"browser_version":     clientVersion,
				"os_version":          "10",
				"referrer":            "",
				"referring_domain":    "",
				"release_channel":     "stable",
				"client_build_number": clientBuildNumber,
			},
			"presence": map[string]any{
				"status":     "online",
				"since":      0,
				"activities": []any{},
				"afk":        false,
			},
			"client_state": map[string]any{
				"guild_versions":              map[string]any{},
				"highest_last_message_id":     "0",
				"read_state_version":          0,
				"user_guild_settings_version": -1,
				"user_settings_version":       -1,
				"private_channels_version":    "0",
				"api_code_version":            0,
			},
		},
	})
}

func (c *Collector) resume(conn *websocket.Conn) error {
	c.mu.Lock()
	sessionID, seq := c.sessionID, c.seq
	c.mu.Unlock()
	log.Printf("resuming session %s at seq %d", sessionID, seq)
	return c.send(conn, map[string]any{
		"op": 6,
		"d":  map[string]any{"token": c.cfg.UserToken, "session_id": sessionID, "seq": seq},
	})
}

func (c *Collector) dispatch(event string, d json.RawMessage) {
	if debugEvents {
		log.Printf("event %s", event)
	}
	switch event {
	case "READY":
		var ready struct {
			SessionID        string  `json:"session_id"`
			ResumeGatewayURL string  `json:"resume_gateway_url"`
			User             rawUser `json:"user"`
		}
		if err := json.Unmarshal(d, &ready); err != nil {
			log.Printf("READY parse: %v", err)
			return
		}
		c.mu.Lock()
		c.sessionID = ready.SessionID
		c.resumeURL = ready.ResumeGatewayURL
		c.selfID = ready.User.ID
		c.mu.Unlock()
		c.ready.Store(true)
		c.store.SaveSession(Session{
			SessionID: ready.SessionID,
			Seq:       c.seq,
			ResumeURL: ready.ResumeGatewayURL,
			UserID:    ready.User.ID,
		})
		log.Printf("ready as %s (%s), watching %d channel(s)",
			ready.User.Username, ready.User.ID, len(c.watchIDs()))
		c.subscribe()
		if c.needGapFill.Swap(false) {
			go c.gapFillAll()
		}

	case "RESUMED":
		log.Printf("session resumed")
		c.ready.Store(true)
		c.subscribe()

	case "MESSAGE_CREATE":
		var m rawMessage
		if err := json.Unmarshal(d, &m); err != nil {
			return
		}
		if debugEvents {
			c.mu.Lock()
			c.seenChans[m.ChannelID]++
			c.mu.Unlock()
		}
		c.storeMessage(m)

	case "MESSAGE_UPDATE":
		c.updateMessage(d)

	case "MESSAGE_DELETE":
		var del struct {
			ID        string `json:"id"`
			ChannelID string `json:"channel_id"`
		}
		if json.Unmarshal(d, &del) != nil {
			return
		}
		c.deleteMessage(del.ID, del.ChannelID)

	case "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE":
		var r struct {
			UserID    string `json:"user_id"`
			ChannelID string `json:"channel_id"`
			MessageID string `json:"message_id"`
			Emoji     struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"emoji"`
		}
		if json.Unmarshal(d, &r) != nil || r.UserID == "" || r.MessageID == "" {
			return
		}
		if !c.isWatched(r.ChannelID) {
			return
		}
		kind := "add"
		if event == "MESSAGE_REACTION_REMOVE" {
			kind = "remove"
		}
		ev := ReactionEvent{
			TS:        fmtTS(time.Now()),
			ChannelID: r.ChannelID,
			MessageID: r.MessageID,
			UserID:    r.UserID,
			Emoji:     emojiKey(r.Emoji.ID, r.Emoji.Name),
			Kind:      kind,
		}
		if err := c.store.AppendReactions(r.ChannelID, []ReactionEvent{ev}); err != nil {
			log.Printf("store reaction: %v", err)
		}
	}
}

func (c *Collector) storeMessage(m rawMessage) {
	if !c.isWatched(m.ChannelID) {
		return
	}
	rec := recordFromRaw(m)
	if err := c.store.AppendMessages(m.ChannelID, []MessageRecord{rec}); err != nil {
		log.Printf("store message: %v", err)
		return
	}
	c.touch(m.ChannelID, rec.ID, rec.TS)
}

func (c *Collector) updateMessage(d json.RawMessage) {
	var u struct {
		ID              string          `json:"id"`
		ChannelID       string          `json:"channel_id"`
		GuildID         string          `json:"guild_id"`
		Content         *string         `json:"content"`
		EditedTimestamp *string         `json:"edited_timestamp"`
		Attachments     []rawAttachment `json:"attachments"`
		Embeds          []rawEmbed      `json:"embeds"`
	}
	if err := json.Unmarshal(d, &u); err != nil {
		return
	}
	if !c.isWatched(u.ChannelID) {
		return
	}
	// An update may carry only embeds (a link preview resolving later) or only
	// content (an edit). Both are appended as their own line; readers merge.
	rec := MessageRecord{
		ID:        u.ID,
		TS:        fmtTS(snowflakeTime(u.ID)),
		ChannelID: u.ChannelID,
		GuildID:   u.GuildID,
	}
	if u.Content != nil {
		rec.Content = *u.Content
	}
	rec.Attachments = convertAttachments(u.Attachments)
	rec.Embeds = convertEmbeds(u.Embeds)
	if u.EditedTimestamp != nil && *u.EditedTimestamp != "" {
		if t, err := time.Parse(time.RFC3339, *u.EditedTimestamp); err == nil {
			s := fmtTS(t)
			rec.Edited = &s
		}
	}
	if rec.Content == "" && len(rec.Attachments) == 0 && len(rec.Embeds) == 0 && rec.Edited == nil {
		return
	}
	if err := c.store.AppendMessages(u.ChannelID, []MessageRecord{rec}); err != nil {
		log.Printf("store edit: %v", err)
	}
}

// deleteMessage appends a tombstone. The original line stays where it is, so a
// deleted message keeps its content forever.
func (c *Collector) deleteMessage(id, channelID string) {
	if !c.isWatched(channelID) {
		return
	}
	rec := MessageRecord{
		ID:        id,
		TS:        fmtTS(snowflakeTime(id)),
		ChannelID: channelID,
		Deleted:   true,
	}
	if err := c.store.AppendMessages(channelID, []MessageRecord{rec}); err != nil {
		log.Printf("store delete: %v", err)
	}
}

// received counts stored messages so the operator can tell "connected but silent"
// apart from "connected and collecting".
func (c *Collector) received() int64 { return atomic.LoadInt64(&c.recv) }

func (c *Collector) touch(channelID, id, ts string) {
	atomic.AddInt64(&c.recv, 1)
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.cursors[channelID]
	if cur == nil {
		cur = &cursorState{}
		c.cursors[channelID] = cur
	}
	cur.total++
	if cur.lastID == "" || lessID(cur.lastID, id) {
		cur.lastID = id
		cur.lastTS = ts
	}
}

// flushStatesLoop persists cursors every 20s instead of on every message: the
// message data itself is already durable, so a lost cursor only costs a re-scan.
func (c *Collector) flushStatesLoop() {
	for {
		time.Sleep(20 * time.Second)
		c.FlushStates()
	}
}

func (c *Collector) statsLoop() {
	last := int64(0)
	for {
		time.Sleep(30 * time.Second)
		now := c.received()
		log.Printf("collected %d message(s) in the last 30s (total this run: %d)", now-last, now)
		last = now
		if debugEvents {
			c.mu.Lock()
			type kv struct {
				id string
				n  int
			}
			var all []kv
			for id, n := range c.seenChans {
				all = append(all, kv{id, n})
			}
			c.mu.Unlock()
			sort.Slice(all, func(i, j int) bool { return all[i].n > all[j].n })
			for i, e := range all {
				if i >= 8 {
					break
				}
				log.Printf("  seen ch=%s n=%d watched=%v", e.id, e.n, c.isWatched(e.id))
			}
		}
	}
}

func (c *Collector) FlushStates() {
	c.mu.Lock()
	snapshot := map[string]cursorState{}
	for ch, cur := range c.cursors {
		snapshot[ch] = *cur
	}
	sess := Session{SessionID: c.sessionID, Seq: c.seq, ResumeURL: c.resumeURL, UserID: c.selfID}
	c.mu.Unlock()

	c.store.SaveSession(sess)
	for ch, cur := range snapshot {
		st := c.store.State(ch)
		if st.LastID == cur.lastID && st.TotalFetched == cur.total && st.CurrentFileStart != "" {
			continue
		}
		st.LastID = cur.lastID
		st.LastTS = cur.lastTS
		st.TotalFetched = cur.total
		st.LastRun = time.Now().UTC().Format(time.RFC3339)
		if st.GuildID == "" {
			if agg, err := c.client.ChannelInfo(ch); err == nil {
				st.ChannelName = agg.Name
				st.ChannelType = channelKind(agg.Type)
				st.GuildID = agg.GuildID
				st.ParentID = agg.ParentID
			}
		}
		if st.CurrentFileStart == "" {
			st.CurrentFileStart = time.Now().In(gmt8).Format(dayLayout)
		}
		if err := c.store.SaveState(ch, st); err != nil {
			log.Printf("save state %s: %v", ch, err)
		}
	}
}

// NoteBackfill folds a history fetch into the live cursor. A backfill can reach
// messages the gateway never pushed — anything written while we were down — and
// without this the next gap fill would fetch them all over again.
func (c *Collector) NoteBackfill(channelID, id, ts string, added int) {
	if added > 0 {
		atomic.AddInt64(&c.recv, int64(added))
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	cur := c.cursors[channelID]
	if cur == nil {
		cur = &cursorState{}
		c.cursors[channelID] = cur
	}
	cur.total += added
	if id != "" && (cur.lastID == "" || lessID(cur.lastID, id)) {
		cur.lastID = id
		cur.lastTS = ts
	}
}

// --- heartbeat ---

// Heartbeat is how the dashboard tells "the collector is running" from "the
// session file exists". Without it a queued history fetch can sit in the folder
// forever while the UI shows a spinner.
type Heartbeat struct {
	PID       int    `json:"pid"`
	At        string `json:"at"`
	Channels  int    `json:"channels"`
	Received  int64  `json:"received"`
	Connected bool   `json:"connected"`
}

const heartbeatStale = 90 * time.Second

func heartbeatFile(home string) string { return filepath.Join(home, "watch.heartbeat") }

func (c *Collector) writeHeartbeat() {
	hb := Heartbeat{
		PID:       os.Getpid(),
		At:        time.Now().In(gmt8).Format(tsLayout),
		Channels:  len(c.watchIDs()),
		Received:  c.received(),
		Connected: c.ready.Load(),
	}
	raw, err := json.Marshal(hb)
	if err != nil {
		return
	}
	path := heartbeatFile(c.cfg.Home)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return
	}
	os.Rename(tmp, path)
}

// ReadHeartbeat reports the collector's last beat. A killed process leaves the
// file behind, so anything older than heartbeatStale counts as offline.
func ReadHeartbeat(home string) (Heartbeat, bool) {
	var hb Heartbeat
	raw, err := os.ReadFile(heartbeatFile(home))
	if err != nil || json.Unmarshal(raw, &hb) != nil {
		return hb, false
	}
	at, err := time.ParseInLocation(tsLayout, hb.At, gmt8)
	if err != nil || time.Since(at) > heartbeatStale {
		return hb, false
	}
	return hb, true
}

// runMaintenance is the collector's housekeeping: it ticks often enough that a
// queued history fetch starts within seconds, and it rotates once an hour. It
// replaced the rotate-only loop because the backfill queue needs a worker inside
// the process that owns the message files.
func (c *Collector) runMaintenance() {
	lastRotate := time.Now()
	for {
		if id, err := RunBackfillJobs(c.cfg.Home, c.store, c.client, c.NoteBackfill, false); err != nil {
			log.Printf("backfill: %v", err)
		} else if id != "" {
			job, _ := findJob(c.cfg.Home, id)
			log.Printf("backfill %s: %s", id, job.Message)
			// A history fetch writes into the live file; a big one would leave it
			// fat enough to slow every later read, so it is archived right away.
			if job != nil && job.Totals.Added+job.Totals.Updated >= backfillRotateAfter {
				if n, err := c.store.Rotate(); err != nil {
					log.Printf("rotate after backfill: %v", err)
				} else if n > 0 {
					log.Printf("rotated %d file(s) after backfill", n)
				}
				lastRotate = time.Now()
			}
		}

		if time.Since(lastRotate) >= time.Hour {
			if n, err := c.store.Rotate(); err != nil {
				log.Printf("rotate: %v", err)
			} else if n > 0 {
				log.Printf("rotated %d file(s)", n)
			}
			lastRotate = time.Now()
		}
		time.Sleep(backfillTick)
	}
}

// watchHeartbeatLoop emits heartbeats on an independent timer so that a long-running
// backfill job never starves the heartbeat and causes the UI to report offline.
func (c *Collector) watchHeartbeatLoop() {
	ticker := time.NewTicker(backfillTick)
	defer ticker.Stop()
	c.syncWatch()
	c.writeHeartbeat()
	for range ticker.C {
		c.syncWatch()
		c.writeHeartbeat()
	}
}

// recordFromRaw normalises a gateway message into the on-disk shape.
func recordFromRaw(m rawMessage) MessageRecord {
	author := m.Author.GlobalName
	if author == "" {
		author = m.Author.Username
	}
	rec := MessageRecord{
		ID:          m.ID,
		TS:          fmtTS(snowflakeTime(m.ID)),
		ChannelID:   m.ChannelID,
		GuildID:     m.GuildID,
		Author:      author,
		Username:    m.Author.Username,
		AuthorID:    m.Author.ID,
		Content:     m.Content,
		Attachments: convertAttachments(m.Attachments),
		Embeds:      convertEmbeds(m.Embeds),
	}
	if m.Referenced != nil {
		rec.ReplyToID = m.Referenced.ID
		rec.Reply = m.Referenced.Author.GlobalName
		if rec.Reply == "" {
			rec.Reply = m.Referenced.Author.Username
		}
		rec.ReplyUser = m.Referenced.Author.Username
	} else if m.MessageReference != nil {
		rec.ReplyToID = m.MessageReference.MessageID
	}
	for _, r := range m.Reactions {
		rec.Reactions = append(rec.Reactions, Reaction{
			Emoji: emojiKey(r.Emoji.ID, r.Emoji.Name),
			Count: r.Count,
		})
	}
	if m.EditedTimestamp != nil && *m.EditedTimestamp != "" {
		if t, err := time.Parse(time.RFC3339, *m.EditedTimestamp); err == nil {
			s := fmtTS(t)
			rec.Edited = &s
		}
	}
	return rec
}

func convertAttachments(in []rawAttachment) []Attachment {
	out := make([]Attachment, 0, len(in))
	for _, a := range in {
		if a.URL == "" {
			continue
		}
		out = append(out, Attachment{
			Filename: a.Filename,
			URL:      a.URL,
			Type:     a.ContentType,
			Width:    a.Width,
			Height:   a.Height,
			Size:     a.Size,
		})
	}
	return out
}

func convertEmbeds(in []rawEmbed) []Embed {
	out := make([]Embed, 0, len(in))
	for _, e := range in {
		emb := Embed{Title: e.Title, Desc: e.Description, URL: e.URL}
		if e.Image != nil {
			emb.Image = e.Image.URL
		} else if e.Thumbnail != nil {
			emb.Image = e.Thumbnail.URL
		}
		if emb.Title == "" && emb.Desc == "" && emb.URL == "" && emb.Image == "" {
			continue
		}
		out = append(out, emb)
	}
	return out
}

// emojiKey renders a custom emoji as <:name:id> and a unicode one as itself.
func emojiKey(id, name string) string {
	if id == "" {
		return name
	}
	return fmt.Sprintf("<:%s:%s>", name, id)
}
