// RELEASE GATE — the sixth engine: QA Insight Agent.
//
// What must hold, in the same intent as the Python suite:
//   - the 9 canonical category ids are exactly these strings, in this order;
//   - GET /v1/projects/{id}/insights is deterministic, jobless, capability
//     "view"-gated and tenant-scoped, with covered/gap/n_a semantics;
//   - POST /v1/projects/{id}/insights/generate is capability "generate"-gated,
//     422 invalid_category on anything outside the taxonomy, and follows the
//     existing 202 {job_id} pattern;
//   - ADVERSARIAL GROUNDING: not one persisted case may reference an endpoint,
//     parameter or body field that is absent from the endpoint inventory, and
//     every case is linked to at least one requirement (BO-07);
//   - the engine is offline: no LLM provider call happens during a run.
package tests_test

import (
	"encoding/json"
	"fmt"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/google/uuid"

	"traceo/internal/db"
	"traceo/internal/llm"
	"traceo/internal/models"
	"traceo/internal/modules/insight"
	"traceo/internal/security"
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// insightProject — a project with the shared 2-endpoint spec and one confirmed
// requirement whose text anchors on both endpoints.
func insightProject(t *testing.T) (map[string]string, string) {
	t.Helper()
	headers := registerOrg(t, "Insight Org")
	pid := createProject(t, headers, "Insight Project")
	importSpec(t, headers, pid)
	rid := addRequirement(t, headers, pid, "REQ-900",
		"Create a customer via POST /customers and read the customer back",
		[]string{"phone must match the pattern 05XXXXXXXX (10 digits)",
			"age must be between 18 and 120"})
	confirmRequirement(t, headers, rid)
	return headers, pid
}

// insightRichProject — an inventory the small shared spec cannot express:
// declared bearer security, a pagination parameter, a date-time parameter, a
// documented 503, and a DELETE that shares its path with a PUT. Every category
// that is n_a against the small spec has something to ground itself in here.
func insightRichProject(t *testing.T) (map[string]string, string) {
	t.Helper()
	headers := registerOrg(t, "Insight Rich Org")
	pid := createProject(t, headers, "Orders Project")
	var project models.Project
	if err := db.DB.First(&project, "id = ?", pid).Error; err != nil {
		t.Fatalf("load project: %v", err)
	}
	orgID := project.OrganisationID

	bearer := models.JSONList{M{"bearerAuth": []any{}}}
	orderSchema := models.JSONMap{"type": "object", "required": []any{"note"},
		"properties": M{
			"note":       M{"type": "string", "maxLength": 200},
			"scheduled":  M{"type": "string", "format": "date-time"},
			"unit_price": M{"type": "number", "minimum": 1, "maximum": 999},
		}}
	okSchema := models.JSONMap{
		"200": M{"type": "object", "properties": M{"id": M{"type": "string"},
			"note": M{"type": "string"}}},
		"503": M{"type": "object", "properties": M{"detail": M{"type": "string"}}},
	}
	for _, ep := range []models.Endpoint{
		{Method: "GET", Path: "/orders", OperationID: "listOrders", Summary: "List orders",
			Parameters: models.JSONList{
				M{"name": "limit", "location": "query", "type": "integer", "required": false,
					"constraints": M{"minimum": 1, "maximum": 100}},
				M{"name": "since", "location": "query", "type": "string", "required": false,
					"constraints": M{"format": "date-time"}},
			},
			ResponseSchemas: okSchema, Security: bearer},
		{Method: "PUT", Path: "/orders/{id}", OperationID: "updateOrder", Summary: "Update an order",
			Parameters: models.JSONList{M{"name": "id", "location": "path", "type": "string",
				"required": true, "constraints": M{}}},
			RequestSchema: orderSchema, ResponseSchemas: okSchema, Security: bearer},
		{Method: "DELETE", Path: "/orders/{id}", OperationID: "deleteOrder", Summary: "Delete an order",
			Parameters: models.JSONList{M{"name": "id", "location": "path", "type": "string",
				"required": true, "constraints": M{}}},
			ResponseSchemas: okSchema, Security: bearer},
	} {
		ep.OrganisationID = orgID
		ep.ProjectID = pid
		ep.Source = "spec"
		if ep.Tags == nil {
			ep.Tags = models.JSONList{}
		}
		if err := db.DB.Create(&ep).Error; err != nil {
			t.Fatalf("seed endpoint: %v", err)
		}
	}
	rid := addRequirement(t, headers, pid, "REQ-910",
		"The system must list orders, update an order and delete an order",
		[]string{"deleting an order removes it from the orders list"})
	confirmRequirement(t, headers, rid)
	return headers, pid
}

func insightsOf(t *testing.T, headers map[string]string, pid string) M {
	t.Helper()
	w := do(t, "GET", "/v1/projects/"+pid+"/insights", nil, headers)
	if w.Code != 200 {
		t.Fatalf("insights failed: %d %.300s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

func categoryRow(t *testing.T, report M, id string) M {
	t.Helper()
	rows, _ := report["categories"].([]any)
	for _, r := range rows {
		row := r.(map[string]any)
		if row["id"] == id {
			return row
		}
	}
	t.Fatalf("category %q missing from the report", id)
	return nil
}

func intOf(v any) int {
	f, _ := v.(float64)
	return int(f)
}

// ---------------------------------------------------------------------------
// A. Taxonomy
// ---------------------------------------------------------------------------

// TestInsightEngineMakesNoLLMCalls — the engine is 100% deterministic and fully
// offline (NFR-D1). It cannot call a provider it does not import: this parses
// the package's own source and fails if internal/llm ever appears there.
func TestInsightEngineMakesNoLLMCalls(t *testing.T) {
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, filepath.Join("..", "internal", "modules", "insight"),
		nil, parser.ImportsOnly)
	if err != nil {
		t.Fatalf("parse insight package: %v", err)
	}
	if len(pkgs) == 0 {
		t.Fatal("insight package not found")
	}
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			for _, imp := range file.Imports {
				if strings.Contains(imp.Path.Value, "internal/llm") {
					t.Fatalf("%s imports %s — the insight engine must stay offline", name, imp.Path.Value)
				}
			}
		}
	}
}

func TestInsightTaxonomyIsTheNineCanonicalIds(t *testing.T) {
	want := []string{"boundary_surprise", "exotic_input", "control_chars", "idempotency",
		"state_corruption", "permission_edge", "timing_dst", "resource_exhaustion",
		"downstream_failure"}
	if len(insight.Categories) != len(want) {
		t.Fatalf("expected %d categories, got %d", len(want), len(insight.Categories))
	}
	for i, id := range want {
		if insight.Categories[i] != id {
			t.Fatalf("category %d: want %q, got %q", i, id, insight.Categories[i])
		}
		if !insight.IsCategory(id) {
			t.Fatalf("IsCategory(%q) must be true", id)
		}
	}
	if insight.IsCategory("chaos_monkey") {
		t.Fatal("unknown ids must not be accepted")
	}
	if insight.Technique != "edge_case" {
		t.Fatalf("technique must be edge_case, got %q", insight.Technique)
	}
}

func TestInsightReportListsEveryCategoryInCanonicalOrder(t *testing.T) {
	headers, pid := insightProject(t)
	report := insightsOf(t, headers, pid)
	rows, _ := report["categories"].([]any)
	if len(rows) != len(insight.Categories) {
		t.Fatalf("expected %d rows, got %d", len(insight.Categories), len(rows))
	}
	for i, r := range rows {
		row := r.(map[string]any)
		if row["id"] != insight.Categories[i] {
			t.Fatalf("row %d: want %q, got %v", i, insight.Categories[i], row["id"])
		}
		for _, key := range []string{"id", "covered_count", "suggestable_count", "status"} {
			if _, ok := row[key]; !ok {
				t.Fatalf("row %d missing key %q", i, key)
			}
		}
	}
	for _, key := range []string{"total_cases", "total_covered", "total_suggestable"} {
		if _, ok := report[key]; !ok {
			t.Fatalf("report missing key %q", key)
		}
	}
}

// ---------------------------------------------------------------------------
// C. Report semantics
// ---------------------------------------------------------------------------

func TestInsightStatusSemantics(t *testing.T) {
	headers, pid := insightProject(t)
	report := insightsOf(t, headers, pid)

	// gap: nothing covered yet, but the builders can ground themselves.
	for _, id := range []string{"exotic_input", "control_chars", "idempotency"} {
		row := categoryRow(t, report, id)
		if row["status"] != "gap" {
			t.Fatalf("%s: expected gap, got %v (%v suggestable)", id, row["status"], row["suggestable_count"])
		}
		if intOf(row["suggestable_count"]) <= 0 {
			t.Fatalf("%s: a gap must be suggestable", id)
		}
	}
	// n_a: the spec has no date/date-time field anywhere, so timing_dst has
	// nothing to ground itself in — the contract's own example.
	timing := categoryRow(t, report, "timing_dst")
	if timing["status"] != "n_a" || intOf(timing["suggestable_count"]) != 0 {
		t.Fatalf("timing_dst must be n_a with 0 suggestable, got %v", timing)
	}
	// Same for state_corruption (no DELETE endpoint), downstream_failure (no
	// documented 5xx) and permission_edge (the spec declares no security
	// scheme): the engine invents none of them.
	for _, id := range []string{"state_corruption", "downstream_failure", "permission_edge"} {
		if row := categoryRow(t, report, id); row["status"] != "n_a" {
			t.Fatalf("%s must be n_a, got %v", id, row["status"])
		}
	}
}

// TestInsightRichInventoryFillsTheRemainingCategories — the categories that are
// n_a against the small spec become gaps the moment the inventory declares what
// they need. Nothing else changes: the trigger is always the inventory.
func TestInsightRichInventoryFillsTheRemainingCategories(t *testing.T) {
	headers, pid := insightRichProject(t)
	report := insightsOf(t, headers, pid)
	for _, id := range []string{"permission_edge", "timing_dst", "state_corruption",
		"downstream_failure", "resource_exhaustion", "boundary_surprise"} {
		row := categoryRow(t, report, id)
		if row["status"] != "gap" || intOf(row["suggestable_count"]) == 0 {
			t.Fatalf("%s should be a suggestable gap here, got %v", id, row)
		}
	}
	all := append([]string(nil), insight.Categories...)
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate", M{"categories": all}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	result := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))["result"].(map[string]any)
	if intOf(result["discarded"]) != 0 {
		t.Fatalf("every builder output must pass the grounding gate: %v", result)
	}
	byCategory, _ := result["by_category"].(map[string]any)
	for _, id := range []string{"permission_edge", "timing_dst", "state_corruption",
		"downstream_failure", "resource_exhaustion", "boundary_surprise"} {
		if intOf(byCategory[id]) == 0 {
			t.Fatalf("no case generated for %s: %v", id, byCategory)
		}
	}
	// The multi-step categories persist real, grounded, multi-step cases.
	var multi int64
	db.DB.Model(&models.TestCase{}).
		Where("project_id = ? AND edge_category = ?", pid, "state_corruption").Count(&multi)
	if multi == 0 {
		t.Fatal("state_corruption must persist at least one case")
	}
	assertInsightCasesGrounded(t, headers, pid)
}

func TestInsightReportIsDeterministic(t *testing.T) {
	headers, pid := insightProject(t)
	first := insightsOf(t, headers, pid)
	second := insightsOf(t, headers, pid)
	for _, id := range insight.Categories {
		a, b := categoryRow(t, first, id), categoryRow(t, second, id)
		if a["suggestable_count"] != b["suggestable_count"] || a["status"] != b["status"] {
			t.Fatalf("%s: report is not deterministic: %v vs %v", id, a, b)
		}
	}
}

func TestInsightCoveredCountsLegacyCasesViaClassifier(t *testing.T) {
	headers, pid := insightProject(t)
	before := categoryRow(t, insightsOf(t, headers, pid), "idempotency")
	if before["status"] != "gap" {
		t.Fatalf("precondition: idempotency should start as a gap, got %v", before["status"])
	}
	// A legacy case (no edge_category) that submits the same mutating request
	// twice IS idempotency coverage — the classifier must see it.
	var project models.Project
	if err := db.DB.First(&project, "id = ?", pid).Error; err != nil {
		t.Fatalf("load project: %v", err)
	}
	tc := models.TestCase{OrganisationID: project.OrganisationID, ProjectID: pid,
		Title: "Legacy: submit the order twice", Type: "negative", Priority: "medium",
		State: "draft", Generated: false, Technique: "manual", Version: 1}
	if err := db.DB.Create(&tc).Error; err != nil {
		t.Fatalf("seed legacy case: %v", err)
	}
	for i := 0; i < 2; i++ {
		step := models.TestStep{TestCaseID: tc.ID, Order: i, Method: "POST", Path: "/customers",
			Request:    models.JSONMap{"headers": M{}, "params": M{}, "body": M{"name": "example"}},
			Assertions: models.JSONList{M{"type": "status_code", "expected": 201}}}
		if err := db.DB.Create(&step).Error; err != nil {
			t.Fatalf("seed legacy step: %v", err)
		}
	}
	after := categoryRow(t, insightsOf(t, headers, pid), "idempotency")
	if after["status"] != "covered" || intOf(after["covered_count"]) < 1 {
		t.Fatalf("legacy duplicate-submit case must count as covered: %v", after)
	}
}

func TestInsightClassifierDoesNotCountPlainBVAAsBoundarySurprise(t *testing.T) {
	tc := &models.TestCase{Title: "BVA: age at maximum boundary — POST /customers",
		Technique: "bva", Type: "boundary"}
	if got := insight.Classify(tc, nil); got != "" {
		t.Fatalf("plain BVA must not be an insight category, got %q", got)
	}
	edge := &models.TestCase{Title: "Edge: age just outside maximum+1 — POST /customers",
		Technique: "edge_case", Type: "boundary"}
	if got := insight.Classify(edge, nil); got != "boundary_surprise" {
		t.Fatalf("just-outside case must be boundary_surprise, got %q", got)
	}
	category := "exotic_input"
	explicit := &models.TestCase{Title: "anything", EdgeCategory: &category}
	if got := insight.Classify(explicit, nil); got != "exotic_input" {
		t.Fatalf("edge_category must win, got %q", got)
	}
}

// TestInsightClassifierMatchesThePythonRuleTable pins the request-value signals
// that the Python engine's classify_case() emits, because covered_count must be
// identical across the two backends for the same project. Each case below was
// verified against the Python implementation with the same input.
func TestInsightClassifierMatchesThePythonRuleTable(t *testing.T) {
	step := func(m, p string, request models.JSONMap, assertions models.JSONList) models.TestStep {
		return models.TestStep{Method: m, Path: p, Request: request, Assertions: assertions}
	}
	body := func(v any) models.JSONMap {
		return models.JSONMap{"headers": M{}, "params": M{}, "body": M{"name": v}}
	}
	status := func(code int) models.JSONList {
		return models.JSONList{M{"type": "status_code", "expected": code}}
	}
	ok := status(201)

	for _, tt := range []struct {
		name  string
		title string
		steps []models.TestStep
		want  string
	}{
		// Taxonomy A names non-ASCII payloads as an exotic_input probe, and the
		// builder's first probe is mixed-script text — so a legacy case already
		// sending non-ASCII text through a field covers it.
		{"CJK request value", "create customer",
			[]models.TestStep{step("POST", "/c", body("新規 注文"), ok)}, "exotic_input"},
		{"accented Latin request value", "create customer",
			[]models.TestStep{step("POST", "/c", body("José Ávila"), ok)}, "exotic_input"},
		{"emoji request value", "create",
			[]models.TestStep{step("POST", "/c", body("ok \U0001F600"), ok)}, "exotic_input"},
		{"zero-width request value", "create",
			[]models.TestStep{step("POST", "/c", body("ab\u200bc"), ok)}, "exotic_input"},
		// A control character outranks the non-ASCII text around it.
		{"control char beats exotic", "create",
			[]models.TestStep{step("POST", "/c", body("東京\u0000"), ok)}, "control_chars"},
		{"401/403 assertion", "create as another actor",
			[]models.TestStep{step("POST", "/c", body("Ann"), status(403))}, "permission_edge"},
		{"5xx tolerated", "create",
			[]models.TestStep{step("POST", "/c", body("Ann"), status(503))}, "downstream_failure"},
		{"repeated mutating step", "submit twice", []models.TestStep{
			step("POST", "/c", body("Ann"), ok), step("POST", "/c", body("Ann"), status(409))},
			"idempotency"},
		{"differing mutating steps", "sequence", []models.TestStep{
			step("DELETE", "/c/{id}", models.JSONMap{}, status(204)),
			step("PUT", "/c/{id}", body("Ann"), status(404))}, "state_corruption"},
		{"extreme pagination value", "list", []models.TestStep{
			step("GET", "/c", models.JSONMap{"params": M{"limit": 1000000000}}, ok)},
			"resource_exhaustion"},
		{"date-time carrying a UTC offset", "schedule", []models.TestStep{
			step("POST", "/c", models.JSONMap{"body": M{"at": "2026-03-29T02:30:00+02:00"}}, ok)},
			"timing_dst"},
		// A title alone is not a signal — only request values are inspected.
		{"unremarkable title, plain body", "customer creation test",
			[]models.TestStep{step("POST", "/c", body("example"), ok)}, ""},
	} {
		tc := &models.TestCase{Title: tt.title, Technique: "manual", Type: "positive"}
		if got := insight.Classify(tc, tt.steps); got != tt.want {
			t.Errorf("%s: Classify = %q, want %q", tt.name, got, tt.want)
		}
	}
}

// ---------------------------------------------------------------------------
// D. Generation
// ---------------------------------------------------------------------------

func TestInsightGenerateRejectsInvalidCategory(t *testing.T) {
	headers, pid := insightProject(t)
	for _, body := range []M{
		{"categories": []string{"chaos_monkey"}},
		{"categories": []string{"exotic_input", "not_a_category"}},
		{"categories": []string{}},
		{},
	} {
		w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate", body, headers)
		if w.Code != 422 {
			t.Fatalf("body %v: expected 422, got %d %.200s", body, w.Code, w.Body.String())
		}
		if !bodyContains(w, "invalid_category") {
			t.Fatalf("body %v: expected invalid_category, got %.200s", body, w.Body.String())
		}
	}
}

func TestInsightGenerateFollowsTheJobPattern(t *testing.T) {
	headers, pid := insightProject(t)
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"exotic_input", "idempotency"}}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	jobID, _ := jsonMap(t, w)["job_id"].(string)
	if jobID == "" {
		t.Fatal("no job_id in the 202 response")
	}
	job := pollJob(t, headers, jobID)
	result, _ := job["result"].(map[string]any)
	if intOf(result["generated"]) <= 0 {
		t.Fatalf("nothing generated: %v", result)
	}
	if intOf(result["discarded"]) != 0 {
		t.Fatalf("the builders must be grounded by construction: %v", result)
	}

	// Persisted shape: draft, technique edge_case, edge_category set and legal,
	// linked to a requirement — visible through the public payload.
	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	if w.Code != 200 {
		t.Fatalf("test-cases failed: %d %.300s", w.Code, w.Body.String())
	}
	found := map[string]int{}
	for _, cv := range itemsOf(jsonAny(t, w)) {
		tc := cv.(map[string]any)
		if tc["technique"] != "edge_case" {
			continue
		}
		category, _ := tc["edge_category"].(string)
		if !insight.IsCategory(category) {
			t.Fatalf("illegal edge_category %v on case %v", tc["edge_category"], tc["id"])
		}
		if tc["state"] != "draft" {
			t.Fatalf("insight cases must land as drafts, got %v", tc["state"])
		}
		found[category]++

		detail := jsonMap(t, do(t, "GET", "/v1/test-cases/"+tc["id"].(string), nil, headers))
		if links, _ := detail["links"].([]any); len(links) == 0 {
			t.Fatalf("case %v is not linked to any requirement", tc["id"])
		}
	}
	for _, id := range []string{"exotic_input", "idempotency"} {
		if found[id] == 0 {
			t.Fatalf("no case generated for the requested category %q", id)
		}
	}
	// Only the requested categories were built.
	for id := range found {
		if id != "exotic_input" && id != "idempotency" {
			t.Fatalf("category %q was not requested but was generated", id)
		}
	}
}

// TestInsightExoticProbesAreNonASCIIAndArabicFree pins contract item 4 of the
// English-only pivot: the exotic_input builder still exercises Unicode (emoji,
// CJK, accented Latin, zero-width, NFD) but emits ZERO Arabic — in the case
// text and in every request value it sends.
func TestInsightExoticProbesAreNonASCIIAndArabicFree(t *testing.T) {
	headers, pid := insightProject(t)
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"exotic_input"}}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	result := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))["result"].(map[string]any)
	if intOf(result["generated"]) == 0 {
		t.Fatalf("exotic_input produced no cases: %v", result)
	}

	var cases []models.TestCase
	db.DB.Where("project_id = ? AND technique = ?", pid, "edge_case").Find(&cases)
	if len(cases) == 0 {
		t.Fatal("no persisted edge_case cases to inspect")
	}
	nonASCII := false
	for _, tc := range cases {
		blobs := []string{tc.Title, tc.Description, tc.Preconditions}
		var steps []models.TestStep
		db.DB.Where("test_case_id = ?", tc.ID).Find(&steps)
		for _, s := range steps {
			raw, err := json.Marshal(s.Request)
			if err != nil {
				t.Fatalf("marshal step request: %v", err)
			}
			blobs = append(blobs, string(raw))
		}
		for _, blob := range blobs {
			for _, r := range blob {
				if isArabicRune(r) {
					t.Fatalf("Arabic character %U in case %q: %.200s", r, tc.Title, blob)
				}
				if r > 0x7f {
					nonASCII = true
				}
			}
		}
	}
	if !nonASCII {
		t.Fatal("exotic_input must still probe non-ASCII input (emoji, CJK, accented Latin, zero-width)")
	}
}

// isArabicRune covers every Arabic block: Arabic, Arabic Supplement/Extended-A,
// and the Presentation Forms A/B ranges. U+FEFF (ZERO WIDTH NO-BREAK SPACE) sits
// at the end of Presentation Forms-B but is a BOM, not an Arabic letter — it is
// a legitimate zero-width probe, so the range stops at U+FEFC.
func isArabicRune(r rune) bool {
	return (r >= 0x0600 && r <= 0x06ff) || (r >= 0x0750 && r <= 0x077f) ||
		(r >= 0x08a0 && r <= 0x08ff) || (r >= 0xfb50 && r <= 0xfdff) ||
		(r >= 0xfe70 && r <= 0xfefc)
}

func TestInsightGenerateClosesTheGapAndDoesNotDuplicate(t *testing.T) {
	headers, pid := insightProject(t)
	before := categoryRow(t, insightsOf(t, headers, pid), "control_chars")
	if before["status"] != "gap" {
		t.Fatalf("precondition: control_chars should be a gap, got %v", before["status"])
	}
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"control_chars"}}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	first := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))["result"].(map[string]any)
	if intOf(first["generated"]) != intOf(before["suggestable_count"]) {
		t.Fatalf("suggestable_count (%v) must match what the job produced (%v)",
			before["suggestable_count"], first["generated"])
	}

	after := categoryRow(t, insightsOf(t, headers, pid), "control_chars")
	if after["status"] != "covered" || intOf(after["covered_count"]) != intOf(first["generated"]) {
		t.Fatalf("category must be covered after generation: %v", after)
	}
	if intOf(after["suggestable_count"]) != 0 {
		t.Fatalf("already-created cases must not be suggested again: %v", after)
	}

	// Re-running the same request creates nothing new.
	w = do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"control_chars"}}, headers)
	second := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))["result"].(map[string]any)
	if intOf(second["generated"]) != 0 {
		t.Fatalf("second run must be a no-op, got %v", second)
	}
}

func TestInsightGenerateWritesAuditEntry(t *testing.T) {
	headers, pid := insightProject(t)
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"permission_edge"}}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	pollJob(t, headers, jsonMap(t, w)["job_id"].(string))

	var entries []models.AuditEntry
	db.DB.Where("action = ? AND object_id = ?", "insight.generate", pid).Find(&entries)
	if len(entries) != 1 {
		t.Fatalf("expected exactly one insight.generate audit entry, got %d", len(entries))
	}
	detail := entries[0].Detail
	cats, _ := detail["categories"].([]any)
	if len(cats) != 1 || cats[0] != "permission_edge" {
		t.Fatalf("audit detail must carry the categories, got %v", detail)
	}
	for _, key := range []string{"created", "discarded"} {
		if _, ok := detail[key]; !ok {
			t.Fatalf("audit detail missing %q: %v", key, detail)
		}
	}
	if entries[0].ActorID == nil {
		t.Fatal("audit entry must be attributed to the actor")
	}
}

func TestInsightGenerateHonoursRequirementSubset(t *testing.T) {
	headers, pid := insightProject(t)
	other := addRequirement(t, headers, pid, "REQ-901",
		"Create a customer via POST /customers with a valid phone number", nil)
	confirmRequirement(t, headers, other)

	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"idempotency"}, "requirement_ids": []string{other}}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	if intOf(pollJob(t, headers, jsonMap(t, w)["job_id"].(string))["result"].(map[string]any)["generated"]) == 0 {
		t.Fatal("the requirement subset should still produce cases")
	}
	// Every generated case must be linked to the requested requirement only.
	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	for _, cv := range itemsOf(jsonAny(t, w)) {
		tc := cv.(map[string]any)
		if tc["technique"] != "edge_case" {
			continue
		}
		detail := jsonMap(t, do(t, "GET", "/v1/test-cases/"+tc["id"].(string), nil, headers))
		links, _ := detail["links"].([]any)
		if len(links) != 1 || links[0].(map[string]any)["id"] != other {
			t.Fatalf("case %v must be linked to the requested requirement only: %v", tc["id"], links)
		}
	}
}

// ---------------------------------------------------------------------------
// ADVERSARIAL GROUNDING — nothing persisted may leave the inventory
// ---------------------------------------------------------------------------

func TestInsightGeneratedCasesAreGroundedInTheInventory(t *testing.T) {
	headers, pid := insightProject(t)
	all := make([]string, len(insight.Categories))
	copy(all, insight.Categories)
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate", M{"categories": all}, headers)
	if w.Code != 202 {
		t.Fatalf("expected 202, got %d %.300s", w.Code, w.Body.String())
	}
	result := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))["result"].(map[string]any)
	if intOf(result["generated"]) <= 0 {
		t.Fatalf("nothing generated: %v", result)
	}
	assertInsightCasesGrounded(t, headers, pid)
}

// assertInsightCasesGrounded — every persisted edge_case must resolve, step by
// step, against the project's endpoint inventory: no fabricated endpoint, no
// fabricated parameter, no fabricated body field, no fabricated assertion
// target, and never an unlinked case.
func assertInsightCasesGrounded(t *testing.T, headers map[string]string, pid string) {
	t.Helper()
	// Ground truth: the imported endpoint inventory as the API reports it.
	w := do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)
	inventory := map[string]M{}
	for _, e := range itemsOf(jsonAny(t, w)) {
		ep := e.(map[string]any)
		inventory[strings.ToUpper(ep["method"].(string))+" "+ep["path"].(string)] = ep
	}
	if len(inventory) == 0 {
		t.Fatal("endpoint inventory is empty")
	}

	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases", nil, headers)
	checked := 0
	for _, cv := range itemsOf(jsonAny(t, w)) {
		tc := cv.(map[string]any)
		if tc["technique"] != "edge_case" {
			continue
		}
		detail := jsonMap(t, do(t, "GET", "/v1/test-cases/"+tc["id"].(string), nil, headers))
		steps := stepsOfDetail(detail)
		if len(steps) == 0 {
			t.Fatalf("case %v has no steps", tc["id"])
		}
		if links, _ := detail["links"].([]any); len(links) == 0 {
			t.Fatalf("case %v is not linked to any requirement", tc["id"])
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
			for pname := range mapOf(request["params"]) {
				if !paramNames[pname] {
					t.Fatalf("fabricated parameter '%s' persisted on %s", pname, key)
				}
			}
			schema, _ := ep["request_schema"].(map[string]any)
			if body, isMap := request["body"].(map[string]any); isMap {
				if _, hasProps := schema["properties"].(map[string]any); hasProps {
					assertBodyGrounded(t, body, schema, key)
				}
			}
			// Assertion targets: json_field may only address a documented 2xx
			// response property.
			respProps := map[string]any{}
			if schemas, ok := ep["response_schemas"].(map[string]any); ok {
				codes := make([]string, 0, len(schemas))
				for code := range schemas {
					codes = append(codes, code)
				}
				sort.Strings(codes)
				for _, code := range codes {
					if code < "200" || code >= "300" {
						continue
					}
					if s, ok := schemas[code].(map[string]any); ok {
						if props, ok := s["properties"].(map[string]any); ok {
							respProps = props
							break
						}
					}
				}
			}
			for _, av := range listOf(step["assertions"]) {
				a, _ := av.(map[string]any)
				if a["type"] != "json_field" || len(respProps) == 0 {
					continue
				}
				path, _ := a["path"].(string)
				seg := strings.SplitN(strings.TrimLeft(path, "$."), ".", 2)[0]
				if _, in := respProps[seg]; !in {
					t.Fatalf("fabricated json_field target '%s' persisted on %s", path, key)
				}
			}
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no insight case steps were checked")
	}
}

func mapOf(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func listOf(v any) []any {
	l, _ := v.([]any)
	return l
}

// ---------------------------------------------------------------------------
// Capability guards + tenant isolation
// ---------------------------------------------------------------------------

func TestInsightCapabilityGuards(t *testing.T) {
	_, pid := insightProject(t)
	var project models.Project
	if err := db.DB.First(&project, "id = ?", pid).Error; err != nil {
		t.Fatalf("load project: %v", err)
	}
	viewer := seedUserInOrg(t, project.OrganisationID, "viewer")

	// "view": a viewer may read the report...
	if w := do(t, "GET", "/v1/projects/"+pid+"/insights", nil, viewer); w.Code != 200 {
		t.Fatalf("viewer must be able to read insights, got %d %.200s", w.Code, w.Body.String())
	}
	// ...but "generate" is denied.
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"exotic_input"}}, viewer)
	if w.Code != 403 || !bodyContains(w, "forbidden") {
		t.Fatalf("viewer must not generate, got %d %.200s", w.Code, w.Body.String())
	}
	// Unauthenticated is 401 on both routes.
	for _, route := range []struct{ method, path string }{
		{"GET", "/v1/projects/" + pid + "/insights"},
		{"POST", "/v1/projects/" + pid + "/insights/generate"},
	} {
		if w := do(t, route.method, route.path, M{"categories": []string{"exotic_input"}}, nil); w.Code != 401 {
			t.Fatalf("%s %s: expected 401, got %d", route.method, route.path, w.Code)
		}
	}
	// The engine never generates for a viewer, so nothing was created.
	var n int64
	db.DB.Model(&models.TestCase{}).Where("project_id = ? AND technique = ?", pid, "edge_case").Count(&n)
	if n != 0 {
		t.Fatalf("a denied request must create nothing, found %d cases", n)
	}
}

func TestInsightTenantIsolation(t *testing.T) {
	_, pid := insightProject(t)
	intruder := registerOrg(t, "Other Org")
	if w := do(t, "GET", "/v1/projects/"+pid+"/insights", nil, intruder); w.Code != 404 {
		t.Fatalf("foreign org must get 404 on the report, got %d", w.Code)
	}
	w := do(t, "POST", "/v1/projects/"+pid+"/insights/generate",
		M{"categories": []string{"exotic_input"}}, intruder)
	if w.Code != 404 {
		t.Fatalf("foreign org must get 404 on generate, got %d", w.Code)
	}
}

// seedUserInOrg mints a token for another role inside an EXISTING organisation —
// the capability matrix is what is under test, not the tenant boundary.
func seedUserInOrg(t *testing.T, orgID, role string) map[string]string {
	t.Helper()
	u := models.User{OrganisationID: orgID,
		Email: fmt.Sprintf("u%s@example.sa", uuid.NewString()[:10]),
		Name:  "Role Tester", PasswordHash: "x", Role: role, Locale: "en"}
	if err := db.DB.Create(&u).Error; err != nil {
		t.Fatalf("seed %s: %v", role, err)
	}
	tok, err := security.CreateToken(u.ID, orgID, role)
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	return map[string]string{"Authorization": "Bearer " + tok}
}

// ---------------------------------------------------------------------------
// E. Untrusted-data framing must not disturb the deterministic mock
// ---------------------------------------------------------------------------

func TestUntrustedFramingKeepsMockDeterministic(t *testing.T) {
	provider := llm.Get()
	segment := "REQ-500 The system must create a customer\n- The phone number matches 05XXXXXXXX"
	framed, err := provider.CompleteJSON("extract_requirement",
		"Extract the software requirement from this segment.\n"+llm.UntrustedNote+
			llm.UntrustedOpen+"\nSEGMENT:\n"+segment+"\n"+llm.UntrustedClose, nil)
	if err != nil {
		t.Fatalf("framed extract failed: %v", err)
	}
	bare, err := provider.CompleteJSON("extract_requirement", "SEGMENT:\n"+segment, nil)
	if err != nil {
		t.Fatalf("bare extract failed: %v", err)
	}
	for _, key := range []string{"external_id", "description", "type", "priority", "confidence"} {
		if framed.Data[key] != bare.Data[key] {
			t.Fatalf("framing changed %q: framed=%v bare=%v", key, framed.Data[key], bare.Data[key])
		}
	}
	if strings.Contains(framed.Data["description"].(string), "TRACEO_UNTRUSTED") {
		t.Fatalf("the delimiter leaked into the extraction: %v", framed.Data["description"])
	}

	payload := `{"requirement":"create a customer","candidates":[` +
		`{"method":"POST","path":"/customers","summary":"create a customer","operation_id":"createCustomer","tags":[]}]}`
	framedMap, err := provider.CompleteJSON("map_requirement",
		llm.UntrustedNote+llm.UntrustedOpen+"\nPAYLOAD:\n"+payload+"\n"+llm.UntrustedClose, nil)
	if err != nil {
		t.Fatalf("framed map failed: %v", err)
	}
	bareMap, err := provider.CompleteJSON("map_requirement", "PAYLOAD:\n"+payload, nil)
	if err != nil {
		t.Fatalf("bare map failed: %v", err)
	}
	if len(framedMap.Data["selected"].([]any)) == 0 {
		t.Fatal("the framed payload must still be parsed by the mock")
	}
	if framedMap.Data["confidence"] != bareMap.Data["confidence"] {
		t.Fatalf("framing changed the mapping confidence: %v vs %v",
			framedMap.Data["confidence"], bareMap.Data["confidence"])
	}
}
