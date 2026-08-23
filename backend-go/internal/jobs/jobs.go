// Package jobs: in-process async job manager (goroutines) — mirrors the Python thread
// manager; swap for a queue when scaling out (NFR-SCA-02).
package jobs

import (
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

// Error is a job failure the caller is expected to ACT on, carrying a stable
// code. A bare error string tells the UI nothing it can branch on: "node was not
// found" and "the page timed out" need different sentences in front of the user,
// and only the failing code knows which is which.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Fail builds a coded job failure.
func Fail(code, message string) error { return &Error{Code: code, Message: message} }

type Job struct {
	mu       sync.Mutex
	ID       string  `json:"id"`
	Kind     string  `json:"kind"`
	Status   string  `json:"status"` // queued|running|completed|failed
	Progress float64 `json:"progress"`
	Message  string  `json:"message"`
	Result   any     `json:"result"`
	Error    *string `json:"error"`
	// ErrorCode is set only when the job failed with a coded jobs.Error.
	ErrorCode *string `json:"error_code"`
	Created   string  `json:"created_at"`

	// --- stage proxying (see Scoped) --------------------------------------
	// parent is non-nil on a proxy returned by Scoped. A proxy owns no state of
	// its own: every Set writes through to the parent, scaled and labelled.
	parent *Job
	lo, hi float64
	label  string
}

// Scoped returns a job-shaped proxy that maps a sub-job's own 0..1 progress into
// the [lo, hi] slice of this job, prefixing its messages with label.
//
// The engine job bodies write progress directly. Handing a composing job (the
// pipeline) straight to each of them would make every stage reset the bar to
// zero, so each stage gets one of these instead — same type, scaled writes.
func (j *Job) Scoped(lo, hi float64, label string) *Job {
	return &Job{ID: j.ID, Kind: j.Kind, Status: "running",
		parent: j, lo: lo, hi: hi, label: label}
}

func (j *Job) Set(progress float64, message string) {
	if j.parent != nil {
		scaled := -1.0
		if progress >= 0 {
			frac := progress
			if frac > 1 {
				frac = 1
			}
			scaled = j.lo + (j.hi-j.lo)*frac
		}
		if message != "" && j.label != "" {
			message = j.label + ": " + message
		}
		j.parent.Set(scaled, message)
		return
	}
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
		"message": j.Message, "result": j.Result, "error": j.Error,
		"error_code": j.ErrorCode, "created_at": j.Created,
	}
}

var (
	mu     sync.Mutex
	jobs   = map[string]*Job{}
	active = map[string]int{} // kind+"|"+projectID -> queued/running jobs
)

func Submit(kind string, fn func(j *Job) (any, error)) *Job {
	return SubmitForProject(kind, "", fn)
}

// SubmitForProject registers the job against a project so ActiveForProject and
// TrySubmitForProject can see it while it is queued or running. An empty
// projectID behaves exactly like Submit.
func SubmitForProject(kind, projectID string, fn func(j *Job) (any, error)) *Job {
	mu.Lock()
	defer mu.Unlock()
	return submitLocked(kind, projectID, fn)
}

// TrySubmitForProject enqueues only when no job of this kind for this project
// is currently queued or running — the autopilot double-trigger guard.
func TrySubmitForProject(kind, projectID string, fn func(j *Job) (any, error)) (*Job, bool) {
	mu.Lock()
	defer mu.Unlock()
	if active[kind+"|"+projectID] > 0 {
		return nil, false
	}
	return submitLocked(kind, projectID, fn), true
}

// ActiveForProject reports whether a job of this kind for this project is
// currently queued or running.
func ActiveForProject(kind, projectID string) bool {
	mu.Lock()
	defer mu.Unlock()
	return active[kind+"|"+projectID] > 0
}

func submitLocked(kind, projectID string, fn func(j *Job) (any, error)) *Job {
	j := &Job{ID: uuid.NewString(), Kind: kind, Status: "queued", Created: time.Now().UTC().Format(time.RFC3339)}
	jobs[j.ID] = j
	key := kind + "|" + projectID
	if projectID != "" {
		active[key]++
	}
	go func() {
		j.mu.Lock()
		j.Status = "running"
		j.mu.Unlock()
		res, err := fn(j)
		// Release the per-project slot BEFORE the terminal status is visible so
		// "status == completed" always implies the guard is open again.
		if projectID != "" {
			mu.Lock()
			active[key]--
			mu.Unlock()
		}
		j.mu.Lock()
		defer j.mu.Unlock()
		if err != nil {
			msg := err.Error()
			j.Status = "failed"
			j.Error = &msg
			var coded *Error
			if errors.As(err, &coded) {
				code := coded.Code
				j.ErrorCode = &code
			}
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
