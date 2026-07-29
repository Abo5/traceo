// Package review — the human gate between generation and execution (FR-REV).
// 1:1 port of backend/app/modules/review.py.
//
// Every generated case lands here as a draft. Reviewers see the requirement text
// alongside the case (FR-REV-02), edit freely (edits flag user_modified and knock an
// approved/stale case back to draft with a version bump, FR-REV-03), and approve or
// reject individually or in bulk (FR-REV-04/05/06). Manual authoring (FR-REV-07,
// FR-GEN-02) requires at least one requirement link — an unlinked case cannot exist,
// which is also why removing the LAST link is refused (FR-TRC-05).
//
// Routing note: POST /test-cases/bulk (static) shares a path position with the
// /test-cases/:case_id/* wildcard routes. Gin 1.10's tree accepts the mix in either
// registration order (verified with a throwaway httptest probe: "bulk" resolves to the
// static handler, "<uuid>/approve" to the wildcard one); the static route is still
// registered FIRST here as the defensive ordering.
package review

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
)

var (
	caseTypes         = []string{"positive", "negative", "boundary"}
	rejectReasonCodes = []string{"incorrect", "shallow", "duplicate", "other"}
	bulkActions       = []string{"approve", "reject"}
)

const titleMaxRunes = 500

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())

	// Static segment first (see package note on the bulk/wildcard collision).
	g.POST("/test-cases/bulk", httpx.Require("approve_reject"), bulkReview)

	g.GET("/projects/:project_id/test-cases", httpx.Require("view"), listTestCases)
	g.POST("/projects/:project_id/test-cases", httpx.Require("edit_test_case"), createTestCase)

	g.GET("/test-cases/:case_id", httpx.Require("view"), getTestCase)
	g.PATCH("/test-cases/:case_id", httpx.Require("edit_test_case"), updateTestCase)
	g.POST("/test-cases/:case_id/approve", httpx.Require("approve_reject"), approveTestCase)
	g.POST("/test-cases/:case_id/reject", httpx.Require("approve_reject"), rejectTestCase)
	g.POST("/test-cases/:case_id/links", httpx.Require("edit_test_case"), addLink)
	g.DELETE("/test-cases/:case_id/links/:requirement_id", httpx.Require("edit_test_case"), removeLink)
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

func utcnow() time.Time { return time.Now().UTC() }

func iso(t time.Time) string { return t.UTC().Format(time.RFC3339) }

func isoPtr(t *time.Time) any {
	if t == nil {
		return nil
	}
	return iso(*t)
}

// nilIfEmpty mirrors the Python nullable Text column: unset reads back as null.
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// pyTruthyStr ports `str(x or fallback)` over a JSON-decoded value.
func pyTruthyStr(v any, fallback string) string {
	switch t := v.(type) {
	case nil:
		return fallback
	case string:
		if t == "" {
			return fallback
		}
		return t
	case bool:
		if !t {
			return fallback
		}
		return "True"
	case float64:
		if t == 0 {
			return fallback
		}
		return fmt.Sprintf("%v", t)
	default:
		return fmt.Sprintf("%v", t)
	}
}

// ---------------------------------------------------------------------------
// Scoped fetch + serializers
// ---------------------------------------------------------------------------

// getCase — org isolation (FR-USR-04): a foreign tenant sees 404, never 403.
// Writes the 404 itself and returns ok=false.
func getCase(c *gin.Context, caseID string) (*models.TestCase, bool) {
	u := httpx.User(c)
	var tc models.TestCase
	if err := db.DB.First(&tc, "id = ?", caseID).Error; err != nil ||
		tc.OrganisationID != u.OrganisationID {
		httpx.Err(c, http.StatusNotFound, "not_found", "Test case not found")
		return nil, false
	}
	return &tc, true
}

// linksFor — case_id -> [{id, external_id, description}] in one query.
func linksFor(caseIDs []string) map[string][]gin.H {
	out := make(map[string][]gin.H, len(caseIDs))
	for _, cid := range caseIDs {
		out[cid] = []gin.H{}
	}
	if len(caseIDs) == 0 {
		return out
	}
	var rows []struct {
		TestCaseID  string
		ID          string
		ExternalID  string
		Description string
	}
	db.DB.Table("requirement_test_cases AS rtc").
		Select("rtc.test_case_id AS test_case_id, r.id AS id, r.external_id AS external_id, r.description AS description").
		Joins("JOIN requirements r ON r.id = rtc.requirement_id").
		Where("rtc.test_case_id IN ?", caseIDs).
		Order("rtc.created_at ASC, r.external_id ASC").
		Scan(&rows)
	for _, row := range rows {
		if _, ok := out[row.TestCaseID]; !ok {
			continue
		}
		out[row.TestCaseID] = append(out[row.TestCaseID], gin.H{
			"id": row.ID, "external_id": row.ExternalID, "description": row.Description,
		})
	}
	return out
}

func linksOf(caseID string) []gin.H {
	l := linksFor([]string{caseID})[caseID]
	if l == nil {
		l = []gin.H{}
	}
	return l
}

func stepsOf(caseID string) []models.TestStep {
	var steps []models.TestStep
	db.DB.Where("test_case_id = ?", caseID).Order("step_order ASC").Find(&steps)
	return steps
}

// stepCounts — case_id -> number of steps (batch, for list endpoints).
func stepCounts(caseIDs []string) map[string]int {
	out := make(map[string]int, len(caseIDs))
	for _, cid := range caseIDs {
		out[cid] = 0
	}
	if len(caseIDs) == 0 {
		return out
	}
	var rows []struct {
		TestCaseID string
		N          int64
	}
	db.DB.Model(&models.TestStep{}).
		Select("test_case_id, count(*) AS n").
		Where("test_case_id IN ?", caseIDs).
		Group("test_case_id").Scan(&rows)
	for _, row := range rows {
		if _, ok := out[row.TestCaseID]; ok {
			out[row.TestCaseID] = int(row.N)
		}
	}
	return out
}

func stepDict(s *models.TestStep) gin.H {
	request := s.Request
	if request == nil {
		request = models.JSONMap{}
	}
	assertions := s.Assertions
	if assertions == nil {
		assertions = models.JSONList{}
	}
	extractions := s.Extractions
	if extractions == nil {
		extractions = models.JSONList{}
	}
	return gin.H{
		"id": s.ID, "order": s.Order, "endpoint_id": s.EndpointID,
		"method": s.Method, "path": s.Path, "request": request,
		"assertions": assertions, "extractions": extractions,
	}
}

func caseDict(tc *models.TestCase, links []gin.H, stepCount int) gin.H {
	if links == nil {
		links = []gin.H{}
	}
	return gin.H{
		"id": tc.ID, "project_id": tc.ProjectID, "title": tc.Title,
		"description": tc.Description, "preconditions": tc.Preconditions,
		"type": tc.Type, "priority": tc.Priority, "state": tc.State,
		"generated": tc.Generated, "user_modified": tc.UserModified,
		"model": tc.Model, "prompt_version": tc.PromptVersion,
		"technique": tc.Technique, "version": tc.Version,
		"approved_by": tc.ApprovedBy, "approved_at": isoPtr(tc.ApprovedAt),
		"rejection_reason": nilIfEmpty(tc.RejectionReason),
		"links":            links,
		"created_at":       iso(tc.CreatedAt), "updated_at": iso(tc.UpdatedAt),
		"step_count": stepCount,
	}
}

// caseDictLoaded — caseDict with the step count resolved from the DB.
func caseDictLoaded(tc *models.TestCase, links []gin.H) gin.H {
	return caseDict(tc, links, stepCounts([]string{tc.ID})[tc.ID])
}

func caseDetail(tc *models.TestCase, links []gin.H) gin.H {
	steps := stepsOf(tc.ID)
	d := caseDict(tc, links, len(steps))
	out := make([]gin.H, 0, len(steps))
	for i := range steps {
		out = append(out, stepDict(&steps[i]))
	}
	d["steps"] = out
	// alias: the review queue renders requirement text alongside the case (FR-REV-02)
	d["requirements"] = d["links"]
	return d
}

// ---------------------------------------------------------------------------
// Step validation (shared by PATCH and manual authoring)
// ---------------------------------------------------------------------------

type cleanStep struct {
	Order       int
	EndpointID  *string
	Method      string
	Path        string
	Request     models.JSONMap
	Assertions  models.JSONList
	Extractions models.JSONList
}

// cleanSteps validates + normalises the raw step payload. On failure it writes the
// 422 envelope itself and returns ok=false.
func cleanSteps(c *gin.Context, raw []any) ([]cleanStep, bool) {
	if len(raw) == 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_steps",
			"steps must be a non-empty list")
		return nil, false
	}
	cleaned := make([]cleanStep, 0, len(raw))
	for i, item := range raw {
		s, ok := item.(map[string]any)
		if !ok {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_steps",
				fmt.Sprintf("step %d must be an object", i))
			return nil, false
		}
		method := strings.ToUpper(pyTruthyStr(s["method"], "GET"))
		path := pyTruthyStr(s["path"], "")
		if path == "" {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_steps",
				fmt.Sprintf("step %d is missing 'path'", i))
			return nil, false
		}
		request := models.JSONMap{}
		if m, ok := s["request"].(map[string]any); ok {
			request = models.JSONMap(m)
		}
		assertions := models.JSONList{}
		if l, ok := s["assertions"].([]any); ok {
			assertions = models.JSONList(l)
		}
		extractions := models.JSONList{}
		if l, ok := s["extractions"].([]any); ok {
			extractions = models.JSONList(l)
		}
		var endpointID *string
		if e, ok := s["endpoint_id"].(string); ok && e != "" {
			v := e
			endpointID = &v
		}
		cleaned = append(cleaned, cleanStep{Order: i, EndpointID: endpointID,
			Method: method, Path: path, Request: request,
			Assertions: assertions, Extractions: extractions})
	}
	return cleaned, true
}

func toStepModels(caseID string, cleaned []cleanStep) []models.TestStep {
	out := make([]models.TestStep, 0, len(cleaned))
	for _, s := range cleaned {
		out = append(out, models.TestStep{
			TestCaseID: caseID, Order: s.Order, EndpointID: s.EndpointID,
			Method: s.Method, Path: s.Path, Request: s.Request,
			Assertions: s.Assertions, Extractions: s.Extractions,
		})
	}
	return out
}

func insertSteps(caseID string, cleaned []cleanStep) {
	rows := toStepModels(caseID, cleaned)
	for i := range rows {
		db.DB.Create(&rows[i])
	}
}

// replaceSteps — atomic replacement (Python's delete-orphan cascade).
func replaceSteps(caseID string, cleaned []cleanStep) {
	db.DB.Where("test_case_id = ?", caseID).Delete(&models.TestStep{})
	insertSteps(caseID, cleaned)
}

// ---------------------------------------------------------------------------
// Approve / reject primitives (shared by single + bulk endpoints)
// ---------------------------------------------------------------------------

// errDetail is the {code, message} pair the Python handlers raise.
type errDetail struct {
	Status  int
	Code    string
	Message string
}

func approveCase(tc *models.TestCase, u *models.User) *errDetail {
	if tc.State == "archived" {
		return &errDetail{http.StatusConflict, "invalid_state",
			"An archived test case cannot be approved"}
	}
	now := utcnow()
	uid := u.ID
	tc.State = "approved"
	tc.ApprovedBy = &uid
	tc.ApprovedAt = &now
	tc.RejectionReason = ""
	db.DB.Model(&models.TestCase{}).Where("id = ?", tc.ID).Updates(map[string]any{
		"state": tc.State, "approved_by": tc.ApprovedBy, "approved_at": tc.ApprovedAt,
		"rejection_reason": nil,
	})
	httpx.Audit(u.OrganisationID, &uid, "test_case.approved", "test_case", tc.ID,
		models.JSONMap{"version": tc.Version})
	return nil
}

func rejectCase(tc *models.TestCase, u *models.User, reasonCode, reasonText string) *errDetail {
	if tc.State == "archived" {
		return &errDetail{http.StatusConflict, "invalid_state",
			"An archived test case cannot be rejected"}
	}
	uid := u.ID
	tc.State = "rejected"
	tc.ApprovedBy = nil
	tc.ApprovedAt = nil
	if reasonText != "" {
		tc.RejectionReason = reasonCode + ": " + reasonText
	} else {
		tc.RejectionReason = reasonCode
	}
	db.DB.Model(&models.TestCase{}).Where("id = ?", tc.ID).Updates(map[string]any{
		"state": tc.State, "approved_by": nil, "approved_at": nil,
		"rejection_reason": tc.RejectionReason,
	})
	httpx.Audit(u.OrganisationID, &uid, "test_case.rejected", "test_case", tc.ID,
		models.JSONMap{"reason_code": reasonCode, "reason_text": reasonText})
	return nil
}

// checkReasonCode writes the 422 itself and returns ok=false.
func checkReasonCode(c *gin.Context, reasonCode string) bool {
	if !contains(rejectReasonCodes, reasonCode) {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_reason_code",
			"reason_code must be one of "+strings.Join(rejectReasonCodes, ", "))
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// Routes — listing & detail
// ---------------------------------------------------------------------------

func listTestCases(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	q := db.DB.Model(&models.TestCase{}).
		Where("test_cases.project_id = ? AND test_cases.organisation_id = ?",
			projectID, u.OrganisationID)
	if state := c.Query("state"); state != "" {
		q = q.Where("test_cases.state = ?", state)
	}
	if typ := c.Query("type"); typ != "" {
		q = q.Where("test_cases.type = ?", typ)
	}
	if reqID := c.Query("requirement_id"); reqID != "" {
		q = q.Joins("JOIN requirement_test_cases rtc ON rtc.test_case_id = test_cases.id").
			Where("rtc.requirement_id = ?", reqID)
	}
	if needle := c.Query("q"); needle != "" {
		like := "%" + strings.ToLower(needle) + "%"
		q = q.Where("LOWER(test_cases.title) LIKE ? OR LOWER(test_cases.description) LIKE ?",
			like, like)
	}
	var cases []models.TestCase
	q.Order("test_cases.created_at ASC").Find(&cases)

	ids := make([]string, 0, len(cases))
	for i := range cases {
		ids = append(ids, cases[i].ID)
	}
	links := linksFor(ids)
	counts := stepCounts(ids)
	out := make([]gin.H, 0, len(cases))
	for i := range cases {
		out = append(out, caseDict(&cases[i], links[cases[i].ID], counts[cases[i].ID]))
	}
	c.JSON(http.StatusOK, gin.H{"test_cases": out})
}

func getTestCase(c *gin.Context) {
	tc, ok := getCase(c, c.Param("case_id"))
	if !ok {
		return
	}
	c.JSON(http.StatusOK, caseDetail(tc, linksOf(tc.ID)))
}

// ---------------------------------------------------------------------------
// Routes — editing (FR-REV-03)
// ---------------------------------------------------------------------------

type casePatch struct {
	Title         *string `json:"title"`
	Description   *string `json:"description"`
	Preconditions *string `json:"preconditions"`
	Type          *string `json:"type"`
	Priority      *string `json:"priority"`
	Steps         *[]any  `json:"steps"`
}

func updateTestCase(c *gin.Context) {
	u := httpx.User(c)
	var body casePatch
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	tc, ok := getCase(c, c.Param("case_id"))
	if !ok {
		return
	}
	if tc.State == "archived" {
		httpx.Err(c, http.StatusConflict, "invalid_state",
			"An archived test case cannot be edited")
		return
	}
	if body.Type != nil && !contains(caseTypes, *body.Type) {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_type",
			"type must be one of "+strings.Join(caseTypes, ", "))
		return
	}

	changed := []string{}
	if body.Title != nil && strings.TrimSpace(*body.Title) != "" && *body.Title != tc.Title {
		tc.Title = truncRunes(strings.TrimSpace(*body.Title), titleMaxRunes)
		changed = append(changed, "title")
	}
	if body.Description != nil && *body.Description != tc.Description {
		tc.Description = *body.Description
		changed = append(changed, "description")
	}
	if body.Preconditions != nil && *body.Preconditions != tc.Preconditions {
		tc.Preconditions = *body.Preconditions
		changed = append(changed, "preconditions")
	}
	if body.Type != nil && *body.Type != tc.Type {
		tc.Type = *body.Type
		changed = append(changed, "type")
	}
	if body.Priority != nil && *body.Priority != tc.Priority {
		tc.Priority = *body.Priority
		changed = append(changed, "priority")
	}
	var newSteps []cleanStep
	if body.Steps != nil {
		cleanedSteps, stepsOK := cleanSteps(c, *body.Steps)
		if !stepsOK {
			return
		}
		newSteps = cleanedSteps
		changed = append(changed, "steps")
	}

	if len(changed) > 0 {
		if newSteps != nil {
			replaceSteps(tc.ID, newSteps)
		}
		tc.UserModified = true // FR-REV-03: human edits are marked
		if tc.State == "approved" || tc.State == "stale" {
			// any edit invalidates the previous approval — back to the review queue
			tc.State = "draft"
			tc.Version++
			tc.ApprovedBy = nil
			tc.ApprovedAt = nil
		}
		db.DB.Model(&models.TestCase{}).Where("id = ?", tc.ID).Updates(map[string]any{
			"title": tc.Title, "description": tc.Description,
			"preconditions": tc.Preconditions, "type": tc.Type, "priority": tc.Priority,
			"user_modified": tc.UserModified, "state": tc.State, "version": tc.Version,
			"approved_by": tc.ApprovedBy, "approved_at": tc.ApprovedAt,
		})
		httpx.Audit(u.OrganisationID, &u.ID, "test_case.updated", "test_case", tc.ID,
			models.JSONMap{"changes": changed, "version": tc.Version})
		db.DB.First(tc, "id = ?", tc.ID) // refresh updated_at
	}
	c.JSON(http.StatusOK, caseDetail(tc, linksOf(tc.ID)))
}

// ---------------------------------------------------------------------------
// Routes — approve / reject (FR-REV-05/06), single + bulk (FR-REV-04)
// ---------------------------------------------------------------------------

func approveTestCase(c *gin.Context) {
	u := httpx.User(c)
	tc, ok := getCase(c, c.Param("case_id"))
	if !ok {
		return
	}
	if e := approveCase(tc, u); e != nil {
		httpx.Err(c, e.Status, e.Code, e.Message)
		return
	}
	db.DB.First(tc, "id = ?", tc.ID) // refresh updated_at
	c.JSON(http.StatusOK, caseDictLoaded(tc, linksOf(tc.ID)))
}

func rejectTestCase(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		ReasonCode string `json:"reason_code"`
		ReasonText string `json:"reason_text"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	tc, ok := getCase(c, c.Param("case_id"))
	if !ok {
		return
	}
	// Python evaluates _check_reason_code as a call argument — its 422 precedes the 409.
	if !checkReasonCode(c, body.ReasonCode) {
		return
	}
	if e := rejectCase(tc, u, body.ReasonCode, body.ReasonText); e != nil {
		httpx.Err(c, e.Status, e.Code, e.Message)
		return
	}
	db.DB.First(tc, "id = ?", tc.ID) // refresh updated_at
	c.JSON(http.StatusOK, caseDictLoaded(tc, linksOf(tc.ID)))
}

func bulkReview(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		IDs        []string `json:"ids"`
		Action     string   `json:"action"`
		ReasonCode *string  `json:"reason_code"`
		ReasonText string   `json:"reason_text"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	if !contains(bulkActions, body.Action) {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_action",
			"action must be one of "+strings.Join(bulkActions, ", "))
		return
	}
	if len(body.IDs) == 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "empty_ids", "ids must be non-empty")
		return
	}
	reasonCode := ""
	if body.Action == "reject" {
		reasonCode = "other" // Python: `body.reason_code or "other"`
		if body.ReasonCode != nil && *body.ReasonCode != "" {
			reasonCode = *body.ReasonCode
		}
		if !checkReasonCode(c, reasonCode) {
			return
		}
	}

	processed := 0
	errs := []gin.H{}
	for _, cid := range body.IDs {
		var tc models.TestCase
		if err := db.DB.First(&tc, "id = ?", cid).Error; err != nil ||
			tc.OrganisationID != u.OrganisationID {
			errs = append(errs, gin.H{"id": cid, "code": "not_found",
				"message": "Test case not found"})
			continue
		}
		var e *errDetail
		if body.Action == "approve" {
			e = approveCase(&tc, u)
		} else {
			e = rejectCase(&tc, u, reasonCode, body.ReasonText)
		}
		if e != nil {
			errs = append(errs, gin.H{"id": cid, "code": e.Code, "message": e.Message})
			continue
		}
		processed++
	}
	c.JSON(http.StatusOK, gin.H{"action": body.Action, "processed": processed, "errors": errs})
}

// ---------------------------------------------------------------------------
// Routes — manual authoring (FR-REV-07, FR-GEN-02: link at creation is mandatory)
// ---------------------------------------------------------------------------

func createTestCase(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")

	raw, err := c.GetRawData()
	if err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	// Pydantic defaults for the optional fields.
	body := struct {
		Title          string   `json:"title"`
		RequirementIDs []string `json:"requirement_ids"`
		Description    string   `json:"description"`
		Preconditions  string   `json:"preconditions"`
		Type           string   `json:"type"`
		Priority       string   `json:"priority"`
		Steps          *[]any   `json:"steps"`
	}{Type: "positive", Priority: "medium"}
	if err := json.Unmarshal(raw, &body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}

	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	if strings.TrimSpace(body.Title) == "" {
		httpx.Err(c, http.StatusUnprocessableEntity, "missing_title", "title is required")
		return
	}
	if len(body.RequirementIDs) == 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "missing_requirements",
			"requirement_ids is required — every test case must trace to a requirement")
		return
	}
	if !contains(caseTypes, body.Type) {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_type",
			"type must be one of "+strings.Join(caseTypes, ", "))
		return
	}

	// de-dup, keep order
	wanted := make([]string, 0, len(body.RequirementIDs))
	seen := map[string]bool{}
	for _, rid := range body.RequirementIDs {
		if !seen[rid] {
			seen[rid] = true
			wanted = append(wanted, rid)
		}
	}
	var reqs []models.Requirement
	db.DB.Where("id IN ? AND project_id = ? AND organisation_id = ?",
		wanted, projectID, u.OrganisationID).Find(&reqs)
	found := map[string]*models.Requirement{}
	for i := range reqs {
		found[reqs[i].ID] = &reqs[i]
	}
	missing := []string{}
	for _, rid := range wanted {
		if _, ok := found[rid]; !ok {
			missing = append(missing, rid)
		}
	}
	if len(missing) > 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "unknown_requirements",
			"Requirements not found in this project: "+strings.Join(missing, ", "))
		return
	}

	var cleaned []cleanStep
	if body.Steps != nil {
		cs, stepsOK := cleanSteps(c, *body.Steps)
		if !stepsOK {
			return
		}
		cleaned = cs
	}

	tc := models.TestCase{
		OrganisationID: u.OrganisationID, ProjectID: projectID,
		Title:       truncRunes(strings.TrimSpace(body.Title), titleMaxRunes),
		Description: body.Description, Preconditions: body.Preconditions,
		Type: body.Type, Priority: body.Priority,
		State: "draft", Generated: false, UserModified: false,
		Model: "", PromptVersion: "", Technique: "manual", Version: 1,
	}
	if err := db.DB.Create(&tc).Error; err != nil {
		httpx.Err(c, http.StatusInternalServerError, "internal_error", "Could not create test case")
		return
	}
	if cleaned != nil {
		insertSteps(tc.ID, cleaned)
	}
	for _, rid := range wanted {
		db.DB.Create(&models.RequirementTestCase{
			RequirementID: rid, TestCaseID: tc.ID, LinkSource: "manual",
			RequirementVersionAtLink: found[rid].Version,
		})
	}
	auditReqs := make([]any, len(wanted))
	for i, rid := range wanted {
		auditReqs[i] = rid
	}
	httpx.Audit(u.OrganisationID, &u.ID, "test_case.created", "test_case", tc.ID,
		models.JSONMap{"manual": true, "requirement_ids": auditReqs})
	c.JSON(http.StatusCreated, caseDetail(&tc, linksOf(tc.ID)))
}

// ---------------------------------------------------------------------------
// Routes — link management (FR-TRC-05)
// ---------------------------------------------------------------------------

func addLink(c *gin.Context) {
	u := httpx.User(c)
	var body struct {
		RequirementID string `json:"requirement_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "validation_error", "Invalid request body")
		return
	}
	tc, ok := getCase(c, c.Param("case_id"))
	if !ok {
		return
	}
	var req models.Requirement
	if err := db.DB.First(&req, "id = ?", body.RequirementID).Error; err != nil ||
		req.OrganisationID != u.OrganisationID || req.ProjectID != tc.ProjectID {
		httpx.Err(c, http.StatusNotFound, "not_found", "Requirement not found in this project")
		return
	}
	var existing models.RequirementTestCase
	if err := db.DB.First(&existing, "requirement_id = ? AND test_case_id = ?",
		req.ID, tc.ID).Error; err == nil {
		httpx.Err(c, http.StatusConflict, "link_exists", "This requirement is already linked")
		return
	}
	db.DB.Create(&models.RequirementTestCase{
		RequirementID: req.ID, TestCaseID: tc.ID, LinkSource: "manual",
		RequirementVersionAtLink: req.Version,
	})
	httpx.Audit(u.OrganisationID, &u.ID, "test_case.link_added", "test_case", tc.ID,
		models.JSONMap{"requirement_id": req.ID})
	c.JSON(http.StatusCreated, gin.H{"test_case_id": tc.ID, "links": linksOf(tc.ID)})
}

func removeLink(c *gin.Context) {
	u := httpx.User(c)
	tc, ok := getCase(c, c.Param("case_id"))
	if !ok {
		return
	}
	requirementID := c.Param("requirement_id")
	var link models.RequirementTestCase
	if err := db.DB.First(&link, "requirement_id = ? AND test_case_id = ?",
		requirementID, tc.ID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Link not found")
		return
	}
	var linkCount int64
	db.DB.Model(&models.RequirementTestCase{}).Where("test_case_id = ?", tc.ID).Count(&linkCount)
	if linkCount <= 1 {
		// a case may never become untraceable (FR-GEN-02 / FR-TRC-05)
		httpx.Err(c, http.StatusConflict, "last_link",
			"Cannot remove the last requirement link — every test case must trace to a requirement")
		return
	}
	db.DB.Where("requirement_id = ? AND test_case_id = ?", requirementID, tc.ID).
		Delete(&models.RequirementTestCase{})
	httpx.Audit(u.OrganisationID, &u.ID, "test_case.link_removed", "test_case", tc.ID,
		models.JSONMap{"requirement_id": requirementID})
	c.JSON(http.StatusOK, gin.H{"test_case_id": tc.ID, "links": linksOf(tc.ID)})
}
