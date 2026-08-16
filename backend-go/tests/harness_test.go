// Package tests_test — quality gates for the Go backend (GO_CONTRACT.md §Quality gates).
//
// TestMain boots a fresh app exactly the way cmd/server/main.go does: temp sqlite
// via TRACEO_DATABASE_URL (set BEFORE config.Load so job goroutines share the same
// file), demo seed off, mock LLM, every module Register mounted under /v1.
//
// HTTP helpers mirror backend/tests/conftest.py. Where a fixture belongs to a
// module still under construction by another agent (identity register, projects
// create), helpers first try the real HTTP route and only then fall back to
// seeding rows directly — so module-scoped gates (integrations, reference) run
// today and the fallbacks become dead code as the other modules land. The
// cross-module gates (flow, isolation, grounding e2e) use HTTP only and are
// EXPECTED to fail until those modules are implemented.
package tests_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/components"
	"traceo/internal/modules/discovery"
	"traceo/internal/modules/execution"
	"traceo/internal/modules/generation"
	"traceo/internal/modules/identity"
	"traceo/internal/modules/ingestion"
	"traceo/internal/modules/insight"
	"traceo/internal/modules/integrations"
	"traceo/internal/modules/projects"
	"traceo/internal/modules/reference"
	"traceo/internal/modules/reporting"
	"traceo/internal/modules/review"
	secmod "traceo/internal/modules/security"
	"traceo/internal/modules/traceability"
	"traceo/internal/modules/webtarget"
	"traceo/internal/security"
)

type M = map[string]any

var engine *gin.Engine

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "traceo-go-tests-")
	if err != nil {
		panic(err)
	}
	os.Setenv("TRACEO_DATABASE_URL", filepath.Join(dir, "test.db"))
	os.Setenv("TRACEO_SEED_DEMO", "0")
	os.Setenv("TRACEO_LLM_PROVIDER", "mock")
	os.Setenv("TRACEO_STORAGE_DIR", filepath.Join(dir, "storage"))
	config.Load()
	db.Open()

	gin.SetMode(gin.TestMode)
	engine = gin.New()
	engine.Use(gin.Recovery())
	v1 := engine.Group(config.C.APIPrefix)
	v1.GET("/jobs/:id", httpx.Auth(), func(c *gin.Context) {
		j := jobs.Get(c.Param("id"))
		if j == nil {
			httpx.Err(c, 404, "not_found", "Job not found")
			return
		}
		c.JSON(200, j.Snapshot())
	})
	for _, reg := range []func(*gin.RouterGroup){
		identity.Register, projects.Register, ingestion.Register, discovery.Register,
		generation.Register, review.Register, execution.Register, traceability.Register,
		reporting.Register, integrations.Register, reference.Register, insight.Register,
		secmod.Register, components.Register, webtarget.Register,
	} {
		reg(v1)
	}

	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

func do(t *testing.T, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	contentType := ""
	switch b := body.(type) {
	case nil:
	case io.Reader:
		reader = b
	case []byte:
		reader = bytes.NewReader(b)
		contentType = "application/json"
	default:
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(raw)
		contentType = "application/json"
	}
	req := httptest.NewRequest(method, path, reader)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, req)
	return w
}

// uploadFile POSTs a multipart body with field name "file" (contract convention).
func uploadFile(t *testing.T, path, filename string, content []byte, mimeType string,
	headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
	h.Set("Content-Type", mimeType)
	part, err := mw.CreatePart(h)
	if err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatalf("multipart write: %v", err)
	}
	mw.Close()
	req := httptest.NewRequest("POST", path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, req)
	return w
}

func jsonMap(t *testing.T, w *httptest.ResponseRecorder) M {
	t.Helper()
	var out M
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not a JSON object: %v — %.300s", err, w.Body.String())
	}
	return out
}

func jsonAny(t *testing.T, w *httptest.ResponseRecorder) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("response is not JSON: %v — %.300s", err, w.Body.String())
	}
	return out
}

// itemsOf normalizes list endpoints that may return a bare list or a wrapped object
// (port of conftest.items_of).
func itemsOf(payload any) []any {
	if l, ok := payload.([]any); ok {
		return l
	}
	if m, ok := payload.(M); ok {
		for _, key := range []string{"items", "rows", "results", "data", "test_cases",
			"requirements", "endpoints", "runs", "environments", "documents", "cases"} {
			if l, ok := m[key].([]any); ok {
				return l
			}
		}
	}
	return []any{}
}

func pollJob(t *testing.T, headers map[string]string, jobID string) M {
	t.Helper()
	if jobID == "" {
		t.Fatal("pollJob called without a job id")
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		w := do(t, "GET", "/v1/jobs/"+jobID, nil, headers)
		if w.Code != 200 {
			t.Fatalf("job poll failed: %d %.300s", w.Code, w.Body.String())
		}
		job := jsonMap(t, w)
		switch job["status"] {
		case "completed":
			return job
		case "failed":
			t.Fatalf("job %s failed: %v", jobID, job["error"])
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("job %s did not finish within 30s", jobID)
	return nil
}

// ---------------------------------------------------------------------------
// Fixture helpers (HTTP first, direct-seed fallback for still-stubbed modules)
// ---------------------------------------------------------------------------

// registerOrg registers a fresh org + admin via POST /v1/auth/register; while the
// identity module is a stub it seeds the rows directly (shared security foundation).
func registerOrg(t *testing.T, orgName string) map[string]string {
	t.Helper()
	email := fmt.Sprintf("u%s@example.sa", uuid.NewString()[:10])
	w := do(t, "POST", "/v1/auth/register", M{
		"org_name": orgName, "name": "Tester", "email": email, "password": "Passw0rd!",
	}, nil)
	if w.Code == 200 || w.Code == 201 {
		data := jsonMap(t, w)
		tok, _ := data["token"].(string)
		if tok == "" {
			tok, _ = data["access_token"].(string)
		}
		if tok != "" {
			return map[string]string{"Authorization": "Bearer " + tok}
		}
	}
	h, _, _ := seedOrgUser(t, orgName, "admin")
	return h
}

func seedOrgUser(t *testing.T, orgName, role string) (map[string]string, string, string) {
	t.Helper()
	org := models.Organisation{Name: orgName, Plan: "free", Settings: models.JSONMap{}}
	if err := db.DB.Create(&org).Error; err != nil {
		t.Fatalf("seed org: %v", err)
	}
	u := models.User{OrganisationID: org.ID,
		Email: fmt.Sprintf("u%s@example.sa", uuid.NewString()[:10]),
		Name:  "Tester", PasswordHash: "x", Role: role, Locale: "en"}
	if err := db.DB.Create(&u).Error; err != nil {
		t.Fatalf("seed user: %v", err)
	}
	tok, err := security.CreateToken(u.ID, org.ID, u.Role)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + tok}, org.ID, u.ID
}

// createProject makes a MANUAL-automation project — the flow/isolation/grounding
// gates exercise the hand-driven endpoints; autopilot has its own gates.
func createProject(t *testing.T, headers map[string]string, name string) string {
	t.Helper()
	w := do(t, "POST", "/v1/projects",
		M{"name": name, "automation": "manual"}, headers)
	if w.Code == 200 || w.Code == 201 {
		data := jsonMap(t, w)
		if id, _ := data["id"].(string); id != "" {
			return id
		}
		if p, ok := data["project"].(M); ok {
			if id, _ := p["id"].(string); id != "" {
				return id
			}
		}
	}
	t.Fatalf("create project failed: %d %.300s", w.Code, w.Body.String())
	return ""
}

// createProjectSeeded — direct-seed variant for module-scoped gates while the
// projects module is a stub.
func seedProject(t *testing.T, orgID, name string) string {
	t.Helper()
	p := models.Project{OrganisationID: orgID, Name: name,
		Status: "active", Automation: "manual"}
	if err := db.DB.Create(&p).Error; err != nil {
		t.Fatalf("seed project: %v", err)
	}
	return p.ID
}

func seedEnvironment(t *testing.T, orgID, projectID string) string {
	t.Helper()
	e := models.Environment{OrganisationID: orgID, ProjectID: projectID,
		Name: "staging", BaseURL: "http://127.0.0.1:9", AuthType: "none",
		Variables: models.JSONMap{}, TLSStrict: boolPtr(true)}
	if err := db.DB.Create(&e).Error; err != nil {
		t.Fatalf("seed environment: %v", err)
	}
	return e.ID
}

func seedRequirement(t *testing.T, orgID, projectID, externalID, state, priority string) string {
	t.Helper()
	r := models.Requirement{OrganisationID: orgID, ProjectID: projectID,
		ExternalID: externalID, Description: "Test requirement " + externalID,
		AcceptanceCriteria: models.JSONList{}, Type: "functional",
		Priority: priority, State: state, Version: 1,
		SourceLocation: models.JSONMap{}, Confidence: 1}
	if err := db.DB.Create(&r).Error; err != nil {
		t.Fatalf("seed requirement: %v", err)
	}
	return r.ID
}

func seedTestCase(t *testing.T, orgID, projectID, title, state string, reqIDs ...string) string {
	t.Helper()
	tc := models.TestCase{OrganisationID: orgID, ProjectID: projectID, Title: title,
		Type: "positive", Priority: "medium", State: state, Generated: true,
		Technique: "positive", Version: 1}
	if err := db.DB.Create(&tc).Error; err != nil {
		t.Fatalf("seed test case: %v", err)
	}
	step := models.TestStep{TestCaseID: tc.ID, Order: 0, Method: "POST", Path: "/customers",
		Request: models.JSONMap{"headers": M{"Content-Type": "application/json"},
			"params": M{}, "body": M{"name": "Sarah", "phone": "0512345678", "age": 30}},
		Assertions:  models.JSONList{M{"type": "status_code", "expected": 201}},
		Extractions: models.JSONList{}}
	if err := db.DB.Create(&step).Error; err != nil {
		t.Fatalf("seed step: %v", err)
	}
	for _, rid := range reqIDs {
		link := models.RequirementTestCase{RequirementID: rid, TestCaseID: tc.ID,
			LinkSource: "generated", RequirementVersionAtLink: 1}
		if err := db.DB.Create(&link).Error; err != nil {
			t.Fatalf("seed link: %v", err)
		}
	}
	return tc.ID
}

func seedRun(t *testing.T, orgID, projectID, envID, state string, counts models.JSONMap) string {
	t.Helper()
	now := time.Now().UTC()
	run := models.Run{OrganisationID: orgID, ProjectID: projectID, EnvironmentID: envID,
		State: state, StartedAt: &now, FinishedAt: &now, Counts: counts, InitiatedBy: "seed"}
	if err := db.DB.Create(&run).Error; err != nil {
		t.Fatalf("seed run: %v", err)
	}
	return run.ID
}

func seedResult(t *testing.T, runID, caseID, outcome string, failureReason models.JSONMap) string {
	t.Helper()
	res := models.TestResult{RunID: runID, TestCaseID: caseID, TestCaseVersion: 1,
		Outcome: outcome, DurationMs: 12, FailureReason: failureReason,
		Evidence: models.JSONList{}}
	if err := db.DB.Create(&res).Error; err != nil {
		t.Fatalf("seed result: %v", err)
	}
	return res.ID
}

// smallOpenAPISpec — port of conftest.small_openapi_spec (2-endpoint OpenAPI 3 spec).
func smallOpenAPISpec() M {
	return M{
		"openapi": "3.0.3",
		"info":    M{"title": "Customers API", "version": "1.0.0"},
		"paths": M{
			"/customers": M{
				"post": M{
					"operationId": "createCustomer",
					"summary":     "Create a customer with phone and age validation",
					"requestBody": M{
						"required": true,
						"content": M{"application/json": M{"schema": M{
							"type":     "object",
							"required": []string{"name", "phone", "age"},
							"properties": M{
								"name":  M{"type": "string", "minLength": 1, "maxLength": 100},
								"phone": M{"type": "string", "pattern": "^05[0-9]{8}$"},
								"email": M{"type": "string", "format": "email"},
								"age":   M{"type": "integer", "minimum": 18, "maximum": 120},
							},
						}}},
					},
					"responses": M{
						"201": M{"description": "Created", "content": M{"application/json": M{
							"schema": M{"type": "object", "properties": M{
								"id": M{"type": "string"}, "name": M{"type": "string"},
							}}}}},
						"422": M{"description": "Validation error"},
					},
				},
			},
			"/customers/{id}": M{
				"get": M{
					"operationId": "getCustomer",
					"summary":     "Get a customer by id",
					"parameters": []M{{"name": "id", "in": "path", "required": true,
						"schema": M{"type": "string"}}},
					"responses": M{
						"200": M{"description": "OK", "content": M{"application/json": M{
							"schema": M{"type": "object", "properties": M{
								"id": M{"type": "string"}, "name": M{"type": "string"},
								"phone": M{"type": "string"},
							}}}}},
						"404": M{"description": "Not found"},
					},
				},
			},
		},
	}
}

func importSpec(t *testing.T, headers map[string]string, projectID string) M {
	t.Helper()
	raw, _ := json.Marshal(smallOpenAPISpec())
	w := uploadFile(t, "/v1/projects/"+projectID+"/api-specs", "spec.json", raw,
		"application/json", headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("spec import failed: %d %.300s", w.Code, w.Body.String())
	}
	if len(bytes.TrimSpace(w.Body.Bytes())) == 0 {
		return M{}
	}
	return jsonMap(t, w)
}

func addRequirement(t *testing.T, headers map[string]string, projectID, externalID,
	description string, criteria []string) string {
	t.Helper()
	if criteria == nil {
		criteria = []string{}
	}
	w := do(t, "POST", "/v1/requirements", M{
		"project_id": projectID, "external_id": externalID, "description": description,
		"acceptance_criteria": criteria, "type": "functional", "priority": "high",
	}, headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("add requirement failed: %d %.300s", w.Code, w.Body.String())
	}
	data := jsonMap(t, w)
	if id, _ := data["id"].(string); id != "" {
		return id
	}
	if r, ok := data["requirement"].(M); ok {
		if id, _ := r["id"].(string); id != "" {
			return id
		}
	}
	t.Fatalf("no requirement id in response: %.300s", w.Body.String())
	return ""
}

func confirmRequirement(t *testing.T, headers map[string]string, requirementID string) {
	t.Helper()
	w := do(t, "PATCH", "/v1/requirements/"+requirementID, M{"state": "confirmed"}, headers)
	if w.Code != 200 {
		t.Fatalf("confirm requirement failed: %d %.300s", w.Code, w.Body.String())
	}
}

func bodyContains(w *httptest.ResponseRecorder, s string) bool {
	return strings.Contains(w.Body.String(), s)
}

func boolPtr(v bool) *bool { return &v }
