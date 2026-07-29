// Package jobs: in-process async job manager (goroutines) — mirrors the Python thread
// manager; swap for a queue when scaling out (NFR-SCA-02).
package jobs

import (
	"sync"
	"time"

	"github.com/google/uuid"
)

type Job struct {
	mu       sync.Mutex
	ID       string  `json:"id"`
	Kind     string  `json:"kind"`
	Status   string  `json:"status"` // queued|running|completed|failed
	Progress float64 `json:"progress"`
	Message  string  `json:"message"`
	Result   any     `json:"result"`
	Error    *string `json:"error"`
	Created  string  `json:"created_at"`
}

func (j *Job) Set(progress float64, message string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if progress >= 0 {
		j.Progress = progress
	}
	if message != "" {
		j.Message = message
	}
}

func (j *Job) Snapshot() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	return map[string]any{
		"id": j.ID, "kind": j.Kind, "status": j.Status, "progress": j.Progress,
		"message": j.Message, "result": j.Result, "error": j.Error, "created_at": j.Created,
	}
}

var (
	mu   sync.Mutex
	jobs = map[string]*Job{}
)

func Submit(kind string, fn func(j *Job) (any, error)) *Job {
	j := &Job{ID: uuid.NewString(), Kind: kind, Status: "queued", Created: time.Now().UTC().Format(time.RFC3339)}
	mu.Lock()
	jobs[j.ID] = j
	mu.Unlock()
	go func() {
		j.mu.Lock()
		j.Status = "running"
		j.mu.Unlock()
		res, err := fn(j)
		j.mu.Lock()
		defer j.mu.Unlock()
		if err != nil {
			msg := err.Error()
			j.Status = "failed"
			j.Error = &msg
		} else {
			j.Status = "completed"
			j.Progress = 1
			j.Result = res
		}
	}()
	return j
}

func Get(id string) *Job {
	mu.Lock()
	defer mu.Unlock()
	return jobs[id]
}
