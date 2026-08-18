// Package projects — project CRUD, dashboard, environments + connectivity check.
// 1:1 port of backend/app/modules/projects.py (v2 dashboard incl. trend,
// regression_watch, gaps_detail, open_defects, median_duration_ms).
//
// Environment secrets: `auth_config` is write-only — stored via security.Encrypt,
// never returned; reads expose only `auth_config_masked: bool` + auth_type.
package projects

import (
	"crypto/tls"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
	"traceo/internal/security"
	"traceo/internal/testtypes"
)

var (
	authTypes = []string{"none", "api_key", "basic", "bearer", "oauth2_cc"}
	tcStates  = []string{"draft", "approved", "rejected", "stale", "archived"}

	// v2 gap next-action vocabulary (FR-051) — from backend traceability.py.
	gapNextActions = map[string]string{
		"no_reachable_endpoint": "Import a specification that covers this requirement, or link it manually",
		"all_cases_disabled":    "Approve one of the linked test cases in review",
		"no_approved_cases":     "Generate test cases for this requirement",
	}
)

const runDisplayBase = 1000 // first run of a project renders as #1001

// --- helpers -----------------------------------------------------------------

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

func projectPayload(p *models.Project) gin.H {
	return gin.H{"id": p.ID, "name": p.Name,
		"automation": p.Automation, "status": p.Status,
		"test_types": testtypes.OfProject(p.TestTypes),
		"created_at": iso(p.CreatedAt), "updated_at": iso(p.UpdatedAt)}
}

func envPayload(e *models.Environment) gin.H {
	// NEVER return decrypted auth values (FR-PRJ-04).
	vars := e.Variables
	if vars == nil {
		vars = models.JSONMap{}
	}
	return gin.H{"id": e.ID, "project_id": e.ProjectID, "name": e.Name, "base_url": e.BaseURL,
		"auth_type": e.AuthType, "variables": vars,
		"tls_strict":         e.TLSStrict,
		"auth_config_masked": len(e.AuthConfigEncrypted) > 0,
		"created_at":         iso(e.CreatedAt), "updated_at": iso(e.UpdatedAt)}
}

func runPayload(r *models.Run) gin.H {
	counts := r.Counts
	if counts == nil {
		counts = models.JSONMap{}
	}
	return gin.H{"id": r.ID, "state": r.State, "environment_id": r.EnvironmentID,
		"started_at": isoPtr(r.StartedAt), "finished_at": isoPtr(r.FinishedAt),
		"counts": counts, "initiated_by": r.InitiatedBy,
		"created_at": iso(r.CreatedAt)}
}

// envScoped: org + project isolated environment lookup. Writes the error itself.
func envScoped(c *gin.Context, projectID, envID string) (*models.Environment, bool) {
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return nil, false
	}
	u := httpx.User(c)
	var env models.Environment
	if err := db.DB.First(&env, "id = ?", envID).Error; err != nil ||
		env.ProjectID != projectID || env.OrganisationID != u.OrganisationID {
		httpx.Err(c, http.StatusNotFound, "not_found", "Environment not found")
		return nil, false
	}
	return &env, true
}

func validateAuthType(c *gin.Context, authType string) bool {
	for _, t := range authTypes {
		if t == authType {
			return true
		}
	}
	httpx.Err(c, http.StatusUnprocessableEntity, "invalid_auth_type",
		"auth_type must be one of: "+strings.Join(authTypes, ", "))
	return false
}

func validAutomation(c *gin.Context, automation string) bool {
	if automation == "auto" || automation == "manual" {
		return true
	}
	httpx.Err(c, http.StatusUnprocessableEntity, "invalid_automation",
		"Automation must be 'auto' or 'manual'")
	return false
}

func cfgStr(m map[string]any, k string) string {
	s, _ := m[k].(string)
	return s
}

// --- routes ------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())
	g.POST("/projects", httpx.Require("manage_projects"), createProject)
	g.GET("/projects", httpx.Require("view"), listProjects)
	g.GET("/projects/:project_id", httpx.Require("view"), getProject)
	g.PATCH("/projects/:project_id", httpx.Require("manage_projects"), updateProject)
	g.DELETE("/projects/:project_id", httpx.Require("manage_projects"), deleteProject)
	g.GET("/projects/:project_id/dashboard", httpx.Require("view"), projectDashboard)

	g.GET("/projects/:project_id/environments", httpx.Require("view"), listEnvironments)
	g.POST("/projects/:project_id/environments", httpx.Require("manage_environments"), createEnvironment)
	g.GET("/projects/:project_id/environments/:env_id", httpx.Require("view"), getEnvironment)
	g.PATCH("/projects/:project_id/environments/:env_id", httpx.Require("manage_environments"), updateEnvironment)
	g.DELETE("/projects/:project_id/environments/:env_id", httpx.Require("manage_environments"), deleteEnvironment)
	g.POST("/projects/:project_id/environments/:env_id/check", httpx.Require("trigger_run"), checkEnvironment)
}

// errWithList refuses with the legal vocabulary attached, so a caller that sent
// a wrong value is told what the right ones are instead of having to guess.
func errWithList(c *gin.Context, code, message string, allowed []string) {
	c.AbortWithStatusJSON(http.StatusUnprocessableEntity, gin.H{"detail": gin.H{
		"code": code, "message": message, "errors": allowed}})
}

// --- projects ----------------------------------------------------------------

func createProject(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		Name       string  `json:"name"`
		Automation *string `json:"automation"` // optional; "auto" (default) | "manual"
		// Omitted means all five (internal/testtypes): a project narrows its
		// scope by saying so, never by staying silent.
		TestTypes []string `json:"test_types"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if len(body.Name) < 1 || len(body.Name) > 200 {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
		return
	}
	automation := "auto"
	if body.Automation != nil {
		automation = *body.Automation
	}
	if !validAutomation(c, automation) {
		return
	}
	chosen := testtypes.DefaultForProject()
	if body.TestTypes != nil {
		valid, code, message := testtypes.Validate(body.TestTypes, false)
		if code != "" {
			errWithList(c, code, message, testtypes.All)
			return
		}
		chosen = valid
	}
	project := models.Project{OrganisationID: u.OrganisationID,
		Name: strings.TrimSpace(body.Name), Automation: automation, TestTypes: chosen}
	if err := db.DB.Create(&project).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create project")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "project.create", "project", project.ID,
		models.JSONMap{"name": project.Name, "automation": project.Automation,
			"test_types": chosen})
	c.JSON(http.StatusCreated, projectPayload(&project))
}

func listProjects(c *gin.Context) {
	u := httpx.User(c)
	q := db.DB.Where("organisation_id = ?", u.OrganisationID)
	if status := c.Query("status"); status != "" {
		q = q.Where("status = ?", status)
	}
	var projects []models.Project
	q.Order("created_at desc").Find(&projects)
	out := make([]gin.H, 0, len(projects))
	for i := range projects {
		out = append(out, projectPayload(&projects[i]))
	}
	c.JSON(http.StatusOK, out)
}

func getProject(c *gin.Context) {
	p, ok := httpx.ProjectScoped(c, c.Param("project_id"))
	if !ok {
		return
	}
	c.JSON(http.StatusOK, projectPayload(p))
}

func updateProject(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		Name       *string  `json:"name"`
		Automation *string  `json:"automation"`
		TestTypes  []string `json:"test_types"`
		Status     *string  `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	project, ok := httpx.ProjectScoped(c, c.Param("project_id"))
	if !ok {
		return
	}
	changes := models.JSONMap{}
	if body.Name != nil {
		if len(*body.Name) < 1 || len(*body.Name) > 200 {
			httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
			return
		}
		name := strings.TrimSpace(*body.Name)
		changes["name"] = map[string]any{"from": project.Name, "to": name}
		project.Name = name
	}
	if body.Automation != nil {
		if !validAutomation(c, *body.Automation) {
			return
		}
		changes["automation"] = map[string]any{"from": project.Automation, "to": *body.Automation}
		project.Automation = *body.Automation
	}
	if body.TestTypes != nil {
		chosen, code, message := testtypes.Validate(body.TestTypes, false)
		if code != "" {
			errWithList(c, code, message, testtypes.All)
			return
		}
		changes["test_types"] = map[string]any{
			"from": testtypes.OfProject(project.TestTypes), "to": chosen}
		project.TestTypes = chosen
	}
	if body.Status != nil {
		if *body.Status != "active" && *body.Status != "archived" {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_status",
				"Status must be 'active' or 'archived'")
			return
		}
		changes["status"] = map[string]any{"from": project.Status, "to": *body.Status}
		project.Status = *body.Status // archive = status change, data retained
	}
	if len(changes) > 0 {
		action := "project.update"
		if st, ok2 := changes["status"].(map[string]any); ok2 && st["to"] == "archived" {
			action = "project.archive"
		}
		httpx.Audit(u.OrganisationID, &u.ID, action, "project", project.ID, changes)
	}
	db.DB.Save(project)
	c.JSON(http.StatusOK, projectPayload(project))
}

// deleteProject cascade-deletes all project data. Audit entries are KEPT (FR data handling).
func deleteProject(c *gin.Context) {
	u := httpx.User(c)
	project, ok := httpx.ProjectScoped(c, c.Param("project_id"))
	if !ok {
		return
	}
	pid, org := project.ID, u.OrganisationID

	var runIDs, caseIDs, reqIDs []string
	db.DB.Model(&models.Run{}).Where("project_id = ? AND organisation_id = ?", pid, org).Pluck("id", &runIDs)
	db.DB.Model(&models.TestCase{}).Where("project_id = ? AND organisation_id = ?", pid, org).Pluck("id", &caseIDs)
	db.DB.Model(&models.Requirement{}).Where("project_id = ? AND organisation_id = ?", pid, org).Pluck("id", &reqIDs)

	if len(runIDs) > 0 {
		db.DB.Where("run_id IN ?", runIDs).Delete(&models.TestResult{})
	}
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.Run{})
	if len(caseIDs) > 0 || len(reqIDs) > 0 {
		db.DB.Where("test_case_id IN ? OR requirement_id IN ?", caseIDs, reqIDs).
			Delete(&models.RequirementTestCase{})
	}
	if len(caseIDs) > 0 {
		db.DB.Where("test_case_id IN ?", caseIDs).Delete(&models.TestStep{})
	}
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.TestCase{})
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.Endpoint{})
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.ApiSpec{})
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.Requirement{})
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.SourceDocument{})
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).Delete(&models.Environment{})
	db.DB.Delete(&models.Project{}, "id = ?", pid)
	httpx.Audit(org, &u.ID, "project.delete", "project", pid, models.JSONMap{"name": project.Name})
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// --- dashboard (FR-PRJ-07 + v2 FR-054/FR-062/FR-051/FR-052) --------------------

func round1(x float64) float64 { return math.Round(x*10) / 10 }

func cint(m models.JSONMap, k string) int {
	if m == nil {
		return 0
	}
	switch v := m[k].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case json.Number:
		i, _ := v.Int64()
		return int(i)
	}
	return 0
}

func runCoveragePct(r *models.Run) float64 {
	total := cint(r.Counts, "total")
	if total == 0 {
		return 0.0
	}
	return round1(float64(cint(r.Counts, "passed")) / float64(total) * 100)
}

func medianInt(values []float64) *int {
	if len(values) == 0 {
		return nil
	}
	sort.Float64s(values)
	n := len(values)
	mid := n / 2
	var m int
	if n%2 == 1 {
		m = int(values[mid])
	} else {
		m = int((values[mid-1] + values[mid]) / 2)
	}
	return &m
}

// runDisplayIDs: run_id -> chronological #1001-style display id within the project.
func runDisplayIDs(projectID string) map[string]int {
	var ids []string
	db.DB.Model(&models.Run{}).Where("project_id = ?", projectID).
		Order("created_at asc, id asc").Pluck("id", &ids)
	out := make(map[string]int, len(ids))
	for i, id := range ids {
		out[id] = runDisplayBase + i + 1
	}
	return out
}

func isHighPriority(priority string) bool {
	p := strings.ToLower(priority)
	return p == "high" || p == "critical"
}

// deriveSeverity — FR-052 severity = requirement priority × failure class
// (port of backend/app/modules/traceability.py derive_severity).
//
//	critical = high-priority requirement + business-rule failure (json_field assertion);
//	major    = schema (json_schema) failure OR transport error OR high-priority other;
//	minor    = everything else.
func deriveSeverity(outcome string, failureReason models.JSONMap, highPriority bool) string {
	fr := failureReason
	if fr == nil {
		fr = models.JSONMap{}
	}
	assertion := map[string]any{}
	if a, ok := fr["assertion"].(map[string]any); ok {
		assertion = a
	}
	errTruthy := false
	switch e := fr["error"].(type) {
	case string:
		errTruthy = e != ""
	case bool:
		errTruthy = e
	case nil:
	default:
		errTruthy = true
	}
	if outcome == "errored" || (errTruthy && len(assertion) == 0) {
		return "major" // transport / execution error
	}
	switch assertion["type"] {
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

// gapReason — v2 gap-reason vocabulary for an uncovered confirmed requirement.
func gapReason(caseStates []string) string {
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

// outcomeMap: test_case_id -> latest TestResult within one run (ascending scan, last wins).
func outcomeMap(runID string) map[string]*models.TestResult {
	var rows []models.TestResult
	db.DB.Where("run_id = ?", runID).Order("created_at asc, id asc").Find(&rows)
	out := map[string]*models.TestResult{}
	for i := range rows {
		out[rows[i].TestCaseID] = &rows[i]
	}
	return out
}

type caseReqInfo struct {
	ExternalIDs  []string
	HighPriority bool
}

// caseRequirementInfo: case_id -> {external_ids, high_priority} over linked requirements.
func caseRequirementInfo(caseIDs []string) map[string]*caseReqInfo {
	info := make(map[string]*caseReqInfo, len(caseIDs))
	for _, cid := range caseIDs {
		info[cid] = &caseReqInfo{ExternalIDs: []string{}}
	}
	if len(caseIDs) == 0 {
		return info
	}
	var rows []struct {
		TestCaseID string
		ExternalID string
		Priority   string
	}
	db.DB.Table("requirement_test_cases").
		Select("requirement_test_cases.test_case_id, requirements.external_id, requirements.priority").
		Joins("JOIN requirements ON requirements.id = requirement_test_cases.requirement_id").
		Where("requirement_test_cases.test_case_id IN ?", caseIDs).
		Scan(&rows)
	for _, row := range rows {
		entry := info[row.TestCaseID]
		if entry == nil {
			continue
		}
		if row.ExternalID != "" {
			entry.ExternalIDs = append(entry.ExternalIDs, row.ExternalID)
		}
		if isHighPriority(row.Priority) {
			entry.HighPriority = true
		}
	}
	return info
}

func projectDashboard(c *gin.Context) {
	u := httpx.User(c)
	pid := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, pid); !ok {
		return
	}
	org := u.OrganisationID

	var requirementCount, confirmedCount int64
	db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ?", pid, org).Count(&requirementCount)
	db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?", pid, org, "confirmed").
		Count(&confirmedCount)

	tcCounts := gin.H{}
	for _, s := range tcStates {
		tcCounts[s] = 0
	}
	var stateRows []struct {
		State string
		N     int64
	}
	db.DB.Model(&models.TestCase{}).Select("state, count(*) as n").
		Where("project_id = ? AND organisation_id = ?", pid, org).
		Group("state").Scan(&stateRows)
	for _, row := range stateRows {
		if _, ok := tcCounts[row.State]; ok {
			tcCounts[row.State] = row.N
		}
	}

	// coverage: confirmed requirements with >=1 approved linked case / confirmed (0 if none)
	var covered int64
	db.DB.Table("requirement_test_cases").
		Joins("JOIN requirements ON requirements.id = requirement_test_cases.requirement_id").
		Joins("JOIN test_cases ON test_cases.id = requirement_test_cases.test_case_id").
		Where("requirements.project_id = ? AND requirements.organisation_id = ? AND requirements.state = ? AND test_cases.state = ?",
			pid, org, "confirmed", "approved").
		Distinct("requirement_test_cases.requirement_id").
		Count(&covered)
	coveragePct := 0.0
	if confirmedCount > 0 {
		coveragePct = round1(100.0 * float64(covered) / float64(confirmedCount))
	}

	var latest models.Run
	hasLatest := db.DB.Where("project_id = ? AND organisation_id = ?", pid, org).
		Order("created_at desc").First(&latest).Error == nil

	displayIDs := runDisplayIDs(pid)

	// -- trend (FR-054): last 14 completed runs, oldest -> newest
	var completed []models.Run
	db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?", pid, org, "completed").
		Order("created_at desc, id desc").Limit(14).Find(&completed)
	for i, j := 0, len(completed)-1; i < j; i, j = i+1, j-1 {
		completed[i], completed[j] = completed[j], completed[i]
	}
	trend := make([]gin.H, 0, len(completed))
	for i := range completed {
		r := &completed[i]
		var did any
		if v, ok := displayIDs[r.ID]; ok {
			did = v
		}
		trend = append(trend, gin.H{
			"run_id": r.ID, "display_id": did,
			"coverage_pct": runCoveragePct(r),
			"passed":       cint(r.Counts, "passed"),
			"failed":       cint(r.Counts, "failed"),
			"errored":      cint(r.Counts, "errored"),
		})
	}

	// -- median run duration over the same window
	durations := []float64{}
	for i := range completed {
		if completed[i].StartedAt != nil && completed[i].FinishedAt != nil {
			durations = append(durations,
				completed[i].FinishedAt.Sub(*completed[i].StartedAt).Seconds()*1000)
		}
	}
	var medianDurationMs any
	if m := medianInt(durations); m != nil {
		medianDurationMs = *m
	}

	// -- open defects (FR-052) + regression watch (FR-062) on the completed runs
	openDefects := gin.H{"total": 0, "critical": 0}
	regressionWatch := []gin.H{}
	if len(completed) > 0 {
		latestCompleted := &completed[len(completed)-1]
		latestResults := outcomeMap(latestCompleted.ID)
		failing := map[string]*models.TestResult{}
		failIDs := []string{}
		for cid, res := range latestResults {
			if res.Outcome == "failed" || res.Outcome == "errored" {
				failing[cid] = res
				failIDs = append(failIDs, cid)
			}
		}
		reqInfo := caseRequirementInfo(failIDs)
		critical := 0
		for cid, res := range failing {
			if deriveSeverity(res.Outcome, res.FailureReason, reqInfo[cid].HighPriority) == "critical" {
				critical++
			}
		}
		openDefects = gin.H{"total": len(failing), "critical": critical}

		if len(completed) >= 2 {
			previousResults := outcomeMap(completed[len(completed)-2].ID)
			regressed := map[string]*models.TestResult{}
			regressedIDs := []string{}
			for cid, res := range failing {
				if prev, ok := previousResults[cid]; ok && prev.Outcome == "passed" {
					regressed[cid] = res
					regressedIDs = append(regressedIDs, cid)
				}
			}
			if len(regressed) > 0 {
				var tcs []models.TestCase
				db.DB.Where("id IN ?", regressedIDs).Find(&tcs)
				titles := map[string]string{}
				for i := range tcs {
					titles[tcs[i].ID] = tcs[i].Title
				}
				sort.Slice(regressedIDs, func(i, j int) bool {
					ti, tj := titles[regressedIDs[i]], titles[regressedIDs[j]]
					if ti != tj {
						return ti < tj
					}
					return regressedIDs[i] < regressedIDs[j]
				})
				for _, cid := range regressedIDs {
					res := regressed[cid]
					regressionWatch = append(regressionWatch, gin.H{
						"test_case_id":             cid,
						"title":                    titles[cid],
						"requirement_external_ids": reqInfo[cid].ExternalIDs,
						"run_id":                   latestCompleted.ID,
						"outcome":                  res.Outcome,
						"severity": deriveSeverity(res.Outcome, res.FailureReason,
							reqInfo[cid].HighPriority),
					})
				}
			}
		}
	}

	// -- gap detail (FR-051): uncovered confirmed requirements + next action
	var confirmedReqs []models.Requirement
	db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?", pid, org, "confirmed").
		Order("external_id asc, created_at asc").Find(&confirmedReqs)
	var linkRows []struct {
		Rid   string
		State string
	}
	db.DB.Table("requirement_test_cases").
		Select("requirement_test_cases.requirement_id AS rid, test_cases.state AS state").
		Joins("JOIN test_cases ON test_cases.id = requirement_test_cases.test_case_id").
		Where("test_cases.project_id = ? AND test_cases.organisation_id = ?", pid, org).
		Scan(&linkRows)
	statesByReq := map[string][]string{}
	for _, row := range linkRows {
		statesByReq[row.Rid] = append(statesByReq[row.Rid], row.State)
	}
	gapsDetail := []gin.H{}
	for i := range confirmedReqs {
		req := &confirmedReqs[i]
		states := statesByReq[req.ID]
		approved := false
		for _, s := range states {
			if s == "approved" {
				approved = true
				break
			}
		}
		if approved {
			continue
		}
		reason := gapReason(states)
		gapsDetail = append(gapsDetail, gin.H{
			"requirement_id": req.ID, "external_id": req.ExternalID,
			"reason": reason, "next_action": gapNextActions[reason],
		})
	}

	var latestPayload any
	if hasLatest {
		lp := runPayload(&latest)
		var did any
		if v, ok := displayIDs[latest.ID]; ok {
			did = v
		}
		lp["display_id"] = did
		latestPayload = lp
	}

	c.JSON(http.StatusOK, gin.H{
		"requirement_count":  requirementCount,
		"confirmed_count":    confirmedCount,
		"test_case_counts":   tcCounts,
		"coverage_pct":       coveragePct,
		"latest_run":         latestPayload,
		"trend":              trend,
		"regression_watch":   regressionWatch,
		"gaps_detail":        gapsDetail,
		"open_defects":       openDefects,
		"median_duration_ms": medianDurationMs,
	})
}

// --- environments (FR-PRJ-04/05) -----------------------------------------------

func listEnvironments(c *gin.Context) {
	u := httpx.User(c)
	pid := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, pid); !ok {
		return
	}
	var envs []models.Environment
	db.DB.Where("project_id = ? AND organisation_id = ?", pid, u.OrganisationID).
		Order("created_at asc").Find(&envs)
	out := make([]gin.H, 0, len(envs))
	for i := range envs {
		out = append(out, envPayload(&envs[i]))
	}
	c.JSON(http.StatusOK, out)
}

func createEnvironment(c *gin.Context) {
	u := httpx.User(c)
	pid := c.Param("project_id")
	var body struct {
		Name       string         `json:"name"`
		BaseURL    string         `json:"base_url"`
		AuthType   *string        `json:"auth_type"`
		AuthConfig map[string]any `json:"auth_config"` // write-only
		Variables  map[string]any `json:"variables"`
		TLSStrict  *bool          `json:"tls_strict"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if _, ok := httpx.ProjectScoped(c, pid); !ok {
		return
	}
	if len(body.Name) < 1 || len(body.Name) > 100 ||
		len(body.BaseURL) < 1 || len(body.BaseURL) > 500 {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
		return
	}
	authType := "none"
	if body.AuthType != nil {
		authType = *body.AuthType
	}
	if !validateAuthType(c, authType) {
		return
	}
	variables := models.JSONMap{}
	if body.Variables != nil {
		variables = models.JSONMap(body.Variables)
	}
	tlsStrict := true
	if body.TLSStrict != nil {
		tlsStrict = *body.TLSStrict
	}
	env, err := CreateEnvironment(u.OrganisationID, pid, body.Name, body.BaseURL,
		authType, variables, tlsStrict, body.AuthConfig)
	if err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create environment")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "environment.create", "environment", env.ID,
		models.JSONMap{"name": env.Name, "auth_type": env.AuthType,
			"auth_config_set": len(env.AuthConfigEncrypted) > 0})
	c.JSON(http.StatusCreated, envPayload(env))
}

// CreateEnvironment persists one environment row. It is the SINGLE place an
// Environment is created, so the auto-created environment an api-specs import
// derives (fixed contract "derive a runnable environment from an imported
// document") is byte-identical in shape to one created through the API: same
// trimming, same defaults, same write-only encryption of auth_config.
//
// Field-length validation and the audit entry stay with the caller — the import
// clips to the column limits instead of rejecting, and records its own action.
func CreateEnvironment(orgID, projectID, name, baseURL, authType string,
	variables map[string]any, tlsStrict bool, authConfig map[string]any) (*models.Environment, error) {
	vars := models.JSONMap{}
	if variables != nil {
		vars = models.JSONMap(variables)
	}
	env := models.Environment{
		OrganisationID: orgID, ProjectID: projectID,
		Name: strings.TrimSpace(name), BaseURL: strings.TrimSpace(baseURL),
		AuthType: authType, Variables: vars, TLSStrict: &tlsStrict,
	}
	if len(authConfig) > 0 {
		env.AuthConfigEncrypted = security.Encrypt(authConfig)
	}
	if err := db.DB.Create(&env).Error; err != nil {
		return nil, err
	}
	return &env, nil
}

func getEnvironment(c *gin.Context) {
	env, ok := envScoped(c, c.Param("project_id"), c.Param("env_id"))
	if !ok {
		return
	}
	c.JSON(http.StatusOK, envPayload(env))
}

func updateEnvironment(c *gin.Context) {
	u := httpx.User(c)
	data, err := io.ReadAll(c.Request.Body)
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	var body struct {
		Name       *string        `json:"name"`
		BaseURL    *string        `json:"base_url"`
		AuthType   *string        `json:"auth_type"`
		AuthConfig map[string]any `json:"auth_config"` // write-only; {} or null clears
		Variables  map[string]any `json:"variables"`
		TLSStrict  *bool          `json:"tls_strict"`
	}
	if err := json.Unmarshal(data, &body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	var probe map[string]json.RawMessage
	_ = json.Unmarshal(data, &probe)
	_, authConfigSet := probe["auth_config"]

	env, ok := envScoped(c, c.Param("project_id"), c.Param("env_id"))
	if !ok {
		return
	}
	changed := []string{}
	if body.Name != nil {
		if len(*body.Name) < 1 || len(*body.Name) > 100 {
			httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
			return
		}
		env.Name = strings.TrimSpace(*body.Name)
		changed = append(changed, "name")
	}
	if body.BaseURL != nil {
		if len(*body.BaseURL) < 1 || len(*body.BaseURL) > 500 {
			httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid field length")
			return
		}
		env.BaseURL = strings.TrimSpace(*body.BaseURL)
		changed = append(changed, "base_url")
	}
	if body.AuthType != nil {
		if !validateAuthType(c, *body.AuthType) {
			return
		}
		env.AuthType = *body.AuthType
		changed = append(changed, "auth_type")
	}
	if authConfigSet {
		// write-only: a dict replaces the secret, {} or null clears it; values never echoed
		if len(body.AuthConfig) > 0 {
			env.AuthConfigEncrypted = security.Encrypt(body.AuthConfig)
		} else {
			env.AuthConfigEncrypted = nil
		}
		changed = append(changed, "auth_config")
	}
	if body.Variables != nil {
		env.Variables = models.JSONMap(body.Variables)
		changed = append(changed, "variables")
	}
	if body.TLSStrict != nil {
		env.TLSStrict = body.TLSStrict
		changed = append(changed, "tls_strict")
	}
	if len(changed) > 0 {
		httpx.Audit(u.OrganisationID, &u.ID, "environment.update", "environment", env.ID,
			models.JSONMap{"fields": changed})
	}
	db.DB.Select("*").Save(env)
	c.JSON(http.StatusOK, envPayload(env))
}

func deleteEnvironment(c *gin.Context) {
	u := httpx.User(c)
	env, ok := envScoped(c, c.Param("project_id"), c.Param("env_id"))
	if !ok {
		return
	}
	var inUse int64
	db.DB.Model(&models.Run{}).Where("environment_id = ?", env.ID).Count(&inUse)
	if inUse > 0 {
		httpx.Err(c, http.StatusConflict, "environment_in_use",
			"Environment has runs recorded against it")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "environment.delete", "environment", env.ID,
		models.JSONMap{"name": env.Name})
	db.DB.Delete(&models.Environment{}, "id = ?", env.ID)
	c.JSON(http.StatusOK, gin.H{"deleted": true})
}

// --- connectivity check (FR-PRJ-06) --------------------------------------------

func httpClient(tlsStrict bool) *http.Client {
	client := &http.Client{Timeout: 5 * time.Second}
	if !tlsStrict {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, // #nosec G402 — user opted out
		}
	}
	return client
}

func checkEnvironment(c *gin.Context) {
	env, ok := envScoped(c, c.Param("project_id"), c.Param("env_id"))
	if !ok {
		return
	}
	cfg := security.Decrypt(env.AuthConfigEncrypted)
	secrets := []string{}
	for _, v := range cfg {
		if s, isStr := v.(string); isStr {
			secrets = append(secrets, s)
		}
	}

	headers := map[string]string{}
	basicUser, basicPass := "", ""
	hasBasic := false
	authApplied := false
	client := httpClient(models.TLSStrictOf(env))

	switch env.AuthType {
	case "api_key":
		if key := cfgStr(cfg, "key"); key != "" {
			header := cfgStr(cfg, "header")
			if header == "" {
				header = "X-API-Key"
			}
			headers[header] = key
			authApplied = true
		}
	case "basic":
		if cfgStr(cfg, "username") != "" || cfgStr(cfg, "password") != "" {
			basicUser, basicPass = cfgStr(cfg, "username"), cfgStr(cfg, "password")
			hasBasic = true
			authApplied = true
		}
	case "bearer":
		if token := cfgStr(cfg, "token"); token != "" {
			headers["Authorization"] = "Bearer " + token
			authApplied = true
		}
	case "oauth2_cc":
		token := cfgStr(cfg, "token")
		if token == "" && cfgStr(cfg, "token_url") != "" && cfgStr(cfg, "client_id") != "" {
			form := url.Values{
				"grant_type":    {"client_credentials"},
				"client_id":     {cfgStr(cfg, "client_id")},
				"client_secret": {cfgStr(cfg, "client_secret")},
			}
			if resp, err := client.PostForm(cfgStr(cfg, "token_url"), form); err == nil {
				if resp.StatusCode < 400 {
					var payload map[string]any
					if json.NewDecoder(resp.Body).Decode(&payload) == nil {
						token, _ = payload["access_token"].(string)
					}
				}
				resp.Body.Close()
			}
		}
		if token != "" {
			headers["Authorization"] = "Bearer " + token
			secrets = append(secrets, token)
			authApplied = true
		}
	}

	if env.BaseURL == "" {
		c.JSON(http.StatusOK, gin.H{"reachable": false, "auth_applied": authApplied,
			"error": "base_url is not set"})
		return
	}

	req, err := http.NewRequest(http.MethodGet, env.BaseURL, nil)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"reachable": false, "auth_applied": authApplied,
			"error": security.Redact(err.Error(), secrets)})
		return
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if hasBasic {
		req.SetBasicAuth(basicUser, basicPass)
	}
	resp, err := client.Do(req) // redirects followed by default
	if err != nil {
		// connectivity probe: report, never leak
		c.JSON(http.StatusOK, gin.H{"reachable": false, "auth_applied": authApplied,
			"error": security.Redact(err.Error(), secrets)})
		return
	}
	defer resp.Body.Close()
	c.JSON(http.StatusOK, gin.H{"reachable": true, "status_code": resp.StatusCode,
		"auth_applied": authApplied})
}
