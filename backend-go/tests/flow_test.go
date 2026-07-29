// RELEASE GATE — end-to-end in-process flow (port of backend/tests/test_flow.py).
//
// register -> Arabic project -> upload .md requirements doc -> parse job ->
// requirements extracted -> confirm_all -> import OpenAPI spec -> generate
// (standard) -> approve all drafts -> traceability shows coverage -> xlsx export.
package tests_test

import (
	"strings"
	"testing"
)

const requirementsMD = `# المتطلبات

REQ-001: يجب أن يبدأ رقم الجوال بـ 05 وأن يتكوّن من 10 أرقام فقط عند إنشاء العميل عبر POST /customers.
- رفض أي رقم لا يطابق الصيغة 05XXXXXXXX بالرمز 422 (invalid phone rejected)
- قبول رقم صحيح مثل 0512345678 (valid phone accepted for customers)

REQ-002: يجب أن يكون عمر العميل بين 18 و120 عاماً عند إنشاء customer جديد.
- رفض age أقل من 18 بالرمز 422 (customers age minimum)
- رفض age أكبر من 120 بالرمز 422 (age maximum accepted boundary)
`

func TestFullFlowFromDocumentToExport(t *testing.T) {
	headers := registerOrg(t, "شركة الجودة")
	pid := createProject(t, headers, "منصة الطلبات", "ar")

	// -- 1. upload the requirements document (multipart .md) and wait for the parse job
	w := uploadFile(t, "/v1/projects/"+pid+"/documents", "requirements_ar.md",
		[]byte(requirementsMD), "text/markdown", headers)
	if w.Code != 200 && w.Code != 201 && w.Code != 202 {
		t.Fatalf("upload failed: %d %.300s", w.Code, w.Body.String())
	}
	upload := jsonMap(t, w)
	if docID, _ := upload["document_id"].(string); docID == "" {
		t.Fatalf("no document_id in upload response: %v", upload)
	}
	jobID, _ := upload["job_id"].(string)
	pollJob(t, headers, jobID)

	// -- 2. at least the two authored requirements were extracted, ids preserved
	w = do(t, "GET", "/v1/projects/"+pid+"/requirements", nil, headers)
	if w.Code != 200 {
		t.Fatalf("list requirements failed: %d %.300s", w.Code, w.Body.String())
	}
	reqs := itemsOf(jsonAny(t, w))
	if len(reqs) < 2 {
		t.Fatalf("expected >=2 extracted requirements, got %d", len(reqs))
	}
	externalIDs := map[string]bool{}
	for _, q := range reqs {
		r := q.(M)
		if id, _ := r["external_id"].(string); id != "" {
			externalIDs[id] = true
		}
		if r["state"] != "extracted" {
			t.Fatalf("requirement not in state 'extracted': %v", r["state"])
		}
	}
	if !externalIDs["REQ-001"] || !externalIDs["REQ-002"] {
		t.Fatalf("missing ids: %v", externalIDs)
	}

	// -- 3. confirm all extracted requirements
	w = do(t, "POST", "/v1/projects/"+pid+"/requirements/confirm_all", nil, headers)
	if w.Code != 200 && w.Code != 201 && w.Code != 204 {
		t.Fatalf("confirm_all failed: %d %.300s", w.Code, w.Body.String())
	}
	w = do(t, "GET", "/v1/projects/"+pid+"/requirements?state=confirmed", nil, headers)
	if confirmed := itemsOf(jsonAny(t, w)); len(confirmed) < 2 {
		t.Fatalf("expected >=2 confirmed requirements, got %d", len(confirmed))
	}

	// -- 4. import the OpenAPI spec (POST /customers: phone pattern, age 18..120,
	//       201 + 422 responses; GET /customers/{id})
	specResult := importSpec(t, headers, pid)
	count, _ := specResult["endpoints_count"].(float64)
	if count < 2 {
		w = do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)
		if len(itemsOf(jsonAny(t, w))) == 0 {
			t.Fatalf("spec import produced no endpoints: %v", specResult)
		}
	}

	// -- 5. generate test cases at standard depth
	w = do(t, "POST", "/v1/projects/"+pid+"/generate", M{"depth": "standard"}, headers)
	if w.Code != 200 && w.Code != 202 {
		t.Fatalf("generate failed: %d %.300s", w.Code, w.Body.String())
	}
	job := pollJob(t, headers, jsonMap(t, w)["job_id"].(string))
	result, _ := job["result"].(map[string]any)
	if result == nil {
		result = M{}
	}
	if generated, _ := result["generated"].(float64); generated <= 0 {
		t.Fatalf("generation produced nothing: %v", result)
	}
	discarded, hasDiscarded := result["discarded"]
	if !hasDiscarded {
		t.Fatalf("grounding gate count missing from result: %v", result)
	}
	// Go/JSON renders integers as float64 after decoding; assert it is integral
	// (the Python gate asserts isinstance(result["discarded"], int)).
	d, isNum := discarded.(float64)
	if !isNum || d != float64(int64(d)) {
		t.Fatalf("discarded must be an integer, got %#v", discarded)
	}

	// -- 6. bulk approve every draft
	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases?state=draft", nil, headers)
	if w.Code != 200 {
		t.Fatalf("list draft test cases failed: %d %.300s", w.Code, w.Body.String())
	}
	drafts := itemsOf(jsonAny(t, w))
	if len(drafts) == 0 {
		t.Fatal("no draft test cases after generation")
	}
	draftIDs := []string{}
	for _, d := range drafts {
		if id, _ := d.(M)["id"].(string); id != "" {
			draftIDs = append(draftIDs, id)
		}
	}
	w = do(t, "POST", "/v1/test-cases/bulk", M{"ids": draftIDs, "action": "approve"}, headers)
	if w.Code != 200 && w.Code != 201 && w.Code != 204 {
		t.Fatalf("bulk approve failed: %d %.300s", w.Code, w.Body.String())
	}
	w = do(t, "GET", "/v1/projects/"+pid+"/test-cases?state=approved", nil, headers)
	if approved := itemsOf(jsonAny(t, w)); len(approved) != len(draftIDs) {
		t.Fatalf("expected %d approved cases, got %d", len(draftIDs), len(approved))
	}

	// -- 7. traceability: coverage present, approved-but-not-run rows flagged
	w = do(t, "GET", "/v1/projects/"+pid+"/traceability", nil, headers)
	if w.Code != 200 {
		t.Fatalf("traceability failed: %d %.300s", w.Code, w.Body.String())
	}
	trace := jsonMap(t, w)
	if cov, _ := trace["coverage_pct"].(float64); cov <= 0 {
		t.Fatalf("coverage is zero: %v", trace)
	}
	rows, _ := trace["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("traceability returned no rows")
	}
	statuses := map[string]bool{}
	for _, row := range rows {
		if s, _ := row.(M)["status"].(string); s != "" {
			statuses[s] = true
		}
	}
	if !statuses["covered_not_run"] {
		t.Fatalf("expected covered_not_run rows: %v", statuses)
	}

	// -- 8. export the traceability matrix as xlsx
	w = do(t, "GET", "/v1/projects/"+pid+"/exports/matrix.xlsx", nil, headers)
	if w.Code != 200 {
		t.Fatalf("xlsx export failed: %d %.300s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "openxml") {
		t.Fatalf("unexpected content type: %s", ct)
	}
	if n := w.Body.Len(); n <= 1000 {
		t.Fatalf("xlsx suspiciously small: %d bytes", n)
	}
}
