// AUTOPILOT GATES — v2 automation contract parity with the Python backend.
//
// Covered: project create/update defaults (nullable language, automation
// default "auto", existing clients unchanged), deterministic offline language
// detection (Arabic-block ratio >= 0.25), the full auto chain (upload -> parse
// -> detect -> confirm_all -> auto-generate -> DRAFT cases only, approval stays
// manual per BO-07), manual-mode opt-out, preset language never overwritten,
// and the generation double-trigger guard.
package tests_test

import (
	"testing"
	"time"

	"traceo/internal/jobs"
	"traceo/internal/modules/autopilot"
)

// --- helpers ---------------------------------------------------------------

func createProjectRaw(t *testing.T, headers map[string]string, body M) M {
	t.Helper()
	w := do(t, "POST", "/v1/projects", body, headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("create project failed: %d %.300s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

func getProjectMap(t *testing.T, headers map[string]string, pid string) M {
	t.Helper()
	w := do(t, "GET", "/v1/projects/"+pid, nil, headers)
	if w.Code != 200 {
		t.Fatalf("get project failed: %d %.300s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

func listState(t *testing.T, headers map[string]string, pid, resource, state string) []any {
	t.Helper()
	path := "/v1/projects/" + pid + "/" + resource
	if state != "" {
		path += "?state=" + state
	}
	w := do(t, "GET", path, nil, headers)
	if w.Code != 200 {
		t.Fatalf("list %s failed: %d %.300s", resource, w.Code, w.Body.String())
	}
	return itemsOf(jsonAny(t, w))
}

func auditActions(t *testing.T, headers map[string]string) map[string]bool {
	t.Helper()
	w := do(t, "GET", "/v1/audit?limit=200", nil, headers)
	if w.Code != 200 {
		t.Fatalf("audit list failed: %d %.300s", w.Code, w.Body.String())
	}
	out := map[string]bool{}
	for _, it := range itemsOf(jsonAny(t, w)) {
		if a, _ := it.(M)["action"].(string); a != "" {
			out[a] = true
		}
	}
	return out
}

func uploadAndParse(t *testing.T, headers map[string]string, pid, filename string) {
	t.Helper()
	w := uploadFile(t, "/v1/projects/"+pid+"/documents", filename,
		[]byte(requirementsMD), "text/markdown", headers)
	if w.Code != 200 && w.Code != 201 && w.Code != 202 {
		t.Fatalf("upload failed: %d %.300s", w.Code, w.Body.String())
	}
	jobID, _ := jsonMap(t, w)["job_id"].(string)
	pollJob(t, headers, jobID)
}

func waitForCases(t *testing.T, headers map[string]string, pid string) []any {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if cases := listState(t, headers, pid, "test-cases", ""); len(cases) > 0 {
			return cases
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("auto-generation produced no test cases within 30s")
	return nil
}

// --- contract 1+2: create/update fields ------------------------------------

func TestProjectAutomationAndNullableLanguage(t *testing.T) {
	headers := registerOrg(t, "منظمة الأتمتة")

	// name only => language null (auto-detect later), automation defaults "auto"
	p := createProjectRaw(t, headers, M{"name": "مشروع بلا لغة"})
	if p["language"] != nil {
		t.Fatalf("language must be null until detected, got %v", p["language"])
	}
	if p["automation"] != "auto" {
		t.Fatalf("automation must default to 'auto', got %v", p["automation"])
	}
	pid, _ := p["id"].(string)
	got := getProjectMap(t, headers, pid)
	if got["language"] != nil || got["automation"] != "auto" {
		t.Fatalf("read-back mismatch: %v", got)
	}

	// existing clients sending language keep working
	p2 := createProjectRaw(t, headers, M{"name": "مشروع عربي", "language": "ar"})
	if p2["language"] != "ar" {
		t.Fatalf("explicit language lost: %v", p2["language"])
	}

	// explicit automation manual
	p3 := createProjectRaw(t, headers, M{"name": "يدوي", "automation": "manual"})
	if p3["automation"] != "manual" {
		t.Fatalf("automation manual lost: %v", p3["automation"])
	}

	// invalid values rejected
	if w := do(t, "POST", "/v1/projects", M{"name": "x", "automation": "bogus"}, headers); w.Code != 422 {
		t.Fatalf("invalid automation must 422, got %d", w.Code)
	}
	if w := do(t, "POST", "/v1/projects", M{"name": "x", "language": "fr"}, headers); w.Code != 422 {
		t.Fatalf("invalid language must 422, got %d", w.Code)
	}

	// update endpoint accepts both fields — freedom to override anytime
	w := do(t, "PATCH", "/v1/projects/"+pid, M{"language": "en", "automation": "manual"}, headers)
	if w.Code != 200 {
		t.Fatalf("project update failed: %d %.300s", w.Code, w.Body.String())
	}
	upd := jsonMap(t, w)
	if upd["language"] != "en" || upd["automation"] != "manual" {
		t.Fatalf("override not applied: %v", upd)
	}
	if w := do(t, "PATCH", "/v1/projects/"+pid, M{"automation": "sometimes"}, headers); w.Code != 422 {
		t.Fatalf("invalid automation on update must 422, got %d", w.Code)
	}
}

// --- contract 3: deterministic language detection ---------------------------

func TestLanguageDetectionRule(t *testing.T) {
	cases := []struct {
		text string
		want string
	}{
		{"يجب أن يبدأ رقم الجوال بـ 05", "ar"},
		{"The system shall reject invalid phone numbers", "en"},
		{"", "en"},           // no alphabetic chars => en
		{"123 456 !!", "en"}, // digits/punctuation only => en
		{"عabc", "ar"},       // 1 Arabic of 4 letters = 0.25 => ar (boundary inclusive)
		{"عabcd", "en"},      // 1 of 5 = 0.2 < 0.25 => en
		{"متطلب mixed with English words النظام", "ar"},
	}
	for _, c := range cases {
		if got := autopilot.DetectLanguage(c.text); got != c.want {
			t.Fatalf("DetectLanguage(%q) = %q, want %q", c.text, got, c.want)
		}
	}
}

// --- contract 4: the auto chain --------------------------------------------

func TestAutopilotUploadToDraftCases(t *testing.T) {
	headers := registerOrg(t, "شركة الطيار الآلي")
	p := createProjectRaw(t, headers, M{"name": "مشروع تلقائي"}) // auto + null language
	pid, _ := p["id"].(string)

	// spec import with zero confirmed requirements must NOT trigger generation
	importSpec(t, headers, pid)
	if cases := listState(t, headers, pid, "test-cases", ""); len(cases) != 0 {
		t.Fatalf("generation ran with no confirmed requirements: %d cases", len(cases))
	}

	// upload the Arabic requirements doc; the parse job runs the whole chain
	uploadAndParse(t, headers, pid, "requirements_ar.md")

	// (3) language detected and persisted on the project
	if got := getProjectMap(t, headers, pid); got["language"] != "ar" {
		t.Fatalf("expected detected language 'ar', got %v", got["language"])
	}

	// (4a) every extracted requirement auto-confirmed
	if extracted := listState(t, headers, pid, "requirements", "extracted"); len(extracted) != 0 {
		t.Fatalf("%d requirements left in 'extracted' after autopilot", len(extracted))
	}
	if confirmed := listState(t, headers, pid, "requirements", "confirmed"); len(confirmed) < 2 {
		t.Fatalf("expected >=2 auto-confirmed requirements, got %d", len(confirmed))
	}

	// (4b) generation auto-triggered -> draft cases; (4c) approval stays manual
	for _, cse := range waitForCases(t, headers, pid) {
		if state := cse.(M)["state"]; state != "draft" {
			t.Fatalf("autopilot must stop at draft, found case in state %v", state)
		}
	}
	if approved := listState(t, headers, pid, "test-cases", "approved"); len(approved) != 0 {
		t.Fatalf("autopilot approved %d cases — approval is a human gate (BO-07)", len(approved))
	}

	// (4d) every auto step audited with the "auto." action prefix
	actions := auditActions(t, headers)
	for _, want := range []string{"auto.language.detect", "auto.requirements.confirm_all", "auto.generate"} {
		if !actions[want] {
			t.Fatalf("missing audit action %q in %v", want, actions)
		}
	}
}

func TestManualModeStopsAtExtraction(t *testing.T) {
	headers := registerOrg(t, "منظمة اليدوي")
	p := createProjectRaw(t, headers, M{"name": "مشروع يدوي", "automation": "manual"})
	pid, _ := p["id"].(string)

	importSpec(t, headers, pid)
	uploadAndParse(t, headers, pid, "requirements_ar.md")

	// language detection is contract item 3 — it runs regardless of the mode
	if got := getProjectMap(t, headers, pid); got["language"] != "ar" {
		t.Fatalf("language detection must run in manual mode too, got %v", got["language"])
	}

	// but the chain stops: nothing confirmed, nothing generated
	if confirmed := listState(t, headers, pid, "requirements", "confirmed"); len(confirmed) != 0 {
		t.Fatalf("manual mode auto-confirmed %d requirements", len(confirmed))
	}
	if extracted := listState(t, headers, pid, "requirements", "extracted"); len(extracted) < 2 {
		t.Fatalf("expected >=2 requirements still 'extracted', got %d", len(extracted))
	}
	time.Sleep(300 * time.Millisecond) // would-be generation job window
	if cases := listState(t, headers, pid, "test-cases", ""); len(cases) != 0 {
		t.Fatalf("manual mode generated %d cases", len(cases))
	}
	actions := auditActions(t, headers)
	if actions["auto.requirements.confirm_all"] || actions["auto.generate"] {
		t.Fatalf("manual mode wrote autopilot audit entries: %v", actions)
	}
	if !actions["auto.language.detect"] {
		t.Fatalf("auto.language.detect audit missing: %v", actions)
	}

	// the manual endpoints still work unchanged on top
	w := do(t, "POST", "/v1/projects/"+pid+"/requirements/confirm_all", nil, headers)
	if w.Code != 200 {
		t.Fatalf("manual confirm_all failed: %d %.300s", w.Code, w.Body.String())
	}
	if confirmed := listState(t, headers, pid, "requirements", "confirmed"); len(confirmed) < 2 {
		t.Fatalf("manual confirm_all confirmed nothing")
	}
}

func TestPresetLanguageNeverOverwritten(t *testing.T) {
	headers := registerOrg(t, "منظمة اللغة الثابتة")
	p := createProjectRaw(t, headers,
		M{"name": "لغة محددة مسبقاً", "language": "en", "automation": "manual"})
	pid, _ := p["id"].(string)

	uploadAndParse(t, headers, pid, "requirements_ar.md") // Arabic content

	if got := getProjectMap(t, headers, pid); got["language"] != "en" {
		t.Fatalf("preset language overwritten: %v", got["language"])
	}
	if actions := auditActions(t, headers); actions["auto.language.detect"] {
		t.Fatal("auto.language.detect ran although language was already set")
	}
}

// --- contract 4b: double-trigger guard --------------------------------------

func TestGenerationDoubleTriggerGuard(t *testing.T) {
	const pid = "guard-project"
	release := make(chan struct{})
	started := make(chan struct{})
	if _, ok := jobs.TrySubmitForProject("generate", pid, func(j *jobs.Job) (any, error) {
		close(started)
		<-release
		return nil, nil
	}); !ok {
		t.Fatal("first submit must pass the guard")
	}
	<-started
	if !jobs.ActiveForProject("generate", pid) {
		t.Fatal("running job not visible to the guard")
	}
	if _, ok := jobs.TrySubmitForProject("generate", pid,
		func(j *jobs.Job) (any, error) { return nil, nil }); ok {
		t.Fatal("guard allowed a second generation job while one was running")
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for jobs.ActiveForProject("generate", pid) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if jobs.ActiveForProject("generate", pid) {
		t.Fatal("guard did not release after the job finished")
	}
	if _, ok := jobs.TrySubmitForProject("generate", pid,
		func(j *jobs.Job) (any, error) { return nil, nil }); !ok {
		t.Fatal("guard must reopen once the previous job completed")
	}
}
