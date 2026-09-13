package main

import (
	"errors"
	"fmt"
	"hash/fnv"
	"strconv"
	"time"
)

// errCancelled ends a fetch without recording an error: the operator asked for it.
var errCancelled = errors.New("cancelled")

// A snowflake is (ms << 22) | (worker << 17) | (process << 12) | increment, so a
// timestamp converted to an id pins the millisecond and nothing finer: every
// message inside that millisecond is a larger number. Comparing milliseconds —
// what this file used to do — therefore loses the later messages of a
// millisecond. These two helpers turn a clock range into an exact id range.
func snowflakeAt(t time.Time) uint64 {
	ms := t.UnixMilli() - discordUnix
	if ms < 0 {
		return 0
	}
	return uint64(ms) << 22
}

// snowflakeCeil is the highest id that can carry timestamp t. Because `before` is
// exclusive, passing it includes every message of t's millisecond.
func snowflakeCeil(t time.Time) uint64 { return snowflakeAt(t) | (1<<22 - 1) }

// snowflakeFloor is the lowest id that can carry timestamp t.
func snowflakeFloor(t time.Time) uint64 { return snowflakeAt(t) }

func parseSnow(id string) uint64 {
	n, err := strconv.ParseUint(id, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

// idRange is an inclusive snowflake window. Ids are the only exact unit here:
// converting a clock instant to an id always lands on the first message of that
// millisecond, never inside a message.
type idRange struct{ floor, ceil uint64 }

// versionKey fingerprints the fields a history fetch can legitimately change.
//
// Attachment and embed *urls* are deliberately not part of it: Discord hands out
// CDN links with a fresh signature every time, so including them would call every
// message with an image "changed" on every run and rewrite the whole day.
// Filenames, embed titles and counts still catch a real difference.
func versionKey(r MessageRecord) uint64 {
	h := fnv.New64a()
	part := func(s string) {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	part(r.Content)
	if r.Edited != nil {
		part(*r.Edited)
	}
	part(r.ReplyToID)
	for _, a := range r.Attachments {
		part(a.Filename)
	}
	for _, e := range r.Embeds {
		part(e.Title)
		part(e.Desc)
		part(e.URL)
	}
	return h.Sum64()
}

// BackfillStats is what one window cost and what it changed.
type BackfillStats struct {
	Pages   int
	Seen    int
	Added   int
	Updated int
	Skipped int
	Newest  string
	Oldest  string
}

// BackfillOpts tunes one window fetch. The zero value is what you want.
type BackfillOpts struct {
	PageSize int
	Pause    time.Duration
	// OnPage runs after every stored page. Returning false stops the fetch; that
	// is also how cancellation works, so there is exactly one exit path.
	OnPage func(BackfillStats) bool
}

// backfillRange walks down from the top of the window with `before`, writing only
// the messages that are missing locally or whose content differs.
//
// `before` is the only direction that can start *inside* a window. `after` needs a
// seed id, and a time-derived seed is a guess: it lands on the first message of a
// millisecond at best, and in a quiet channel it lands minutes away from anything.
// Walking down from an exact upper bound has no such hole.
//
// local maps message id → fingerprint of the copy on disk; tally is the channel's
// reaction log (see Store.ReactionTally). Both may be nil, which treats every
// message as new.
func backfillRange(client *Client, store *Store, channelID string, r idRange, local map[string]uint64, tally map[string]map[string]int, opts BackfillOpts) (BackfillStats, error) {
	var st BackfillStats
	pageSize := opts.PageSize
	if pageSize <= 0 || pageSize > 100 {
		pageSize = 100
	}
	cursor := strconv.FormatUint(r.ceil, 10)

	for page := 0; ; page++ {
		msgs, err := client.Messages(channelID, "", cursor, pageSize)
		if err != nil {
			return st, fmt.Errorf("page %d: %w", page, err)
		}
		if len(msgs) == 0 {
			break
		}
		st.Pages++

		batch := make([]MessageRecord, 0, len(msgs))
		for _, m := range msgs {
			if parseSnow(m.ID) < r.floor {
				continue
			}
			st.Seen++
			rec := recordFromRaw(m)
			rec.Full = true
			if have, known := local[m.ID]; known {
				if have == versionKey(rec) {
					st.Skipped++
					continue
				}
				st.Updated++
			} else {
				st.Added++
			}
			// The reaction log owns the counts of messages it has seen; writing
			// the REST snapshot on top of it would double every count on read.
			if tally[m.ID] != nil {
				rec.Reactions = nil
			}
			batch = append(batch, rec)
			if st.Newest == "" || lessID(st.Newest, m.ID) {
				st.Newest = m.ID
			}
			if st.Oldest == "" || lessID(m.ID, st.Oldest) {
				st.Oldest = m.ID
			}
		}
		if len(batch) > 0 {
			if err := store.AppendMessages(channelID, batch); err != nil {
				return st, err
			}
		}

		if opts.OnPage != nil && !opts.OnPage(st) {
			return st, errCancelled
		}
		// The page is newest-first, so its tail is the oldest id we have seen. A
		// page shorter than the limit means the channel itself ran out.
		tail := msgs[len(msgs)-1]
		if parseSnow(tail.ID) <= r.floor || len(msgs) < pageSize {
			break
		}
		cursor = tail.ID
		if opts.Pause > 0 {
			time.Sleep(opts.Pause)
		}
	}
	return st, nil
}

// BackfillWindow fetches everything whose timestamp lands inside [from, to] — both
// ends included, to the millisecond — and writes only what is new or different.
func BackfillWindow(client *Client, store *Store, channelID string, from, to time.Time, local map[string]uint64, tally map[string]map[string]int, opts BackfillOpts) (BackfillStats, error) {
	return backfillRange(client, store, channelID, idRange{snowflakeFloor(from), snowflakeCeil(to)}, local, tally, opts)
}

// GapFill closes the hole left by a restart: everything newer than the stored
// cursor. The window is normally minutes wide, so this is a couple of requests.
func GapFill(client *Client, store *Store, channelID string, now time.Time) (int, error) {
	st := store.State(channelID)
	if st.LastID == "" {
		return 0, nil
	}
	// +1 because the cursor message itself is already on disk. Comparing ids
	// rather than milliseconds is what keeps a second message from the same
	// millisecond from being thrown away.
	res, err := backfillRange(client, store, channelID, idRange{parseSnow(st.LastID) + 1, snowflakeCeil(now)}, nil, nil, BackfillOpts{})
	if err != nil {
		return res.Added, err
	}
	if res.Added > 0 {
		st.LastID = res.Newest
		st.LastTS = fmtTS(snowflakeTime(res.Newest))
		st.TotalFetched += res.Added
		st.LastRun = time.Now().UTC().Format(time.RFC3339)
		if st.CurrentFileStart == "" {
			st.CurrentFileStart = time.Now().In(gmt8).Format(dayLayout)
		}
		if err := store.SaveState(channelID, st); err != nil {
			return res.Added, err
		}
	}
	return res.Added, nil
}
