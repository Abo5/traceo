// Path-parameter binding gate — inventories store paths as templates
// (/calendars/{calendarId}/events) and the value lives in the step's params.
// Before binding existed the engine sent the template literally
// (GET /calendars/%7BcalendarId%7D/events?calendarId=example), so every
// path-parameterised case 404'd no matter what the system under test did.
//
// These run a real run against a local recorder so the assertion is on the wire
// format actually sent, not on an internal helper.
package tests_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"traceo/internal/db"
	"traceo/internal/models"
)

// recorder is a stand-in system under test: it answers 200 and remembers the
// exact request line it received, keyed by the first path segment.
type recorder struct {
	mu    sync.Mutex
	byTag map[string]*http.Request
	srv   *httptest.Server
}

func newRecorder(t *testing.T) *recorder {
	t.Helper()
	r := &recorder{byTag: map[string]*http.Request{}}
	r.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		tag := strings.SplitN(strings.TrimPrefix(req.URL.Path, "/"), "/", 2)[0]
		r.mu.Lock()
		r.byTag[tag] = req.Clone(req.Context())
		r.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(r.srv.Close)
	return r
}

func (r *recorder) get(t *testing.T, tag string) *http.Request {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	req := r.byTag[tag]
	if req == nil {
		t.Fatalf("no request reached the system under test for /%s — the case did not run", tag)
	}
	return req
}

// seedPathCase seeds an approved single-step case; params are the step's query
// params before binding consumes any of them.
func seedPathCase(t *testing.T, orgID, projectID, title, path string, params M) {
	t.Helper()
	tc := models.TestCase{OrganisationID: orgID, ProjectID: projectID, Title: title,
		Type: "positive", Priority: "medium", State: "approved", Generated: true,
		Technique: "positive", Version: 1}
	if err := db.DB.Create(&tc).Error; err != nil {
		t.Fatalf("seed case: %v", err)
	}
	if params == nil {
		params = M{}
	}
	step := models.TestStep{TestCaseID: tc.ID, Order: 0, Method: "GET", Path: path,
		Request:     models.JSONMap{"headers": M{}, "params": params},
		Assertions:  models.JSONList{M{"type": "status_code", "expected": 200}},
		Extractions: models.JSONList{}}
	if err := db.DB.Create(&step).Error; err != nil {
		t.Fatalf("seed step: %v", err)
	}
}

func TestPathParamsAreBoundBeforeTheRequestIsSent(t *testing.T) {
	rec := newRecorder(t)
	headers, orgID, _ := seedOrgUser(t, "Path Binding Co", "admin")
	projectID := seedProject(t, orgID, "Path binding")

	env := models.Environment{OrganisationID: orgID, ProjectID: projectID, Name: "staging",
		BaseURL: rec.srv.URL, AuthType: "none", TLSStrict: boolPtr(true),
		// tenantId is only available as an environment variable — no step supplies it.
		Variables: models.JSONMap{"tenantId": "acme-sa"}}
	if err := db.DB.Create(&env).Error; err != nil {
		t.Fatalf("seed environment: %v", err)
	}

	// 1. value from the step params (and `limit` proves unrelated params survive)
	seedPathCase(t, orgID, projectID, "from params", "/calendars/{calendarId}/events",
		M{"calendarId": "example", "limit": 5})
	// 2. value from an environment variable
	seedPathCase(t, orgID, projectID, "from environment", "/tenants/{tenantId}/items", nil)
	// 3. placeholder nobody can fill stays literal
	seedPathCase(t, orgID, projectID, "unknown stays literal", "/widgets/{mysteryId}", nil)
	// 4. percent-encoding: a space must not split the request line, a slash must
	//    not smuggle in an extra path segment
	seedPathCase(t, orgID, projectID, "encoded value", "/files/{name}",
		M{"name": "annual report/2026 Q1"})

	w := do(t, "POST", "/v1/projects/"+projectID+"/runs", M{"environment_id": env.ID}, headers)
	if w.Code != 202 {
		t.Fatalf("run launch failed: %d %.300s", w.Code, w.Body.String())
	}
	pollJob(t, headers, jsonMap(t, w)["job_id"].(string))

	t.Run("value comes from the step params and its key leaves the query", func(t *testing.T) {
		req := rec.get(t, "calendars")
		if req.URL.Path != "/calendars/example/events" {
			t.Errorf("path not bound: got %q, want /calendars/example/events", req.URL.Path)
		}
		q := req.URL.Query()
		if q.Has("calendarId") {
			t.Errorf("consumed param was still sent in the query string: %q", req.URL.RawQuery)
		}
		if q.Get("limit") != "5" {
			t.Errorf("unrelated param was dropped: %q", req.URL.RawQuery)
		}
	})

	t.Run("value falls back to an environment variable", func(t *testing.T) {
		req := rec.get(t, "tenants")
		if req.URL.Path != "/tenants/acme-sa/items" {
			t.Errorf("environment variable not bound: got %q", req.URL.Path)
		}
		if req.URL.RawQuery != "" {
			t.Errorf("context binding must not add query params, got %q", req.URL.RawQuery)
		}
	})

	t.Run("unknown placeholder is left literal", func(t *testing.T) {
		req := rec.get(t, "widgets")
		if req.URL.Path != "/widgets/{mysteryId}" {
			t.Errorf("unfillable placeholder should survive verbatim, got %q", req.URL.Path)
		}
	})

	t.Run("value is percent-encoded with nothing safe", func(t *testing.T) {
		req := rec.get(t, "files")
		if req.RequestURI != "/files/annual%20report%2F2026%20Q1" {
			t.Errorf("bad encoding on the wire: %q — space must be %%20 and / must be %%2F",
				req.RequestURI)
		}
		// Escaped on the wire, so the slash never becomes a path separator for
		// the system under test; it decodes back to the single intended segment.
		if req.URL.EscapedPath() != "/files/annual%20report%2F2026%20Q1" {
			t.Errorf("encoded slash escaped its segment: %q", req.URL.EscapedPath())
		}
	})
}
