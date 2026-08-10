// AUTOPILOT GATES — v2 automation contract parity with the Python backend.
//
// Covered: project create/update defaults (automation default "auto", no
// language field anywhere in the payload), the full auto chain (upload -> parse
// -> confirm_all -> auto-generate -> DRAFT cases only, approval stays manual per
// BO-07), manual-mode opt-out, and the generation double-trigger guard.
package tests_test

import (
	"testing"
	"time"

	"traceo/internal/jobs"
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

func TestProjectAutomationDefaultsAndNoLanguageField(t *testing.T) {
	headers := registerOrg(t, "Automation Org")

	// name only => automation defaults to "auto"; the payload carries no language
	p := createProjectRaw(t, headers, M{"name": "Project Without Language"})
	if _, present := p["language"]; present {
		t.Fatalf("project payload must not carry a language field: %v", p)
	}
	if p["automation"] != "auto" {
		t.Fatalf("automation must default to 'auto', got %v", p["automation"])
	}
	pid, _ := p["id"].(string)
	got := getProjectMap(t, headers, pid)
	if _, present := got["language"]; present {
		t.Fatalf("read-back payload must not carry a language field: %v", got)
	}
	if got["automation"] != "auto" {
		t.Fatalf("read-back mismatch: %v", got)
	}

	// explicit automation manual
	p3 := createProjectRaw(t, headers, M{"name": "Manual", "automation": "manual"})
	if p3["automation"] != "manual" {
		t.Fatalf("automation manual lost: %v", p3["automation"])
	}

	// invalid values rejected
	if w := do(t, "POST", "/v1/projects", M{"name": "x", "automation": "bogus"}, headers); w.Code != 422 {
		t.Fatalf("invalid automation must 422, got %d", w.Code)
	}

	// update endpoint still overrides automation, and never grows a language back
	w := do(t, "PATCH", "/v1/projects/"+pid, M{"automation": "manual"}, headers)
	if w.Code != 200 {
		t.Fatalf("project update failed: %d %.300s", w.Code, w.Body.String())
	}
	upd := jsonMap(t, w)
	if upd["automation"] != "manual" {
		t.Fatalf("override not applied: %v", upd)
	}
	if _, present := upd["language"]; present {
		t.Fatalf("update payload must not carry a language field: %v", upd)
	}
	if w := do(t, "PATCH", "/v1/projects/"+pid, M{"automation": "sometimes"}, headers); w.Code != 422 {
		t.Fatalf("invalid automation on update must 422, got %d", w.Code)
	}
}

// --- contract 4: the auto chain --------------------------------------------

func TestAutopilotUploadToDraftCases(t *testing.T) {
	headers := registerOrg(t, "Autopilot Works")
	p := createProjectRaw(t, headers, M{"name": "Autopilot Project"}) // automation "auto"
	pid, _ := p["id"].(string)

	// spec import with zero confirmed requirements must NOT trigger generation
	importSpec(t, headers, pid)
	if cases := listState(t, headers, pid, "test-cases", ""); len(cases) != 0 {
		t.Fatalf("generation ran with no confirmed requirements: %d cases", len(cases))
	}

	// upload the requirements doc; the parse job runs the whole chain
	uploadAndParse(t, headers, pid, "requirements_en.md")

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
	for _, want := range []string{"auto.requirements.confirm_all", "auto.generate"} {
		if !actions[want] {
			t.Fatalf("missing audit action %q in %v", want, actions)
		}
	}
	if actions["auto.language.detect"] {
		t.Fatalf("language detection was removed but still audits: %v", actions)
	}
}

func TestManualModeStopsAtExtraction(t *testing.T) {
	headers := registerOrg(t, "Manual Org")
	p := createProjectRaw(t, headers, M{"name": "Manual Project", "automation": "manual"})
	pid, _ := p["id"].(string)

	importSpec(t, headers, pid)
	uploadAndParse(t, headers, pid, "requirements_en.md")

	// the chain stops: nothing confirmed, nothing generated
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

	// the manual endpoints still work unchanged on top
	w := do(t, "POST", "/v1/projects/"+pid+"/requirements/confirm_all", nil, headers)
	if w.Code != 200 {
		t.Fatalf("manual confirm_all failed: %d %.300s", w.Code, w.Body.String())
	}
	if confirmed := listState(t, headers, pid, "requirements", "confirmed"); len(confirmed) < 2 {
		t.Fatalf("manual confirm_all confirmed nothing")
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
