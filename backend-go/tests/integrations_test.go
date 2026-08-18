// Quality gate — integrations module (port of backend/tests/test_integrations.py
// intent): API keys + X-API-Key auth, CI gate thresholds, webhooks (CRUD, HMAC
// signature, Slack special case, FireWebhooks), schedules + scheduler tick,
// Xray/defects exports, organisation export and the feature reference catalog.
package tests_test

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/modules/integrations"
)

func makeAPIKey(t *testing.T, headers map[string]string, name string) M {
	t.Helper()
	w := do(t, "POST", "/v1/api-keys", M{"name": name}, headers)
	if w.Code != 201 {
		t.Fatalf("api key create failed: %d %.300s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

// ------------------------------------------------------------------ API keys + gate

func TestAPIKeyLifecycleAndGateAuth(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Org Keys", "admin")
	pid := seedProject(t, orgID, "Test Project")

	created := makeAPIKey(t, headers, "ci-key")
	key, _ := created["key"].(string)
	if !strings.HasPrefix(key, "trc_") || len(key) != 44 { // trc_ + 40 hex
		t.Fatalf("bad key format: %q", key)
	}
	if created["prefix"] != key[:8] {
		t.Fatalf("prefix mismatch: %v vs %s", created["prefix"], key[:8])
	}

	// list never exposes the full key
	w := do(t, "GET", "/v1/api-keys", nil, headers)
	listed := itemsOf(jsonAny(t, w))
	if len(listed) != 1 {
		t.Fatalf("expected 1 key, got %d", len(listed))
	}
	first := listed[0].(M)
	if _, hasKey := first["key"]; hasKey {
		t.Fatal("list exposed the full key")
	}
	if first["prefix"] != key[:8] || first["revoked"] != false {
		t.Fatalf("bad listed key: %v", first)
	}

	// gate works with X-API-Key AND with Bearer; empty project fails coverage
	for _, auth := range []map[string]string{{"X-API-Key": key}, headers} {
		w = do(t, "GET", "/v1/projects/"+pid+"/gate", nil, auth)
		if w.Code != 200 {
			t.Fatalf("gate failed: %d %.300s", w.Code, w.Body.String())
		}
		gate := jsonMap(t, w)
		if gate["pass"] != false {
			t.Fatalf("empty project must fail the gate: %v", gate)
		}
		found := false
		for _, b := range gate["breaches"].([]any) {
			if b.(M)["check"] == "min_coverage" {
				found = true
			}
		}
		if !found {
			t.Fatalf("expected min_coverage breach: %v", gate["breaches"])
		}
	}

	// last_used_at recorded after use
	w = do(t, "GET", "/v1/api-keys", nil, headers)
	if itemsOf(jsonAny(t, w))[0].(M)["last_used_at"] == nil {
		t.Fatal("last_used_at not recorded")
	}

	// ?exit=1 -> 412 for `curl -f` pipelines
	w = do(t, "GET", "/v1/projects/"+pid+"/gate?exit=1", nil, map[string]string{"X-API-Key": key})
	if w.Code != 412 {
		t.Fatalf("exit=1 must 412, got %d", w.Code)
	}
	if jsonMap(t, w)["detail"].(M)["code"] != "gate_failed" {
		t.Fatalf("bad 412 body: %.300s", w.Body.String())
	}

	// unknown key and revoked key -> 401
	w = do(t, "GET", "/v1/projects/"+pid+"/gate", nil,
		map[string]string{"X-API-Key": "trc_" + strings.Repeat("0", 40)})
	if w.Code != 401 {
		t.Fatalf("unknown key must 401, got %d", w.Code)
	}
	w = do(t, "POST", "/v1/api-keys/"+created["id"].(string)+"/revoke", nil, headers)
	if w.Code != 200 || jsonMap(t, w)["revoked"] != true {
		t.Fatalf("revoke failed: %d %.300s", w.Code, w.Body.String())
	}
	w = do(t, "GET", "/v1/projects/"+pid+"/gate", nil, map[string]string{"X-API-Key": key})
	if w.Code != 401 {
		t.Fatalf("revoked key must 401, got %d", w.Code)
	}
	if jsonMap(t, w)["detail"].(M)["code"] != "invalid_api_key" {
		t.Fatalf("bad revoked-key error: %.300s", w.Body.String())
	}
}

func TestAPIKeyIsOrgScoped(t *testing.T) {
	headersA, _, _ := seedOrgUser(t, "Org A", "admin")
	_, orgB, _ := seedOrgUser(t, "Org B", "admin")
	pidB := seedProject(t, orgB, "Org B Project")
	keyA, _ := makeAPIKey(t, headersA, "ci-key")["key"].(string)

	// org A's key cannot see org B's project
	for _, path := range []string{
		"/v1/projects/" + pidB + "/gate",
		"/v1/public/traceability/" + pidB,
	} {
		w := do(t, "GET", path, nil, map[string]string{"X-API-Key": keyA})
		if w.Code != 404 {
			t.Fatalf("cross-org %s must 404, got %d", path, w.Code)
		}
	}
}

func TestGateThresholdsAndDefects(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Org Gate", "admin")
	pid := seedProject(t, orgID, "Gate Project")
	rid := seedRequirement(t, orgID, pid, "REQ-001", "confirmed", "high")
	caseID := seedTestCase(t, orgID, pid, "Approved case", "approved", rid)

	// fully covered, no runs -> gate passes
	gate := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/gate", nil, headers))
	if gate["pass"] != true || len(gate["breaches"].([]any)) != 0 {
		t.Fatalf("covered project must pass: %v", gate)
	}
	if gate["coverage_pct"] != 100.0 {
		t.Fatalf("coverage must be 100: %v", gate["coverage_pct"])
	}
	od := gate["open_defects"].(M)
	if od["total"] != 0.0 || od["critical"] != 0.0 {
		t.Fatalf("open defects must be zero: %v", od)
	}
	if gate["latest_run"] != nil {
		t.Fatalf("latest_run must be null: %v", gate["latest_run"])
	}

	// add an uncovered confirmed requirement -> coverage 50 -> min_coverage breach
	seedRequirement(t, orgID, pid, "REQ-XXX", "confirmed", "medium")
	gate = jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/gate", nil, headers))
	if gate["pass"] != false || gate["coverage_pct"] != 50.0 {
		t.Fatalf("expected 50%% failing gate: %v", gate)
	}
	var breach M
	for _, b := range gate["breaches"].([]any) {
		if b.(M)["check"] == "min_coverage" {
			breach = b.(M)
		}
	}
	if breach == nil || breach["limit"] != 80.0 || breach["actual"] != 50.0 {
		t.Fatalf("bad min_coverage breach: %v", breach)
	}

	// lenient threshold passes; ?exit=1 on the failing default -> 412
	gate = jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/gate?min_coverage=40", nil, headers))
	if gate["pass"] != true {
		t.Fatalf("min_coverage=40 must pass: %v", gate)
	}
	if w := do(t, "GET", "/v1/projects/"+pid+"/gate?exit=1", nil, headers); w.Code != 412 {
		t.Fatalf("exit=1 must 412, got %d", w.Code)
	}

	// completed run with failures -> open defects, max_failed/max_critical breaches
	envID := seedEnvironment(t, orgID, pid)
	caseID2 := seedTestCase(t, orgID, pid, "Second case", "approved", rid)
	runID := seedRun(t, orgID, pid, envID, "completed",
		models.JSONMap{"total": 2, "passed": 0, "failed": 1, "errored": 1})
	// business-rule failure on a high-priority requirement -> critical
	seedResult(t, runID, caseID, "failed", models.JSONMap{
		"assertion": M{"type": "json_field", "path": "id", "op": "exists"},
		"expected":  true, "actual": nil})
	seedResult(t, runID, caseID2, "errored", models.JSONMap{"error": "connection refused"})

	gate = jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/gate?min_coverage=40&max_failed=0", nil, headers))
	if gate["pass"] != false {
		t.Fatalf("failing run must breach: %v", gate)
	}
	if gate["latest_run"].(M)["id"] != runID {
		t.Fatalf("latest_run mismatch: %v", gate["latest_run"])
	}
	od = gate["open_defects"].(M)
	if od["total"] != 2.0 || od["critical"] != 1.0 {
		t.Fatalf("bad open_defects: %v", od)
	}
	checks := map[string]M{}
	for _, b := range gate["breaches"].([]any) {
		checks[b.(M)["check"].(string)] = b.(M)
	}
	mf, ok := checks["max_failed"]
	if !ok || mf["actual"] != 2.0 {
		t.Fatalf("bad max_failed breach: %v", checks)
	}
	mc, ok := checks["max_critical"]
	if !ok || mc["actual"] != 1.0 {
		t.Fatalf("bad max_critical breach: %v", checks)
	}
	for _, b := range []M{mf, mc} {
		ids, _ := b["requirement_external_ids"].([]any)
		found := false
		for _, id := range ids {
			if id == "REQ-001" {
				found = true
			}
		}
		if !found {
			t.Fatalf("breach must name REQ-001: %v", b)
		}
	}
}

// ------------------------------------------------------------------ public surface

func TestPublicAPIKeySurface(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Org Public", "admin")
	pid := seedProject(t, orgID, "Public Project")
	rid := seedRequirement(t, orgID, pid, "REQ-001", "confirmed", "high")
	seedTestCase(t, orgID, pid, "Approved case", "approved", rid)
	envID := seedEnvironment(t, orgID, pid)
	key, _ := makeAPIKey(t, headers, "public-key")["key"].(string)
	keyHeaders := map[string]string{"X-API-Key": key}

	// traceability readable via API key — same shape as the module route
	w := do(t, "GET", "/v1/public/traceability/"+pid, nil, keyHeaders)
	if w.Code != 200 {
		t.Fatalf("public traceability failed: %d %.300s", w.Code, w.Body.String())
	}
	trace := jsonMap(t, w)
	rows, _ := trace["rows"].([]any)
	if len(rows) == 0 {
		t.Fatalf("traceability rows empty: %v", trace)
	}
	if trace["coverage_pct"] != 100.0 {
		t.Fatalf("coverage must be 100: %v", trace["coverage_pct"])
	}
	if rows[0].(M)["status"] != "covered_not_run" {
		t.Fatalf("expected covered_not_run: %v", rows[0])
	}

	// run launch via API key (public CI surface) -> 202 {job_id, run_id}
	w = do(t, "POST", "/v1/public/projects/"+pid+"/runs", M{"environment_id": envID}, keyHeaders)
	if w.Code != 202 {
		t.Fatalf("public run launch failed: %d %.300s", w.Code, w.Body.String())
	}
	launched := jsonMap(t, w)
	runID, _ := launched["run_id"].(string)
	if runID == "" || launched["job_id"] == "" {
		t.Fatalf("bad launch response: %v", launched)
	}

	// run readable via API key (execution engine not wired yet -> still queued is OK)
	w = do(t, "GET", "/v1/public/runs/"+runID, nil, keyHeaders)
	if w.Code != 200 {
		t.Fatalf("public run read failed: %d %.300s", w.Code, w.Body.String())
	}
	run := jsonMap(t, w)
	if run["id"] != runID || run["display_id"] != 1001.0 {
		t.Fatalf("bad run payload: %v", run)
	}

	// bad body -> 422; missing env -> 404; no auth at all -> 401
	if w = do(t, "POST", "/v1/public/projects/"+pid+"/runs", M{}, keyHeaders); w.Code != 422 {
		t.Fatalf("missing environment_id must 422, got %d", w.Code)
	}
	if w = do(t, "GET", "/v1/public/runs/"+runID, nil, nil); w.Code != 401 {
		t.Fatalf("unauthenticated must 401, got %d", w.Code)
	}

	// project with no approved cases -> 409
	pid2 := seedProject(t, orgID, "No Cases")
	env2 := seedEnvironment(t, orgID, pid2)
	if w = do(t, "POST", "/v1/public/projects/"+pid2+"/runs", M{"environment_id": env2}, keyHeaders); w.Code != 409 {
		t.Fatalf("no approved cases must 409, got %d", w.Code)
	}
}

// ------------------------------------------------------------------ webhooks

type capturedCall struct {
	Body    []byte
	Headers http.Header
}

type hostRewriteTransport struct{ target *url.URL }

func (rt hostRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req.URL.Scheme = rt.target.Scheme
	req.URL.Host = rt.target.Host
	return http.DefaultTransport.RoundTrip(req)
}

// webhookNet stubs the SSRF guard and points every delivery at a capture server
// (parity with the Python monkeypatch fixture).
func webhookNet(t *testing.T) *[]capturedCall {
	t.Helper()
	var mu sync.Mutex
	calls := &[]capturedCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		*calls = append(*calls, capturedCall{Body: body, Headers: r.Header.Clone()})
		mu.Unlock()
		w.WriteHeader(200)
	}))
	target, _ := url.Parse(srv.URL)
	prevGuard := integrations.AssertPublicHost
	prevTransport := integrations.WebhookHTTPClient.Transport
	integrations.AssertPublicHost = func(string) *integrations.GuardError { return nil }
	integrations.WebhookHTTPClient.Transport = hostRewriteTransport{target: target}
	t.Cleanup(func() {
		integrations.AssertPublicHost = prevGuard
		integrations.WebhookHTTPClient.Transport = prevTransport
		srv.Close()
	})
	return calls
}

func TestWebhookCRUDTestAndFire(t *testing.T) {
	calls := webhookNet(t)
	headers, orgID, _ := seedOrgUser(t, "Org Hooks", "admin")
	pid := seedProject(t, orgID, "Webhook Project")

	// invalid scheme rejected
	w := do(t, "POST", "/v1/projects/"+pid+"/webhooks",
		M{"name": "bad", "url": "ftp://example.com/x"}, headers)
	if w.Code != 422 {
		t.Fatalf("ftp scheme must 422, got %d", w.Code)
	}
	// unsupported event rejected
	w = do(t, "POST", "/v1/projects/"+pid+"/webhooks",
		M{"name": "bad", "url": "https://example.com/hook", "events": []string{"run.deleted"}}, headers)
	if w.Code != 422 {
		t.Fatalf("unsupported event must 422, got %d", w.Code)
	}

	w = do(t, "POST", "/v1/projects/"+pid+"/webhooks",
		M{"name": "ci hook", "url": "https://example.com/hook", "secret": "s3cret"}, headers)
	if w.Code != 201 {
		t.Fatalf("webhook create failed: %d %.300s", w.Code, w.Body.String())
	}
	hook := jsonMap(t, w)
	if hook["secret_set"] != true {
		t.Fatalf("secret_set must be true: %v", hook)
	}
	events, _ := hook["events"].([]any)
	if len(events) != 1 || events[0] != "run.completed" {
		t.Fatalf("default events wrong: %v", hook["events"])
	}
	hookID := hook["id"].(string)

	w = do(t, "GET", "/v1/projects/"+pid+"/webhooks", nil, headers)
	hooks := itemsOf(jsonAny(t, w))
	if len(hooks) != 1 {
		t.Fatalf("expected 1 webhook, got %d", len(hooks))
	}
	if _, leak := hooks[0].(M)["secret"]; leak {
		t.Fatal("webhook list leaked the secret")
	}

	w = do(t, "PATCH", "/v1/webhooks/"+hookID, M{"name": "renamed"}, headers)
	if w.Code != 200 || jsonMap(t, w)["name"] != "renamed" {
		t.Fatalf("patch failed: %d %.300s", w.Code, w.Body.String())
	}

	// test-fire: delivered, signed with HMAC-SHA256 over the exact body
	w = do(t, "POST", "/v1/webhooks/"+hookID+"/test", nil, headers)
	if w.Code != 200 {
		t.Fatalf("test-fire failed: %d %.300s", w.Code, w.Body.String())
	}
	res := jsonMap(t, w)
	if res["webhook_id"] != hookID || res["delivered"] != true || res["status"] != 200.0 {
		t.Fatalf("bad test-fire response: %v", res)
	}
	if len(*calls) != 1 {
		t.Fatalf("expected 1 delivery, got %d", len(*calls))
	}
	call := (*calls)[0]
	mac := hmac.New(sha256.New, []byte("s3cret"))
	mac.Write(call.Body)
	expectedSig := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if call.Headers.Get("X-Traceo-Signature") != expectedSig {
		t.Fatalf("HMAC mismatch: %s vs %s", call.Headers.Get("X-Traceo-Signature"), expectedSig)
	}
	if call.Headers.Get("X-Traceo-Event") != "run.completed" {
		t.Fatalf("bad event header: %s", call.Headers.Get("X-Traceo-Event"))
	}
	var payload M
	if err := json.Unmarshal(call.Body, &payload); err != nil {
		t.Fatalf("payload not JSON: %v", err)
	}
	if payload["event"] != "run.completed" || payload["project"].(M)["id"] != pid {
		t.Fatalf("bad payload: %v", payload)
	}
	w = do(t, "GET", "/v1/projects/"+pid+"/webhooks", nil, headers)
	first := itemsOf(jsonAny(t, w))[0].(M)
	if first["last_status"] != 200.0 || first["last_fired_at"] == nil {
		t.Fatalf("delivery status not recorded: %v", first)
	}

	// Slack special case: {"text": <summary>} payload instead
	w = do(t, "POST", "/v1/projects/"+pid+"/webhooks",
		M{"name": "slack", "url": "https://hooks.slack.com/services/T0/B0/XYZ"}, headers)
	if w.Code != 201 {
		t.Fatalf("slack webhook create failed: %d %.300s", w.Code, w.Body.String())
	}
	slackID := jsonMap(t, w)["id"].(string)
	do(t, "POST", "/v1/webhooks/"+slackID+"/test", nil, headers)
	var slackBody M
	if err := json.Unmarshal((*calls)[len(*calls)-1].Body, &slackBody); err != nil {
		t.Fatalf("slack payload not JSON: %v", err)
	}
	if len(slackBody) != 1 || slackBody["text"] == nil {
		t.Fatalf("slack payload must be exactly {text}: %v", slackBody)
	}
	if !strings.Contains(slackBody["text"].(string), "Run #") {
		t.Fatalf("slack summary is not the run summary: %v", slackBody["text"])
	}

	// FireWebhooks delivers to every enabled subscribed hook and never panics
	before := len(*calls)
	integrations.FireWebhooks(pid, "run.completed", M{
		"event": "run.completed", "project": M{"id": pid, "name": "p"},
		"run": M{"id": "r1", "display_id": 1001, "state": "completed",
			"counts": M{"total": 2, "passed": 1, "failed": 1, "errored": 0}},
		"timestamp": "2026-01-01T00:00:00+00:00"})
	if len(*calls) != before+2 { // json hook + slack hook
		t.Fatalf("FireWebhooks: expected %d calls, got %d", before+2, len(*calls))
	}
	integrations.FireWebhooks(pid, "run.started", M{"event": "run.started"})
	if len(*calls) != before+2 {
		t.Fatal("unsubscribed event must fire nothing")
	}

	w = do(t, "DELETE", "/v1/webhooks/"+hookID, nil, headers)
	if w.Code != 200 {
		t.Fatalf("delete failed: %d", w.Code)
	}
	w = do(t, "GET", "/v1/projects/"+pid+"/webhooks", nil, headers)
	if len(itemsOf(jsonAny(t, w))) != 1 {
		t.Fatal("expected 1 webhook after delete")
	}
}

// ------------------------------------------------------------------ schedules

func TestScheduleCRUDAndSchedulerTick(t *testing.T) {
	headers, orgID, userID := seedOrgUser(t, "Org Sched", "admin")
	pid := seedProject(t, orgID, "Schedule Project")
	rid := seedRequirement(t, orgID, pid, "REQ-001", "confirmed", "high")
	seedTestCase(t, orgID, pid, "Approved case", "approved", rid)
	envID := seedEnvironment(t, orgID, pid)

	// interval below 15 minutes rejected
	w := do(t, "POST", "/v1/projects/"+pid+"/schedules",
		M{"name": "too fast", "environment_id": envID, "interval_minutes": 10}, headers)
	if w.Code != 422 {
		t.Fatalf("interval 10 must 422, got %d", w.Code)
	}

	w = do(t, "POST", "/v1/projects/"+pid+"/schedules",
		M{"name": "nightly", "environment_id": envID, "interval_minutes": 60}, headers)
	if w.Code != 201 {
		t.Fatalf("schedule create failed: %d %.300s", w.Code, w.Body.String())
	}
	sched := jsonMap(t, w)
	if sched["enabled"] != true || sched["next_run_at"] == nil {
		t.Fatalf("bad schedule: %v", sched)
	}
	schedID := sched["id"].(string)

	w = do(t, "PATCH", "/v1/schedules/"+schedID, M{"interval_minutes": 30}, headers)
	if w.Code != 200 || jsonMap(t, w)["interval_minutes"] != 30.0 {
		t.Fatalf("patch failed: %d %.300s", w.Code, w.Body.String())
	}

	// force the schedule due, then run one scheduler tick
	due := time.Now().UTC().Add(-time.Minute)
	if err := db.DB.Model(&models.Schedule{}).Where("id = ?", schedID).
		Update("next_run_at", due).Error; err != nil {
		t.Fatalf("force due: %v", err)
	}
	if n := integrations.SchedulerTick(); n != 1 {
		t.Fatalf("expected 1 launch, got %d", n)
	}
	var runs []models.Run
	db.DB.Where("project_id = ?", pid).Find(&runs)
	if len(runs) != 1 {
		t.Fatalf("scheduler did not launch a run: %d", len(runs))
	}
	if runs[0].InitiatedBy != userID { // schedule creator
		t.Fatalf("initiated_by mismatch: %s vs %s", runs[0].InitiatedBy, userID)
	}

	// schedule advanced: last_run_at set, next_run_at back in the future
	updated := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/schedules", nil, headers)))[0].(M)
	if updated["last_run_at"] == nil {
		t.Fatal("last_run_at not set")
	}
	if updated["next_run_at"].(string) <= updated["last_run_at"].(string) {
		t.Fatalf("next_run_at must be after last_run_at: %v", updated)
	}

	// audit trail recorded the scheduled launch
	var auditCount int64
	db.DB.Model(&models.AuditEntry{}).
		Where("organisation_id = ? AND action = ?", orgID, "run.scheduled").Count(&auditCount)
	if auditCount == 0 {
		t.Fatal("run.scheduled audit entry missing")
	}

	// a second immediate tick does nothing (next_run_at is in the future)
	if n := integrations.SchedulerTick(); n != 0 {
		t.Fatalf("second tick must launch 0, got %d", n)
	}

	w = do(t, "DELETE", "/v1/schedules/"+schedID, nil, headers)
	if w.Code != 200 {
		t.Fatalf("delete failed: %d", w.Code)
	}
	if left := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/schedules", nil, headers))); len(left) != 0 {
		t.Fatalf("expected empty schedule list, got %v", left)
	}
}

// ------------------------------------------------------------------ exports (FR-070)

func TestXrayAndDefectsExports(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Org Export", "admin")
	pid := seedProject(t, orgID, "Export Project")
	rid := seedRequirement(t, orgID, pid, "REQ-001", "confirmed", "high")
	passedCase := seedTestCase(t, orgID, pid, "Passing case", "approved", rid)
	erroredCase := seedTestCase(t, orgID, pid, "Errored case", "approved", rid)
	envID := seedEnvironment(t, orgID, pid)
	runID := seedRun(t, orgID, pid, envID, "completed",
		models.JSONMap{"total": 2, "passed": 1, "failed": 0, "errored": 1})
	seedResult(t, runID, passedCase, "passed", nil)
	seedResult(t, runID, erroredCase, "errored", models.JSONMap{"error": "connection refused"})

	// Xray import JSON
	w := do(t, "GET", "/v1/runs/"+runID+"/exports/xray.json", nil, headers)
	if w.Code != 200 {
		t.Fatalf("xray export failed: %d %.300s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("missing attachment disposition: %s", w.Header().Get("Content-Disposition"))
	}
	doc := jsonMap(t, w)
	if !strings.HasPrefix(doc["info"].(M)["summary"].(string), "Traceo run #") {
		t.Fatalf("bad summary: %v", doc["info"])
	}
	tests, _ := doc["tests"].([]any)
	if len(tests) != 2 {
		t.Fatalf("xray export must list both results: %v", tests)
	}
	sawKey := false
	for _, entry := range tests {
		e := entry.(M)
		if e["status"] != "PASSED" && e["status"] != "FAILED" {
			t.Fatalf("bad status: %v", e["status"])
		}
		ti := e["testInfo"].(M)
		if ti["type"] != "Generic" || ti["summary"] == "" {
			t.Fatalf("bad testInfo: %v", ti)
		}
		if e["testKey"] == "REQ-001" {
			sawKey = true
		}
	}
	if !sawKey {
		t.Fatal("no test carries testKey REQ-001")
	}

	// Jira defects CSV: failures only, UTF-8 BOM so Excel reads non-ASCII
	w = do(t, "GET", "/v1/runs/"+runID+"/exports/defects.csv", nil, headers)
	if w.Code != 200 {
		t.Fatalf("defects export failed: %d", w.Code)
	}
	raw := w.Body.Bytes()
	if !bytes.HasPrefix(raw, []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatal("missing UTF-8 BOM")
	}
	text := string(raw[3:])
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if lines[0] != "Summary,Description,Priority,Labels" {
		t.Fatalf("bad CSV header: %q", lines[0])
	}
	if !strings.Contains(text, "REQ-001") || !strings.Contains(text, "[ERRORED]") {
		t.Fatalf("CSV missing failure row: %.300s", text)
	}
	if strings.Contains(text, "Passing case") {
		t.Fatal("CSV must contain failures only")
	}
}

// ------------------------------------------------------------------ org export + reference

func TestOrganisationExport(t *testing.T) {
	headers, orgID, _ := seedOrgUser(t, "Org PDPL", "admin")
	pid := seedProject(t, orgID, "Full Export Project")
	seedRequirement(t, orgID, pid, "REQ-001", "confirmed", "high")
	makeAPIKey(t, headers, "audit-seed") // guarantees at least one audit entry

	w := do(t, "GET", "/v1/export/organisation", nil, headers)
	if w.Code != 200 {
		t.Fatalf("org export failed: %d %.300s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Content-Disposition"), `filename="traceo_export.json"`) {
		t.Fatalf("bad disposition: %s", w.Header().Get("Content-Disposition"))
	}
	doc := jsonMap(t, w)
	if doc["organisation"].(M)["name"] == "" {
		t.Fatalf("missing organisation: %v", doc["organisation"])
	}
	projects, _ := doc["projects"].([]any)
	if len(projects) != 1 || projects[0].(M)["id"] != pid {
		t.Fatalf("bad projects: %v", projects)
	}
	reqs, _ := doc["requirements"].([]any)
	if len(reqs) == 0 || reqs[0].(M)["external_id"] != "REQ-001" {
		t.Fatalf("bad requirements: %v", reqs)
	}
	if doc["audit_entry_count"].(float64) <= 0 {
		t.Fatalf("audit_entry_count must be > 0: %v", doc["audit_entry_count"])
	}
	if strings.Contains(w.Body.String(), `"evidence"`) { // PDPL: evidence excluded
		t.Fatal("export leaked evidence")
	}

	// non-admin roles are rejected
	viewerHeaders, _, _ := seedOrgUser(t, "Org PDPL Viewer", "viewer")
	if w = do(t, "GET", "/v1/export/organisation", nil, viewerHeaders); w.Code != 403 {
		t.Fatalf("viewer must 403, got %d", w.Code)
	}
}

func TestReferenceCatalog(t *testing.T) {
	headers, _, _ := seedOrgUser(t, "Org Ref", "admin")
	w := do(t, "GET", "/v1/reference/features", nil, headers)
	if w.Code != 200 {
		t.Fatalf("reference failed: %d %.300s", w.Code, w.Body.String())
	}
	data := jsonMap(t, w)
	features, _ := data["features"].([]any)
	groups, _ := data["groups"].([]any)
	if len(features) != 37 || len(groups) != 8 {
		t.Fatalf("expected 37 features / 8 groups, got %d / %d", len(features), len(groups))
	}
	groupKeys := map[string]bool{}
	for _, g := range groups {
		groupKeys[g.(M)["key"].(string)] = true
	}
	ids := map[string]M{}
	for _, f := range features {
		ft := f.(M)
		id := ft["id"].(string)
		ids[id] = ft
		if !strings.HasPrefix(id, "FR-") || !groupKeys[ft["group"].(string)] {
			t.Fatalf("bad feature: %v", ft)
		}
		if p := ft["priority"]; p != "P0" && p != "P1" && p != "P2" {
			t.Fatalf("bad priority: %v", ft)
		}
		if s := ft["status"]; s != "built" && s != "planned" {
			t.Fatalf("bad status: %v", ft)
		}
		if ft["name_ar"] == "" || ft["name_en"] == "" || ft["description_ar"] == "" {
			t.Fatalf("empty names: %v", ft)
		}
	}
	if len(ids) != 37 {
		t.Fatalf("feature ids must be unique: %d", len(ids))
	}
	for id, want := range map[string]string{"FR-061": "built", "FR-060": "built",
		"FR-070": "built", "FR-011": "planned", "FR-021": "planned"} {
		if ids[id]["status"] != want {
			t.Fatalf("%s must be %s: %v", id, want, ids[id]["status"])
		}
	}
	counts := data["counts"].(M)
	if counts["built"].(float64)+counts["planned"].(float64) != 37 {
		t.Fatalf("counts must sum to 37: %v", counts)
	}
	// unauthenticated -> 401
	if w = do(t, "GET", "/v1/reference/features", nil, nil); w.Code != 401 {
		t.Fatalf("unauthenticated must 401, got %d", w.Code)
	}
}
