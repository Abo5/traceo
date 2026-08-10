// Package reporting — 1:1 port of backend/app/modules/reporting.py (TRD §4.8):
// the exportable deliverables. Traceability matrix as a styled XLSX (FR-RPT-04),
// run reports as JSON + a
// self-contained printable HTML page that doubles as the PDF deliverable via the
// browser's print dialog (FR-RPT-01/02/03/05), and run-over-run regression
// comparison (FR-RPT-06).
//
// Route params: runs use `:id` (the integrations package already registered
// /runs/:id/exports/xray.json — gin requires one wildcard name per path segment)
// and projects use `:project_id` (matching projects/ingestion/discovery).
package reporting

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/xuri/excelize/v2"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
)

const (
	xlsxMediaType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	// evidenceHTMLMax is a display cap; stored evidence is already truncated on capture.
	evidenceHTMLMax = 4000
	runDisplayBase  = 1000 // first run of a project renders as #1001
	brandAmber      = "FF8A22"
)

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	r.GET("/projects/:project_id/exports/matrix.xlsx",
		httpx.Auth(), httpx.Require("export"), exportMatrix)
	r.GET("/runs/:id/report", httpx.Auth(), httpx.Require("view"), runReport)
	r.GET("/runs/:id/report.html", httpx.Auth(), httpx.Require("view"), runReportHTML)
	r.GET("/runs/:id/compare/:other_id", httpx.Auth(), httpx.Require("view"), compareRuns)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// iso renders a timestamp the way the rest of the Go port does (RFC3339 UTC).
func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

func isoPtrStr(t *time.Time) string {
	if t == nil {
		return ""
	}
	return iso(*t)
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

func round2(f float64) float64 { return math.Round(f*100) / 100 }

// numInt coerces a JSON-decoded numeric (float64 from the DB columns, int when
// freshly computed) into an int.
func numInt(v any) int {
	switch t := v.(type) {
	case int:
		return t
	case int64:
		return int(t)
	case float64:
		return int(t)
	case float32:
		return int(t)
	case json.Number:
		f, _ := t.Float64()
		return int(f)
	}
	return 0
}

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
	case int:
		return t != 0
	}
	return true
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	if m, ok := v.(models.JSONMap); ok {
		return map[string]any(m)
	}
	return nil
}

func head8(s string) string {
	if len(s) > 8 {
		return s[:8]
	}
	return s
}

// --- local ports of traceability read-time helpers (that module is owned by
// another package; these are pure functions over the shared schema — the
// integrations package carries the same local copies for the same reason) ---

func isHighPriority(priority string) bool {
	p := strings.ToLower(priority)
	return p == "high" || p == "critical"
}

// deriveSeverity — FR-052 severity = requirement priority × failure class.
func deriveSeverity(outcome string, failureReason models.JSONMap, highPriority bool) string {
	fr := failureReason
	if fr == nil {
		fr = models.JSONMap{}
	}
	assertion := asMap(fr["assertion"])
	if outcome == "errored" || (truthy(fr["error"]) && assertion == nil) {
		return "major" // transport / execution error
	}
	atype, _ := assertion["type"].(string)
	if atype == "json_field" { // business-rule class
		if highPriority {
			return "critical"
		}
		return "minor"
	}
	if atype == "json_schema" { // schema class
		return "major"
	}
	if highPriority {
		return "major"
	}
	return "minor"
}

func runDisplayID(run *models.Run) int {
	var ids []string
	db.DB.Model(&models.Run{}).Where("project_id = ?", run.ProjectID).
		Order("created_at ASC, id ASC").Pluck("id", &ids)
	for i, id := range ids {
		if id == run.ID {
			return runDisplayBase + i + 1
		}
	}
	return runDisplayBase + 1
}

func getRunByID(c *gin.Context, runID string) (*models.Run, bool) {
	u := httpx.User(c)
	var run models.Run
	if err := db.DB.First(&run, "id = ? AND organisation_id = ?", runID, u.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Run not found")
		return nil, false
	}
	return &run, true
}

// ---------------------------------------------------------------------------
// Shared data assembly
// ---------------------------------------------------------------------------

type reqRef struct {
	ID          string
	ExternalID  string
	Description string
	Priority    string
}

func (r reqRef) payload() gin.H {
	return gin.H{"id": r.ID, "external_id": r.ExternalID,
		"description": r.Description, "priority": r.Priority}
}

// label — external_id, or the first 8 chars of the uuid when it is empty.
func (r reqRef) label() string {
	if r.ExternalID != "" {
		return r.ExternalID
	}
	return head8(r.ID)
}

// requirementsByCase — test_case_id -> linked requirements.
func requirementsByCase(caseIDs []string) map[string][]reqRef {
	out := make(map[string][]reqRef, len(caseIDs))
	for _, cid := range caseIDs {
		out[cid] = []reqRef{}
	}
	if len(caseIDs) == 0 {
		return out
	}
	var rows []struct {
		TestCaseID  string
		ID          string
		ExternalID  string
		Description string
		Priority    string
	}
	db.DB.Raw(`SELECT rtc.test_case_id, r.id, r.external_id, r.description, r.priority
		FROM requirement_test_cases rtc
		JOIN requirements r ON r.id = rtc.requirement_id
		WHERE rtc.test_case_id IN ?`, caseIDs).Scan(&rows)
	for _, row := range rows {
		if _, ok := out[row.TestCaseID]; !ok {
			continue
		}
		out[row.TestCaseID] = append(out[row.TestCaseID], reqRef{
			ID: row.ID, ExternalID: row.ExternalID,
			Description: row.Description, Priority: row.Priority})
	}
	return out
}

// latestResultMap — test_case_id -> most recent TestResult (ascending scan: last write wins).
func latestResultMap(caseIDs []string) map[string]*models.TestResult {
	latest := map[string]*models.TestResult{}
	if len(caseIDs) == 0 {
		return latest
	}
	var rows []models.TestResult
	db.DB.Where("test_case_id IN ?", caseIDs).
		Order("created_at ASC, id ASC").Find(&rows)
	for i := range rows {
		latest[rows[i].TestCaseID] = &rows[i]
	}
	return latest
}

// runOutcomes — latest result per case WITHIN one run (normally exactly one per case).
func runOutcomes(runID string) map[string]*models.TestResult {
	latest := map[string]*models.TestResult{}
	var rows []models.TestResult
	db.DB.Where("run_id = ?", runID).Order("created_at ASC, id ASC").Find(&rows)
	for i := range rows {
		latest[rows[i].TestCaseID] = &rows[i]
	}
	return latest
}

func runDict(run *models.Run) gin.H {
	counts := run.Counts
	if counts == nil {
		counts = models.JSONMap{}
	}
	var abort any
	if run.AbortReason != "" {
		abort = run.AbortReason
	}
	return gin.H{
		"id": run.ID, "project_id": run.ProjectID, "environment_id": run.EnvironmentID,
		"state": run.State, "started_at": isoPtr(run.StartedAt),
		"finished_at": isoPtr(run.FinishedAt), "counts": counts,
		"initiated_by": run.InitiatedBy, "abort_reason": abort,
		"created_at": iso(run.CreatedAt),
	}
}

// resultRow pairs a result with its (still existing) test case — the Python join.
type resultRow struct {
	Res *models.TestResult
	TC  *models.TestCase
}

func resultRows(runID string) []resultRow {
	var results []models.TestResult
	db.DB.Where("run_id = ?", runID).Order("created_at ASC").Find(&results)
	ids := make([]string, 0, len(results))
	seen := map[string]bool{}
	for _, r := range results {
		if !seen[r.TestCaseID] {
			seen[r.TestCaseID] = true
			ids = append(ids, r.TestCaseID)
		}
	}
	var cases []models.TestCase
	if len(ids) > 0 {
		db.DB.Where("id IN ?", ids).Find(&cases)
	}
	byID := map[string]*models.TestCase{}
	for i := range cases {
		byID[cases[i].ID] = &cases[i]
	}
	rows := make([]resultRow, 0, len(results))
	for i := range results {
		if tc := byID[results[i].TestCaseID]; tc != nil {
			rows = append(rows, resultRow{Res: &results[i], TC: tc})
		}
	}
	return rows
}

// stepsByCase — test_case_id -> steps ordered by `order`.
func stepsByCase(caseIDs []string) map[string][]models.TestStep {
	out := map[string][]models.TestStep{}
	if len(caseIDs) == 0 {
		return out
	}
	var steps []models.TestStep
	db.DB.Where("test_case_id IN ?", caseIDs).Order("step_order ASC").Find(&steps)
	for _, s := range steps {
		out[s.TestCaseID] = append(out[s.TestCaseID], s)
	}
	return out
}

type reportEntry struct {
	TC            *models.TestCase
	Version       int
	Outcome       string
	DurationMs    int
	FailureReason models.JSONMap
	Evidence      models.JSONList
	Requirements  []reqRef
	ExecutedAt    string
	Severity      any // string on failed/errored, nil otherwise (FR-052)
}

func (e *reportEntry) payload() gin.H {
	reqs := make([]gin.H, 0, len(e.Requirements))
	for _, r := range e.Requirements {
		reqs = append(reqs, r.payload())
	}
	evidence := e.Evidence
	if evidence == nil {
		evidence = models.JSONList{}
	}
	return gin.H{
		"test_case": gin.H{"id": e.TC.ID, "title": e.TC.Title,
			"description": e.TC.Description, "type": e.TC.Type,
			"priority": e.TC.Priority, "state": e.TC.State,
			"technique": e.TC.Technique},
		"test_case_version": e.Version,
		"outcome":           e.Outcome,
		"duration_ms":       e.DurationMs,
		"failure_reason":    e.FailureReason,
		"evidence":          evidence,
		"requirements":      reqs,
		"executed_at":       e.ExecutedAt,
		"severity":          e.Severity,
	}
}

func reportEntries(run *models.Run) []*reportEntry {
	rows := resultRows(run.ID)
	caseIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		caseIDs = append(caseIDs, r.TC.ID)
	}
	reqs := requirementsByCase(caseIDs)
	entries := make([]*reportEntry, 0, len(rows))
	for _, row := range rows {
		linked := reqs[row.TC.ID]
		high := false
		for _, r := range linked {
			if isHighPriority(r.Priority) {
				high = true
				break
			}
		}
		evidence := row.Res.Evidence
		if evidence == nil {
			evidence = models.JSONList{}
		}
		var severity any
		if row.Res.Outcome == "failed" || row.Res.Outcome == "errored" {
			severity = deriveSeverity(row.Res.Outcome, row.Res.FailureReason, high)
		}
		entries = append(entries, &reportEntry{
			TC: row.TC, Version: row.Res.TestCaseVersion, Outcome: row.Res.Outcome,
			DurationMs: row.Res.DurationMs, FailureReason: row.Res.FailureReason,
			Evidence: evidence, Requirements: linked,
			ExecutedAt: iso(row.Res.CreatedAt), Severity: severity,
		})
	}
	return entries
}

// countsOf — the persisted run counts, or a tally derived from the entries.
func countsOf(run *models.Run, entries []*reportEntry) models.JSONMap {
	counts := models.JSONMap{}
	for k, v := range run.Counts {
		counts[k] = v
	}
	if len(counts) == 0 {
		counts = models.JSONMap{"total": len(entries), "passed": 0, "failed": 0, "errored": 0}
		for _, e := range entries {
			counts[e.Outcome] = numInt(counts[e.Outcome]) + 1
		}
	}
	return counts
}

// ---------------------------------------------------------------------------
// XLSX traceability matrix (FR-RPT-04)
// ---------------------------------------------------------------------------

func exportMatrix(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}

	var reqs []models.Requirement
	db.DB.Where("project_id = ? AND organisation_id = ? AND state != ?",
		projectID, u.OrganisationID, "removed").
		Order("external_id ASC, created_at ASC").Find(&reqs)
	var cases []models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Order("created_at ASC").Find(&cases)

	caseByID := map[string]*models.TestCase{}
	caseIDs := make([]string, 0, len(cases))
	for i := range cases {
		caseByID[cases[i].ID] = &cases[i]
		caseIDs = append(caseIDs, cases[i].ID)
	}
	reqByID := map[string]*models.Requirement{}
	for i := range reqs {
		reqByID[reqs[i].ID] = &reqs[i]
	}
	var links []models.RequirementTestCase
	if len(caseIDs) > 0 {
		db.DB.Where("test_case_id IN ?", caseIDs).Find(&links)
	}
	casesByReq := map[string][]string{}
	reqsByCase := map[string][]string{}
	for _, link := range links {
		if reqByID[link.RequirementID] != nil && caseByID[link.TestCaseID] != nil {
			casesByReq[link.RequirementID] = append(casesByReq[link.RequirementID], link.TestCaseID)
			reqsByCase[link.TestCaseID] = append(reqsByCase[link.TestCaseID], link.RequirementID)
		}
	}
	latest := latestResultMap(caseIDs)

	reqLabel := func(rid string) string {
		if r := reqByID[rid]; r != nil {
			if r.ExternalID != "" {
				return r.ExternalID
			}
			return head8(r.ID)
		}
		return head8(rid)
	}

	f := excelize.NewFile()
	defer func() { _ = f.Close() }()

	// Brand header: bold white on amber, vertically centred (matches openpyxl).
	headerStyle, err := f.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{brandAmber}},
		Alignment: &excelize.Alignment{Vertical: "center"},
	})
	if err != nil {
		httpx.Err(c, 500, "export_failed", "Could not build the workbook")
		return
	}

	newSheet := func(title string, headers []string, widths []float64) bool {
		if _, e := f.NewSheet(title); e != nil {
			return false
		}
		for i, h := range headers {
			col, _ := excelize.ColumnNumberToName(i + 1)
			_ = f.SetCellValue(title, col+"1", h)
			_ = f.SetCellStyle(title, col+"1", col+"1", headerStyle)
			if i < len(widths) {
				_ = f.SetColWidth(title, col, col, widths[i])
			}
		}
		_ = f.SetPanes(title, &excelize.Panes{ // freeze_panes = "A2"
			Freeze: true, Split: false, XSplit: 0, YSplit: 1,
			TopLeftCell: "A2", ActivePane: "bottomLeft",
			Selection: []excelize.Selection{
				{SQRef: "A2", ActiveCell: "A2", Pane: "bottomLeft"}},
		})
		// Sheets are always left-to-right — the product is English-only.
		ltr := false
		_ = f.SetSheetView(title, -1, &excelize.ViewOptions{RightToLeft: &ltr})
		return true
	}

	rowNum := map[string]int{}
	appendRow := func(title string, values []any) {
		rowNum[title]++
		_ = f.SetSheetRow(title, fmt.Sprintf("A%d", rowNum[title]+1), &values)
	}

	// -- Sheet 1: Requirements
	newSheet("Requirements",
		[]string{"External ID", "Description", "Type", "Priority", "State",
			"Version", "Confidence", "Linked Cases"},
		[]float64{14, 70, 16, 10, 12, 9, 11, 13})
	for i := range reqs {
		r := &reqs[i]
		appendRow("Requirements", []any{r.ExternalID, r.Description, r.Type, r.Priority,
			r.State, r.Version, round2(r.Confidence), len(casesByReq[r.ID])})
	}

	// -- Sheet 2: Test Cases
	newSheet("Test Cases",
		[]string{"Case ID", "Title", "Type", "Priority", "State", "Technique",
			"Source", "User Modified", "Version", "Requirements"},
		[]float64{38, 60, 10, 10, 10, 14, 11, 13, 9, 24})
	for i := range cases {
		cse := &cases[i]
		source := "manual"
		if cse.Generated {
			source = "generated"
		}
		modified := "no"
		if cse.UserModified {
			modified = "yes"
		}
		labels := make([]string, 0, len(reqsByCase[cse.ID]))
		for _, rid := range reqsByCase[cse.ID] {
			labels = append(labels, reqLabel(rid))
		}
		appendRow("Test Cases", []any{cse.ID, cse.Title, cse.Type, cse.Priority, cse.State,
			cse.Technique, source, modified, cse.Version, strings.Join(labels, ", ")})
	}

	// -- Sheet 3: Matrix — one row per requirement<->case link; uncovered reqs still appear
	newSheet("Matrix",
		[]string{"Requirement", "Requirement Description", "Req State", "Case ID",
			"Case Title", "Case State", "Latest Outcome"},
		[]float64{14, 55, 12, 38, 55, 10, 14})
	for i := range reqs {
		r := &reqs[i]
		label := r.ExternalID
		if label == "" {
			label = head8(r.ID)
		}
		linked := casesByReq[r.ID]
		if len(linked) == 0 {
			appendRow("Matrix", []any{label, r.Description, r.State, "", "— NOT COVERED —", "", ""})
			continue
		}
		for _, cid := range linked {
			cse := caseByID[cid]
			outcome := "not_run"
			if res := latest[cid]; res != nil {
				outcome = res.Outcome
			}
			appendRow("Matrix", []any{label, r.Description, r.State,
				cse.ID, cse.Title, cse.State, outcome})
		}
	}

	// -- Sheet 4: Latest Results
	newSheet("Latest Results",
		[]string{"Case ID", "Title", "Case State", "Outcome", "Duration (ms)",
			"Run ID", "Executed At"},
		[]float64{38, 60, 10, 10, 13, 38, 24})
	for i := range cases {
		cse := &cases[i]
		res := latest[cse.ID]
		if res == nil {
			appendRow("Latest Results", []any{cse.ID, cse.Title, cse.State, "not_run", "", "", ""})
			continue
		}
		appendRow("Latest Results", []any{cse.ID, cse.Title, cse.State, res.Outcome,
			res.DurationMs, res.RunID, iso(res.CreatedAt)})
	}

	// openpyxl's wb.remove(wb.active): drop the default sheet excelize creates.
	if idx, e := f.GetSheetIndex("Requirements"); e == nil && idx >= 0 {
		f.SetActiveSheet(idx)
	}
	_ = f.DeleteSheet("Sheet1")

	var buf bytes.Buffer
	if err := f.Write(&buf); err != nil {
		httpx.Err(c, 500, "export_failed", "Could not serialise the workbook")
		return
	}
	filename := "traceo-matrix-" + head8(projectID) + ".xlsx"
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.Data(200, xlsxMediaType, buf.Bytes())
}

// ---------------------------------------------------------------------------
// Run report — JSON (FR-RPT-01/02/03 + FR-044-lite perf block)
// ---------------------------------------------------------------------------

// percentile — nearest-rank percentile over a pre-sorted list. Python's round()
// is banker's rounding (half to even), hence math.RoundToEven here.
func percentile(sorted []int, q float64) int {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	idx := int(math.RoundToEven(q * float64(n-1)))
	if idx < 0 {
		idx = 0
	}
	if idx > n-1 {
		idx = n - 1
	}
	return sorted[idx]
}

type perfKey struct{ Method, Path string }

// perfBlock — per-endpoint latency aggregation from evidence elapsed_ms (FR-044).
// Evidence entries are positional per step, so the step list names the endpoint.
func perfBlock(run *models.Run) []gin.H {
	rows := resultRows(run.ID)
	caseIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		caseIDs = append(caseIDs, r.TC.ID)
	}
	steps := stepsByCase(caseIDs)

	buckets := map[perfKey][]int{}
	for _, row := range rows {
		st := steps[row.TC.ID]
		for i, ev := range row.Res.Evidence {
			m := asMap(ev)
			if m == nil || i >= len(st) {
				continue
			}
			elapsed, ok := numeric(m["elapsed_ms"])
			if !ok {
				continue
			}
			key := perfKey{strings.ToUpper(st[i].Method), st[i].Path}
			buckets[key] = append(buckets[key], int(elapsed))
		}
	}
	keys := make([]perfKey, 0, len(buckets))
	for k := range buckets {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool {
		if keys[a].Path != keys[b].Path {
			return keys[a].Path < keys[b].Path
		}
		return keys[a].Method < keys[b].Method
	})
	perf := make([]gin.H, 0, len(keys))
	for _, k := range keys {
		vals := buckets[k]
		sort.Ints(vals)
		perf = append(perf, gin.H{"method": k.Method, "path": k.Path,
			"p50_ms": percentile(vals, 0.50), "p95_ms": percentile(vals, 0.95),
			"max_ms": vals[len(vals)-1], "calls": len(vals)})
	}
	return perf
}

func numeric(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	}
	return 0, false
}

func runReport(c *gin.Context) {
	run, ok := getRunByID(c, c.Param("id"))
	if !ok {
		return
	}
	entries := reportEntries(run)
	payload := runDict(run)
	payload["display_id"] = runDisplayID(run)
	cases := make([]gin.H, 0, len(entries))
	for _, e := range entries {
		cases = append(cases, e.payload())
	}
	c.JSON(200, gin.H{"run": payload, "counts": countsOf(run, entries),
		"cases": cases, "perf": perfBlock(run)})
}

// ---------------------------------------------------------------------------
// Run comparison (FR-RPT-06)
// ---------------------------------------------------------------------------

func compareRuns(c *gin.Context) {
	run, ok := getRunByID(c, c.Param("id"))
	if !ok {
		return
	}
	other, ok := getRunByID(c, c.Param("other_id"))
	if !ok {
		return
	}
	if run.ProjectID != other.ProjectID {
		httpx.Err(c, 409, "different_projects",
			"Runs belong to different projects and cannot be compared")
		return
	}

	current := runOutcomes(run.ID)
	baseline := runOutcomes(other.ID)
	shared := make([]string, 0, len(current))
	for cid := range current {
		if _, ok := baseline[cid]; ok {
			shared = append(shared, cid)
		}
	}
	sort.Strings(shared)

	titles := map[string]string{}
	if len(shared) > 0 {
		var cases []models.TestCase
		db.DB.Where("id IN ?", shared).Find(&cases)
		for i := range cases {
			titles[cases[i].ID] = cases[i].Title
		}
	}

	newlyFailing := []gin.H{}
	newlyPassing := []gin.H{}
	unchanged := 0
	for _, cid := range shared {
		nowO, prevO := current[cid].Outcome, baseline[cid].Outcome
		item := gin.H{"test_case_id": cid, "title": titles[cid],
			"outcome": nowO, "previous_outcome": prevO}
		switch {
		case (nowO == "failed" || nowO == "errored") && prevO == "passed":
			newlyFailing = append(newlyFailing, item)
		case nowO == "passed" && (prevO == "failed" || prevO == "errored"):
			newlyPassing = append(newlyPassing, item)
		case nowO == prevO:
			unchanged++
		}
	}

	c.JSON(200, gin.H{"run_id": run.ID, "other_id": other.ID,
		"newly_failing": newlyFailing, "newly_passing": newlyPassing,
		"unchanged":      unchanged,
		"coverage_delta": round1(runCoverage(run) - runCoverage(other))})
}

// runCoverage — passed/total of the persisted run counts, one decimal.
func runCoverage(r *models.Run) float64 {
	total := numInt(r.Counts["total"])
	if total == 0 {
		return 0.0
	}
	return round1(float64(numInt(r.Counts["passed"])) / float64(total) * 100)
}
