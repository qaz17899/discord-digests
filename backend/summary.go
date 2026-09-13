package main

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ChannelSummary is everything the workbench can say about one channel over one
// date range without shipping the messages themselves. The status wall reads it
// for every channel; the channel view reads it and fetches the messages too.
type ChannelSummary struct {
	ChannelID string `json:"channelId"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	GuildID   string `json:"guildId"`
	Watching  bool   `json:"watching"`

	From string `json:"from"`
	To   string `json:"to"`

	Count     int `json:"count"`
	PrevCount int `json:"prevCount"`
	Authors   int `json:"authors"`
	Media     int `json:"media"`
	Reactions int `json:"reactions"`
	Links     int `json:"links"`

	Hourly          []int  `json:"hourly"`
	PeakHour        int    `json:"peakHour"`
	ColdHour        int    `json:"coldHour"`
	PeakMinute      string `json:"peakMinute"`
	PeakMinuteCount int    `json:"peakMinuteCount"`

	TopAuthors []map[string]any `json:"topAuthors"`
	TopReplied []map[string]any `json:"topReplied"`
	TopReacted []map[string]any `json:"topReacted"`
	TopDomains []map[string]any `json:"topDomains"`

	Events []EventSignal `json:"events"`

	Report      string `json:"report"`      // report file name, "" when there is none
	ReportInput string `json:"reportInput"` // prepared input file name, "" when there is none

	FirstTS string `json:"firstTs"`
	LastTS  string `json:"lastTs"`
}

type cachedSummary struct {
	at  time.Time
	sum *ChannelSummary
}

const summaryTTL = 3 * time.Second

func (s *Server) summaryFor(channelID, fromDay, toDay string, refresh bool) (*ChannelSummary, error) {
	key := channelID + "|" + fromDay + "|" + toDay
	if !refresh {
		s.cacheMu.Lock()
		c, ok := s.cache[key]
		s.cacheMu.Unlock()
		if ok && time.Since(c.at) < summaryTTL {
			return c.sum, nil
		}
	}
	sum, err := s.buildSummary(channelID, fromDay, toDay)
	if err != nil {
		return nil, err
	}
	s.cacheMu.Lock()
	if s.cache == nil {
		s.cache = map[string]cachedSummary{}
	}
	s.cache[key] = cachedSummary{at: time.Now(), sum: sum}
	s.cacheMu.Unlock()
	return sum, nil
}

func (s *Server) buildSummary(channelID, fromDay, toDay string) (*ChannelSummary, error) {
	recs, err := s.store.LoadRangeWithReactions(channelID, fromDay, toDay)
	if err != nil {
		return nil, err
	}
	prevFrom, prevTo, err := previousSpan(fromDay, toDay)
	if err != nil {
		return nil, err
	}
	prev, err := s.store.LoadRange(channelID, prevFrom, prevTo)
	if err != nil {
		return nil, err
	}

	st := s.store.State(channelID)
	name := st.ChannelName
	if name == "" {
		name = channelID
	}
	sum := &ChannelSummary{
		ChannelID: channelID, Name: name, Type: st.ChannelType, GuildID: st.GuildID,
		Watching: s.watching(channelID), From: fromDay, To: toDay,
		Count: len(recs), PrevCount: len(prev),
		Hourly: make([]int, 24),
	}
	sum.Report, sum.ReportInput = s.findReport(channelID, fromDay)

	minute := make([]int, 1440)
	authors := map[string]int{}
	replied := map[string]int{}
	reacted := map[string]int{}
	domains := map[string]int{}
	seenAuthors := map[string]struct{}{}

	for i := range recs {
		r := &recs[i]
		if m, ok := minuteOfTS(r.TS); ok {
			sum.Hourly[m/60]++
			minute[m]++
		}
		authors[r.Author]++
		seenAuthors[r.Author] = struct{}{}
		if r.Reply != "" {
			replied[r.Reply]++
		} else if r.ReplyUser != "" {
			replied[r.ReplyUser]++
		}
		n := reactionTotal(*r)
		if n > 0 {
			reacted[r.Author] += n
			sum.Reactions += n
		}
		sum.Media += len(r.Attachments)
		for _, u := range urlsIn(*r) {
			sum.Links++
			if parsed, err := url.Parse(u); err == nil && parsed.Host != "" {
				domains[parsed.Host]++
			}
		}
		if sum.FirstTS == "" {
			sum.FirstTS = r.TS
		}
		sum.LastTS = r.TS
	}

	sum.Authors = len(seenAuthors)
	sum.TopAuthors = topN(authors, 12)
	sum.TopReplied = topN(replied, 12)
	sum.TopReacted = topN(reacted, 12)
	sum.TopDomains = topN(domains, 12)

	// Peak and cold hour are only meaningful over the hours that had traffic;
	// an empty hour is the coldest by definition only if the day is complete.
	peakHour, coldHour := 0, 0
	for h := 1; h < 24; h++ {
		if sum.Hourly[h] > sum.Hourly[peakHour] {
			peakHour = h
		}
		if sum.Hourly[h] < sum.Hourly[coldHour] {
			coldHour = h
		}
	}
	sum.PeakHour, sum.ColdHour = peakHour, coldHour

	peakMin, peakCount := 0, 0
	for m, n := range minute {
		if n > peakCount {
			peakMin, peakCount = m, n
		}
	}
	sum.PeakMinuteCount = peakCount
	sum.PeakMinute = fmt.Sprintf("%02d:%02d", peakMin/60, peakMin%60)

	sum.Events = BuildEvents(recs)
	if sum.Events == nil {
		sum.Events = []EventSignal{}
	}
	return sum, nil
}

// previousSpan is the range immediately before fromDay..toDay with the same
// length, so a ratio always compares like with like.
func previousSpan(fromDay, toDay string) (string, string, error) {
	from, err := time.ParseInLocation(dayLayout, fromDay, gmt8)
	if err != nil {
		return "", "", err
	}
	to, err := time.ParseInLocation(dayLayout, toDay, gmt8)
	if err != nil {
		return "", "", err
	}
	span := to.Sub(from) + 24*time.Hour
	return from.Add(-span).Format(dayLayout), from.Add(-24 * time.Hour).Format(dayLayout), nil
}

// findReport looks for a report covering the first day of the range. A report
// that was generated for a wider range still covers that day, so the name only
// has to start with the channel and the day.
func (s *Server) findReport(channelID, fromDay string) (report, input string) {
	entries, err := os.ReadDir(filepath.Join(s.cfg.Home, "reports"))
	if err != nil {
		return "", ""
	}
	prefix := channelID + "-" + fromDay
	for _, e := range entries {
		name := e.Name()
		if !strings.HasPrefix(name, prefix) {
			continue
		}
		switch {
		case strings.HasSuffix(name, ".md"):
			// The exact day wins over a range that happens to cover it.
			if name == prefix+".md" {
				return name, input
			}
			if report == "" {
				report = name
			}
		case strings.HasSuffix(name, ".input.txt"):
			if input == "" || name == prefix+".input.txt" {
				input = name
			}
		}
	}
	return report, input
}
