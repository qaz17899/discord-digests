package main

import (
	"fmt"
	"path/filepath"
	"time"
)

// DigestJob tracks one summarizer run. The dashboard polls it instead of
// holding an HTTP request open for minutes, and it reports the real batch
// count, so the progress bar is not decoration.
type DigestJob struct {
	ID        string `json:"id"`
	ChannelID string `json:"channelId"`
	From      string `json:"from"`
	To        string `json:"to"`
	State     string `json:"state"` // running | done | input | error
	Message   string `json:"message"`
	Batches   int    `json:"batches"`
	Done      int    `json:"done"`
	Report    string `json:"report"`
	Started   string `json:"started"`
	Finished  string `json:"finished"`
}

const maxJobs = 20

// startDigest runs a digest in the background. Starting the same range twice
// while it is still running returns the job that is already going. from/to are
// exact instants: a full day is 00:00:00..23:59:59, an hour window is anything
// narrower.
func (s *Server) startDigest(channelID string, from, to time.Time) (*DigestJob, error) {
	fromISO := from.In(gmt8).Format(tsLayout)
	toISO := to.In(gmt8).Format(tsLayout)

	s.jobMu.Lock()
	for _, j := range s.jobs {
		if j.State == "running" && j.ChannelID == channelID && j.From == fromISO && j.To == toISO {
			s.jobMu.Unlock()
			return j, nil
		}
	}
	job := &DigestJob{
		ID:        fmt.Sprintf("%s-%d", channelID, time.Now().UnixNano()),
		ChannelID: channelID, From: fromISO, To: toISO,
		State: "running", Message: "整理訊息中",
		Started: time.Now().In(gmt8).Format(tsLayout),
	}
	s.jobs = append(s.jobs, job)
	if len(s.jobs) > maxJobs {
		s.jobs = s.jobs[len(s.jobs)-maxJobs:]
	}
	s.jobMu.Unlock()

	go func() {
		res, err := Digest(s.digestClient(), s.store, s.cfg, channelID, from, to, func(done, total int) {
			s.jobMu.Lock()
			job.Done, job.Batches = done, total
			s.jobMu.Unlock()
		})

		s.jobMu.Lock()
		defer s.jobMu.Unlock()
		job.Finished = time.Now().In(gmt8).Format(tsLayout)
		switch {
		case err != nil:
			job.State, job.Message = "error", err.Error()
		case res.Report == "":
			job.State = "input"
			job.Message = "未設定模型：已備妥輸入檔，等待外部模型產生摘要"
			job.Batches, job.Done = 0, 0
		default:
			job.State = "done"
			job.Message = fmt.Sprintf("完成：%d 則訊息、%d 批", res.Messages, res.Batches)
			job.Report = filepath.Base(res.Report)
			job.Batches, job.Done = res.Batches, res.Batches
		}
	}()
	return job, nil
}

func (s *Server) job(id string) (*DigestJob, bool) {
	s.jobMu.Lock()
	defer s.jobMu.Unlock()
	for _, j := range s.jobs {
		if j.ID == id {
			cp := *j
			return &cp, true
		}
	}
	return nil, false
}
