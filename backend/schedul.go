package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// The scheduler is the one thing in `serve` that acts on its own. It summarizes
// whole days on a timer, writes the reports where the dashboard already looks
// for them, and keeps a small state file so a restart does not re-spend tokens
// on a run that already happened.
const (
	defaultScheduleTime = "08:30"
	scheduleStateFile   = "schedule.json"
	scheduleTickEvery   = 30 * time.Second
	maxScheduledRun     = 12 // channels per tick; a day summary should not run for hours
)

type scheduleState struct {
	// LastRun maps "<day offset>|<channel>" to the last completion instant, so
	// "already done today" survives a restart.
	LastRun  map[string]string `json:"lastRun"`
	LastNote string            `json:"lastNote,omitempty"`
}

func (s *Server) schedulePath() string { return filepath.Join(s.cfg.Home, scheduleStateFile) }

func (s *Server) loadScheduleState() scheduleState {
	st := scheduleState{LastRun: map[string]string{}}
	raw, err := os.ReadFile(s.schedulePath())
	if err != nil {
		return st
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		log.Printf("schedule: ignoring unreadable %s: %v", scheduleStateFile, err)
		return scheduleState{LastRun: map[string]string{}}
	}
	if st.LastRun == nil {
		st.LastRun = map[string]string{}
	}
	return st
}

func (s *Server) saveScheduleState(st scheduleState) {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		log.Printf("schedule: encode state: %v", err)
		return
	}
	tmp := s.schedulePath() + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o600); err != nil {
		log.Printf("schedule: write state: %v", err)
		return
	}
	if err := os.Rename(tmp, s.schedulePath()); err != nil {
		log.Printf("schedule: write state: %v", err)
	}
}

// startScheduler ticks forever, comparing the wall clock against the configured
// run time. Nothing else in the process writes reports on its own.
func (s *Server) startScheduler() {
	go func() {
		for {
			s.runScheduledDigests(time.Now().In(gmt8))
			time.Sleep(scheduleTickEvery)
		}
	}()
}

// runScheduledDigests starts a run when the clock has passed the configured time
// and this day has not been done yet.
func (s *Server) runScheduledDigests(now time.Time) {
	sch := s.currentSchedule()
	if !sch.Enabled {
		return
	}
	if sch.WeekdaysOnly && (now.Weekday() == time.Saturday || now.Weekday() == time.Sunday) {
		return
	}
	due, ok := scheduleDueAt(sch, now)
	if !ok || now.Before(due) {
		return
	}

	targets := sch.Targets
	if len(targets) == 0 {
		s.cfgMu.RLock()
		targets = append(targets, s.cfg.Settings.Watch...)
		s.cfgMu.RUnlock()
	}
	if len(targets) == 0 {
		return
	}

	day := now.AddDate(0, 0, -sch.OffsetDays).Format(dayLayout)
	state := s.loadScheduleState()
	started := 0
	for _, id := range targets {
		if started >= maxScheduledRun {
			break
		}
		key := day + "|" + id
		if _, done := state.LastRun[key]; done {
			continue
		}
		// A run that would overwrite an existing report of the same range is
		// pointless; record it as done instead.
		if reportExists(s.cfg.Home, id, day) {
			state.LastRun[key] = "skipped:report-exists"
			continue
		}
		if _, err := s.startDigest(id, dayStart(day), dayEnd(day)); err != nil {
			log.Printf("schedule: %s %s: %v", id, day, err)
			state.LastRun[key] = "error:" + err.Error()
			continue
		}
		state.LastRun[key] = now.Format(tsLayout)
		state.LastNote = fmt.Sprintf("%s 排程摘要 %s", now.Format(tsLayout), day)
		started++
		log.Printf("schedule: started digest for %s %s", id, day)
	}
	if started > 0 || len(state.LastRun) > 0 {
		s.saveScheduleState(state)
	}
}

// scheduleDueAt is the moment today's run becomes due.
func scheduleDueAt(sch Schedule, now time.Time) (time.Time, bool) {
	switch sch.Mode {
	case "interval":
		hours := sch.IntervalH
		if hours <= 0 {
			hours = 6
		}
		// Interval mode fires on the hour boundaries that divide the day.
		due := time.Date(now.Year(), now.Month(), now.Day(), (now.Hour()/hours)*hours, 0, 0, 0, gmt8)
		return due, true
	default:
		hh, mm, err := parseClock(sch.Time)
		if err != nil {
			return time.Time{}, false
		}
		return time.Date(now.Year(), now.Month(), now.Day(), hh, mm, 0, 0, gmt8), true
	}
}

func parseClock(v string) (int, int, error) {
	var hh, mm int
	if _, err := fmt.Sscanf(strings.TrimSpace(v), "%d:%d", &hh, &mm); err != nil {
		return 0, 0, fmt.Errorf("time must look like HH:MM, got %q", v)
	}
	if hh < 0 || hh > 23 || mm < 0 || mm > 59 {
		return 0, 0, fmt.Errorf("time out of range: %q", v)
	}
	return hh, mm, nil
}

func reportExists(home, channelID, day string) bool {
	_, err := os.Stat(filepath.Join(home, "reports", channelID+"-"+day+".md"))
	return err == nil
}

func dayStart(day string) time.Time {
	t, _ := time.ParseInLocation(dayLayout, day, gmt8)
	return t
}

func dayEnd(day string) time.Time {
	return dayStart(day).Add(24*time.Hour - time.Second)
}

func (s *Server) currentSchedule() Schedule {
	s.cfgMu.RLock()
	defer s.cfgMu.RUnlock()
	return s.cfg.Settings.Schedule
}

// nextRunAt is what the dashboard shows as "下次執行".
func nextRunAt(sch Schedule, now time.Time) string {
	if !sch.Enabled {
		return ""
	}
	due, ok := scheduleDueAt(sch, now)
	if !ok {
		return ""
	}
	for i := 0; i < 8; i++ {
		candidate := due.AddDate(0, 0, i)
		if sch.Mode == "interval" {
			candidate = due.Add(time.Duration(i) * time.Duration(sch.IntervalH) * time.Hour)
		}
		if candidate.After(now) {
			if sch.WeekdaysOnly && (candidate.Weekday() == time.Saturday || candidate.Weekday() == time.Sunday) {
				continue
			}
			return candidate.Format(tsLayout)
		}
	}
	return ""
}

// handleSchedule returns the schedule plus what the timer has actually done.
func (s *Server) handleSchedule(w http.ResponseWriter, r *http.Request) {
	s.cfgMu.RLock()
	sch := s.cfg.Settings.Schedule
	s.cfgMu.RUnlock()
	st := s.loadScheduleState()

	recent := make([]map[string]string, 0, len(st.LastRun))
	keys := make([]string, 0, len(st.LastRun))
	for k := range st.LastRun {
		keys = append(keys, k)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	for i, k := range keys {
		if i >= 20 {
			break
		}
		day, channel, _ := strings.Cut(k, "|")
		recent = append(recent, map[string]string{"key": k, "day": day, "channelId": channel, "at": st.LastRun[k]})
	}
	writeJSON(w, map[string]any{
		"schedule": sch,
		"nextRun":  nextRunAt(sch, time.Now().In(gmt8)),
		"lastNote": st.LastNote,
		"recent":   recent,
	})
}

// handleSchedulePut saves the schedule. The timer picks the change up on its
// next tick, so no restart is needed.
func (s *Server) handleSchedulePut(w http.ResponseWriter, r *http.Request) {
	var body Schedule
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, 400, "bad body: %v", err)
		return
	}
	if body.Mode != "daily" && body.Mode != "interval" {
		writeErr(w, 400, "mode 必須是 daily 或 interval")
		return
	}
	if body.Mode == "daily" {
		if _, _, err := parseClock(body.Time); err != nil {
			writeErr(w, 400, "%v", err)
			return
		}
	}
	if body.OffsetDays < 0 || body.OffsetDays > 7 {
		writeErr(w, 400, "offsetDays 必須在 0~7 之間")
		return
	}
	body.Targets = cleanIDs(body.Targets)

	s.cfgMu.Lock()
	s.cfg.Settings.Schedule = body
	s.cfgMu.Unlock()
	s.cfg.SaveSettings()

	s.handleSchedule(w, r)
}

// cleanIDs drops empty entries and duplicates so config.json stays readable.
func cleanIDs(ids []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
