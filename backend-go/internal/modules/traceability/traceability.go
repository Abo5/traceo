// Package traceability — the live requirement -> case -> latest-result view
// (TRD §4.7). 1:1 port of backend/app/modules/traceability.py.
//
// The RequirementTestCase join table "is the product": this module renders it as
// the coverage matrix (FR-TRC-01/02), computes the coverage KPI (FR-TRC-03),
// surfaces gaps with the v2 reason/next_action vocabulary (FR-TRC-06 / FR-051),
// keeps the staleness contract (FR-TRC-04 — MarkStale is called by the ingestion
// module) and exposes per-requirement run history (FR-TRC-07).
//
// Everything is computed on read; no schema additions.
package traceability

import (
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
)

// RunDisplayBase — the first run of a project renders as #1001.
const RunDisplayBase = 1000

// GapNextActions — v2 gap vocabulary (FR-051): reason -> suggested next action.
var GapNextActions = map[string]string{
	"no_reachable_endpoint": "Import a specification that covers this requirement, or link it manually",
	"all_cases_disabled":    "Approve one of the linked test cases in review",
	"no_approved_cases":     "Generate test cases for this requirement",
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	// The matrix read is part of the public CI surface, so it also accepts
	// `X-API-Key` (API_CONTRACT_V2_ADDENDUM.md); history stays JWT-only.
	r.GET("/projects/:project_id/traceability", httpx.AuthOrAPIKey(), httpx.Require("view"), traceabilityMatrix)
	r.GET("/requirements/:requirement_id/history", httpx.Auth(), httpx.Require("view"), requirementHistory)
}

// ---------------------------------------------------------------------------
// Shared read-time helpers (no schema changes — everything computed on read)
// ---------------------------------------------------------------------------

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// isoPtr mirrors the Python `_iso` helper: None stays null.
func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

// RunDisplayIDs — run_id -> chronological #1001-style display id within the project.
func RunDisplayIDs(projectID string) map[string]int {
	var ids []string
	db.DB.Model(&models.Run{}).Where("project_id = ?", projectID).
		Order("created_at ASC, id ASC").Pluck("id", &ids)
	out := make(map[string]int, len(ids))
	for i, id := range ids {
		out[id] = RunDisplayBase + i + 1
	}
	return out
}

// RunDisplayID — the #1001-style display id of one run within its project.
func RunDisplayID(run *models.Run) int {
	if n, ok := RunDisplayIDs(run.ProjectID)[run.ID]; ok {
		return n
	}
	return RunDisplayBase + 1
}

// IsHighPriority — requirement priority classes that escalate defect severity.
func IsHighPriority(priority string) bool {
	p := strings.ToLower(priority)
	return p == "high" || p == "critical"
}

// DeriveSeverity — FR-052 severity = requirement priority × failure class.
//
//	critical = high-priority requirement + business-rule failure (json_field assertion);
//	major    = schema (json_schema) failure OR transport error OR high-priority other;
//	minor    = everything else.
func DeriveSeverity(outcome string, failureReason models.JSONMap, highPriority bool) string {
	fr := failureReason
	if fr == nil {
		fr = models.JSONMap{}
	}
	assertion, _ := fr["assertion"].(map[string]any) // non-dict `assertion` reads as absent
	if outcome == "errored" || (truthy(fr["error"]) && assertion == nil) {
		return "major" // transport / execution error
	}
	atype, _ := assertion["type"].(string)
	switch atype {
	case "json_field": // business-rule class
		if highPriority {
			return "critical"
		}
		return "minor"
	case "json_schema": // schema class
		return "major"
	}
	if highPriority {
		return "major"
	}
	return "minor"
}

// truthy mirrors Python truthiness for the values that reach failure_reason JSON.
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0
	case map[string]any:
		return len(t) > 0
	case []any:
		return len(t) > 0
	default:
		return true
	}
}

// GapReason — v2 gap-reason vocabulary for an uncovered confirmed requirement.
func GapReason(caseStates []string) string {
	if len(caseStates) == 0 {
		return "no_reachable_endpoint" // never mapped / unmappable
	}
	for _, s := range caseStates {
		if s == "approved" {
			return "no_approved_cases" // fallback
		}
	}
	return "all_cases_disabled" // linked, but nothing approved counts
}

// ---------------------------------------------------------------------------
// Staleness helper — called by ingestion (FR-TRC-04)
// ---------------------------------------------------------------------------

// MarkStale — a changed requirement invalidates every APPROVED case linked to it.
// (The Python signature takes the session and lets the caller commit; the Go port
// writes through the shared db.DB handle immediately.)
func MarkStale(reqID string) {
	var caseIDs []string
	db.DB.Model(&models.RequirementTestCase{}).
		Where("requirement_id = ?", reqID).Pluck("test_case_id", &caseIDs)
	if len(caseIDs) == 0 {
		return
	}
	db.DB.Model(&models.TestCase{}).
		Where("id IN ? AND state = ?", caseIDs, "approved").
		Update("state", "stale")
}

// ---------------------------------------------------------------------------
// Latest-outcome computation
// ---------------------------------------------------------------------------

// latestOutcomes — test_case_id -> outcome of its most recent TestResult.
func latestOutcomes(caseIDs []string) map[string]string {
	latest := map[string]string{}
	if len(caseIDs) == 0 {
		return latest
	}
	var rows []struct {
		TestCaseID string
		Outcome    string
	}
	db.DB.Model(&models.TestResult{}).
		Select("test_case_id, outcome").
		Where("test_case_id IN ?", caseIDs).
		Order("created_at ASC, id ASC").Scan(&rows)
	for _, r := range rows { // ascending order: the last write wins = newest
		latest[r.TestCaseID] = r.Outcome
	}
	return latest
}

type matrixCase struct {
	ID            string
	Title         string
	State         string
	LatestOutcome string // "" == null
}

// requirementStatus — FR-TRC-02 status ladder. Only APPROVED cases count as coverage.
func requirementStatus(cases []matrixCase) string {
	outcomes := []string{}
	approved := 0
	for _, cse := range cases {
		if cse.State != "approved" {
			continue
		}
		approved++
		if cse.LatestOutcome != "" {
			outcomes = append(outcomes, cse.LatestOutcome)
		}
	}
	if approved == 0 {
		return "not_covered"
	}
	if len(outcomes) == 0 {
		return "covered_not_run"
	}
	for _, o := range outcomes {
		if o == "failed" {
			return "failing"
		}
	}
	for _, o := range outcomes {
		if o == "errored" {
			return "errored"
		}
	}
	return "passing"
}

// ---------------------------------------------------------------------------
// GET /projects/{project_id}/traceability  (FR-TRC-01/02/03/06)
// ---------------------------------------------------------------------------

func traceabilityMatrix(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	org := u.OrganisationID

	var reqs []models.Requirement
	db.DB.Where("project_id = ? AND organisation_id = ? AND state != ?", projectID, org, "removed").
		Order("external_id ASC, created_at ASC").Find(&reqs)

	// links joined to their case (project + org scoped through the case row)
	var linkRows []struct {
		RequirementID string
		ID            string
		Title         string
		State         string
		CreatedAt     time.Time
	}
	db.DB.Table("requirement_test_cases AS rtc").
		Select("rtc.requirement_id AS requirement_id, tc.id AS id, tc.title AS title, "+
			"tc.state AS state, tc.created_at AS created_at").
		Joins("JOIN test_cases tc ON tc.id = rtc.test_case_id").
		Where("tc.project_id = ? AND tc.organisation_id = ?", projectID, org).
		Scan(&linkRows)

	casesByReq := map[string][]matrixCase{}
	sortKey := map[string]time.Time{}
	seen := map[string]bool{}
	allCaseIDs := []string{}
	for _, row := range linkRows {
		casesByReq[row.RequirementID] = append(casesByReq[row.RequirementID],
			matrixCase{ID: row.ID, Title: row.Title, State: row.State})
		sortKey[row.ID] = row.CreatedAt
		if !seen[row.ID] {
			seen[row.ID] = true
			allCaseIDs = append(allCaseIDs, row.ID)
		}
	}
	latest := latestOutcomes(allCaseIDs)

	rows := []gin.H{}
	gaps := []gin.H{}
	confirmedTotal, confirmedCovered := 0, 0
	for i := range reqs {
		req := &reqs[i]
		linked := casesByReq[req.ID]
		sort.SliceStable(linked, func(a, b int) bool { // (created_at, id)
			ta, tb := sortKey[linked[a].ID], sortKey[linked[b].ID]
			if !ta.Equal(tb) {
				return ta.Before(tb)
			}
			return linked[a].ID < linked[b].ID
		})

		cases := make([]gin.H, 0, len(linked))
		states := make([]string, 0, len(linked))
		hasApproved := false
		for j := range linked {
			linked[j].LatestOutcome = latest[linked[j].ID]
			var outcome any
			if linked[j].LatestOutcome != "" {
				outcome = linked[j].LatestOutcome
			}
			cases = append(cases, gin.H{"id": linked[j].ID, "title": linked[j].Title,
				"state": linked[j].State, "latest_outcome": outcome})
			states = append(states, linked[j].State)
			if linked[j].State == "approved" {
				hasApproved = true
			}
		}
		status := requirementStatus(linked)

		if req.State == "confirmed" {
			confirmedTotal++
			if hasApproved {
				confirmedCovered++
			} else {
				reason := GapReason(states)
				gaps = append(gaps, gin.H{"requirement_id": req.ID,
					"external_id": req.ExternalID, "reason": reason,
					"next_action": GapNextActions[reason]})
			}
		}

		rows = append(rows, gin.H{
			"requirement": gin.H{
				"id": req.ID, "external_id": req.ExternalID,
				"description": req.Description, "type": req.Type,
				"priority": req.Priority, "state": req.State, "version": req.Version,
			},
			"cases":  cases,
			"status": status,
		})
	}

	// FR-TRC-03: stale/draft/rejected cases are excluded — approved only.
	coveragePct := 0.0
	if confirmedTotal > 0 {
		coveragePct = round1(float64(confirmedCovered) / float64(confirmedTotal) * 100)
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "coverage_pct": coveragePct, "gaps": gaps})
}

// ---------------------------------------------------------------------------
// GET /requirements/{requirement_id}/history  (FR-TRC-07)
// ---------------------------------------------------------------------------

type historyRow struct {
	TestCaseID      string
	TestCaseVersion int
	Outcome         string
	DurationMs      int
	ResultCreatedAt time.Time
	RunID           string
	RunProjectID    string
	RunEnvID        string
	RunState        string
	RunStartedAt    *time.Time
	RunFinishedAt   *time.Time
	RunCounts       models.JSONMap
}

func requirementHistory(c *gin.Context) {
	u := httpx.User(c)
	var req models.Requirement
	if err := db.DB.First(&req, "id = ?", c.Param("requirement_id")).Error; err != nil ||
		req.OrganisationID != u.OrganisationID {
		httpx.Err(c, http.StatusNotFound, "not_found", "Requirement not found")
		return
	}

	var caseIDs []string
	db.DB.Model(&models.RequirementTestCase{}).
		Where("requirement_id = ?", req.ID).Pluck("test_case_id", &caseIDs)
	if len(caseIDs) == 0 {
		c.JSON(http.StatusOK, gin.H{"requirement_id": req.ID,
			"external_id": req.ExternalID, "runs": []gin.H{}})
		return
	}

	var cases []models.TestCase
	db.DB.Where("id IN ?", caseIDs).Find(&cases)
	titles := make(map[string]string, len(cases))
	for i := range cases {
		titles[cases[i].ID] = cases[i].Title
	}

	var rows []historyRow
	db.DB.Table("test_results AS tr").
		Select("tr.test_case_id AS test_case_id, tr.test_case_version AS test_case_version, "+
			"tr.outcome AS outcome, tr.duration_ms AS duration_ms, "+
			"tr.created_at AS result_created_at, r.id AS run_id, "+
			"r.project_id AS run_project_id, r.environment_id AS run_env_id, "+
			"r.state AS run_state, r.started_at AS run_started_at, "+
			"r.finished_at AS run_finished_at, r.counts AS run_counts").
		Joins("JOIN runs r ON r.id = tr.run_id").
		Where("tr.test_case_id IN ? AND r.organisation_id = ?", caseIDs, u.OrganisationID).
		Order("r.created_at DESC, tr.created_at ASC").
		Scan(&rows)

	runs := []gin.H{}
	byRun := map[string]gin.H{}
	results := map[string][]gin.H{} // run_id -> results (rebuilt per run for the verdict pass)
	order := []string{}
	for i := range rows {
		row := &rows[i]
		if _, ok := byRun[row.RunID]; !ok {
			counts := row.RunCounts
			if counts == nil {
				counts = models.JSONMap{}
			}
			entry := gin.H{
				"run": gin.H{"id": row.RunID, "project_id": row.RunProjectID,
					"environment_id": row.RunEnvID, "state": row.RunState,
					"started_at":  isoPtr(row.RunStartedAt),
					"finished_at": isoPtr(row.RunFinishedAt),
					"counts":      counts},
				"results": []gin.H{},
			}
			byRun[row.RunID] = entry
			order = append(order, row.RunID)
			runs = append(runs, entry)
		}
		results[row.RunID] = append(results[row.RunID], gin.H{
			"test_case_id":      row.TestCaseID,
			"title":             titles[row.TestCaseID],
			"test_case_version": row.TestCaseVersion,
			"outcome":           row.Outcome,
			"duration_ms":       row.DurationMs,
			"executed_at":       iso(row.ResultCreatedAt),
		})
	}

	for _, runID := range order { // requirement-level verdict per run (FR-TRC-07)
		entry := byRun[runID]
		entry["results"] = results[runID]
		verdict, errored := "passed", false
		for _, r := range results[runID] {
			switch r["outcome"] {
			case "failed":
				verdict = "failed"
			case "errored":
				errored = true
			}
		}
		if verdict != "failed" && errored {
			verdict = "errored"
		}
		entry["outcome"] = verdict
	}

	c.JSON(http.StatusOK, gin.H{"requirement_id": req.ID,
		"external_id": req.ExternalID, "runs": runs})
}
