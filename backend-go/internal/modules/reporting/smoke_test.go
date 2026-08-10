package reporting

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/security"

	"github.com/xuri/excelize/v2"
)

func TestSmoke(t *testing.T) {
	dir := t.TempDir()
	os.Setenv("TRACEO_DB", filepath.Join(dir, "t.db"))
	os.Setenv("TRACEO_DATABASE_URL", filepath.Join(dir, "t.db"))
	config.Load()
	config.C.DatabaseURL = filepath.Join(dir, "t.db")
	db.DB = nil
	db.Open()

	org := models.Organisation{Name: "O"}
	db.DB.Create(&org)
	org2 := models.Organisation{Name: "O2"}
	db.DB.Create(&org2)
	h, _ := security.HashPassword("x")
	u := models.User{OrganisationID: org.ID, Email: "a@b.c", PasswordHash: h, Role: "admin"}
	db.DB.Create(&u)
	u2 := models.User{OrganisationID: org2.ID, Email: "z@b.c", PasswordHash: h, Role: "admin"}
	db.DB.Create(&u2)

	p := models.Project{OrganisationID: org.ID, Name: "Project", Automation: "manual"}
	db.DB.Create(&p)
	env := models.Environment{OrganisationID: org.ID, ProjectID: p.ID, Name: "staging"}
	db.DB.Create(&env)
	r1 := models.Requirement{OrganisationID: org.ID, ProjectID: p.ID, ExternalID: "FR-1",
		Description: "The user <must> be able to sign in", Priority: "high", State: "confirmed", Confidence: 0.876}
	db.DB.Create(&r1)
	r2 := models.Requirement{OrganisationID: org.ID, ProjectID: p.ID, ExternalID: "",
		Description: "uncovered", State: "confirmed"}
	db.DB.Create(&r2)
	tc := models.TestCase{OrganisationID: org.ID, ProjectID: p.ID, Title: "login ok",
		Type: "positive", Priority: "high", State: "approved", Generated: true, Technique: "positive"}
	db.DB.Create(&tc)
	db.DB.Create(&models.TestStep{TestCaseID: tc.ID, Order: 1, Method: "post", Path: "/login"})
	db.DB.Create(&models.RequirementTestCase{RequirementID: r1.ID, TestCaseID: tc.ID})

	now := time.Now().UTC()
	run := models.Run{OrganisationID: org.ID, ProjectID: p.ID, EnvironmentID: env.ID,
		State: "completed", StartedAt: &now, FinishedAt: &now,
		Counts: models.JSONMap{"total": 1, "passed": 0, "failed": 1, "errored": 0}}
	db.DB.Create(&run)
	db.DB.Create(&models.TestResult{RunID: run.ID, TestCaseID: tc.ID, Outcome: "failed",
		DurationMs: 42,
		FailureReason: models.JSONMap{"assertion": map[string]any{"type": "json_field"},
			"expected": 200, "actual": 500},
		Evidence: models.JSONList{map[string]any{
			"request":    map[string]any{"method": "POST", "url": "http://x/login", "headers": map[string]any{"A": "b"}, "body": map[string]any{"u": "<x>"}},
			"response":   map[string]any{"status": 500, "body": map[string]any{"e": "boom"}},
			"elapsed_ms": 42}}})

	prev := models.Run{OrganisationID: org.ID, ProjectID: p.ID, EnvironmentID: env.ID,
		State: "completed", Counts: models.JSONMap{"total": 1, "passed": 1, "failed": 0}}
	db.DB.Create(&prev)
	db.DB.Create(&models.TestResult{RunID: prev.ID, TestCaseID: tc.ID, Outcome: "passed", DurationMs: 10})

	gin.SetMode(gin.TestMode)
	app := gin.New()
	Register(app.Group("/v1"))

	tok, _ := security.CreateToken(u.ID, org.ID, u.Role)
	tok2, _ := security.CreateToken(u2.ID, org2.ID, u2.Role)
	call := func(path, token string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req, _ := http.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		app.ServeHTTP(w, req)
		return w
	}

	// xlsx
	w := call("/v1/projects/"+p.ID+"/exports/matrix.xlsx", tok)
	if w.Code != 200 {
		t.Fatalf("xlsx %d %s", w.Code, w.Body.String())
	}
	t.Log("CD:", w.Header().Get("Content-Disposition"), "CT:", w.Header().Get("Content-Type"))
	f, err := excelize.OpenReader(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("open xlsx: %v", err)
	}
	t.Log("sheets:", f.GetSheetList())
	for _, s := range f.GetSheetList() {
		rows, _ := f.GetRows(s)
		t.Logf("%s: %v", s, rows)
	}
	if w2 := call("/v1/projects/"+p.ID+"/exports/matrix.xlsx", tok2); w2.Code != 404 {
		t.Fatalf("tenant leak xlsx: %d", w2.Code)
	}

	// report json
	w = call("/v1/runs/"+run.ID+"/report", tok)
	if w.Code != 200 {
		t.Fatalf("report %d %s", w.Code, w.Body.String())
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	b, _ := json.MarshalIndent(out, "", " ")
	t.Log(string(b))
	if w2 := call("/v1/runs/"+run.ID+"/report", tok2); w2.Code != 404 {
		t.Fatalf("tenant leak report: %d", w2.Code)
	}

	// report html
	w = call("/v1/runs/"+run.ID+"/report.html", tok)
	if w.Code != 200 {
		t.Fatalf("html %d %s", w.Code, w.Body.String())
	}
	t.Log("html CT:", w.Header().Get("Content-Type"))
	t.Log(w.Body.String()[len(reportCSS)+400:])

	// compare
	w = call("/v1/runs/"+run.ID+"/compare/"+prev.ID, tok)
	if w.Code != 200 {
		t.Fatalf("compare %d %s", w.Code, w.Body.String())
	}
	t.Log("compare:", w.Body.String())
}

func TestPercentile(t *testing.T) {
	cases := []struct {
		vals []int
		q    float64
		want int
	}{
		{[]int{1, 2}, 0.50, 1},       // python round(0.5) == 0 (banker's)
		{[]int{1, 2, 3}, 0.50, 2},    // round(1.0) == 1
		{[]int{1, 2, 3, 4}, 0.50, 3}, // round(1.5) == 2 (banker's) -> index 2
		{[]int{1, 2}, 0.95, 2},
		{[]int{5}, 0.95, 5},
	}
	for _, c := range cases {
		if got := percentile(c.vals, c.q); got != c.want {
			t.Errorf("percentile(%v,%v)=%d want %d", c.vals, c.q, got, c.want)
		}
	}
}
