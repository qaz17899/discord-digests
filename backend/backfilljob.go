package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Manual history fetch: the dashboard queues it, the collector runs it.
//
// It has to be the collector because message files have exactly one writer.
// Rotate() gzips the live file and deletes it; a second writer either blocks that
// delete or has the lines it wrote during the gzip silently removed with the file.
//
// The queue is a folder of state files, not a channel or a table. serve writes
// *.request.json, the collector renames it to *.running.json (an atomic claim),
// and the dashboard reads whichever file exists — so progress survives a restart
// of either side and there is no protocol to keep in sync.

const (
	jobsDirName = "jobs"
	// backfillMaxDays is a product decision: nobody needs a 90-day window, and
	// ninety days of history paging is ten hours of hammering a throwaway account.
	backfillMaxDays   = 30
	backfillChains    = 2 // parallel day fetches inside one channel
	backfillChannels  = 2 // channels fetched at the same time
	backfillPagePause = 300 * time.Millisecond
	backfillTick      = 5 * time.Second
	backfillKeepDone  = 20
	backfillSaveEvery = 5 // pages between job-file writes

	// backfillRotateAfter is how much a history fetch must write before the live
	// file is archived right away.
	backfillRotateAfter = 20000
)

// BackfillDay is one finished (channel, day) unit.
type BackfillDay struct {
	Day     string `json:"day"`
	Added   int    `json:"added"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
	Pages   int    `json:"pages"`
	Ms      int64  `json:"ms"`
	Err     string `json:"err,omitempty"`
}

// BackfillCurrent is one chain in flight, for the progress panel.
type BackfillCurrent struct {
	Channel string `json:"channel"`
	Day     string `json:"day"`
	Pages   int    `json:"pages"`
	Added   int    `json:"added"`
	Updated int    `json:"updated"`
	Skipped int    `json:"skipped"`
}

type BackfillTotals struct {
	Units      int `json:"units"` // (channel × day) planned
	Done       int `json:"done"`
	Added      int `json:"added"`
	Updated    int `json:"updated"`
	Skipped    int `json:"skipped"`
	Pages      int `json:"pages"`
	Errors     int `json:"errors"`
	MsgsPerMin int `json:"msgsPerMin"`
	EtaMin     int `json:"etaMin"`
}

// BackfillJob is one queued history fetch. State is also the file suffix, so the
// dashboard can show a job without opening it.
type BackfillJob struct {
	ID       string   `json:"id"`
	State    string   `json:"state"` // request | running | done | error | cancelled
	Channels []string `json:"channels"`

	From string `json:"from"` // "YYYY-MM-DDTHH:MM" GMT+8
	To   string `json:"to"`

	Totals  BackfillTotals                    `json:"totals"`
	Done    map[string]map[string]BackfillDay `json:"done,omitempty"`
	Current []*BackfillCurrent                `json:"current,omitempty"`

	Message    string `json:"message,omitempty"`
	CreatedAt  string `json:"createdAt"`
	StartedAt  string `json:"startedAt,omitempty"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
}

var jobStates = []string{"request", "running", "done", "error", "cancelled"}

func jobsDir(home string) string { return filepath.Join(home, jobsDirName) }

func jobFile(home, id, state string) string {
	return filepath.Join(jobsDir(home), id+"."+state+".json")
}

func cancelFile(home, id string) string {
	return filepath.Join(jobsDir(home), id+".cancel")
}

// saveJob writes the job under one state and removes the other state files, so
// exactly one of them exists at a time. The write is atomic (tmp + rename)
// because the dashboard reads these files while the collector writes them.
func saveJob(home string, job *BackfillJob, state string) error {
	if err := os.MkdirAll(jobsDir(home), 0o755); err != nil {
		return err
	}
	job.State = state
	job.UpdatedAt = time.Now().In(gmt8).Format(tsLayout)
	raw, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return err
	}
	target := jobFile(home, job.ID, state)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		return err
	}
	for _, other := range jobStates {
		if other != state {
			os.Remove(jobFile(home, job.ID, other))
		}
	}
	return nil
}

func splitJobName(name string) (id, state string, ok bool) {
	stem := strings.TrimSuffix(name, ".json")
	i := strings.LastIndexByte(stem, '.')
	if i <= 0 {
		return "", "", false
	}
	id, state = stem[:i], stem[i+1:]
	for _, s := range jobStates {
		if s == state {
			return id, state, true
		}
	}
	return "", "", false
}

// jobRank orders the states a job can be found in, so a folder holding both a
// stale request file and a finished one resolves to the finished one.
func jobRank(state string) int {
	switch state {
	case "request":
		return 0
	case "running":
		return 1
	default:
		return 2
	}
}

func findJob(home, id string) (*BackfillJob, bool) {
	best := -1
	var out *BackfillJob
	for _, state := range jobStates {
		raw, err := os.ReadFile(jobFile(home, id, state))
		if err != nil || jobRank(state) <= best {
			continue
		}
		var job BackfillJob
		if json.Unmarshal(raw, &job) != nil {
			continue
		}
		job.State = state
		out, best = &job, jobRank(state)
	}
	return out, out != nil
}

// listJobs returns every job on disk, newest first. limit <= 0 means all.
func listJobs(home string, limit int) []*BackfillJob {
	entries, err := os.ReadDir(jobsDir(home))
	if err != nil {
		return []*BackfillJob{}
	}
	byID := map[string]*BackfillJob{}
	rank := map[string]int{}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".json") {
			continue
		}
		id, state, ok := splitJobName(name)
		if !ok {
			continue
		}
		if have, dup := rank[id]; dup && have >= jobRank(state) {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(jobsDir(home), name))
		if err != nil {
			continue
		}
		var job BackfillJob
		if json.Unmarshal(raw, &job) != nil {
			continue
		}
		job.State = state
		byID[id], rank[id] = &job, jobRank(state)
	}
	out := make([]*BackfillJob, 0, len(byID))
	for _, j := range byID {
		out = append(out, j)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// planDays turns a window into the GMT+8 days it covers.
//
// Days are the unit of work because they give the progress bar a real
// denominator, make a restart resume at most one day back, and let parallel
// chains take different days without ever sharing a millisecond of history.
func planDays(from, to time.Time) []string {
	start, end := from.In(gmt8), to.In(gmt8)
	first := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, gmt8)
	last := time.Date(end.Year(), end.Month(), end.Day(), 0, 0, 0, 0, gmt8)
	var days []string
	for d := first; !d.After(last); d = d.AddDate(0, 0, 1) {
		days = append(days, d.Format(dayLayout))
	}
	return days
}

// CreateBackfillJob validates a request and puts it in the queue. It never talks
// to Discord; the collector picks it up within a few seconds.
func CreateBackfillJob(home string, channels []string, from, to time.Time) (*BackfillJob, error) {
	channels = cleanIDs(channels)
	if len(channels) == 0 {
		return nil, fmt.Errorf("至少選一個頻道")
	}
	if from.After(to) {
		return nil, fmt.Errorf("開始時間必須早於結束時間")
	}
	days := planDays(from, to)
	if len(days) > backfillMaxDays {
		return nil, fmt.Errorf("一次最多回補 %d 天（目前選了 %d 天）", backfillMaxDays, len(days))
	}
	job := &BackfillJob{
		ID:        fmt.Sprintf("bf-%d", time.Now().UnixNano()),
		State:     "request",
		Channels:  channels,
		From:      from.In(gmt8).Format("2006-01-02T15:04"),
		To:        to.In(gmt8).Format("2006-01-02T15:04"),
		Done:      map[string]map[string]BackfillDay{},
		CreatedAt: time.Now().In(gmt8).Format(tsLayout),
	}
	for _, ch := range channels {
		job.Done[ch] = map[string]BackfillDay{}
	}
	job.Totals.Units = len(days) * len(channels)
	if err := saveJob(home, job, "request"); err != nil {
		return nil, err
	}
	return job, nil
}

// CancelBackfillJob asks the collector to stop. The flag is a file so that the
// request works no matter which process is running the job.
func CancelBackfillJob(home, id string) error {
	if _, ok := findJob(home, id); !ok {
		return fmt.Errorf("找不到這個工作")
	}
	return os.WriteFile(cancelFile(home, id), []byte(time.Now().In(gmt8).Format(tsLayout)+"\n"), 0o644)
}

// ResumeBackfillJobs puts half-finished jobs back in the queue. Because a day is
// the unit of work, a job that died mid-day just re-fetches that day, and the
// fingerprint check makes the re-fetch cheap and idempotent.
func ResumeBackfillJobs(home string) int {
	entries, err := os.ReadDir(jobsDir(home))
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".running.json") {
			continue
		}
		src := filepath.Join(jobsDir(home), e.Name())
		raw, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		var job BackfillJob
		if json.Unmarshal(raw, &job) != nil {
			continue
		}
		job.Current = nil
		os.Remove(src)
		if err := saveJob(home, &job, "request"); err == nil {
			n++
		}
	}
	return n
}

// pruneJobs keeps the newest finished jobs; a queue entry is never pruned.
func pruneJobs(home string, keep int) {
	jobs := listJobs(home, 0)
	if len(jobs) <= keep {
		return
	}
	for _, j := range jobs[keep:] {
		if j.State == "request" || j.State == "running" {
			continue
		}
		for _, s := range jobStates {
			os.Remove(jobFile(home, j.ID, s))
		}
		os.Remove(cancelFile(home, j.ID))
	}
}

// stateNotifier folds a finished day's find into _state.json for callers that are
// not the collector (the CLI, which runs alone). The collector keeps its cursor in
// memory and must not have it overwritten by a file write, so it has its own path.
func stateNotifier(store *Store) func(channelID, id, ts string, added int) {
	return func(channelID, id, ts string, added int) {
		st := store.State(channelID)
		st.TotalFetched += added
		if id != "" && (st.LastID == "" || lessID(st.LastID, id)) {
			st.LastID = id
			st.LastTS = ts
		}
		st.LastRun = time.Now().UTC().Format(time.RFC3339)
		if st.CurrentFileStart == "" {
			st.CurrentFileStart = time.Now().In(gmt8).Format(dayLayout)
		}
		if err := store.SaveState(channelID, st); err != nil {
			log.Printf("save state %s: %v", channelID, err)
		}
	}
}

// RunBackfillJobs claims at most one queued job and runs it to completion,
// returning the id it handled ("" when the queue is empty).
//
// resume puts half-finished jobs back in the queue first. The collector passes
// false because it does that once at startup; a CLI run passes true, because it
// only gets to run after checking that no collector is alive — the one that died
// is the one that left the half-finished job behind.
func RunBackfillJobs(home string, store *Store, client *Client, notify func(channelID, id, ts string, added int), resume bool) (string, error) {
	if resume {
		ResumeBackfillJobs(home)
	}
	job, err := claimJob(home)
	if err != nil || job == nil {
		return "", err
	}
	runBackfillJob(home, store, client, job, notify)
	return job.ID, nil
}

// claimJob takes the oldest queued request out of the queue. The rename is the
// lock: two workers racing on the same folder cannot both win it.
func claimJob(home string) (*BackfillJob, error) {
	entries, err := os.ReadDir(jobsDir(home))
	if err != nil {
		return nil, nil // no queue yet
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".request.json") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		src := filepath.Join(jobsDir(home), name)
		raw, err := os.ReadFile(src)
		if err != nil {
			continue
		}
		var job BackfillJob
		if json.Unmarshal(raw, &job) != nil || job.ID == "" {
			continue
		}
		if err := os.Rename(src, jobFile(home, job.ID, "running")); err != nil {
			continue // another worker got it first
		}
		job.State = "running"
		return &job, nil
	}
	return nil, nil
}

// backfillRun is the mutable state of one running job.
type backfillRun struct {
	home   string
	store  *Store
	client *Client
	job    *BackfillJob
	notify func(channelID, id, ts string, added int)

	from, to time.Time
	stopped  atomic.Bool
	clock    time.Time

	mu         sync.Mutex
	pagesSince int
}

func runBackfillJob(home string, store *Store, client *Client, job *BackfillJob, notify func(string, string, string, int)) {
	from, err := parseWhen(job.From)
	if err != nil {
		job.Message = fmt.Sprintf("開始時間無法解析：%v", err)
		saveJob(home, job, "error")
		return
	}
	to, err := parseWhen(job.To)
	if err != nil {
		job.Message = fmt.Sprintf("結束時間無法解析：%v", err)
		saveJob(home, job, "error")
		return
	}
	if job.Done == nil {
		job.Done = map[string]map[string]BackfillDay{}
	}
	for _, ch := range job.Channels {
		if job.Done[ch] == nil {
			job.Done[ch] = map[string]BackfillDay{}
		}
	}

	run := &backfillRun{home: home, store: store, client: client, job: job, notify: notify, from: from, to: to, clock: time.Now()}
	run.job.StartedAt = run.clock.In(gmt8).Format(tsLayout)
	run.flush()

	// A resumed job must not restart its counters, and a day that failed last time
	// is worth another try.
	job.Totals = BackfillTotals{}
	allDays := planDays(from, to)
	remaining := map[string][]string{}
	job.Totals.Units = len(allDays) * len(job.Channels)
	for _, ch := range job.Channels {
		for _, day := range allDays {
			unit, done := job.Done[ch][day]
			if !done || unit.Err != "" {
				remaining[ch] = append(remaining[ch], day)
				continue
			}
			job.Totals.Done++
			job.Totals.Added += unit.Added
			job.Totals.Updated += unit.Updated
			job.Totals.Skipped += unit.Skipped
			job.Totals.Pages += unit.Pages
		}
	}

	// Channels in parallel; inside a channel the days are handed to a couple of
	// chains. Neither axis ever touches the same millisecond as another.
	sem := make(chan struct{}, backfillChannels)
	var wg sync.WaitGroup
	for _, ch := range job.Channels {
		days := remaining[ch]
		if len(days) == 0 || run.stoppedNow() {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(ch string, days []string) {
			defer wg.Done()
			defer func() { <-sem }()
			run.runChannel(ch, days)
		}(ch, days)
	}
	wg.Wait()

	run.finish()
	pruneJobs(home, backfillKeepDone)
}

// runChannel hands this channel's remaining days to backfillChains workers. The
// day list is computed before any of them start, so no chain ever reads the
// job's maps while another one writes them.
func (r *backfillRun) runChannel(channelID string, days []string) {
	// The reaction log decides who owns reaction counts, and it is the same for
	// every day of the channel, so it is read once.
	tally, err := r.store.ReactionTally(channelID)
	if err != nil {
		log.Printf("backfill %s: reaction log: %v", channelID, err)
	}

	next := int32(-1)
	var wg sync.WaitGroup
	for i := 0; i < backfillChains; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				if r.stoppedNow() {
					return
				}
				idx := int(atomic.AddInt32(&next, 1))
				if idx >= len(days) {
					return
				}
				r.runDay(channelID, days[idx], tally)
			}
		}()
	}
	wg.Wait()
}

// runDay fetches one day and records the result. A day is all-or-nothing: if it
// fails or is cancelled nothing is recorded, so a later run simply retries it.
func (r *backfillRun) runDay(channelID, day string, tally map[string]map[string]int) {
	from, to := dayStart(day), dayEnd(day)
	if from.Before(r.from) {
		from = r.from
	}
	if to.After(r.to) {
		to = r.to
	}

	// Local fingerprints for this day: only ids that already exist, only the
	// fields a history fetch can change.
	local := map[string]uint64{}
	if recs, err := r.store.LoadRange(channelID, day, day); err == nil {
		local = make(map[string]uint64, len(recs))
		for _, rec := range recs {
			local[rec.ID] = versionKey(rec)
		}
	} else {
		log.Printf("backfill %s %s: read local: %v", channelID, day, err)
	}

	cur := &BackfillCurrent{Channel: channelID, Day: day}
	r.addCurrent(cur)
	started := time.Now()

	stats, err := BackfillWindow(r.client, r.store, channelID, from, to, local, tally, BackfillOpts{
		Pause: backfillPagePause,
		OnPage: func(s BackfillStats) bool {
			r.touchCurrent(cur, s)
			r.pageDone()
			return !r.stoppedNow()
		},
	})
	r.dropCurrent(cur)

	if err == errCancelled {
		return
	}
	unit := BackfillDay{
		Day: day, Added: stats.Added, Updated: stats.Updated, Skipped: stats.Skipped,
		Pages: stats.Pages, Ms: time.Since(started).Milliseconds(),
	}
	if err != nil {
		unit.Err = err.Error()
		log.Printf("backfill %s %s: %v", channelID, day, err)
	} else if stats.Added > 0 && r.notify != nil && stats.Newest != "" {
		// Tell the live cursor about anything it has not seen, so a restart does
		// not re-fetch what we just wrote.
		r.notify(channelID, stats.Newest, fmtTS(snowflakeTime(stats.Newest)), stats.Added)
	}
	r.finishUnit(channelID, unit, stats)
}

func (r *backfillRun) addCurrent(cur *BackfillCurrent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.job.Current = append(r.job.Current, cur)
}

// touchCurrent updates an in-flight card under the same lock the job file is
// written with, so a write can never catch a chain mutating it.
func (r *backfillRun) touchCurrent(cur *BackfillCurrent, s BackfillStats) {
	r.mu.Lock()
	defer r.mu.Unlock()
	cur.Pages, cur.Added, cur.Updated, cur.Skipped = s.Pages, s.Added, s.Updated, s.Skipped
}

func (r *backfillRun) dropCurrent(cur *BackfillCurrent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.job.Current[:0]
	for _, c := range r.job.Current {
		if c != cur {
			kept = append(kept, c)
		}
	}
	r.job.Current = kept
}

func (r *backfillRun) finishUnit(channelID string, unit BackfillDay, s BackfillStats) {
	r.mu.Lock()
	r.job.Done[channelID][unit.Day] = unit
	r.job.Totals.Done++
	r.job.Totals.Added += s.Added
	r.job.Totals.Updated += s.Updated
	r.job.Totals.Skipped += s.Skipped
	r.job.Totals.Pages += s.Pages
	if unit.Err != "" {
		r.job.Totals.Errors++
	}
	r.mu.Unlock()
	r.flush()
}

// pageDone writes the job file every few pages: often enough that the dashboard
// moves, rare enough that the disk never notices.
func (r *backfillRun) pageDone() {
	r.mu.Lock()
	r.pagesSince++
	save := r.pagesSince >= backfillSaveEvery
	if save {
		r.pagesSince = 0
	}
	r.mu.Unlock()
	if save {
		r.flush()
	}
}

func (r *backfillRun) flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if done := r.job.Totals.Done; done > 0 {
		elapsed := time.Since(r.clock)
		moved := r.job.Totals.Added + r.job.Totals.Updated
		r.job.Totals.MsgsPerMin = int(float64(moved) / elapsed.Minutes())
		if left := r.job.Totals.Units - done; left > 0 {
			r.job.Totals.EtaMin = int((elapsed * time.Duration(left) / time.Duration(done)).Minutes())
		} else {
			r.job.Totals.EtaMin = 0
		}
	}
	// The snapshot is a shallow copy plus a live totals view, so a chain that is
	// mid-page still shows up in the dashboard.
	out := *r.job
	out.Current = append([]*BackfillCurrent(nil), r.job.Current...)
	out.Totals = r.liveTotals()
	if err := saveJob(r.home, &out, "running"); err != nil {
		log.Printf("backfill %s: save: %v", r.job.ID, err)
	}
}

// liveTotals adds the in-flight chains to the finished days, so the dashboard
// counts pages while they are still being fetched. The stored totals stay
// untouched: a chain adds its own numbers again when it finishes.
func (r *backfillRun) liveTotals() BackfillTotals {
	t := r.job.Totals
	for _, c := range r.job.Current {
		t.Added += c.Added
		t.Updated += c.Updated
		t.Skipped += c.Skipped
		t.Pages += c.Pages
	}
	return t
}

// stoppedNow reports whether a cancel was requested. The flag file is checked at
// most once per page, which is a couple of seconds of latency.
func (r *backfillRun) stoppedNow() bool {
	if r.stopped.Load() {
		return true
	}
	if _, err := os.Stat(cancelFile(r.home, r.job.ID)); err == nil {
		r.stopped.Store(true)
		return true
	}
	return false
}

func (r *backfillRun) finish() {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.job.Current = nil
	state, msg := "done", ""
	switch {
	case r.stopped.Load():
		state = "cancelled"
		msg = fmt.Sprintf("已取消:%d/%d 天完成、新增 %d 則", r.job.Totals.Done, r.job.Totals.Units, r.job.Totals.Added)
	case r.job.Totals.Errors > 0:
		state = "error"
		msg = fmt.Sprintf("結束:%d 天成功、%d 天失敗、新增 %d 則", r.job.Totals.Done-r.job.Totals.Errors, r.job.Totals.Errors, r.job.Totals.Added)
	default:
		msg = fmt.Sprintf("完成:%d 天、新增 %d 則、更新 %d 則、未變 %d 則", r.job.Totals.Done, r.job.Totals.Added, r.job.Totals.Updated, r.job.Totals.Skipped)
	}
	r.job.Message = msg
	r.job.FinishedAt = time.Now().In(gmt8).Format(tsLayout)
	os.Remove(cancelFile(r.home, r.job.ID))
	if err := saveJob(r.home, r.job, state); err != nil {
		log.Printf("backfill %s: finish: %v", r.job.ID, err)
	}
}
