package review

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/security"
)

var (
	engine *gin.Engine
	tok    string
	tokOth string
	orgA   string
	projA  string
	reqA1  string
	reqA2  string
	caseA  string
)

func setup(t *testing.T) {
	if engine != nil {
		return
	}
	dir := t.TempDir()
	os.Setenv("TRACEO_DATABASE_URL", filepath.Join(dir, "t.db"))
	config.Load()
	db.Open()
	gin.SetMode(gin.TestMode)
	engine = gin.New()
	Register(engine.Group("/v1"))

	mk := func(name, email, role string) (string, string) {
		org := models.Organisation{Name: name}
		db.DB.Create(&org)
		h, _ := security.HashPassword("x")
		u := models.User{OrganisationID: org.ID, Email: email, Name: name, PasswordHash: h, Role: role}
		db.DB.Create(&u)
		tk, _ := security.CreateToken(u.ID, org.ID, role)
		return org.ID, tk
	}
	orgA, tok = mk("A", "a@x.com", "admin")
	_, tokOth = mk("B", "b@x.com", "admin")

	p := models.Project{OrganisationID: orgA, Name: "P", Language: "en", Status: "active"}
	db.DB.Create(&p)
	projA = p.ID
	r1 := models.Requirement{OrganisationID: orgA, ProjectID: projA, ExternalID: "FR-1",
		Description: "d1", State: "confirmed", Version: 2}
	r2 := models.Requirement{OrganisationID: orgA, ProjectID: projA, ExternalID: "FR-2",
		Description: "d2", State: "confirmed", Version: 1}
	db.DB.Create(&r1)
	db.DB.Create(&r2)
	reqA1, reqA2 = r1.ID, r2.ID
}

func do(t *testing.T, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var rdr *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, rdr)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, req)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func TestReviewFlow(t *testing.T) {
	setup(t)

	// manual create
	code, out := do(t, "POST", "/v1/projects/"+projA+"/test-cases", tok, map[string]any{
		"title": " Manual case ", "requirement_ids": []string{reqA1, reqA1, reqA2},
		"type": "positive", "priority": "high",
		"steps": []any{map[string]any{"path": "/a", "method": "post"},
			map[string]any{"path": "/b"}},
	})
	if code != 201 {
		t.Fatalf("create=%d %v", code, out)
	}
	caseA, _ = out["id"].(string)
	if out["title"] != "Manual case" || out["technique"] != "manual" || out["step_count"].(float64) != 2 {
		t.Fatalf("create payload: %v", out)
	}
	if len(out["links"].([]any)) != 2 || len(out["requirements"].([]any)) != 2 {
		t.Fatalf("links: %v", out["links"])
	}
	steps := out["steps"].([]any)
	s0 := steps[0].(map[string]any)
	if s0["method"] != "POST" || s0["path"] != "/a" || s0["order"].(float64) != 0 {
		t.Fatalf("step0: %v", s0)
	}
	if out["rejection_reason"] != nil || out["approved_by"] != nil || out["version"].(float64) != 1 {
		t.Fatalf("nulls/version: %v", out)
	}
	// link carries requirement version at link time
	var l models.RequirementTestCase
	db.DB.First(&l, "requirement_id = ? AND test_case_id = ?", reqA1, caseA)
	if l.RequirementVersionAtLink != 2 || l.LinkSource != "manual" {
		t.Fatalf("link row: %+v", l)
	}

	// tenant isolation
	if code, _ = do(t, "GET", "/v1/test-cases/"+caseA, tokOth, nil); code != 404 {
		t.Fatalf("cross-org get=%d", code)
	}
	if code, _ = do(t, "GET", "/v1/projects/"+projA+"/test-cases", tokOth, nil); code != 404 {
		t.Fatalf("cross-org list=%d", code)
	}

	// list + filters
	code, out = do(t, "GET", "/v1/projects/"+projA+"/test-cases?state=draft&type=positive&q=MANUAL&requirement_id="+reqA2, tok, nil)
	if code != 200 || len(out["test_cases"].([]any)) != 1 {
		t.Fatalf("list=%d %v", code, out)
	}
	first := out["test_cases"].([]any)[0].(map[string]any)
	if first["step_count"].(float64) != 2 || len(first["links"].([]any)) != 2 {
		t.Fatalf("list row: %v", first)
	}
	code, out = do(t, "GET", "/v1/projects/"+projA+"/test-cases?state=approved", tok, nil)
	if code != 200 || len(out["test_cases"].([]any)) != 0 {
		t.Fatalf("list filter=%d %v", code, out)
	}

	// approve
	code, out = do(t, "POST", "/v1/test-cases/"+caseA+"/approve", tok, nil)
	if code != 200 || out["state"] != "approved" || out["approved_by"] == nil ||
		out["step_count"].(float64) != 2 {
		t.Fatalf("approve=%d %v", code, out)
	}

	// patch resets to draft + bumps version
	code, out = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{"description": "new"})
	if code != 200 || out["state"] != "draft" || out["version"].(float64) != 2 ||
		out["user_modified"] != true || out["approved_by"] != nil || out["approved_at"] != nil {
		t.Fatalf("patch=%d %v", code, out)
	}
	// no-op patch does not bump
	code, out = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{"description": "new"})
	if code != 200 || out["version"].(float64) != 2 {
		t.Fatalf("noop patch=%d %v", code, out)
	}

	// patch invalid type / bad steps
	if code, out = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{"type": "weird"}); code != 422 {
		t.Fatalf("bad type=%d %v", code, out)
	}
	if code, out = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{"steps": []any{}}); code != 422 {
		t.Fatalf("empty steps=%d %v", code, out)
	}
	code, out = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{"steps": []any{map[string]any{"method": "GET"}}})
	if code != 422 || out["detail"].(map[string]any)["message"] != "step 0 is missing 'path'" {
		t.Fatalf("missing path=%d %v", code, out)
	}
	// step replacement
	code, out = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{
		"steps": []any{map[string]any{"path": "/only", "assertions": []any{map[string]any{"type": "status_code"}}}}})
	if code != 200 || out["step_count"].(float64) != 1 || len(out["steps"].([]any)) != 1 {
		t.Fatalf("replace steps=%d %v", code, out)
	}

	// reject
	code, out = do(t, "POST", "/v1/test-cases/"+caseA+"/reject", tok, map[string]any{
		"reason_code": "shallow", "reason_text": "too thin"})
	if code != 200 || out["state"] != "rejected" || out["rejection_reason"] != "shallow: too thin" {
		t.Fatalf("reject=%d %v", code, out)
	}
	if code, _ = do(t, "POST", "/v1/test-cases/"+caseA+"/reject", tok, map[string]any{"reason_code": "nope"}); code != 422 {
		t.Fatalf("bad reason=%d", code)
	}
	// approve clears rejection_reason
	code, out = do(t, "POST", "/v1/test-cases/"+caseA+"/approve", tok, nil)
	if code != 200 || out["rejection_reason"] != nil {
		t.Fatalf("approve clear=%d %v", code, out)
	}

	// bulk
	code, out = do(t, "POST", "/v1/test-cases/bulk", tok, map[string]any{
		"ids": []string{caseA, "missing-id"}, "action": "approve"})
	if code != 200 || out["processed"].(float64) != 1 || len(out["errors"].([]any)) != 1 {
		t.Fatalf("bulk=%d %v", code, out)
	}
	if code, _ = do(t, "POST", "/v1/test-cases/bulk", tok, map[string]any{"ids": []string{}, "action": "approve"}); code != 422 {
		t.Fatalf("bulk empty=%d", code)
	}
	if code, _ = do(t, "POST", "/v1/test-cases/bulk", tok, map[string]any{"ids": []string{caseA}, "action": "nope"}); code != 422 {
		t.Fatalf("bulk action=%d", code)
	}
	// bulk cross-org -> not_found error entry
	code, out = do(t, "POST", "/v1/test-cases/bulk", tokOth, map[string]any{
		"ids": []string{caseA}, "action": "approve"})
	if code != 200 || out["processed"].(float64) != 0 {
		t.Fatalf("bulk cross-org=%d %v", code, out)
	}
	// bulk reject defaults reason_code to "other"
	code, out = do(t, "POST", "/v1/test-cases/bulk", tok, map[string]any{
		"ids": []string{caseA}, "action": "reject"})
	if code != 200 || out["processed"].(float64) != 1 {
		t.Fatalf("bulk reject=%d %v", code, out)
	}
	code, out = do(t, "GET", "/v1/test-cases/"+caseA, tok, nil)
	if out["rejection_reason"] != "other" {
		t.Fatalf("bulk reject reason=%v", out)
	}

	// archived guards
	db.DB.Model(&models.TestCase{}).Where("id = ?", caseA).Update("state", "archived")
	if code, _ = do(t, "POST", "/v1/test-cases/"+caseA+"/approve", tok, nil); code != 409 {
		t.Fatalf("archived approve=%d", code)
	}
	if code, _ = do(t, "PATCH", "/v1/test-cases/"+caseA, tok, map[string]any{"title": "z"}); code != 409 {
		t.Fatalf("archived patch=%d", code)
	}
	code, out = do(t, "POST", "/v1/test-cases/bulk", tok, map[string]any{
		"ids": []string{caseA}, "action": "reject"})
	errs := out["errors"].([]any)
	if code != 200 || out["processed"].(float64) != 0 || errs[0].(map[string]any)["code"] != "invalid_state" {
		t.Fatalf("bulk archived=%d %v", code, out)
	}
	db.DB.Model(&models.TestCase{}).Where("id = ?", caseA).Update("state", "draft")

	// links: duplicate -> 409, unknown -> 404, remove -> 200, last -> 409
	if code, _ = do(t, "POST", "/v1/test-cases/"+caseA+"/links", tok, map[string]any{"requirement_id": reqA1}); code != 409 {
		t.Fatalf("dup link=%d", code)
	}
	if code, _ = do(t, "POST", "/v1/test-cases/"+caseA+"/links", tok, map[string]any{"requirement_id": "nope"}); code != 404 {
		t.Fatalf("unknown link=%d", code)
	}
	code, out = do(t, "DELETE", "/v1/test-cases/"+caseA+"/links/"+reqA2, tok, nil)
	if code != 200 || len(out["links"].([]any)) != 1 {
		t.Fatalf("unlink=%d %v", code, out)
	}
	if code, _ = do(t, "DELETE", "/v1/test-cases/"+caseA+"/links/"+reqA1, tok, nil); code != 409 {
		t.Fatalf("last link=%d", code)
	}
	if code, _ = do(t, "DELETE", "/v1/test-cases/"+caseA+"/links/"+reqA2, tok, nil); code != 404 {
		t.Fatalf("gone link=%d", code)
	}
	code, out = do(t, "POST", "/v1/test-cases/"+caseA+"/links", tok, map[string]any{"requirement_id": reqA2})
	if code != 201 || len(out["links"].([]any)) != 2 {
		t.Fatalf("readd=%d %v", code, out)
	}

	// create validation
	if code, _ = do(t, "POST", "/v1/projects/"+projA+"/test-cases", tok, map[string]any{
		"title": "x", "requirement_ids": []string{}}); code != 422 {
		t.Fatalf("no reqs=%d", code)
	}
	code, out = do(t, "POST", "/v1/projects/"+projA+"/test-cases", tok, map[string]any{
		"title": "x", "requirement_ids": []string{"ghost"}})
	if code != 422 || out["detail"].(map[string]any)["code"] != "unknown_requirements" {
		t.Fatalf("ghost req=%d %v", code, out)
	}
	if code, _ = do(t, "POST", "/v1/projects/"+projA+"/test-cases", tokOth, map[string]any{
		"title": "x", "requirement_ids": []string{reqA1}}); code != 404 {
		t.Fatalf("cross-org create=%d", code)
	}

	// audit rows written
	var n int64
	db.DB.Model(&models.AuditEntry{}).Where("object_id = ?", caseA).Count(&n)
	if n < 8 {
		t.Fatalf("audit count=%d", n)
	}
}

func TestRouterRegistration(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r.Group("/v1"))
	found := map[string]bool{}
	for _, ri := range r.Routes() {
		found[ri.Method+" "+ri.Path] = true
	}
	for _, want := range []string{
		"GET /v1/projects/:project_id/test-cases",
		"POST /v1/projects/:project_id/test-cases",
		"GET /v1/test-cases/:case_id",
		"PATCH /v1/test-cases/:case_id",
		"POST /v1/test-cases/:case_id/approve",
		"POST /v1/test-cases/:case_id/reject",
		"POST /v1/test-cases/bulk",
		"POST /v1/test-cases/:case_id/links",
		"DELETE /v1/test-cases/:case_id/links/:requirement_id",
	} {
		if !found[want] {
			t.Fatalf("missing route %s", want)
		}
	}
}
