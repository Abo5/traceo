// RELEASE GATE — multi-tenant isolation (port of backend/tests/test_isolation.py).
//
// Two organisations A and B. A builds a full world (project, requirement, spec,
// manual test case); B must see NOTHING of it: project-scoped reads return 404,
// object reads AND mutations return 404, and B's own listings stay empty.
package tests_test

import (
	"strings"
	"testing"
)

// projectScopedGets — every project-scoped GET the owner may read and the other
// org must not (Python's PROJECT_SCOPED_GETS parametrization).
var projectScopedGets = []string{
	"/v1/projects/{pid}",
	"/v1/projects/{pid}/requirements",
	"/v1/projects/{pid}/documents",
	"/v1/projects/{pid}/endpoints",
	"/v1/projects/{pid}/test-cases",
	"/v1/projects/{pid}/traceability",
	"/v1/projects/{pid}/runs",
	"/v1/projects/{pid}/environments",
	"/v1/projects/{pid}/dashboard",
	"/v1/projects/{pid}/exports/matrix.xlsx",
}

type isolationWorld struct {
	a, b          map[string]string
	pid           string
	requirementID string
	testCaseID    string
}

// setupIsolationWorld — org A with a project, one requirement and an imported
// spec; org B is a stranger. Port of test_isolation._setup_world.
func setupIsolationWorld(t *testing.T, withTestCase bool) isolationWorld {
	t.Helper()
	a := registerOrg(t, "Org A")
	b := registerOrg(t, "Org B")
	pid := createProject(t, a, "مشروع المنظمة أ", "ar")
	rid := addRequirement(t, a, pid, "REQ-ISO-1",
		"Create a customer via POST /customers with valid phone and age", nil)
	importSpec(t, a, pid)

	world := isolationWorld{a: a, b: b, pid: pid, requirementID: rid}
	if !withTestCase {
		return world
	}

	w := do(t, "POST", "/v1/projects/"+pid+"/test-cases", M{
		"title":           "Manual: create customer with valid data",
		"description":     "Manually authored case for isolation testing",
		"preconditions":   "Authenticated session",
		"type":            "positive",
		"priority":        "high",
		"requirement_ids": []string{rid},
		"steps": []M{{
			"order": 0, "method": "POST", "path": "/customers",
			"request": M{
				"headers": M{"Content-Type": "application/json"},
				"params":  M{},
				"body":    M{"name": "أحمد", "phone": "0512345678", "age": 30},
			},
			"assertions":  []M{{"type": "status_code", "expected": 201}},
			"extractions": []M{},
		}},
	}, a)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("manual test case creation failed: %d %.300s", w.Code, w.Body.String())
	}
	data := jsonMap(t, w)
	tcid, _ := data["id"].(string)
	if tcid == "" {
		if tc, ok := data["test_case"].(map[string]any); ok {
			tcid, _ = tc["id"].(string)
		}
	}
	if tcid == "" {
		t.Fatalf("no test case id in response: %v", data)
	}
	world.testCaseID = tcid
	return world
}

func TestProjectScopedReadsAre404AcrossOrgs(t *testing.T) {
	world := setupIsolationWorld(t, false)

	for _, template := range projectScopedGets {
		template := template
		url := strings.ReplaceAll(template, "{pid}", world.pid)
		t.Run(template, func(t *testing.T) {
			// sanity: the owner org CAN read it
			if w := do(t, "GET", url, nil, world.a); w.Code != 200 {
				t.Fatalf("owner should access %s: %d %.300s", url, w.Code, w.Body.String())
			}
			// the other org gets 404 — never a leak, never a 403 oracle with data
			if w := do(t, "GET", url, nil, world.b); w.Code != 404 {
				t.Fatalf("cross-org read of %s must 404, got %d: %.300s",
					url, w.Code, w.Body.String())
			}
		})
	}
}

func TestCrossOrgTestCaseDetailIs404(t *testing.T) {
	world := setupIsolationWorld(t, true)

	if w := do(t, "GET", "/v1/test-cases/"+world.testCaseID, nil, world.a); w.Code != 200 {
		t.Fatalf("owner read must 200, got %d: %.300s", w.Code, w.Body.String())
	}
	if w := do(t, "GET", "/v1/test-cases/"+world.testCaseID, nil, world.b); w.Code != 404 {
		t.Fatalf("cross-org read must 404, got %d: %.300s", w.Code, w.Body.String())
	}
	// mutations are blocked with the same 404 (no existence oracle)
	if w := do(t, "POST", "/v1/test-cases/"+world.testCaseID+"/approve", nil, world.b); w.Code != 404 {
		t.Fatalf("cross-org approve must 404, got %d: %.300s", w.Code, w.Body.String())
	}
}

func TestCrossOrgRequirementAccessIs404(t *testing.T) {
	world := setupIsolationWorld(t, false)
	rid := world.requirementID

	if w := do(t, "PATCH", "/v1/requirements/"+rid, M{"priority": "low"}, world.a); w.Code != 200 {
		t.Fatalf("owner patch must 200, got %d: %.300s", w.Code, w.Body.String())
	}
	if w := do(t, "PATCH", "/v1/requirements/"+rid, M{"priority": "low"}, world.b); w.Code != 404 {
		t.Fatalf("cross-org patch must 404, got %d: %.300s", w.Code, w.Body.String())
	}
	if w := do(t, "DELETE", "/v1/requirements/"+rid, nil, world.b); w.Code != 404 {
		t.Fatalf("cross-org delete must 404, got %d: %.300s", w.Code, w.Body.String())
	}
}

func TestOrgBListingsDoNotLeakOrgAObjects(t *testing.T) {
	world := setupIsolationWorld(t, true)

	// B's project list is entirely empty — A's project never appears
	w := do(t, "GET", "/v1/projects", nil, world.b)
	if w.Code != 200 {
		t.Fatalf("project list failed: %d %.300s", w.Code, w.Body.String())
	}
	if rows := itemsOf(jsonAny(t, w)); len(rows) != 0 {
		t.Fatalf("org B project list leaked: %.300s", w.Body.String())
	}

	// B creates its own project: its scoped listings stay empty of A's data
	pidB := createProject(t, world.b, "مشروع المنظمة ب", "ar")
	for _, suffix := range []string{"requirements", "endpoints", "test-cases", "documents", "runs"} {
		w = do(t, "GET", "/v1/projects/"+pidB+"/"+suffix, nil, world.b)
		if w.Code != 200 {
			t.Fatalf("%s: %d %.300s", suffix, w.Code, w.Body.String())
		}
		if rows := itemsOf(jsonAny(t, w)); len(rows) != 0 {
			t.Fatalf("org B saw rows in fresh project %s: %v", suffix, rows)
		}
	}

	// and A still sees its own data (isolation is not deletion)
	if w = do(t, "GET", "/v1/projects/"+world.pid, nil, world.a); w.Code != 200 {
		t.Fatalf("owner project read must 200, got %d", w.Code)
	}
	if w = do(t, "GET", "/v1/test-cases/"+world.testCaseID, nil, world.a); w.Code != 200 {
		t.Fatalf("owner test case read must 200, got %d", w.Code)
	}
}
