// RELEASE GATE — security testing, phase S0 (docs/SECURITY_TESTING_PLAN.md).
//
// What these gates protect:
//   - the corpus is a shipped, versioned DATA file with a closed precondition
//     vocabulary — not a table of prose;
//   - every generated case is grounded by the GENERATOR'S OWN validator and
//     traceable to a requirement; an endpoint no requirement maps to produces
//     nothing at all, and the coverage report SAYS SO (BO-07);
//   - the coverage matrix adds up: covered + not_applicable + gap == pairs;
//   - an ACTIVE class is generated and marked, and the executor refuses to run
//     it (§7 safety rails).
package tests_test

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"

	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/modules/generation"
	secmod "traceo/internal/modules/security"
	"traceo/internal/security"
)

// ---------------------------------------------------------------------------
// Local helpers (direct DB access for fixtures the HTTP surface cannot express)
// ---------------------------------------------------------------------------

func dbFirstEndpoint(row *models.Endpoint, id string) error {
	return db.DB.First(row, "id = ?", id).Error
}

// dbUpdateWeakness marks an existing case as belonging to a weakness class —
// the S1 generator will do this through the API; S0 tests need the state.
func dbUpdateWeakness(caseID string, weaknessID *string) error {
	return db.DB.Model(&models.TestCase{}).Where("id = ?", caseID).
		Update("weakness_id", weaknessID).Error
}

// seedRoleInProjectOrg mints a token for a new user with `role` inside the
// project's OWN organisation.
func seedRoleInProjectOrg(t *testing.T, projectID, role string) map[string]string {
	t.Helper()
	var p models.Project
	if err := db.DB.First(&p, "id = ?", projectID).Error; err != nil {
		t.Fatalf("project %s not found: %v", projectID, err)
	}
	u := models.User{OrganisationID: p.OrganisationID,
		Email: fmt.Sprintf("u%s@example.sa", uuid.NewString()[:10]),
		Name:  "Role Tester", PasswordHash: "x", Role: role, Locale: "en"}
	if err := db.DB.Create(&u).Error; err != nil {
		t.Fatalf("seed user: %v", err)
	}
	tok, err := security.CreateToken(u.ID, p.OrganisationID, role)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + tok}
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

var requiredWeaknessClasses = []string{
	"missing-authn", "broken-object-level-authz", "broken-function-level-authz",
	"mass-assignment", "injection-surface", "input-validation", "error-leakage",
	"security-headers", "token-handling", "rate-limiting",
}

// legalPreconditionKeys is the CLOSED vocabulary the builder evaluates. A key
// outside it cannot be checked, so it must not appear in the shipped file.
var legalPreconditionKeys = map[string]bool{
	"always": true, "declares_security": true, "path_has_parameter": true,
	"request_has_body": true, "request_has_privileged_field": true,
	"has_string_field": true, "has_constrained_input": true,
}

func TestWeaknessCatalogueIsShippedAndWellFormed(t *testing.T) {
	headers := registerOrg(t, "Weakness Org")
	w := do(t, "GET", "/v1/weaknesses", nil, headers)
	if w.Code != 200 {
		t.Fatalf("GET /v1/weaknesses failed: %d %.300s", w.Code, w.Body.String())
	}
	payload := jsonMap(t, w)
	if version, _ := payload["version"].(string); version == "" {
		t.Fatal("the corpus ships no version — every report stamps it")
	}
	items, _ := payload["weaknesses"].([]any)
	if len(items) < len(requiredWeaknessClasses) {
		t.Fatalf("expected at least %d classes, got %d", len(requiredWeaknessClasses), len(items))
	}

	seen := map[string]M{}
	for _, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("catalogue entry is not an object: %v", item)
		}
		id, _ := entry["id"].(string)
		if id == "" {
			t.Fatalf("catalogue entry without an id: %v", entry)
		}
		if _, dup := seen[id]; dup {
			t.Fatalf("duplicate weakness id %q", id)
		}
		seen[id] = entry

		if title, _ := entry["title"].(string); title == "" {
			t.Fatalf("%s: no title", id)
		}
		switch entry["severity"] {
		case "critical", "high", "medium", "low":
		default:
			t.Fatalf("%s: illegal severity %v", id, entry["severity"])
		}
		switch entry["activity"] {
		case "passive", "active":
		default:
			t.Fatalf("%s: illegal activity %v", id, entry["activity"])
		}
		refs, _ := entry["refs"].(map[string]any)
		if refs == nil {
			t.Fatalf("%s: no refs", id)
		}
		// owasp_api may be null: the 2023 API Top 10 has no injection entry, and
		// an absent mapping is recorded as absent rather than forced into the
		// nearest category. The key itself must always be present.
		if _, present := refs["owasp_api"]; !present {
			t.Fatalf("%s: refs must state owasp_api, even as null", id)
		}
		if owasp, isString := refs["owasp_api"].(string); isString && owasp == "" {
			t.Fatalf("%s: owasp_api is an empty string — use null for 'no mapping'", id)
		}
		if cwe, _ := refs["cwe"].([]any); len(cwe) == 0 {
			t.Fatalf("%s: no CWE reference", id)
		}
		if asvs, _ := refs["asvs"].([]any); len(asvs) == 0 {
			t.Fatalf("%s: no ASVS reference", id)
		}
		pre, _ := entry["precondition"].(map[string]any)
		if len(pre) == 0 {
			t.Fatalf("%s: no precondition — an unconditional class cannot be skipped auditably", id)
		}
		for key := range pre {
			if !legalPreconditionKeys[key] {
				t.Fatalf("%s: precondition key %q is outside the closed vocabulary the builder evaluates", id, key)
			}
		}
		if checks, _ := entry["checks"].([]any); len(checks) == 0 {
			t.Fatalf("%s: no checks", id)
		}
	}

	for _, id := range requiredWeaknessClasses {
		if _, ok := seen[id]; !ok {
			t.Fatalf("the shipped corpus is missing the %q class", id)
		}
	}
	// Anything that writes or floods must be marked active so the executor rail
	// can see it (§7).
	if seen["rate-limiting"]["activity"] != "active" {
		t.Fatal("rate-limiting floods the target and must be marked active")
	}
	if seen["mass-assignment"]["activity"] != "active" {
		t.Fatal("mass-assignment writes and must be marked active")
	}
}

func TestWeaknessesRequiresAuthentication(t *testing.T) {
	if w := do(t, "GET", "/v1/weaknesses", nil, nil); w.Code != 401 {
		t.Fatalf("expected 401 without a token, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// applicable() — pure, and the reason is required when it says no
// ---------------------------------------------------------------------------

func TestApplicableAlwaysStatesAReasonWhenItRefuses(t *testing.T) {
	bare := &models.Endpoint{Method: "GET", Path: "/ping",
		Parameters: models.JSONList{}, Security: models.JSONList{}}
	refused := 0
	for _, weak := range secmod.Weaknesses() {
		ok, reason := secmod.Applicable(bare, weak)
		if ok {
			continue
		}
		refused++
		if strings.TrimSpace(reason) == "" {
			t.Fatalf("%s refused the endpoint without a reason — the skip would be invisible", weak.ID)
		}
		if len(reason) < 20 {
			t.Fatalf("%s: the reason must EXPLAIN, not label: %q", weak.ID, reason)
		}
	}
	if refused == 0 {
		t.Fatal("a bare unauthenticated endpoint must fail several preconditions")
	}
	// error-leakage / security-headers / rate-limiting apply to every endpoint.
	for _, id := range []string{"error-leakage", "security-headers", "rate-limiting"} {
		ok, reason := secmod.Applicable(bare, secmod.Find(id))
		if !ok {
			t.Fatalf("%s must apply to any endpoint, got %q", id, reason)
		}
	}
}

func TestApplicableIsPureAndDeterministic(t *testing.T) {
	ep := &models.Endpoint{Method: "GET", Path: "/customers/{id}",
		Parameters: models.JSONList{map[string]any{"name": "id", "location": "path",
			"type": "string", "required": true}},
		Security: models.JSONList{map[string]any{"bearerAuth": []any{}}}}
	for i := 0; i < 5; i++ {
		if ok, _ := secmod.Applicable(ep, secmod.Find("broken-object-level-authz")); !ok {
			t.Fatal("BOLA must apply to an endpoint with a declared path parameter")
		}
	}
	noParam := &models.Endpoint{Method: "GET", Path: "/customers/{id}",
		Parameters: models.JSONList{}, Security: models.JSONList{}}
	ok, reason := secmod.Applicable(noParam, secmod.Find("broken-object-level-authz"))
	if ok {
		t.Fatal("an undeclared {id} is not an object identifier the builder may use")
	}
	if !strings.Contains(reason, "identifier") {
		t.Fatalf("the reason must say what is missing: %q", reason)
	}
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

// seedSecurityProject imports the 2-endpoint spec and confirms a requirement
// that lexically anchors both endpoints.
func seedSecurityProject(t *testing.T) (map[string]string, string) {
	t.Helper()
	headers := registerOrg(t, "Security Org")
	pid := createProject(t, headers, "Security Project")
	importSpec(t, headers, pid)
	rid := addRequirement(t, headers, pid, "REQ-SEC-1",
		"Create a customer via POST /customers and read a customer by id",
		[]string{"phone must match the pattern 05XXXXXXXX (10 digits)"})
	confirmRequirement(t, headers, rid)
	return headers, pid
}

func generateSecurity(t *testing.T, headers map[string]string, pid string, body M) M {
	t.Helper()
	w := do(t, "POST", "/v1/projects/"+pid+"/security/generate", body, headers)
	if w.Code != 202 {
		t.Fatalf("security generate expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	jobID, _ := jsonMap(t, w)["job_id"].(string)
	job := pollJob(t, headers, jobID)
	result, _ := job["result"].(map[string]any)
	if result == nil {
		t.Fatalf("job carried no result: %v", job)
	}
	return result
}

func TestSecurityGenerationProducesGroundedTraceableCases(t *testing.T) {
	headers, pid := seedSecurityProject(t)
	result := generateSecurity(t, headers, pid, M{})

	generated, _ := result["generated"].(float64)
	if generated <= 0 {
		t.Fatalf("nothing generated: %v", result)
	}
	if _, ok := result["discarded"].(float64); !ok {
		t.Fatalf("result must count grounding discards: %v", result)
	}
	skipped, _ := result["skipped"].([]any)
	if len(skipped) == 0 {
		t.Fatal("a 2-endpoint inventory cannot satisfy all 10 classes — skipped must be reported")
	}
	for _, s := range skipped {
		entry, _ := s.(map[string]any)
		for _, key := range []string{"endpoint", "weakness", "reason"} {
			if v, _ := entry[key].(string); v == "" {
				t.Fatalf("skipped entry misses %q: %v", key, entry)
			}
		}
	}

	// Ground truth: the imported inventory.
	w := do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)
	inventory := map[string]*models.Endpoint{}
	for _, e := range itemsOf(jsonAny(t, w)) {
		ep := e.(map[string]any)
		key := strings.ToUpper(ep["method"].(string)) + " " + ep["path"].(string)
		var row models.Endpoint
		if err := dbFirstEndpoint(&row, ep["id"].(string)); err != nil {
			t.Fatalf("endpoint %s not readable: %v", key, err)
		}
		inventory[key] = &row
	}

	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	cases := itemsOf(jsonAny(t, w))
	securityCases := 0
	for _, cv := range cases {
		tc := cv.(map[string]any)
		wid, _ := tc["weakness_id"].(string)
		if wid == "" {
			continue
		}
		securityCases++
		if tc["technique"] != "security" {
			t.Fatalf("security case carries technique %v", tc["technique"])
		}
		if secmod.Find(wid) == nil {
			t.Fatalf("case names a weakness outside the shipped corpus: %q", wid)
		}
		detail := jsonMap(t, do(t, "GET", "/v1/test-cases/"+tc["id"].(string), nil, headers))
		links, _ := detail["links"].([]any)
		if len(links) == 0 {
			t.Fatalf("security case %s is not traceable to any requirement (BO-07)", tc["id"])
		}
		steps := stepsOfDetail(detail)
		if len(steps) == 0 {
			t.Fatalf("security case %s has no steps", tc["id"])
		}
		step := steps[0].(map[string]any)
		key := strings.ToUpper(step["method"].(string)) + " " + step["path"].(string)
		if _, known := inventory[key]; !known {
			t.Fatalf("fabricated endpoint persisted: %s", key)
		}
		// The persisted case must still pass the generator's own gate.
		reconstructed := map[string]any{
			"requirement_ids": []string{"linked"},
			"steps": []any{map[string]any{
				"method": step["method"], "path": step["path"],
				"request":    step["request"],
				"assertions": step["assertions"],
			}},
		}
		if v := generation.GroundingValidate(reconstructed, inventory); len(v) > 0 {
			t.Fatalf("persisted security case %s violates the grounding gate: %v", tc["id"], v)
		}
	}
	if securityCases == 0 {
		t.Fatal("no security case was persisted")
	}
}

// securedSpec declares a bearer-guarded endpoint, so the authentication and
// authorisation classes have something to bite on.
func securedSpec() M {
	return M{
		"openapi": "3.0.3",
		"info":    M{"title": "Orders API", "version": "1.0.0"},
		"components": M{"securitySchemes": M{
			"bearerAuth": M{"type": "http", "scheme": "bearer"}}},
		"paths": M{
			"/orders/{orderId}": M{
				"get": M{
					"operationId": "getOrder",
					"summary":     "Get an order by id",
					"security":    []any{M{"bearerAuth": []any{}}},
					"parameters": []M{{"name": "orderId", "in": "path", "required": true,
						"schema": M{"type": "string"}}},
					"responses": M{
						"200": M{"description": "OK", "content": M{"application/json": M{
							"schema": M{"type": "object", "properties": M{
								"id": M{"type": "string"}, "total": M{"type": "number"}}}}}},
						"403": M{"description": "Forbidden"},
					},
				},
			},
		},
	}
}

func TestAuthClassesBuildTheRightRequestShapes(t *testing.T) {
	headers := registerOrg(t, "Auth Class Org")
	pid := createProject(t, headers, "Auth Class Project")
	raw, _ := jsonBytes(securedSpec())
	w := uploadFile(t, "/v1/projects/"+pid+"/api-specs", "orders.json", raw,
		"application/json", headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("spec import failed: %d %.300s", w.Code, w.Body.String())
	}
	rid := addRequirement(t, headers, pid, "REQ-SEC-AUTH",
		"Read an order by id from GET /orders/{orderId}", nil)
	confirmRequirement(t, headers, rid)

	generateSecurity(t, headers, pid, M{"weakness_ids": []string{
		"missing-authn", "broken-function-level-authz", "token-handling",
		"broken-object-level-authz"}})

	byWeakness := map[string][]M{}
	list := do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	for _, cv := range itemsOf(jsonAny(t, list)) {
		tc := cv.(map[string]any)
		wid, _ := tc["weakness_id"].(string)
		if wid == "" {
			continue
		}
		detail := jsonMap(t, do(t, "GET", "/v1/test-cases/"+tc["id"].(string), nil, headers))
		steps := stepsOfDetail(detail)
		if len(steps) == 0 {
			t.Fatalf("%s produced a case with no steps", wid)
		}
		step := steps[0].(map[string]any)
		request, _ := step["request"].(map[string]any)
		byWeakness[wid] = append(byWeakness[wid], request)
	}

	authOf := func(request M) string {
		headers, _ := request["headers"].(map[string]any)
		for k, v := range headers {
			if strings.EqualFold(k, "authorization") {
				s, _ := v.(string)
				return s
			}
		}
		return ""
	}

	if reqs := byWeakness["missing-authn"]; len(reqs) != 1 {
		t.Fatalf("expected one missing-authn case, got %d", len(reqs))
	} else if auth := authOf(reqs[0]); auth != "" {
		t.Fatalf("the unauthenticated probe still carries credentials: %q", auth)
	}
	if reqs := byWeakness["broken-function-level-authz"]; len(reqs) != 1 {
		t.Fatalf("expected one BFLA case, got %d", len(reqs))
	} else if auth := authOf(reqs[0]); !strings.Contains(auth, "{{low_privilege_token}}") {
		t.Fatalf("BFLA must replay as a lower-privileged actor, got %q", auth)
	}
	tokenCases := byWeakness["token-handling"]
	if len(tokenCases) != 2 {
		t.Fatalf("token handling covers expired AND forged tokens, got %d cases", len(tokenCases))
	}
	seenTokens := map[string]bool{}
	for _, req := range tokenCases {
		seenTokens[authOf(req)] = true
	}
	for _, want := range []string{"Bearer {{expired_token}}", "Bearer {{unsigned_token}}"} {
		if !seenTokens[want] {
			t.Fatalf("missing the %s probe: %v", want, seenTokens)
		}
	}
	if reqs := byWeakness["broken-object-level-authz"]; len(reqs) != 1 {
		t.Fatalf("expected one BOLA case, got %d", len(reqs))
	} else {
		params, _ := reqs[0]["params"].(map[string]any)
		if params["orderId"] != "{{foreign_object_id}}" {
			t.Fatalf("BOLA must address another actor's object through the declared path parameter: %v", params)
		}
	}
}

func TestSecurityGenerationIsIdempotent(t *testing.T) {
	headers, pid := seedSecurityProject(t)
	first := generateSecurity(t, headers, pid, M{})
	second := generateSecurity(t, headers, pid, M{})
	if g, _ := second["generated"].(float64); g != 0 {
		t.Fatalf("a second run must not duplicate cases, generated %v (first %v)",
			g, first["generated"])
	}
}

func TestSecurityGenerationHonoursTheWeaknessFilter(t *testing.T) {
	headers, pid := seedSecurityProject(t)
	result := generateSecurity(t, headers, pid, M{"weakness_ids": []string{"security-headers"}})
	if g, _ := result["generated"].(float64); g <= 0 {
		t.Fatalf("expected security-headers cases: %v", result)
	}
	w := do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	for _, cv := range itemsOf(jsonAny(t, w)) {
		tc := cv.(map[string]any)
		if wid, _ := tc["weakness_id"].(string); wid != "" && wid != "security-headers" {
			t.Fatalf("filter ignored: %q was generated", wid)
		}
	}
}

func TestSecurityGenerationRejectsAnUnknownWeakness(t *testing.T) {
	headers, pid := seedSecurityProject(t)
	w := do(t, "POST", "/v1/projects/"+pid+"/security/generate",
		M{"weakness_ids": []string{"not-a-class"}}, headers)
	if w.Code != 422 {
		t.Fatalf("expected 422 for an unknown weakness, got %d %.300s", w.Code, w.Body.String())
	}
	if !bodyContains(w, "unknown_weakness") {
		t.Fatalf("expected code unknown_weakness: %.300s", w.Body.String())
	}
	detail, _ := jsonMap(t, w)["detail"].(map[string]any)
	if errs, _ := detail["errors"].([]any); len(errs) != len(secmod.Weaknesses()) {
		t.Fatalf("the 422 must name the shipped corpus: %v", detail["errors"])
	}
}

// BO-07: no requirement, no case — and the report says so.
func TestEndpointWithoutARequirementProducesNoCasesAndIsReported(t *testing.T) {
	headers := registerOrg(t, "Untraceable Org")
	pid := createProject(t, headers, "Untraceable Project")
	importSpec(t, headers, pid) // endpoints, but no confirmed requirement anywhere

	result := generateSecurity(t, headers, pid, M{})
	if g, _ := result["generated"].(float64); g != 0 {
		t.Fatalf("cases were generated without a requirement to trace them to: %v", result)
	}
	skipped, _ := result["skipped"].([]any)
	found := false
	for _, s := range skipped {
		if reason, _ := s.(map[string]any)["reason"].(string); strings.Contains(reason, "no requirement") {
			found = true
		}
	}
	if !found {
		t.Fatalf("the untraceable pairs must be reported with their own reason: %v", skipped)
	}

	cov := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/security/coverage", nil, headers))
	covSkipped, _ := cov["skipped"].([]any)
	found = false
	for _, s := range covSkipped {
		if reason, _ := s.(map[string]any)["reason"].(string); strings.Contains(reason, "no requirement") {
			found = true
		}
	}
	if !found {
		t.Fatalf("coverage must state the untraceable reason distinctly: %v", cov["skipped"])
	}
}

// ---------------------------------------------------------------------------
// Coverage matrix (§11)
// ---------------------------------------------------------------------------

func TestSecurityCoverageMatrixAddsUpAndGapShrinks(t *testing.T) {
	headers, pid := seedSecurityProject(t)

	before := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/security/coverage", nil, headers))
	if v, _ := before["corpus_version"].(string); v == "" {
		t.Fatal("coverage must stamp the corpus version")
	}
	pairs, _ := before["pairs"].(map[string]any)
	total, _ := pairs["total"].(float64)
	if total != float64(2*len(secmod.Weaknesses())) {
		t.Fatalf("2 endpoints x %d classes = %d pairs, got %v",
			len(secmod.Weaknesses()), 2*len(secmod.Weaknesses()), total)
	}
	sum := pairs["covered"].(float64) + pairs["not_applicable"].(float64) + pairs["gap"].(float64)
	if sum != total {
		t.Fatalf("covered + not_applicable + gap = %v, expected %v", sum, total)
	}
	if pairs["covered"].(float64) != 0 {
		t.Fatalf("nothing generated yet, covered must be 0: %v", pairs)
	}
	gapBefore := pairs["gap"].(float64)
	if gapBefore == 0 {
		t.Fatal("applicable-but-ungenerated pairs must show as gap — that is the point of the report")
	}

	byWeakness, _ := before["by_weakness"].([]any)
	if len(byWeakness) != len(secmod.Weaknesses()) {
		t.Fatalf("by_weakness must carry every class, got %d", len(byWeakness))
	}
	for i, row := range byWeakness {
		r := row.(map[string]any)
		if r["weakness_id"] != secmod.Weaknesses()[i].ID {
			t.Fatalf("by_weakness order must follow the catalogue: %v at %d", r["weakness_id"], i)
		}
		for _, key := range []string{"covered", "not_applicable", "gap"} {
			if _, ok := r[key].(float64); !ok {
				t.Fatalf("by_weakness row misses %q: %v", key, r)
			}
		}
	}
	// Every not-applicable pair is auditable: it appears in skipped with the
	// precondition that failed. (A gap that a requirement already anchors is
	// counted, not re-explained — its reason is simply "no case yet".)
	skipped, _ := before["skipped"].([]any)
	if float64(len(skipped)) != pairs["not_applicable"].(float64) {
		t.Fatalf("every not-applicable pair must appear in skipped: %d entries vs %v",
			len(skipped), pairs)
	}
	for _, s := range skipped {
		entry := s.(map[string]any)
		for _, key := range []string{"endpoint_id", "method", "path", "weakness_id", "reason"} {
			if v, _ := entry[key].(string); v == "" {
				t.Fatalf("skipped entry misses %q: %v", key, entry)
			}
		}
	}

	generateSecurity(t, headers, pid, M{})

	after := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/security/coverage", nil, headers))
	pairsAfter, _ := after["pairs"].(map[string]any)
	if pairsAfter["covered"].(float64) <= 0 {
		t.Fatalf("generation must move pairs into covered: %v", pairsAfter)
	}
	if pairsAfter["gap"].(float64) >= gapBefore {
		t.Fatalf("gap must shrink after generation: %v -> %v", gapBefore, pairsAfter["gap"])
	}
	sumAfter := pairsAfter["covered"].(float64) + pairsAfter["not_applicable"].(float64) +
		pairsAfter["gap"].(float64)
	if sumAfter != total {
		t.Fatalf("the matrix stopped adding up: %v", pairsAfter)
	}
}

// ---------------------------------------------------------------------------
// Capability guards + tenant isolation
// ---------------------------------------------------------------------------

func TestSecurityRoutesEnforceCapabilitiesAndTenancy(t *testing.T) {
	_, pid := seedSecurityProject(t)

	viewer := seedRoleInProjectOrg(t, pid, "viewer")
	if w := do(t, "GET", "/v1/projects/"+pid+"/security/coverage", nil, viewer); w.Code != 200 {
		t.Fatalf("a viewer may read the coverage report, got %d", w.Code)
	}
	if w := do(t, "POST", "/v1/projects/"+pid+"/security/generate", M{}, viewer); w.Code != 403 {
		t.Fatalf("a viewer may not generate, got %d", w.Code)
	}

	other := registerOrg(t, "Other Org")
	if w := do(t, "GET", "/v1/projects/"+pid+"/security/coverage", nil, other); w.Code != 404 {
		t.Fatalf("cross-tenant coverage must 404, got %d", w.Code)
	}
	if w := do(t, "POST", "/v1/projects/"+pid+"/security/generate", M{}, other); w.Code != 404 {
		t.Fatalf("cross-tenant generate must 404, got %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// §7 safety rail — an ACTIVE class is generated and marked, never executed
// ---------------------------------------------------------------------------

func TestExecutorRefusesActiveWeaknessClasses(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Active Rail Org", "admin")
	pid := seedProject(t, orgID, "Active Rail Project")
	envID := seedEnvironment(t, orgID, pid)
	rid := seedRequirement(t, orgID, pid, "REQ-RAIL", "confirmed", "high")

	activeID := seedTestCase(t, orgID, pid, "Security [rate-limiting]: burst", "approved", rid)
	active := "rate-limiting"
	if err := dbUpdateWeakness(activeID, &active); err != nil {
		t.Fatalf("mark active case: %v", err)
	}

	w := do(t, "POST", "/v1/projects/"+pid+"/runs", M{"environment_id": envID}, headers)
	if w.Code != 409 {
		t.Fatalf("an approved ACTIVE-class case is the only case: the run must be refused, got %d %.300s",
			w.Code, w.Body.String())
	}

	// A passive-class case is runnable, and the run payload carries its kind.
	passiveID := seedTestCase(t, orgID, pid, "Security [security-headers]: headers", "approved", rid)
	passive := "security-headers"
	if err := dbUpdateWeakness(passiveID, &passive); err != nil {
		t.Fatalf("mark passive case: %v", err)
	}
	w = do(t, "POST", "/v1/projects/"+pid+"/runs", M{"environment_id": envID}, headers)
	if w.Code != 202 {
		t.Fatalf("a passive-class case must be runnable, got %d %.300s", w.Code, w.Body.String())
	}
	runID, _ := jsonMap(t, w)["run_id"].(string)
	pollJob(t, headers, jsonMap(t, w)["job_id"].(string))
	run := jsonMap(t, do(t, "GET", "/v1/runs/"+runID, nil, headers))
	if run["kind"] != "functional" {
		t.Fatalf("run payload must carry kind, got %v", run["kind"])
	}
	counts, _ := run["counts"].(map[string]any)
	if total, _ := counts["total"].(float64); total != 1 {
		t.Fatalf("only the passive case may run, counts=%v", counts)
	}
}

func TestTestCasePayloadCarriesWeaknessID(t *testing.T) {
	headers, pid := seedSecurityProject(t)
	generateSecurity(t, headers, pid, M{"weakness_ids": []string{"security-headers"}})
	w := do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	found := false
	for _, cv := range itemsOf(jsonAny(t, w)) {
		tc := cv.(map[string]any)
		if _, present := tc["weakness_id"]; !present {
			t.Fatalf("every test-case payload must carry weakness_id (null for non-security cases): %v", tc)
		}
		if wid, _ := tc["weakness_id"].(string); wid == "security-headers" {
			found = true
		}
	}
	if !found {
		t.Fatal("the generated security case did not surface its weakness_id")
	}
}

// jsonBytes marshals a fixture for a multipart upload.
func jsonBytes(v any) ([]byte, error) { return json.Marshal(v) }
