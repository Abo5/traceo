// Package integrations — v2 addendum port of backend/app/modules/integrations.py:
// public API keys, CI/CD gate, webhooks (SSRF-guarded, HMAC-signed, Slack special
// case), Xray/Jira exports, scheduled runs and the PDPL organisation data export.
//
// X-API-Key alt-auth: the Python router overrides /projects/{id}/traceability,
// /runs/{id} and POST /projects/{id}/runs in place (FastAPI allows mounting first).
// Gin panics on duplicate routes, so the CI gate route is registered HERE with dual
// auth (Bearer OR X-API-Key), and the three wrapped endpoints are exposed as
// API-key-capable aliases under /public/* with identical response shapes:
//
//	GET  /public/traceability/{project_id}
//	GET  /public/runs/{run_id}
//	POST /public/projects/{project_id}/runs
//
// Wiring (no import of the execution package — execution imports THIS package to
// call FireWebhooks on terminal run state, per GO_CONTRACT.md, so importing it back
// would create a cycle): the scheduler and the public run-launch alias create the
// Run row themselves and hand execution off through the ExecuteRun hook below.
package integrations

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/security"
)

const (
	keyPrefix           = "trc_"
	keyHexChars         = 40
	webhookTimeoutS     = 5
	schedulerIntervalS  = 60
	minScheduleInterval = 15
	runDisplayBase      = 1000 // first run of a project renders as #1001
)

var supportedEvents = []string{"run.completed"}

// FireWebhooks fires all enabled project webhooks subscribed to `event`. One
// attempt each, status recorded, never panics. Called by the execution module on
// terminal run state (execution imports integrations — one-way, no cycle).
func FireWebhooks(projectID, event string, payload map[string]any) {
	defer func() { _ = recover() }()
	var hooks []models.Webhook
	if err := db.DB.Where("project_id = ? AND enabled = ?", projectID, true).Find(&hooks).Error; err != nil {
		return
	}
	summary := slackSummary(payload)
	for i := range hooks {
		w := &hooks[i]
		if !eventSubscribed(w, event) {
			continue
		}
		status := deliver(w, event, payload, summary)
		now := time.Now().UTC()
		w.LastStatus = status
		w.LastFiredAt = &now
		db.DB.Model(&models.Webhook{}).Where("id = ?", w.ID).
			Updates(map[string]any{"last_status": status, "last_fired_at": now})
	}
}

// ExecuteRun, when wired (see cmd/server/main.go), executes a queued run the same
// way POST /projects/{id}/runs does. Until wired, scheduler/public launches leave
// the run in state "queued".
var ExecuteRun func(j *jobs.Job, runID string, caseIDs []string) (any, error)

// LaunchRunForSchedule — nil-safe indirection to the execution module's scheduled
// launch entrypoint (same name as the exported symbol the execution module provides).
// integrations cannot import execution directly: execution imports THIS package for
// FireWebhooks (GO_CONTRACT.md), so the reverse import would be a cycle. Wire in
// main.go once execution lands:
//
//	integrations.LaunchRunForSchedule = execution.LaunchRunForSchedule
//
// When nil, the scheduler falls back to creating the queued Run itself (Python
// `_launch_scheduled_run` port) and executing via the ExecuteRun hook if set.
var LaunchRunForSchedule func(projectID, envID, userID string) error

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	// API keys (FR-061 token surface)
	r.POST("/api-keys", httpx.Auth(), httpx.Require("manage_projects"), createAPIKey)
	r.GET("/api-keys", httpx.Auth(), httpx.Require("view"), listAPIKeys)
	r.POST("/api-keys/:id/revoke", httpx.Auth(), httpx.Require("manage_projects"), revokeAPIKey)

	// CI/CD gate — dual auth (Bearer JWT or X-API-Key)
	r.GET("/projects/:project_id/gate", ciGate)

	// Public (X-API-Key capable) aliases of the wrapped Python endpoints.
	r.GET("/public/traceability/:id", publicTraceability)
	r.GET("/public/runs/:id", publicGetRun)
	r.POST("/public/projects/:id/runs", publicLaunchRun)

	// Webhooks (FR-070/072 transport)
	r.GET("/projects/:project_id/webhooks", httpx.Auth(), httpx.Require("view"), listWebhooks)
	r.POST("/projects/:project_id/webhooks", httpx.Auth(), httpx.Require("manage_projects"), createWebhook)
	r.PATCH("/webhooks/:id", httpx.Auth(), httpx.Require("manage_projects"), updateWebhook)
	r.DELETE("/webhooks/:id", httpx.Auth(), httpx.Require("manage_projects"), deleteWebhook)
	r.POST("/webhooks/:id/test", httpx.Auth(), httpx.Require("manage_projects"), testWebhook)

	// Xray / Jira exports (FR-070)
	r.GET("/runs/:id/exports/xray.json", httpx.Auth(), httpx.Require("export"), exportXray)
	r.GET("/runs/:id/exports/defects.csv", httpx.Auth(), httpx.Require("export"), exportDefectsCSV)

	// Schedules (FR-060)
	r.GET("/projects/:project_id/schedules", httpx.Auth(), httpx.Require("view"), listSchedules)
	r.POST("/projects/:project_id/schedules", httpx.Auth(), httpx.Require("manage_projects"), createSchedule)
	r.PATCH("/schedules/:id", httpx.Auth(), httpx.Require("manage_projects"), updateSchedule)
	r.DELETE("/schedules/:id", httpx.Auth(), httpx.Require("manage_projects"), deleteSchedule)

	// Organisation data export (FR-082, PDPL)
	r.GET("/export/organisation", httpx.Auth(), httpx.Require("manage_members"), exportOrganisation)
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

func utcnow() time.Time { return time.Now().UTC() }

func iso(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339)
}

func isoV(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// jsonCompact marshals without HTML escaping (parity with json.dumps ensure_ascii=False).
func jsonCompact(v any) []byte {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return []byte(strings.TrimSuffix(b.String(), "\n"))
}

func jsonIndent(v any) []byte {
	var b strings.Builder
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
	return []byte(strings.TrimSuffix(b.String(), "\n"))
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }

// --- local ports of traceability helpers (that module is owned by another
// package; these read-time helpers are pure functions over the shared schema) ---

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
	assertion, _ := fr["assertion"].(map[string]any)
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

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	default:
		return true
	}
}

func runDisplayIDs(projectID string) map[string]int {
	var ids []string
	db.DB.Model(&models.Run{}).Where("project_id = ?", projectID).
		Order("created_at ASC, id ASC").Pluck("id", &ids)
	out := make(map[string]int, len(ids))
	for i, id := range ids {
		out[id] = runDisplayBase + i + 1
	}
	return out
}

func runDisplayID(run *models.Run) int {
	if n, ok := runDisplayIDs(run.ProjectID)[run.ID]; ok {
		return n
	}
	return runDisplayBase + 1
}

// ---------------------------------------------------------------------------
// API keys (FR-061 token surface)
// ---------------------------------------------------------------------------

func keyDict(k *models.ApiKey) gin.H {
	return gin.H{"id": k.ID, "name": k.Name, "prefix": k.Prefix,
		"created_at": isoV(k.CreatedAt), "last_used_at": iso(k.LastUsedAt),
		"revoked": k.Revoked}
}

func createAPIKey(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		Name string `json:"name"`
	}
	_ = c.ShouldBindJSON(&body)
	name := strings.TrimSpace(body.Name)
	if name == "" {
		httpx.Err(c, 422, "invalid_name", "API key name is required")
		return
	}
	raw := make([]byte, keyHexChars/2)
	_, _ = rand.Read(raw)
	fullKey := keyPrefix + hex.EncodeToString(raw) // trc_ + 40 hex
	sum := sha256.Sum256([]byte(fullKey))
	k := models.ApiKey{OrganisationID: u.OrganisationID, Name: name,
		Prefix: fullKey[:8], KeyHash: hex.EncodeToString(sum[:]), CreatedBy: u.ID}
	if err := db.DB.Create(&k).Error; err != nil {
		httpx.Err(c, 500, "db_error", "Could not create API key")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "api_key.created", "api_key", k.ID,
		models.JSONMap{"name": name, "prefix": k.Prefix})
	// The full key is returned ONCE — only the sha256 hash is stored.
	c.JSON(201, gin.H{"id": k.ID, "name": k.Name, "prefix": k.Prefix, "key": fullKey})
}

func listAPIKeys(c *gin.Context) {
	u := httpx.User(c)
	var keys []models.ApiKey
	db.DB.Where("organisation_id = ?", u.OrganisationID).
		Order("created_at DESC").Find(&keys)
	out := make([]gin.H, 0, len(keys))
	for i := range keys {
		out = append(out, keyDict(&keys[i]))
	}
	c.JSON(200, out)
}

func revokeAPIKey(c *gin.Context) {
	u := httpx.User(c)
	var k models.ApiKey
	if err := db.DB.First(&k, "id = ? AND organisation_id = ?", c.Param("id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "API key not found")
		return
	}
	k.Revoked = true
	db.DB.Model(&k).Update("revoked", true)
	httpx.Audit(u.OrganisationID, &u.ID, "api_key.revoked", "api_key", k.ID,
		models.JSONMap{"name": k.Name, "prefix": k.Prefix})
	c.JSON(200, keyDict(&k))
}

// ---------------------------------------------------------------------------
// Alt auth: X-API-Key OR Bearer JWT (public API surface only)
// ---------------------------------------------------------------------------

// userOrAPIKey resolves either an `X-API-Key: trc_...` header or the standard
// Bearer JWT. API keys map to a synthetic org-scoped qa_engineer actor.
// On failure it writes the 401 response and returns ok=false.
// init installs the key resolver so httpx.AuthOrAPIKey() can honour `X-API-Key`
// on the canonical CI routes owned by the execution/traceability modules.
func init() { httpx.APIKeyResolver = resolveAPIKey }

// resolveAPIKey maps a raw `trc_...` key to a transient (never persisted)
// org-scoped actor with qa_engineer capabilities.
func resolveAPIKey(apiKey string) (*models.User, bool) {
	sum := sha256.Sum256([]byte(apiKey))
	var k models.ApiKey
	if err := db.DB.First(&k, "key_hash = ?", hex.EncodeToString(sum[:])).Error; err != nil || k.Revoked {
		return nil, false
	}
	db.DB.Model(&k).Update("last_used_at", utcnow())
	u := &models.User{OrganisationID: k.OrganisationID, Email: "",
		Name: "API key: " + k.Name, Role: "qa_engineer", Locale: "en"}
	u.ID = k.ID
	return u, true
}

func userOrAPIKey(c *gin.Context) (*models.User, bool) {
	if apiKey := c.GetHeader("X-API-Key"); apiKey != "" {
		u, ok := resolveAPIKey(apiKey)
		if !ok {
			httpx.Err(c, 401, "invalid_api_key", "Unknown or revoked API key")
			return nil, false
		}
		return u, true
	}
	h := c.GetHeader("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		httpx.Err(c, 401, "unauthenticated", "Missing bearer token")
		return nil, false
	}
	claims, err := security.DecodeToken(strings.TrimSpace(strings.TrimPrefix(h, "Bearer ")))
	if err != nil {
		httpx.Err(c, 401, "invalid_token", "Invalid or expired token")
		return nil, false
	}
	var user models.User
	if e := db.DB.First(&user, "id = ?", claims.Sub).Error; e != nil {
		httpx.Err(c, 401, "unknown_user", "User not found")
		return nil, false
	}
	return &user, true
}

func checkCapability(c *gin.Context, actor *models.User, capability string) bool {
	if !security.Has(actor.Role, capability) {
		httpx.Err(c, 403, "forbidden", "Role '"+actor.Role+"' lacks '"+capability+"'")
		return false
	}
	return true
}

// projectScopedFor mirrors httpx.ProjectScoped for a resolved (possibly synthetic) actor.
func projectScopedFor(c *gin.Context, actor *models.User, projectID string) (*models.Project, bool) {
	var p models.Project
	if err := db.DB.First(&p, "id = ? AND organisation_id = ?", projectID, actor.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Project not found")
		return nil, false
	}
	return &p, true
}

// ---------------------------------------------------------------------------
// CI/CD gate (FR-061)
// ---------------------------------------------------------------------------

// projectCoveragePct — confirmed requirements with >=1 approved linked case / all confirmed.
func projectCoveragePct(projectID, orgID string) float64 {
	var confirmed int64
	db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?", projectID, orgID, "confirmed").
		Count(&confirmed)
	if confirmed == 0 {
		return 0.0
	}
	var covered int64
	db.DB.Raw(`SELECT COUNT(DISTINCT rtc.requirement_id)
		FROM requirement_test_cases rtc
		JOIN requirements r ON r.id = rtc.requirement_id
		JOIN test_cases tc ON tc.id = rtc.test_case_id
		WHERE r.project_id = ? AND r.organisation_id = ? AND r.state = 'confirmed'
		AND tc.state = 'approved'`, projectID, orgID).Scan(&covered)
	return round1(100.0 * float64(covered) / float64(confirmed))
}

func latestCompletedRun(projectID, orgID string) *models.Run {
	var run models.Run
	err := db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		projectID, orgID, "completed").
		Order("created_at DESC, id DESC").First(&run).Error
	if err != nil {
		return nil
	}
	return &run
}

// failingResults — test_case_id -> latest failing/errored result within the run.
func failingResults(runID string) map[string]*models.TestResult {
	var rows []models.TestResult
	db.DB.Where("run_id = ?", runID).Order("created_at ASC, id ASC").Find(&rows)
	latest := map[string]*models.TestResult{}
	for i := range rows {
		latest[rows[i].TestCaseID] = &rows[i]
	}
	out := map[string]*models.TestResult{}
	for cid, r := range latest {
		if r.Outcome == "failed" || r.Outcome == "errored" {
			out[cid] = r
		}
	}
	return out
}

type reqInfo struct {
	ExternalIDs  []string
	HighPriority bool
}

// requirementsOfCases — case_id -> {external_ids, high_priority}.
func requirementsOfCases(caseIDs []string) map[string]*reqInfo {
	info := make(map[string]*reqInfo, len(caseIDs))
	for _, cid := range caseIDs {
		info[cid] = &reqInfo{ExternalIDs: []string{}}
	}
	if len(caseIDs) == 0 {
		return info
	}
	var rows []struct {
		TestCaseID string
		ExternalID string
		Priority   string
	}
	db.DB.Raw(`SELECT rtc.test_case_id, r.external_id, r.priority
		FROM requirement_test_cases rtc
		JOIN requirements r ON r.id = rtc.requirement_id
		WHERE rtc.test_case_id IN ?`, caseIDs).Scan(&rows)
	for _, row := range rows {
		e := info[row.TestCaseID]
		if e == nil {
			continue
		}
		if row.ExternalID != "" {
			e.ExternalIDs = append(e.ExternalIDs, row.ExternalID)
		}
		if isHighPriority(row.Priority) {
			e.HighPriority = true
		}
	}
	return info
}

func ciGate(c *gin.Context) {
	actor, ok := userOrAPIKey(c)
	if !ok {
		return
	}
	if !checkCapability(c, actor, "view") {
		return
	}
	projectID := c.Param("project_id")
	if _, ok := projectScopedFor(c, actor, projectID); !ok {
		return
	}
	orgID := actor.OrganisationID

	minCoverage := 80.0
	if v := c.Query("min_coverage"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			minCoverage = f
		}
	}
	maxCritical := 0
	if v := c.Query("max_critical"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxCritical = n
		}
	}
	var maxFailed *int
	if v := c.Query("max_failed"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			maxFailed = &n
		}
	}
	exitFlag := 0
	if v := c.Query("exit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			exitFlag = n
		}
	}

	coveragePct := projectCoveragePct(projectID, orgID)

	latest := latestCompletedRun(projectID, orgID)
	var latestPayload any
	failing := map[string]*models.TestResult{}
	rinfo := map[string]*reqInfo{}
	openDefects := gin.H{"total": 0, "critical": 0}
	if latest != nil {
		counts := latest.Counts
		if counts == nil {
			counts = models.JSONMap{}
		}
		latestPayload = gin.H{"id": latest.ID, "display_id": runDisplayID(latest), "counts": counts}
		failing = failingResults(latest.ID)
		caseIDs := make([]string, 0, len(failing))
		for cid := range failing {
			caseIDs = append(caseIDs, cid)
		}
		rinfo = requirementsOfCases(caseIDs)
		critical := 0
		for cid, res := range failing {
			if deriveSeverity(res.Outcome, res.FailureReason, rinfo[cid].HighPriority) == "critical" {
				critical++
			}
		}
		openDefects = gin.H{"total": len(failing), "critical": critical}
	}

	breachReqs := func(caseIDs []string) []string {
		seen := []string{}
		have := map[string]bool{}
		for _, cid := range caseIDs {
			if e, ok := rinfo[cid]; ok {
				for _, ext := range e.ExternalIDs {
					if !have[ext] {
						have[ext] = true
						seen = append(seen, ext)
					}
				}
			}
		}
		sort.Strings(seen)
		return seen
	}

	breaches := []gin.H{}
	if coveragePct < minCoverage {
		breaches = append(breaches, gin.H{"check": "min_coverage", "limit": minCoverage,
			"actual": coveragePct})
	}
	criticalCount, _ := openDefects["critical"].(int)
	totalCount, _ := openDefects["total"].(int)
	if criticalCount > maxCritical {
		criticalIDs := []string{}
		for cid, res := range failing {
			if deriveSeverity(res.Outcome, res.FailureReason, rinfo[cid].HighPriority) == "critical" {
				criticalIDs = append(criticalIDs, cid)
			}
		}
		breaches = append(breaches, gin.H{"check": "max_critical", "limit": maxCritical,
			"actual": criticalCount, "requirement_external_ids": breachReqs(criticalIDs)})
	}
	if maxFailed != nil && totalCount > *maxFailed {
		allIDs := make([]string, 0, len(failing))
		for cid := range failing {
			allIDs = append(allIDs, cid)
		}
		breaches = append(breaches, gin.H{"check": "max_failed", "limit": *maxFailed,
			"actual": totalCount, "requirement_external_ids": breachReqs(allIDs)})
	}

	gate := gin.H{"pass": len(breaches) == 0, "coverage_pct": coveragePct,
		"open_defects": openDefects, "latest_run": latestPayload, "breaches": breaches}
	if exitFlag != 0 && len(breaches) > 0 {
		// `?exit=1`: non-2xx so `curl -f` fails the CI job (FR-061)
		c.AbortWithStatusJSON(412, gin.H{"detail": gin.H{"code": "gate_failed",
			"message": "Quality gate failed", "gate": gate}})
		return
	}
	c.JSON(200, gate)
}

// ---------------------------------------------------------------------------
// Public API-key surface — aliases with the same response shapes as the
// traceability / execution endpoints (see package comment).
// ---------------------------------------------------------------------------

var gapNextActions = map[string]string{
	"no_reachable_endpoint": "استورد مواصفة تغطي هذا المتطلب أو اربطه يدوياً",
	"all_cases_disabled":    "اعتمد إحدى الحالات المرتبطة في المراجعة",
	"no_approved_cases":     "ولّد حالات لهذا المتطلب",
}

func gapReason(caseStates []string) string {
	if len(caseStates) == 0 {
		return "no_reachable_endpoint"
	}
	for _, s := range caseStates {
		if s == "approved" {
			return "no_approved_cases"
		}
	}
	return "all_cases_disabled"
}

func requirementStatus(cases []gin.H) string {
	approved := []gin.H{}
	for _, cse := range cases {
		if cse["state"] == "approved" {
			approved = append(approved, cse)
		}
	}
	if len(approved) == 0 {
		return "not_covered"
	}
	outcomes := []string{}
	for _, cse := range approved {
		if o, ok := cse["latest_outcome"].(string); ok && o != "" {
			outcomes = append(outcomes, o)
		}
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

func latestOutcomes(caseIDs []string) map[string]string {
	out := map[string]string{}
	if len(caseIDs) == 0 {
		return out
	}
	var rows []models.TestResult
	db.DB.Where("test_case_id IN ?", caseIDs).
		Order("created_at ASC, id ASC").Find(&rows)
	for _, r := range rows { // ascending: last write wins = newest
		out[r.TestCaseID] = r.Outcome
	}
	return out
}

// publicTraceability — same response shape as GET /projects/{id}/traceability.
func publicTraceability(c *gin.Context) {
	actor, ok := userOrAPIKey(c)
	if !ok {
		return
	}
	if !checkCapability(c, actor, "view") {
		return
	}
	projectID := c.Param("id")
	if _, ok := projectScopedFor(c, actor, projectID); !ok {
		return
	}

	var reqs []models.Requirement
	db.DB.Where("project_id = ? AND organisation_id = ? AND state != ?",
		projectID, actor.OrganisationID, "removed").
		Order("external_id ASC, created_at ASC").Find(&reqs)

	var links []models.RequirementTestCase
	db.DB.Raw(`SELECT rtc.* FROM requirement_test_cases rtc
		JOIN test_cases tc ON tc.id = rtc.test_case_id
		WHERE tc.project_id = ? AND tc.organisation_id = ?`,
		projectID, actor.OrganisationID).Scan(&links)
	caseIDSet := map[string]bool{}
	for _, l := range links {
		caseIDSet[l.TestCaseID] = true
	}
	caseIDs := make([]string, 0, len(caseIDSet))
	for id := range caseIDSet {
		caseIDs = append(caseIDs, id)
	}
	var tcs []models.TestCase
	if len(caseIDs) > 0 {
		db.DB.Where("id IN ?", caseIDs).Find(&tcs)
	}
	tcByID := map[string]*models.TestCase{}
	for i := range tcs {
		tcByID[tcs[i].ID] = &tcs[i]
	}
	casesByReq := map[string][]*models.TestCase{}
	for _, l := range links {
		if tc := tcByID[l.TestCaseID]; tc != nil {
			casesByReq[l.RequirementID] = append(casesByReq[l.RequirementID], tc)
		}
	}
	latest := latestOutcomes(caseIDs)

	rows := []gin.H{}
	gaps := []gin.H{}
	confirmedTotal, confirmedCovered := 0, 0
	for i := range reqs {
		req := &reqs[i]
		linked := casesByReq[req.ID]
		sort.Slice(linked, func(a, b int) bool {
			if linked[a].CreatedAt.Equal(linked[b].CreatedAt) {
				return linked[a].ID < linked[b].ID
			}
			return linked[a].CreatedAt.Before(linked[b].CreatedAt)
		})
		cases := []gin.H{}
		states := []string{}
		hasApproved := false
		for _, tc := range linked {
			var lo any
			if o, ok := latest[tc.ID]; ok {
				lo = o
			}
			cases = append(cases, gin.H{"id": tc.ID, "title": tc.Title,
				"state": tc.State, "latest_outcome": lo})
			states = append(states, tc.State)
			if tc.State == "approved" {
				hasApproved = true
			}
		}
		status := requirementStatus(cases)
		if req.State == "confirmed" {
			confirmedTotal++
			if hasApproved {
				confirmedCovered++
			} else {
				reason := gapReason(states)
				gaps = append(gaps, gin.H{"requirement_id": req.ID,
					"external_id": req.ExternalID, "reason": reason,
					"next_action": gapNextActions[reason]})
			}
		}
		rows = append(rows, gin.H{
			"requirement": gin.H{"id": req.ID, "external_id": req.ExternalID,
				"description": req.Description, "type": req.Type,
				"priority": req.Priority, "state": req.State, "version": req.Version},
			"cases":  cases,
			"status": status,
		})
	}
	coveragePct := 0.0
	if confirmedTotal > 0 {
		coveragePct = round1(float64(confirmedCovered) / float64(confirmedTotal) * 100)
	}
	c.JSON(200, gin.H{"rows": rows, "coverage_pct": coveragePct, "gaps": gaps})
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
		"state": run.State, "started_at": iso(run.StartedAt),
		"finished_at": iso(run.FinishedAt), "counts": counts,
		"initiated_by": run.InitiatedBy, "abort_reason": abort,
		"created_at": isoV(run.CreatedAt),
	}
}

// publicGetRun — same response shape as GET /runs/{id}.
func publicGetRun(c *gin.Context) {
	actor, ok := userOrAPIKey(c)
	if !ok {
		return
	}
	if !checkCapability(c, actor, "view") {
		return
	}
	var run models.Run
	if err := db.DB.First(&run, "id = ? AND organisation_id = ?",
		c.Param("id"), actor.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Run not found")
		return
	}
	d := runDict(&run)
	d["display_id"] = runDisplayID(&run)
	c.JSON(200, d)
}

// publicLaunchRun — same behavior/shape as POST /projects/{id}/runs (202 {job_id, run_id}).
func publicLaunchRun(c *gin.Context) {
	actor, ok := userOrAPIKey(c)
	if !ok {
		return
	}
	if !checkCapability(c, actor, "trigger_run") {
		return
	}
	projectID := c.Param("id")
	if _, ok := projectScopedFor(c, actor, projectID); !ok {
		return
	}
	var body struct {
		EnvironmentID string   `json:"environment_id"`
		TestCaseIDs   []string `json:"test_case_ids"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.EnvironmentID == "" {
		httpx.Err(c, 422, "invalid_body", "environment_id is required")
		return
	}
	var env models.Environment
	if err := db.DB.First(&env, "id = ? AND project_id = ? AND organisation_id = ?",
		body.EnvironmentID, projectID, actor.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Environment not found in this project")
		return
	}
	q := db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		projectID, actor.OrganisationID, "approved")
	if len(body.TestCaseIDs) > 0 {
		q = q.Where("id IN ?", body.TestCaseIDs)
	}
	var cases []models.TestCase
	q.Find(&cases)
	if len(cases) == 0 {
		httpx.Err(c, 409, "no_approved_cases", "No approved test cases to execute")
		return
	}
	run := models.Run{OrganisationID: actor.OrganisationID, ProjectID: projectID,
		EnvironmentID: env.ID, State: "queued", InitiatedBy: actor.ID,
		Counts: models.JSONMap{}}
	if err := db.DB.Create(&run).Error; err != nil {
		httpx.Err(c, 500, "db_error", "Could not create run")
		return
	}
	httpx.Audit(actor.OrganisationID, &actor.ID, "run.started", "run", run.ID,
		models.JSONMap{"environment_id": env.ID, "case_count": len(cases)})
	caseIDs := make([]string, len(cases))
	for i, cse := range cases {
		caseIDs[i] = cse.ID
	}
	runID := run.ID
	job := jobs.Submit("execute", func(j *jobs.Job) (any, error) {
		if ExecuteRun != nil {
			return ExecuteRun(j, runID, caseIDs)
		}
		return gin.H{"run_id": runID, "note": "execution engine not wired"}, nil
	})
	c.JSON(202, gin.H{"job_id": job.ID, "run_id": runID})
}

// ---------------------------------------------------------------------------
// Webhooks (FR-070/072 transport)
// ---------------------------------------------------------------------------

// GuardError carries the 422 error code/message from the SSRF guard.
type GuardError struct{ Code, Message string }

func (e *GuardError) Error() string { return e.Message }

// AssertPublicHost resolves the hostname and rejects private/loopback/link-local/
// metadata targets (same rules as the discovery spec fetch). Exported as a variable
// so tests can stub it (parity with the Python monkeypatch).
var AssertPublicHost = func(hostname string) *GuardError {
	if hostname == "" {
		return &GuardError{"invalid_url", "URL has no host."}
	}
	addrs, err := net.LookupHost(hostname)
	if err != nil {
		return &GuardError{"unresolvable_host", "Cannot resolve host '" + hostname + "'."}
	}
	for _, a := range addrs {
		ip := net.ParseIP(a)
		if ip == nil {
			continue
		}
		if ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
			ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified() ||
			a == "169.254.169.254" {
			return &GuardError{"ssrf_blocked",
				"URL resolves to a private, loopback, or metadata address."}
		}
	}
	return nil
}

func validateWebhookURL(c *gin.Context, raw string) bool {
	parts, err := url.Parse(raw)
	if err != nil || (parts.Scheme != "http" && parts.Scheme != "https") {
		httpx.Err(c, 422, "invalid_url", "Only http/https URLs are allowed.")
		return false
	}
	if ge := AssertPublicHost(parts.Hostname()); ge != nil {
		httpx.Err(c, 422, ge.Code, ge.Message)
		return false
	}
	return true
}

func validateEvents(c *gin.Context, events []string) bool {
	for _, e := range events {
		ok := false
		for _, s := range supportedEvents {
			if e == s {
				ok = true
				break
			}
		}
		if !ok {
			httpx.Err(c, 422, "unsupported_event",
				"Unsupported event '"+e+"'. Supported: "+strings.Join(supportedEvents, ", "))
			return false
		}
	}
	return true
}

func eventsList(events []string) models.JSONList {
	out := make(models.JSONList, len(events))
	for i, e := range events {
		out[i] = e
	}
	return out
}

func eventSubscribed(w *models.Webhook, event string) bool {
	for _, e := range w.Events {
		if s, ok := e.(string); ok && s == event {
			return true
		}
	}
	return false
}

func webhookDict(w *models.Webhook) gin.H {
	events := w.Events
	if events == nil {
		events = models.JSONList{}
	}
	var lastStatus any
	if w.LastStatus != nil {
		lastStatus = *w.LastStatus
	}
	return gin.H{"id": w.ID, "project_id": w.ProjectID, "name": w.Name, "url": w.URL,
		"secret_set": w.Secret != "", "events": events, "enabled": w.Enabled,
		"last_status": lastStatus, "last_fired_at": iso(w.LastFiredAt),
		"created_at": isoV(w.CreatedAt)}
}

func getWebhook(c *gin.Context) (*models.Webhook, bool) {
	u := httpx.User(c)
	var w models.Webhook
	if err := db.DB.First(&w, "id = ? AND organisation_id = ?", c.Param("id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Webhook not found")
		return nil, false
	}
	return &w, true
}

func listWebhooks(c *gin.Context) {
	u := httpx.User(c)
	if _, ok := httpx.ProjectScoped(c, c.Param("project_id")); !ok {
		return
	}
	var hooks []models.Webhook
	db.DB.Where("project_id = ? AND organisation_id = ?", c.Param("project_id"), u.OrganisationID).
		Order("created_at ASC").Find(&hooks)
	out := make([]gin.H, 0, len(hooks))
	for i := range hooks {
		out = append(out, webhookDict(&hooks[i]))
	}
	c.JSON(200, out)
}

func createWebhook(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var body struct {
		Name    string    `json:"name"`
		URL     string    `json:"url"`
		Secret  *string   `json:"secret"`
		Events  *[]string `json:"events"`
		Enabled *bool     `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Name == "" || body.URL == "" {
		httpx.Err(c, 422, "invalid_body", "name and url are required")
		return
	}
	if !validateWebhookURL(c, body.URL) {
		return
	}
	events := []string{"run.completed"}
	if body.Events != nil {
		events = *body.Events
	}
	if !validateEvents(c, events) {
		return
	}
	secret := ""
	if body.Secret != nil {
		secret = *body.Secret
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	w := models.Webhook{OrganisationID: u.OrganisationID, ProjectID: projectID,
		Name: strings.TrimSpace(body.Name), URL: strings.TrimSpace(body.URL),
		Secret: secret, Events: eventsList(events), Enabled: enabled}
	if err := db.DB.Create(&w).Error; err != nil {
		httpx.Err(c, 500, "db_error", "Could not create webhook")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "webhook.created", "webhook", w.ID,
		models.JSONMap{"name": w.Name, "url": w.URL})
	c.JSON(201, webhookDict(&w))
}

func updateWebhook(c *gin.Context) {
	u := httpx.User(c)
	w, ok := getWebhook(c)
	if !ok {
		return
	}
	var body struct {
		Name    *string   `json:"name"`
		URL     *string   `json:"url"`
		Secret  *string   `json:"secret"`
		Events  *[]string `json:"events"`
		Enabled *bool     `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, 422, "invalid_body", "Invalid JSON body")
		return
	}
	if body.URL != nil {
		if !validateWebhookURL(c, *body.URL) {
			return
		}
		w.URL = strings.TrimSpace(*body.URL)
	}
	if body.Name != nil {
		w.Name = strings.TrimSpace(*body.Name)
	}
	if body.Secret != nil {
		w.Secret = *body.Secret
	}
	if body.Events != nil {
		if !validateEvents(c, *body.Events) {
			return
		}
		w.Events = eventsList(*body.Events)
	}
	if body.Enabled != nil {
		w.Enabled = *body.Enabled
	}
	db.DB.Model(&models.Webhook{}).Where("id = ?", w.ID).Updates(map[string]any{
		"name": w.Name, "url": w.URL, "secret": w.Secret,
		"events": w.Events, "enabled": w.Enabled})
	httpx.Audit(u.OrganisationID, &u.ID, "webhook.updated", "webhook", w.ID,
		models.JSONMap{"name": w.Name})
	c.JSON(200, webhookDict(w))
}

func deleteWebhook(c *gin.Context) {
	u := httpx.User(c)
	w, ok := getWebhook(c)
	if !ok {
		return
	}
	db.DB.Delete(&models.Webhook{}, "id = ?", w.ID)
	httpx.Audit(u.OrganisationID, &u.ID, "webhook.deleted", "webhook", w.ID,
		models.JSONMap{"name": w.Name})
	c.JSON(200, gin.H{"deleted": true})
}

// WebhookHTTPClient delivers webhooks (5s timeout). Var so tests can stub transport.
var WebhookHTTPClient = &http.Client{Timeout: webhookTimeoutS * time.Second}

// deliver — one delivery attempt, 5s timeout. Returns the HTTP status or nil on
// transport failure. Slack incoming webhooks get a {"text": ...} payload.
func deliver(w *models.Webhook, event string, payload map[string]any, summaryAr string) *int {
	var body []byte
	if strings.Contains(w.URL, "hooks.slack.com") {
		body = jsonCompact(map[string]any{"text": summaryAr})
	} else {
		body = jsonCompact(payload)
	}
	req, err := http.NewRequest(http.MethodPost, w.URL, strings.NewReader(string(body)))
	if err != nil {
		return nil
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Traceo-Event", event)
	if w.Secret != "" {
		mac := hmac.New(sha256.New, []byte(w.Secret))
		mac.Write(body)
		req.Header.Set("X-Traceo-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	resp, err := WebhookHTTPClient.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	status := resp.StatusCode
	return &status
}

func slackSummary(payload map[string]any) string {
	run, _ := payload["run"].(map[string]any)
	project, _ := payload["project"].(map[string]any)
	counts, _ := run["counts"].(map[string]any)
	get := func(m map[string]any, k string, d any) any {
		if m != nil {
			if v, ok := m[k]; ok && v != nil {
				return v
			}
		}
		return d
	}
	return fmt.Sprintf("اكتمل التشغيل #%v في مشروع %v: %v ناجح، %v فاشل، %v خطأ من أصل %v",
		get(run, "display_id", "?"), get(project, "name", "?"),
		get(counts, "passed", 0), get(counts, "failed", 0),
		get(counts, "errored", 0), get(counts, "total", 0))
}

func testWebhook(c *gin.Context) {
	u := httpx.User(c)
	w, ok := getWebhook(c)
	if !ok {
		return
	}
	var project models.Project
	projectName := ""
	if err := db.DB.First(&project, "id = ?", w.ProjectID).Error; err == nil {
		projectName = project.Name
	}
	payload := map[string]any{
		"event": "run.completed", "test": true,
		"project": map[string]any{"id": w.ProjectID, "name": projectName},
		"run": map[string]any{"id": "00000000-0000-0000-0000-000000000000",
			"display_id": 1001, "state": "completed",
			"counts":       map[string]any{"total": 4, "passed": 3, "failed": 1, "errored": 0},
			"coverage_pct": 75.0},
		"timestamp": isoV(utcnow()),
	}
	status := deliver(w, "run.completed", payload, slackSummary(payload))
	now := utcnow()
	db.DB.Model(&models.Webhook{}).Where("id = ?", w.ID).
		Updates(map[string]any{"last_status": status, "last_fired_at": now})
	var auditStatus any
	if status != nil {
		auditStatus = *status
	}
	httpx.Audit(u.OrganisationID, &u.ID, "webhook.tested", "webhook", w.ID,
		models.JSONMap{"status": auditStatus})
	var statusOut any
	delivered := false
	if status != nil {
		statusOut = *status
		delivered = *status < 400
	}
	c.JSON(200, gin.H{"webhook_id": w.ID, "delivered": delivered, "status": statusOut})
}

// ---------------------------------------------------------------------------
// Xray / Jira exports (FR-070)
// ---------------------------------------------------------------------------

var jiraPriority = map[string]string{"critical": "Highest", "major": "High", "minor": "Medium"}

func getRunScoped(c *gin.Context) (*models.Run, bool) {
	u := httpx.User(c)
	var run models.Run
	if err := db.DB.First(&run, "id = ? AND organisation_id = ?", c.Param("id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Run not found")
		return nil, false
	}
	return &run, true
}

type runRow struct {
	Res *models.TestResult
	TC  *models.TestCase
}

func runRows(run *models.Run) []runRow {
	var results []models.TestResult
	db.DB.Where("run_id = ?", run.ID).Order("created_at ASC").Find(&results)
	caseIDs := make([]string, 0, len(results))
	seen := map[string]bool{}
	for _, r := range results {
		if !seen[r.TestCaseID] {
			seen[r.TestCaseID] = true
			caseIDs = append(caseIDs, r.TestCaseID)
		}
	}
	var cases []models.TestCase
	if len(caseIDs) > 0 {
		db.DB.Where("id IN ?", caseIDs).Find(&cases)
	}
	byID := map[string]*models.TestCase{}
	for i := range cases {
		byID[cases[i].ID] = &cases[i]
	}
	rows := []runRow{}
	for i := range results {
		if tc := byID[results[i].TestCaseID]; tc != nil {
			rows = append(rows, runRow{Res: &results[i], TC: tc})
		}
	}
	return rows
}

func stepsOf(caseID string) []models.TestStep {
	var steps []models.TestStep
	db.DB.Where("test_case_id = ?", caseID).Order("step_order ASC").Find(&steps)
	return steps
}

func exportXray(c *gin.Context) {
	run, ok := getRunScoped(c)
	if !ok {
		return
	}
	var project models.Project
	projectName := run.ProjectID
	if err := db.DB.First(&project, "id = ?", run.ProjectID).Error; err == nil {
		projectName = project.Name
	}
	rows := runRows(run)
	caseIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		caseIDs = append(caseIDs, r.TC.ID)
	}
	rinfo := requirementsOfCases(caseIDs)
	displayID := runDisplayID(run)

	tests := []map[string]any{}
	for _, row := range rows {
		finish := row.Res.CreatedAt
		start := finish.Add(-time.Duration(row.Res.DurationMs) * time.Millisecond)
		steps := stepsOf(row.TC.ID)
		parts := make([]string, 0, len(steps))
		for _, s := range steps {
			parts = append(parts, strings.ToUpper(s.Method)+" "+s.Path)
		}
		definition := strings.Join(parts, " ; ")
		if definition == "" {
			definition = row.TC.Title
		}
		comment := ""
		if row.Res.Outcome != "passed" && len(row.Res.FailureReason) > 0 {
			comment = string(jsonCompact(row.Res.FailureReason))
		}
		status := "FAILED"
		if row.Res.Outcome == "passed" {
			status = "PASSED"
		}
		entry := map[string]any{
			"testInfo": map[string]any{"summary": row.TC.Title, "type": "Generic",
				"definition": definition},
			"start": isoV(start), "finish": isoV(finish),
			"status": status, "comment": comment,
		}
		if e, ok := rinfo[row.TC.ID]; ok && len(e.ExternalIDs) > 0 {
			entry["testKey"] = e.ExternalIDs[0]
		}
		tests = append(tests, entry)
	}

	counts := run.Counts
	if counts == nil {
		counts = models.JSONMap{}
	}
	finished := "—"
	if run.FinishedAt != nil {
		finished = isoV(*run.FinishedAt)
	}
	doc := map[string]any{
		"info": map[string]any{
			"summary": fmt.Sprintf("Traceo run #%d — %s", displayID, projectName),
			"description": fmt.Sprintf("State: %s · counts: %s · finished: %s",
				run.State, string(jsonCompact(counts)), finished),
		},
		"tests": tests,
	}
	c.Header("Content-Disposition",
		fmt.Sprintf(`attachment; filename="traceo-run-%d-xray.json"`, displayID))
	c.Data(200, "application/json", jsonIndent(doc))
}

func exportDefectsCSV(c *gin.Context) {
	run, ok := getRunScoped(c)
	if !ok {
		return
	}
	rows := runRows(run)
	caseIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		caseIDs = append(caseIDs, r.TC.ID)
	}
	rinfo := requirementsOfCases(caseIDs)
	displayID := runDisplayID(run)

	var buf strings.Builder
	writer := csv.NewWriter(&buf)
	_ = writer.Write([]string{"Summary", "Description", "Priority", "Labels"})
	for _, row := range rows {
		if row.Res.Outcome != "failed" && row.Res.Outcome != "errored" {
			continue // failures only
		}
		info := rinfo[row.TC.ID]
		if info == nil {
			info = &reqInfo{ExternalIDs: []string{}}
		}
		severity := deriveSeverity(row.Res.Outcome, row.Res.FailureReason, info.HighPriority)
		fr := row.Res.FailureReason
		if fr == nil {
			fr = models.JSONMap{}
		}
		steps := stepsOf(row.TC.ID)
		lines := []string{fmt.Sprintf("[Traceo run #%d] %s", displayID, row.TC.Title), "", "Steps:"}
		for i, s := range steps {
			lines = append(lines, fmt.Sprintf("%d. %s %s", i+1, strings.ToUpper(s.Method), s.Path))
		}
		if fr["assertion"] != nil {
			lines = append(lines, "",
				"Expected: "+string(jsonCompact(fr["expected"])),
				"Actual: "+string(jsonCompact(fr["actual"])))
		} else if truthy(fr["error"]) {
			lines = append(lines, "", fmt.Sprintf("Error: %v", fr["error"]))
		}
		priority := jiraPriority[severity]
		if priority == "" {
			priority = "Medium"
		}
		_ = writer.Write([]string{
			fmt.Sprintf("[%s] %s", strings.ToUpper(row.Res.Outcome), row.TC.Title),
			strings.Join(lines, "\n"),
			priority,
			strings.Join(info.ExternalIDs, " "),
		})
	}
	writer.Flush()
	// UTF-8 BOM so Excel opens Arabic content correctly
	body := append([]byte("\ufeff"), []byte(buf.String())...)
	c.Header("Content-Disposition",
		fmt.Sprintf(`attachment; filename="traceo-run-%d-defects.csv"`, displayID))
	c.Data(200, "text/csv; charset=utf-8", body)
}

// ---------------------------------------------------------------------------
// Schedules (FR-060)
// ---------------------------------------------------------------------------

func scheduleDict(s *models.Schedule) gin.H {
	return gin.H{"id": s.ID, "project_id": s.ProjectID, "environment_id": s.EnvironmentID,
		"name": s.Name, "interval_minutes": s.IntervalMinutes, "enabled": s.Enabled,
		"last_run_at": iso(s.LastRunAt), "next_run_at": iso(s.NextRunAt),
		"created_at": isoV(s.CreatedAt)}
}

func checkInterval(c *gin.Context, minutes int) bool {
	if minutes < minScheduleInterval {
		httpx.Err(c, 422, "interval_too_short",
			fmt.Sprintf("interval_minutes must be at least %d", minScheduleInterval))
		return false
	}
	return true
}

func envInProject(c *gin.Context, envID, projectID string, u *models.User) bool {
	var env models.Environment
	if err := db.DB.First(&env, "id = ? AND project_id = ? AND organisation_id = ?",
		envID, projectID, u.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Environment not found in this project")
		return false
	}
	return true
}

func listSchedules(c *gin.Context) {
	u := httpx.User(c)
	if _, ok := httpx.ProjectScoped(c, c.Param("project_id")); !ok {
		return
	}
	var schedules []models.Schedule
	db.DB.Where("project_id = ? AND organisation_id = ?", c.Param("project_id"), u.OrganisationID).
		Order("created_at ASC").Find(&schedules)
	out := make([]gin.H, 0, len(schedules))
	for i := range schedules {
		out = append(out, scheduleDict(&schedules[i]))
	}
	c.JSON(200, out)
}

func createSchedule(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var body struct {
		Name            string `json:"name"`
		EnvironmentID   string `json:"environment_id"`
		IntervalMinutes int    `json:"interval_minutes"`
		Enabled         *bool  `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || body.Name == "" || body.EnvironmentID == "" {
		httpx.Err(c, 422, "invalid_body", "name, environment_id and interval_minutes are required")
		return
	}
	if !checkInterval(c, body.IntervalMinutes) {
		return
	}
	if !envInProject(c, body.EnvironmentID, projectID, u) {
		return
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	next := utcnow().Add(time.Duration(body.IntervalMinutes) * time.Minute)
	s := models.Schedule{OrganisationID: u.OrganisationID, ProjectID: projectID,
		EnvironmentID: body.EnvironmentID, Name: strings.TrimSpace(body.Name),
		IntervalMinutes: body.IntervalMinutes, Enabled: enabled,
		NextRunAt: &next, CreatedBy: u.ID}
	if err := db.DB.Create(&s).Error; err != nil {
		httpx.Err(c, 500, "db_error", "Could not create schedule")
		return
	}
	httpx.Audit(u.OrganisationID, &u.ID, "schedule.created", "schedule", s.ID,
		models.JSONMap{"name": s.Name, "interval_minutes": s.IntervalMinutes})
	c.JSON(201, scheduleDict(&s))
}

func getSchedule(c *gin.Context) (*models.Schedule, bool) {
	u := httpx.User(c)
	var s models.Schedule
	if err := db.DB.First(&s, "id = ? AND organisation_id = ?", c.Param("id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, 404, "not_found", "Schedule not found")
		return nil, false
	}
	return &s, true
}

func updateSchedule(c *gin.Context) {
	u := httpx.User(c)
	s, ok := getSchedule(c)
	if !ok {
		return
	}
	var body struct {
		Name            *string `json:"name"`
		EnvironmentID   *string `json:"environment_id"`
		IntervalMinutes *int    `json:"interval_minutes"`
		Enabled         *bool   `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, 422, "invalid_body", "Invalid JSON body")
		return
	}
	if body.IntervalMinutes != nil {
		if !checkInterval(c, *body.IntervalMinutes) {
			return
		}
		s.IntervalMinutes = *body.IntervalMinutes
		next := utcnow().Add(time.Duration(*body.IntervalMinutes) * time.Minute)
		s.NextRunAt = &next
	}
	if body.EnvironmentID != nil {
		if !envInProject(c, *body.EnvironmentID, s.ProjectID, u) {
			return
		}
		s.EnvironmentID = *body.EnvironmentID
	}
	if body.Name != nil {
		s.Name = strings.TrimSpace(*body.Name)
	}
	if body.Enabled != nil {
		s.Enabled = *body.Enabled
	}
	db.DB.Model(&models.Schedule{}).Where("id = ?", s.ID).Updates(map[string]any{
		"name": s.Name, "environment_id": s.EnvironmentID,
		"interval_minutes": s.IntervalMinutes, "enabled": s.Enabled,
		"next_run_at": s.NextRunAt})
	httpx.Audit(u.OrganisationID, &u.ID, "schedule.updated", "schedule", s.ID,
		models.JSONMap{"name": s.Name})
	c.JSON(200, scheduleDict(s))
}

func deleteSchedule(c *gin.Context) {
	u := httpx.User(c)
	s, ok := getSchedule(c)
	if !ok {
		return
	}
	db.DB.Delete(&models.Schedule{}, "id = ?", s.ID)
	httpx.Audit(u.OrganisationID, &u.ID, "schedule.deleted", "schedule", s.ID,
		models.JSONMap{"name": s.Name})
	c.JSON(200, gin.H{"deleted": true})
}

// --- Scheduler daemon (started once from main.go startup) --------------------

var (
	schedulerOnce    sync.Once
	schedulerStarted bool
)

// launchScheduledRun triggers the same run-launch path as POST /projects/{id}/runs
// for a due schedule (all approved cases, the schedule's environment). Returns the
// run id or "" when skipped (no approved cases / missing environment).
func launchScheduledRun(sched *models.Schedule) string {
	now := utcnow()
	interval := sched.IntervalMinutes
	if interval < 1 {
		interval = 1
	}
	next := now.Add(time.Duration(interval) * time.Minute)
	db.DB.Model(&models.Schedule{}).Where("id = ?", sched.ID).
		Updates(map[string]any{"last_run_at": now, "next_run_at": next})

	// Preferred path: the execution module's scheduled-launch entrypoint (wired in
	// main.go). It owns run creation + execution end to end.
	if LaunchRunForSchedule != nil {
		if err := LaunchRunForSchedule(sched.ProjectID, sched.EnvironmentID, sched.CreatedBy); err != nil {
			return ""
		}
		return "launched"
	}

	var env models.Environment
	if err := db.DB.First(&env, "id = ? AND project_id = ?",
		sched.EnvironmentID, sched.ProjectID).Error; err != nil {
		return ""
	}
	var cases []models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		sched.ProjectID, sched.OrganisationID, "approved").Find(&cases)
	if len(cases) == 0 { // skip silently — nothing approved to execute
		return ""
	}

	run := models.Run{OrganisationID: sched.OrganisationID, ProjectID: sched.ProjectID,
		EnvironmentID: env.ID, State: "queued", InitiatedBy: sched.CreatedBy,
		Counts: models.JSONMap{}}
	if err := db.DB.Create(&run).Error; err != nil {
		return ""
	}
	createdBy := sched.CreatedBy
	httpx.Audit(sched.OrganisationID, &createdBy, "run.scheduled", "run", run.ID,
		models.JSONMap{"schedule_id": sched.ID, "environment_id": env.ID,
			"case_count": len(cases)})

	runID := run.ID
	caseIDs := make([]string, len(cases))
	for i, cse := range cases {
		caseIDs[i] = cse.ID
	}
	jobs.Submit("execute", func(j *jobs.Job) (any, error) {
		if ExecuteRun != nil {
			return ExecuteRun(j, runID, caseIDs)
		}
		return gin.H{"run_id": runID, "note": "execution engine not wired"}, nil
	})
	return runID
}

// SchedulerTick scans enabled schedules that are due and launches them.
// Returns the number of launches (exported for the quality-gate tests).
func SchedulerTick() int {
	launched := 0
	var due []models.Schedule
	db.DB.Where("enabled = ? AND next_run_at <= ?", true, utcnow()).Find(&due)
	for i := range due {
		func() {
			defer func() { _ = recover() }() // one bad schedule must not stop the rest
			if launchScheduledRun(&due[i]) != "" {
				launched++
			}
		}()
	}
	return launched
}

// StartScheduler starts the schedule daemon goroutine exactly once (main.go startup).
func StartScheduler() {
	schedulerOnce.Do(func() {
		schedulerStarted = true
		go func() {
			for {
				time.Sleep(schedulerIntervalS * time.Second)
				func() {
					defer func() { _ = recover() }() // the daemon must survive anything
					SchedulerTick()
				}()
			}
		}()
	})
}

// ---------------------------------------------------------------------------
// Organisation data export (FR-082, PDPL)
// ---------------------------------------------------------------------------

func exportOrganisation(c *gin.Context) {
	u := httpx.User(c)
	orgID := u.OrganisationID

	var org models.Organisation
	var orgDoc any
	if err := db.DB.First(&org, "id = ?", orgID).Error; err == nil {
		orgDoc = map[string]any{"id": org.ID, "name": org.Name, "plan": org.Plan,
			"created_at": isoV(org.CreatedAt)}
	}

	var projects []models.Project
	db.DB.Where("organisation_id = ?", orgID).Order("created_at ASC").Find(&projects)
	var reqs []models.Requirement
	db.DB.Where("organisation_id = ?", orgID).Order("created_at ASC").Find(&reqs)
	var cases []models.TestCase
	db.DB.Where("organisation_id = ?", orgID).Order("created_at ASC").Find(&cases)
	var runs []models.Run
	db.DB.Where("organisation_id = ?", orgID).Order("created_at ASC").Find(&runs)
	var auditCount int64
	db.DB.Model(&models.AuditEntry{}).Where("organisation_id = ?", orgID).Count(&auditCount)

	resultSummaries := map[string][]map[string]any{}
	runIDs := make([]string, len(runs))
	for i, r := range runs {
		runIDs[i] = r.ID
	}
	if len(runIDs) > 0 {
		var results []models.TestResult
		db.DB.Where("run_id IN ?", runIDs).Order("created_at ASC").Find(&results)
		for _, res := range results {
			// Evidence EXCLUDED by design (PDPL data-minimisation)
			resultSummaries[res.RunID] = append(resultSummaries[res.RunID], map[string]any{
				"test_case_id":      res.TestCaseID,
				"test_case_version": res.TestCaseVersion,
				"outcome":           res.Outcome, "duration_ms": res.DurationMs,
				"executed_at": isoV(res.CreatedAt)})
		}
	}

	projDocs := []map[string]any{}
	for _, p := range projects {
		projDocs = append(projDocs, map[string]any{"id": p.ID, "name": p.Name,
			"language": p.Language, "status": p.Status, "created_at": isoV(p.CreatedAt)})
	}
	reqDocs := []map[string]any{}
	for _, r := range reqs {
		ac := r.AcceptanceCriteria
		if ac == nil {
			ac = models.JSONList{}
		}
		reqDocs = append(reqDocs, map[string]any{"id": r.ID, "project_id": r.ProjectID,
			"external_id": r.ExternalID, "description": r.Description,
			"acceptance_criteria": ac, "type": r.Type, "priority": r.Priority,
			"state": r.State, "version": r.Version, "source_text": r.SourceText})
	}
	caseDocs := []map[string]any{}
	for _, tc := range cases {
		steps := stepsOf(tc.ID)
		stepDocs := []map[string]any{}
		for _, s := range steps {
			req := s.Request
			if req == nil {
				req = models.JSONMap{}
			}
			asserts := s.Assertions
			if asserts == nil {
				asserts = models.JSONList{}
			}
			extr := s.Extractions
			if extr == nil {
				extr = models.JSONList{}
			}
			stepDocs = append(stepDocs, map[string]any{"order": s.Order,
				"method": s.Method, "path": s.Path, "request": req,
				"assertions": asserts, "extractions": extr})
		}
		caseDocs = append(caseDocs, map[string]any{"id": tc.ID, "project_id": tc.ProjectID,
			"title": tc.Title, "description": tc.Description,
			"preconditions": tc.Preconditions, "type": tc.Type,
			"priority": tc.Priority, "state": tc.State, "technique": tc.Technique,
			"generated": tc.Generated, "version": tc.Version, "steps": stepDocs})
	}
	runDocs := []map[string]any{}
	for _, r := range runs {
		counts := r.Counts
		if counts == nil {
			counts = models.JSONMap{}
		}
		summaries := resultSummaries[r.ID]
		if summaries == nil {
			summaries = []map[string]any{}
		}
		runDocs = append(runDocs, map[string]any{"id": r.ID, "project_id": r.ProjectID,
			"environment_id": r.EnvironmentID, "state": r.State,
			"started_at": iso(r.StartedAt), "finished_at": iso(r.FinishedAt),
			"counts": counts, "initiated_by": r.InitiatedBy, "results": summaries})
	}

	doc := map[string]any{
		"exported_at":       isoV(utcnow()),
		"organisation":      orgDoc,
		"projects":          projDocs,
		"requirements":      reqDocs,
		"test_cases":        caseDocs,
		"runs":              runDocs,
		"audit_entry_count": auditCount,
	}
	httpx.Audit(orgID, &u.ID, "organisation.exported", "organisation", orgID,
		models.JSONMap{"projects": len(projects), "runs": len(runs)})
	c.Header("Content-Disposition", `attachment; filename="traceo_export.json"`)
	c.Data(200, "application/json", jsonIndent(doc))
}
