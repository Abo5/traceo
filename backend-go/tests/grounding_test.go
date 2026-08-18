// RELEASE GATE — grounding (port of backend/tests/test_grounding.py; FR-GEN-06,
// BR-09, BO-07).
//
// The grounding validator is the hard gate between the generator and
// persistence: a single fabricated endpoint, method, parameter, body field or
// missing requirement link must yield violations so the case is DISCARDED —
// never repaired, never shown.
//
// Part 1 is adversarial unit tests against generation.GroundingValidate
// directly. The Go inventory is keyed by the string "METHOD path" instead of
// Python's (method, path) tuple — the only shape difference.
// Part 2 is end-to-end: everything the pipeline persists must be grounded in
// the imported endpoint inventory.
package tests_test

import (
	"strings"
	"testing"

	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

// ---------------------------------------------------------------------------
// Unit fixtures — an inventory of two endpoints, keyed by "METHOD path"
// ---------------------------------------------------------------------------

func makeGroundingInventory() map[string]*models.Endpoint {
	postCustomers := &models.Endpoint{
		Method:     "POST",
		Path:       "/customers",
		Parameters: models.JSONList{},
		RequestSchema: models.JSONMap{
			"type":     "object",
			"required": []any{"name", "phone", "age"},
			"properties": map[string]any{
				"name":  map[string]any{"type": "string", "minLength": 1, "maxLength": 100},
				"phone": map[string]any{"type": "string", "pattern": "^05[0-9]{8}$"},
				"email": map[string]any{"type": "string", "format": "email"},
				"age":   map[string]any{"type": "integer", "minimum": 18, "maximum": 120},
			},
		},
		ResponseSchemas: models.JSONMap{
			"201": map[string]any{"type": "object", "properties": map[string]any{
				"id": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"}}},
		},
		Security: models.JSONList{map[string]any{"bearerAuth": []any{}}},
		Tags:     models.JSONList{},
	}
	postCustomers.ID = "ep-post-customers"

	getCustomer := &models.Endpoint{
		Method: "GET",
		Path:   "/customers/{id}",
		Parameters: models.JSONList{map[string]any{
			"name": "id", "location": "path", "type": "string",
			"required": true, "constraints": map[string]any{}}},
		RequestSchema: nil,
		ResponseSchemas: models.JSONMap{
			"200": map[string]any{"type": "object", "properties": map[string]any{
				"id": map[string]any{"type": "string"}, "name": map[string]any{"type": "string"},
				"phone": map[string]any{"type": "string"}}},
		},
		Security: models.JSONList{map[string]any{"bearerAuth": []any{}}},
		Tags:     models.JSONList{},
	}
	getCustomer.ID = "ep-get-customer"

	return map[string]*models.Endpoint{
		"POST /customers":     postCustomers,
		"GET /customers/{id}": getCustomer,
	}
}

func makeGroundedCase() map[string]any {
	return map[string]any{
		"title":           "Positive: valid request — POST /customers",
		"requirement_ids": []any{"req-1"},
		"steps": []any{map[string]any{
			"order":  0,
			"method": "POST",
			"path":   "/customers",
			"request": map[string]any{
				"headers": map[string]any{"Content-Type": "application/json",
					"Authorization": "Bearer {{token}}"},
				"params": map[string]any{},
				"body": map[string]any{"name": "Sarah Nolan", "phone": "0512345678",
					"email": "sara@example.sa", "age": 30},
			},
			"assertions":  []any{map[string]any{"type": "status_code", "expected": 201}},
			"extractions": []any{},
		}},
	}
}

// firstStep returns step 0 of a case built by makeGroundedCase.
func firstStep(c map[string]any) map[string]any {
	return c["steps"].([]any)[0].(map[string]any)
}

func anyViolationContains(violations []string, parts ...string) bool {
	for _, v := range violations {
		matched := true
		for _, p := range parts {
			if !strings.Contains(v, p) {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Unit tests — adversarial fixtures
// ---------------------------------------------------------------------------

func TestGroundedCaseHasNoViolations(t *testing.T) {
	if v := generation.GroundingValidate(makeGroundedCase(), makeGroundingInventory()); len(v) != 0 {
		t.Fatalf("grounded case must have no violations, got %v", v)
	}
}

func TestFabricatedPathYieldsViolation(t *testing.T) {
	c := makeGroundedCase()
	firstStep(c)["path"] = "/ghost-endpoint"
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) == 0 || !anyViolationContains(v, "does not exist") {
		t.Fatalf("fabricated path must be rejected: %v", v)
	}
}

func TestFabricatedMethodYieldsViolation(t *testing.T) {
	c := makeGroundedCase()
	firstStep(c)["method"] = "DELETE" // only POST /customers exists
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) == 0 || !anyViolationContains(v, "does not exist") {
		t.Fatalf("fabricated method must be rejected: %v", v)
	}
}

func TestFabricatedQueryParamYieldsViolation(t *testing.T) {
	c := makeGroundedCase()
	c["steps"] = []any{map[string]any{
		"order": 0, "method": "GET", "path": "/customers/{id}",
		"request": map[string]any{
			"headers": map[string]any{"Authorization": "Bearer {{token}}"},
			"params":  map[string]any{"id": "CUST-001", "sort": "asc"}, // 'sort' fabricated
		},
		"assertions":  []any{map[string]any{"type": "status_code", "expected": 200}},
		"extractions": []any{},
	}}
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) == 0 || !anyViolationContains(v, "'sort'", "not defined") {
		t.Fatalf("fabricated query parameter must be rejected: %v", v)
	}
}

func TestFabricatedBodyFieldYieldsViolation(t *testing.T) {
	c := makeGroundedCase()
	body := firstStep(c)["request"].(map[string]any)["body"].(map[string]any)
	body["nickname"] = "Nickname" // not in schema
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) == 0 || !anyViolationContains(v, "'nickname'", "does not exist") {
		t.Fatalf("fabricated body field must be rejected: %v", v)
	}
}

func TestMissingRequirementLinkYieldsViolation(t *testing.T) {
	c := makeGroundedCase()
	c["requirement_ids"] = []any{}
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) == 0 || !anyViolationContains(v, "requirement") {
		t.Fatalf("unlinked case must be rejected: %v", v)
	}
}

func TestFabricatedJSONFieldAssertionTargetYieldsViolation(t *testing.T) {
	c := makeGroundedCase()
	step := firstStep(c)
	step["assertions"] = append(step["assertions"].([]any),
		map[string]any{"type": "json_field", "path": "balance.total", "op": "exists"})
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) == 0 || !anyViolationContains(v, "json_field") {
		t.Fatalf("fabricated json_field target must be rejected: %v", v)
	}
}

func TestViolationsAreIndependentPerStep(t *testing.T) {
	// A grounded step plus a fabricated one — only the fabricated step trips.
	c := makeGroundedCase()
	bad := deepCopyAny(firstStep(c)).(map[string]any)
	bad["path"] = "/refunds"
	c["steps"] = append(c["steps"].([]any), bad)
	v := generation.GroundingValidate(c, makeGroundingInventory())
	if len(v) != 1 {
		t.Fatalf("expected exactly 1 violation, got %v", v)
	}
	if !strings.Contains(v[0], "step 1") {
		t.Fatalf("violation must name step 1: %q", v[0])
	}
}

// deepCopyAny — Go stand-in for copy.deepcopy over decoded-JSON shapes.
func deepCopyAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = deepCopyAny(val)
		}
		return out
	case models.JSONMap:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = deepCopyAny(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = deepCopyAny(val)
		}
		return out
	}
	return v
}

// ---------------------------------------------------------------------------
// End-to-end — everything persisted by the pipeline is grounded
// ---------------------------------------------------------------------------

func stepsOfDetail(detail M) []any {
	if s, ok := detail["steps"].([]any); ok {
		return s
	}
	if tc, ok := detail["test_case"].(map[string]any); ok {
		if s, ok := tc["steps"].([]any); ok {
			return s
		}
	}
	return nil
}

func assertBodyGrounded(t *testing.T, body, schema map[string]any, ctx string) {
	t.Helper()
	props, _ := schema["properties"].(map[string]any)
	for key, val := range body {
		sub, in := props[key]
		if !in {
			t.Fatalf("%s: body field '%s' not in the endpoint schema", ctx, key)
		}
		vm, vIsMap := val.(map[string]any)
		sm, sIsMap := sub.(map[string]any)
		if !vIsMap || !sIsMap {
			continue
		}
		if _, hasProps := sm["properties"].(map[string]any); !hasProps {
			continue
		}
		assertBodyGrounded(t, vm, sm, ctx+"."+key)
	}
}

func TestGeneratedCasesAreGroundedInImportedInventory(t *testing.T) {
	headers := registerOrg(t, "Test Org")
	pid := createProject(t, headers, "Test Project")

	importSpec(t, headers, pid) // POST /customers + GET /customers/{id}
	rid := addRequirement(t, headers, pid, "REQ-100",
		"Create a customer via POST /customers with a valid phone number and age",
		[]string{"phone must match the pattern 05XXXXXXXX (10 digits)",
			"age must be between 18 and 120",
			"invalid customer input returns 422"})
	confirmRequirement(t, headers, rid)

	w := do(t, "POST", "/v1/projects/"+pid+"/generate", M{"depth": "standard"}, headers)
	if w.Code != 200 && w.Code != 202 {
		t.Fatalf("generate failed: %d %.300s", w.Code, w.Body.String())
	}
	job := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))
	result, _ := job["result"].(map[string]any)
	if generated, _ := result["generated"].(float64); generated <= 0 {
		t.Fatalf("nothing generated: %v", result)
	}

	// Ground truth: the imported endpoint inventory
	w = do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)
	if w.Code != 200 {
		t.Fatalf("endpoints failed: %d %.300s", w.Code, w.Body.String())
	}
	inventory := map[string]M{}
	for _, e := range itemsOf(jsonAny(t, w)) {
		ep := e.(map[string]any)
		inventory[strings.ToUpper(ep["method"].(string))+" "+ep["path"].(string)] = ep
	}
	if len(inventory) == 0 {
		t.Fatal("endpoint inventory is empty")
	}

	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	if w.Code != 200 {
		t.Fatalf("test-cases failed: %d %.300s", w.Code, w.Body.String())
	}
	cases := itemsOf(jsonAny(t, w))
	if len(cases) == 0 {
		t.Fatal("no persisted test cases returned")
	}

	for _, cv := range cases {
		caseID := cv.(map[string]any)["id"].(string)
		w = do(t, "GET", "/v1/test-cases/"+caseID, nil, headers)
		if w.Code != 200 {
			t.Fatalf("detail failed: %d %.300s", w.Code, w.Body.String())
		}
		steps := stepsOfDetail(jsonMap(t, w))
		if len(steps) == 0 {
			t.Fatalf("case %s has no steps", caseID)
		}
		for _, sv := range steps {
			step := sv.(map[string]any)
			key := strings.ToUpper(step["method"].(string)) + " " + step["path"].(string)
			ep, ok := inventory[key]
			if !ok {
				t.Fatalf("fabricated endpoint persisted: %s", key)
			}
			request, _ := step["request"].(map[string]any)

			paramNames := map[string]bool{}
			if params, ok := ep["parameters"].([]any); ok {
				for _, pv := range params {
					if p, ok := pv.(map[string]any); ok {
						if n, _ := p["name"].(string); n != "" {
							paramNames[n] = true
						}
					}
				}
			}
			if reqParams, ok := request["params"].(map[string]any); ok {
				for pname := range reqParams {
					if !paramNames[pname] {
						t.Fatalf("fabricated parameter '%s' persisted on %s", pname, key)
					}
				}
			}

			body, bodyIsMap := request["body"].(map[string]any)
			schema, _ := ep["request_schema"].(map[string]any)
			if _, hasProps := schema["properties"].(map[string]any); bodyIsMap && hasProps {
				assertBodyGrounded(t, body, schema, key)
			}
		}
	}
}
