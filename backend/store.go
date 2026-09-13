package main

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	tsLayout    = "2006-01-02 15:04:05"
	dayLayout   = "2006-01-02"
	discordUnix = 1420070400000
)

var gmt8 = time.FixedZone("GMT+8", 8*3600)

type Attachment struct {
	Filename string `json:"filename"`
	URL      string `json:"url"`
	Type     string `json:"type,omitempty"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
	Size     int    `json:"size,omitempty"`
}

type Embed struct {
	Title string `json:"title,omitempty"`
	Desc  string `json:"desc,omitempty"`
	URL   string `json:"url,omitempty"`
	Image string `json:"image,omitempty"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
}

// MessageRecord is one line of all.jsonl.
// A message is never rewritten. Every state change appends a new line with the
// same id:
//   - create carries content/attachments/embeds
//   - edit carries the new content plus edited
//   - delete carries deleted:true and nothing else
//   - full:true marks a message body a history fetch just read from the API
//
// Readers merge by id, newest field wins, deleted is sticky. Append-only is what
// makes crash recovery free and what makes a delete un-losable.
type MessageRecord struct {
	ID          string       `json:"id"`
	TS          string       `json:"ts"`
	ChannelID   string       `json:"channel"`
	GuildID     string       `json:"guild,omitempty"`
	Author      string       `json:"author"`
	Username    string       `json:"username,omitempty"`
	AuthorID    string       `json:"author_id,omitempty"`
	Content     string       `json:"content"`
	Reply       string       `json:"reply,omitempty"`
	ReplyUser   string       `json:"reply_username,omitempty"`
	ReplyToID   string       `json:"reply_to_id,omitempty"`
	Attachments []Attachment `json:"attachments,omitempty"`
	Embeds      []Embed      `json:"embeds,omitempty"`
	Reactions   []Reaction   `json:"reactions,omitempty"`
	Edited      *string      `json:"edited,omitempty"`
	Deleted     bool         `json:"deleted,omitempty"`
	// Full marks a complete, authoritative copy of the message. History fetches
	// write it so a real change (an edit, a cleared body, a late embed) replaces
	// the whole record instead of being merged field-by-field, where an empty
	// string means "nothing to say" and would leave the stale text in place.
	Full bool `json:"full,omitempty"`
}

// ReactionEvent is one line of all.reactions.jsonl. Counts on the message record
// are a snapshot; this log is the truth about who reacted, when.
type ReactionEvent struct {
	TS        string `json:"ts"`
	ChannelID string `json:"channel"`
	MessageID string `json:"msg"`
	UserID    string `json:"user"`
	Emoji     string `json:"emoji"`
	Kind      string `json:"t"` // add | remove
}

// State is the per-channel cursor. lastId is the highest message id ever seen.
type State struct {
	LastID           string `json:"lastId"`
	LastTS           string `json:"lastTs"`
	TotalFetched     int    `json:"totalFetched"`
	LastRun          string `json:"lastRun"`
	ChannelName      string `json:"channelName,omitempty"`
	ChannelType      string `json:"channelType,omitempty"`
	GuildID          string `json:"guildId,omitempty"`
	ParentID         string `json:"parentId,omitempty"`
	CurrentFileStart string `json:"currentFileStart,omitempty"`
	Archived         int    `json:"archived,omitempty"`
}

// Session is the gateway resume cursor. Global, not per channel.
type Session struct {
	SessionID string `json:"sessionId"`
	Seq       int64  `json:"seq"`
	ResumeURL string `json:"resumeUrl"`
	UserID    string `json:"userId"`
}

type Store struct {
	home string
	mu   sync.Mutex
	open map[string]*os.File
}

func NewStore(home string) *Store {
	return &Store{home: home, open: map[string]*os.File{}}
}

func (s *Store) channelDir(channelID string) string {
	return filepath.Join(s.home, "raw", channelID)
}

func (s *Store) liveFile(channelID string) string {
	return filepath.Join(s.channelDir(channelID), "all.jsonl")
}

func (s *Store) liveReactionFile(channelID string) string {
	return filepath.Join(s.channelDir(channelID), "all.reactions.jsonl")
}

func (s *Store) AppendMessages(channelID string, recs []MessageRecord) error {
	sort.SliceStable(recs, func(i, j int) bool { return lessID(recs[i].ID, recs[j].ID) })
	path := s.liveFile(channelID)
	for _, r := range recs {
		if err := s.appendJSON(path, r); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) AppendReactions(channelID string, evs []ReactionEvent) error {
	path := s.liveReactionFile(channelID)
	for _, e := range evs {
		if err := s.appendJSON(path, e); err != nil {
			return err
		}
	}
	return nil
}

// appendJSON keeps one open handle per file and writes unbuffered, so killing
// the process loses at most the single line being written.
func (s *Store) appendJSON(path string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')

	s.mu.Lock()
	defer s.mu.Unlock()

	f, ok := s.open[path]
	if !ok {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		f, err = os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			return err
		}
		s.open[path] = f
	}
	_, err = f.Write(raw)
	return err
}

func (s *Store) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for path, f := range s.open {
		f.Close()
		delete(s.open, path)
	}
}

func (s *Store) closePath(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if f, ok := s.open[path]; ok {
		f.Close()
		delete(s.open, path)
	}
}

// LoadRange merges the live file and every overlapping archive, then keeps the
// messages whose GMT+8 day falls inside [from, to]. Empty strings mean "open end".
func (s *Store) LoadRange(channelID, from, to string) ([]MessageRecord, error) {
	order := []string{}
	byID := map[string]*MessageRecord{}

	scan := func(path string, gzipped bool) error {
		return s.scanLines(path, gzipped, func(line []byte) {
			var r MessageRecord
			if json.Unmarshal(line, &r) != nil {
				return
			}
			merge(&order, byID, r)
		})
	}

	for _, a := range s.archives(channelID) {
		if to != "" && a.first > to {
			continue
		}
		if from != "" && a.last < from {
			continue
		}
		if err := scan(a.path, true); err != nil {
			return nil, err
		}
	}
	if err := scan(s.liveFile(channelID), false); err != nil {
		return nil, err
	}

	out := make([]MessageRecord, 0, len(order))
	for _, id := range order {
		r := byID[id]
		day := gmt8DayOf(r.TS)
		if from != "" && day < from {
			continue
		}
		if to != "" && day > to {
			continue
		}
		out = append(out, *r)
	}
	sort.SliceStable(out, func(i, j int) bool { return lessID(out[i].ID, out[j].ID) })
	return out, nil
}

func merge(order *[]string, byID map[string]*MessageRecord, in MessageRecord) {
	prev, ok := byID[in.ID]
	if !ok {
		copied := in
		byID[in.ID] = &copied
		*order = append(*order, in.ID)
		return
	}
	// A history fetch read the message whole, so an empty field really means
	// empty. Replace, do not merge — otherwise an edit that deleted the text
	// would keep the old text forever. The tombstone flag stays sticky either way.
	if in.Full {
		sticky := prev.Deleted || in.Deleted
		*prev = in
		prev.Deleted = sticky
		return
	}
	// Field-wise so that an embed-only update never wipes the text, and a
	// tombstone (which carries nothing but the id) never wipes anything.
	if in.Content != "" {
		prev.Content = in.Content
	}
	if len(in.Attachments) > 0 {
		prev.Attachments = in.Attachments
	}
	if len(in.Embeds) > 0 {
		prev.Embeds = in.Embeds
	}
	if len(in.Reactions) > 0 {
		prev.Reactions = in.Reactions
	}
	if in.Edited != nil {
		prev.Edited = in.Edited
	}
	if in.ReplyToID != "" {
		prev.ReplyToID = in.ReplyToID
		prev.Reply = in.Reply
		prev.ReplyUser = in.ReplyUser
	}
	prev.Deleted = prev.Deleted || in.Deleted
}

// ReactionTally replays the reaction log into per-message counts. Reaction
// counts that arrived before the collector started are missing, so the message
// record's own snapshot is used as the baseline by callers when they need it.
// LoadRangeWithReactions loads a range and overlays the reaction log, which is
// more current than the snapshot each message carried when it was first seen.
// A missing reaction log is not an error: the snapshot is all there is.
func (s *Store) LoadRangeWithReactions(channelID, fromDay, toDay string) ([]MessageRecord, error) {
	recs, err := s.LoadRange(channelID, fromDay, toDay)
	if err != nil {
		return nil, err
	}
	tally, err := s.ReactionTally(channelID)
	if err != nil {
		return recs, nil
	}
	for i := range recs {
		counts := tally[recs[i].ID]
		if len(counts) == 0 {
			continue
		}
		merged := map[string]int{}
		for _, x := range recs[i].Reactions {
			merged[x.Emoji] = x.Count
		}
		for emoji, n := range counts {
			merged[emoji] += n
		}
		recs[i].Reactions = recs[i].Reactions[:0]
		for emoji, n := range merged {
			if n > 0 {
				recs[i].Reactions = append(recs[i].Reactions, Reaction{Emoji: emoji, Count: n})
			}
		}
	}
	return recs, nil
}

func (s *Store) ReactionTally(channelID string) (map[string]map[string]int, error) {
	tally := map[string]map[string]int{}
	apply := func(line []byte) {
		var ev ReactionEvent
		if json.Unmarshal(line, &ev) != nil {
			return
		}
		if tally[ev.MessageID] == nil {
			tally[ev.MessageID] = map[string]int{}
		}
		if ev.Kind == "add" {
			tally[ev.MessageID][ev.Emoji]++
		} else if tally[ev.MessageID][ev.Emoji] > 0 {
			tally[ev.MessageID][ev.Emoji]--
		}
	}
	for _, a := range s.archives(channelID) {
		if strings.Contains(filepath.Base(a.path), "reactions") {
			if err := s.scanLines(a.path, true, apply); err != nil {
				return nil, err
			}
		}
	}
	if err := s.scanLines(s.liveReactionFile(channelID), false, apply); err != nil {
		return nil, err
	}
	return tally, nil
}

type archiveRange struct {
	path        string
	first, last string
}

// archives lists gzipped archives, parsing the <first>_<last> day range out of
// the filename so a range query can skip non-overlapping files.
func (s *Store) archives(channelID string) []archiveRange {
	dir := filepath.Join(s.channelDir(channelID), "archive")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []archiveRange
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".jsonl.gz") || strings.Contains(name, ".reactions.") {
			continue
		}
		stem := strings.TrimSuffix(name, ".jsonl.gz")
		first, last, ok := strings.Cut(stem, "_")
		if !ok || len(first) != len(dayLayout) || len(last) != len(dayLayout) {
			continue
		}
		out = append(out, archiveRange{path: filepath.Join(dir, name), first: first, last: last})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].first < out[j].first })
	return out
}

func (s *Store) scanLines(path string, gzipped bool, fn func([]byte)) error {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	defer f.Close()

	var r io.Reader = f
	if gzipped {
		zr, err := gzip.NewReader(f)
		if err != nil {
			// A half-written archive is not worth crashing over; skip it.
			return nil
		}
		defer zr.Close()
		r = zr
	}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 256*1024), 32*1024*1024)
	for sc.Scan() {
		if len(sc.Bytes()) > 0 {
			fn(sc.Bytes())
		}
	}
	return sc.Err()
}

func (s *Store) Channels() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.home, "raw"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out, nil
}

func (s *Store) State(channelID string) State {
	var st State
	if raw, err := os.ReadFile(filepath.Join(s.channelDir(channelID), "_state.json")); err == nil {
		json.Unmarshal(raw, &st)
	}
	return st
}

func (s *Store) SaveState(channelID string, st State) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	dir := s.channelDir(channelID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp := filepath.Join(dir, "_state.json.tmp")
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "_state.json"))
}

func (s *Store) Session() Session {
	var sess Session
	if raw, err := os.ReadFile(filepath.Join(s.home, "gateway.json")); err == nil {
		json.Unmarshal(raw, &sess)
	}
	return sess
}

func (s *Store) SaveSession(sess Session) error {
	raw, err := json.MarshalIndent(sess, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.home, "gateway.json.tmp")
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(s.home, "gateway.json"))
}

// Rotate gzips each channel's live file into archive/<first>_<last>.jsonl.gz and
// starts a fresh live file. Rotating whole files (rather than slicing by day) is
// what keeps deletes appendable: a tombstone always lands in the live file.
func (s *Store) Rotate() (int, error) {
	channels, err := s.Channels()
	if err != nil {
		return 0, err
	}
	today := time.Now().In(gmt8).Format(dayLayout)
	rotated := 0
	for _, ch := range channels {
		st := s.State(ch)
		if st.CurrentFileStart == "" || st.CurrentFileStart >= today {
			continue
		}
		for _, pair := range [][2]string{
			{s.liveFile(ch), "jsonl.gz"},
			{s.liveReactionFile(ch), "reactions.jsonl.gz"},
		} {
			live, suffix := pair[0], pair[1]
			if _, err := os.Stat(live); err != nil {
				continue
			}
			s.closePath(live)

			first, last, err := s.fileDaySpan(live)
			if err != nil || first == "" {
				continue
			}
			dst := filepath.Join(s.channelDir(ch), "archive", first+"_"+last+"."+suffix)
			if err := gzipInto(live, dst); err != nil {
				return rotated, err
			}
			if err := os.Remove(live); err != nil {
				return rotated, err
			}
			rotated++
		}
		st.CurrentFileStart = today
		st.Archived++
		s.SaveState(ch, st)
	}
	return rotated, nil
}

// fileDaySpan reads the first and last line's day from a jsonl file.
func (s *Store) fileDaySpan(path string) (string, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 32*1024*1024)
	first, last := "", ""
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) < 20 {
			continue
		}
		var probe struct {
			TS string `json:"ts"`
		}
		if json.Unmarshal(line, &probe) != nil || len(probe.TS) < 10 {
			continue
		}
		if first == "" {
			first = probe.TS[:10]
		}
		last = probe.TS[:10]
	}
	return first, last, sc.Err()
}

func gzipInto(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := dst + ".tmp"
	out, err := os.Create(tmp)
	if err != nil {
		return err
	}
	zw, err := gzip.NewWriterLevel(out, gzip.BestCompression)
	if err != nil {
		out.Close()
		return err
	}
	if _, err := io.Copy(zw, in); err != nil {
		zw.Close()
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := zw.Close(); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, dst)
}

// --- time and id helpers ---

func snowflakeTime(id string) time.Time {
	n, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		return time.Now().In(gmt8)
	}
	return time.UnixMilli(int64(n>>22) + discordUnix).In(gmt8)
}

func fmtTS(t time.Time) string { return t.In(gmt8).Format(tsLayout) }

func gmt8DayOf(ts string) string {
	if len(ts) >= 10 {
		return ts[:10]
	}
	return time.Now().In(gmt8).Format(dayLayout)
}

func lessID(a, b string) bool {
	na, ea := strconv.ParseUint(a, 10, 64)
	nb, eb := strconv.ParseUint(b, 10, 64)
	if ea != nil || eb != nil {
		return a < b
	}
	return na < nb
}

func parseDay(s string) (time.Time, error) {
	return time.ParseInLocation(dayLayout, s, gmt8)
}

// parseWhen accepts a day, a "YYYY-MM-DDTHH:MM" local timestamp, or RFC3339.
func parseWhen(s string) (time.Time, error) {
	if t, err := time.ParseInLocation(tsLayout, s, gmt8); err == nil {
		return t, nil
	}
	if t, err := time.ParseInLocation("2006-01-02T15:04", s, gmt8); err == nil {
		return t, nil
	}
	if t, err := time.ParseInLocation(dayLayout, s, gmt8); err == nil {
		return t, nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, nil
	}
	return time.Time{}, fmt.Errorf("cannot parse %q (want YYYY-MM-DD, YYYY-MM-DDTHH:MM, or RFC3339)", s)
}

// dirSize sums the size of every regular file under root.
func dirSize(root string) int64 {
	var total int64
	filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && info != nil && info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total
}
