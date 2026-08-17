package tests_test

// Web targets — point Traceo at a URL and pick what to test. Parity gate for
// backend/tests/test_webtarget.py: the same claims, the same recorded sidecar
// document, so a client cannot tell the two backends apart.
//
// Nothing here starts a browser: a unit test that shells out to Chromium is a
// network test wearing a costume. The sidecar seam (webtarget.SidecarRunner) is
// replaced with the recorded payload instead.

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/modules/webtarget"
)

const webTargetURL = "http://localhost:8019/web/index.php/auth/login"

// recordedPayload is the sidecar document captured from the real SPA target,
// with the screenshot pointed at the committed fixture raster.
func recordedPayload(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("fixtures", "webtarget_orangehrm.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	abs, err := filepath.Abs(filepath.Join("fixtures", "webtarget_screen.png"))
	if err != nil {
		t.Fatalf("fixture path: %v", err)
	}
	doc["screenshot"] = abs
	return doc
}

// withSidecar replaces the browser invocation with the recorded document and
// allows a loopback target (the SSRF guard has its own test).
func withSidecar(t *testing.T, doc map[string]any) {
	t.Helper()
	previousRunner := webtarget.SidecarRunner
	previousPrivate := config.C.AllowPrivateTargets
	webtarget.SidecarRunner = func(url, viewport, outDir string, timeoutS float64,
		plan *webtarget.CrawlPlan) (map[string]any, error) {
		return doc, nil
	}
	config.C.AllowPrivateTargets = true
	t.Cleanup(func() {
		webtarget.SidecarRunner = previousRunner
		config.C.AllowPrivateTargets = previousPrivate
	})
}

func allowPrivate(t *testing.T) {
	t.Helper()
	previous := config.C.AllowPrivateTargets
	config.C.AllowPrivateTargets = true
	t.Cleanup(func() { config.C.AllowPrivateTargets = previous })
}

func webTargetProject(t *testing.T) (map[string]string, string) {
	t.Helper()
	headers := registerOrg(t, "Web Target Org")
	return headers, createProject(t, headers, "Web Target Project")
}

func startTarget(t *testing.T, headers map[string]string, projectID string,
	types []string, target string) *httptest.ResponseRecorder {
	t.Helper()
	if target == "" {
		target = webTargetURL
	}
	return do(t, "POST", "/v1/projects/"+projectID+"/web-targets",
		M{"url": target, "test_types": types}, headers)
}

// pollTerminal polls until the job reaches a terminal state — failure included.
func pollTerminal(t *testing.T, headers map[string]string, jobID string) M {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		w := do(t, "GET", "/v1/jobs/"+jobID, nil, headers)
		if w.Code != 200 {
			t.Fatalf("job poll failed: %d %.300s", w.Code, w.Body.String())
		}
		job := jsonMap(t, w)
		if job["status"] == "completed" || job["status"] == "failed" {
			return job
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("job %s never finished", jobID)
	return nil
}

func runTarget(t *testing.T, headers map[string]string, projectID string, types []string) (M, M) {
	t.Helper()
	w := startTarget(t, headers, projectID, types, "")
	if w.Code != 202 {
		t.Fatalf("start failed: %d %.300s", w.Code, w.Body.String())
	}
	accepted := jsonMap(t, w)
	job := pollTerminal(t, headers, accepted["job_id"].(string))
	if job["status"] != "completed" {
		t.Fatalf("job failed: %v", job["error"])
	}
	return job, accepted
}

func allTypes() []string { return append([]string{}, webtarget.TestTypes...) }

// ---------------------------------------------------------------------------
// 1. Request validation
// ---------------------------------------------------------------------------

func TestWebTargetUnknownTestTypeIsRefusedWithTheLegalList(t *testing.T) {
	allowPrivate(t)
	headers, pid := webTargetProject(t)
	w := startTarget(t, headers, pid, []string{"functional", "perfomance"}, "")
	if w.Code != 422 {
		t.Fatalf("expected 422, got %d %.300s", w.Code, w.Body.String())
	}
	detail := jsonMap(t, w)["detail"].(map[string]any)
	if detail["code"] != "invalid_test_type" {
		t.Fatalf("code = %v", detail["code"])
	}
	legal := detail["errors"].([]any)
	if len(legal) != len(webtarget.TestTypes) {
		t.Fatalf("errors must list every legal type, got %v", legal)
	}
	for i, want := range webtarget.TestTypes {
		if legal[i] != want {
			t.Fatalf("errors[%d] = %v, want %s", i, legal[i], want)
		}
	}
	if !strings.Contains(fmt.Sprint(detail["message"]), "perfomance") {
		t.Fatalf("message must name the offending value: %v", detail["message"])
	}
	// nothing was created for a request that was refused
	listed := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, headers))
	if len(listed["web_targets"].([]any)) != 0 {
		t.Fatalf("a refused request created a target")
	}
}

func TestWebTargetNoTestTypeIsRefused(t *testing.T) {
	allowPrivate(t)
	headers, pid := webTargetProject(t)
	w := startTarget(t, headers, pid, []string{}, "")
	if w.Code != 422 {
		t.Fatalf("expected 422, got %d", w.Code)
	}
	if jsonMap(t, w)["detail"].(map[string]any)["code"] != "invalid_test_type" {
		t.Fatalf("wrong code: %.200s", w.Body.String())
	}
}

func TestWebTargetTestTypesAreDeduplicatedIntoCanonicalOrder(t *testing.T) {
	got, code, _ := webtarget.ValidateTestTypes([]string{"ui", "api", "ui"})
	if code != "" || strings.Join(got, ",") != "api,ui" {
		t.Fatalf("got %v (code %q)", got, code)
	}
	got, code, _ = webtarget.ValidateTestTypes([]string{"SECURITY", " functional "})
	if code != "" || strings.Join(got, ",") != "functional,security" {
		t.Fatalf("got %v (code %q)", got, code)
	}
}

func TestWebTargetRejectsNonHTTPSchemesAndPrivateHosts(t *testing.T) {
	headers, pid := webTargetProject(t)
	w := startTarget(t, headers, pid, []string{"ui"}, "file:///etc/passwd")
	if w.Code != 422 || jsonMap(t, w)["detail"].(map[string]any)["code"] != "invalid_url" {
		t.Fatalf("scheme guard: %d %.200s", w.Code, w.Body.String())
	}
	// with the escape hatch OFF, a loopback target is refused by the same SSRF
	// rule the spec fetcher applies
	previous := config.C.AllowPrivateTargets
	config.C.AllowPrivateTargets = false
	defer func() { config.C.AllowPrivateTargets = previous }()
	w = startTarget(t, headers, pid, []string{"ui"}, "http://127.0.0.1:8019/login")
	if w.Code != 422 || jsonMap(t, w)["detail"].(map[string]any)["code"] != "ssrf_blocked" {
		t.Fatalf("ssrf guard: %d %.200s", w.Code, w.Body.String())
	}
}

func TestWebTargetRejectsAnImpossibleViewport(t *testing.T) {
	allowPrivate(t)
	headers, pid := webTargetProject(t)
	w := do(t, "POST", "/v1/projects/"+pid+"/web-targets",
		M{"url": webTargetURL, "test_types": []string{"ui"}, "viewport": "banana"}, headers)
	if w.Code != 422 || jsonMap(t, w)["detail"].(map[string]any)["code"] != "invalid_viewport" {
		t.Fatalf("viewport guard: %d %.200s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// 2. Capability guards and org scoping
// ---------------------------------------------------------------------------

func TestWebTargetViewerMayReadButNeverStart(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	_, accepted := runTarget(t, headers, pid, []string{"functional"})

	viewer, _, _ := seedOrgUserInOrg(t, headers, "viewer")
	w := do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, viewer)
	if w.Code != 200 {
		t.Fatalf("a viewer must be able to read targets: %d", w.Code)
	}
	if w = do(t, "GET", "/v1/web-targets/"+accepted["target_id"].(string), nil, viewer); w.Code != 200 {
		t.Fatalf("viewer detail read: %d", w.Code)
	}
	w = startTarget(t, viewer, pid, []string{"functional"}, "")
	if w.Code != 403 || jsonMap(t, w)["detail"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("a viewer must not start a discovery: %d %.200s", w.Code, w.Body.String())
	}
}

func TestWebTargetIsNeverVisibleToAnotherOrganisation(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	_, accepted := runTarget(t, headers, pid, []string{"functional"})

	other := registerOrg(t, "Other Org")
	if w := do(t, "GET", "/v1/web-targets/"+accepted["target_id"].(string), nil, other); w.Code != 404 {
		t.Fatalf("cross-org read: %d", w.Code)
	}
	if w := do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, other); w.Code != 404 {
		t.Fatalf("cross-org list: %d", w.Code)
	}
	if w := do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, nil); w.Code != 401 {
		t.Fatalf("unauthenticated list: %d", w.Code)
	}
}

// ---------------------------------------------------------------------------
// 3. The sidecar is missing — the failure that must never be silent
// ---------------------------------------------------------------------------

func TestWebTargetMissingSidecarFailsTheJobWithANamedCode(t *testing.T) {
	allowPrivate(t)
	previous := config.C.WebDiscoveryScript
	config.C.WebDiscoveryScript = "/nonexistent/discover.mjs"
	defer func() { config.C.WebDiscoveryScript = previous }()

	headers, pid := webTargetProject(t)
	w := startTarget(t, headers, pid, []string{"functional", "ui"}, "")
	if w.Code != 202 {
		t.Fatalf("start failed: %d %.300s", w.Code, w.Body.String())
	}
	accepted := jsonMap(t, w)
	job := pollTerminal(t, headers, accepted["job_id"].(string))
	if job["status"] != "failed" {
		t.Fatalf("a missing sidecar must FAIL the job, got %v", job["status"])
	}
	if job["error_code"] != "browser_discovery_unavailable" {
		t.Fatalf("error_code = %v", job["error_code"])
	}
	message := strings.ToLower(fmt.Sprint(job["error"]))
	if !strings.Contains(message, "playwright") || !strings.Contains(message, "node") {
		t.Fatalf("the message must say what to install: %v", job["error"])
	}
	detail := jsonMap(t, do(t, "GET", "/v1/web-targets/"+accepted["target_id"].(string), nil, headers))
	if detail["status"] != "failed" {
		t.Fatalf("target status = %v", detail["status"])
	}
	if !strings.Contains(fmt.Sprint(detail["error"]), "browser_discovery_unavailable") {
		t.Fatalf("target error = %v", detail["error"])
	}
}

func TestWebTargetMissingNodeBinaryFailsTheSameWay(t *testing.T) {
	allowPrivate(t)
	prevScript, prevNode := config.C.WebDiscoveryScript, config.C.NodeBin
	// a script that exists, and a node that does not — the other half of "unavailable"
	abs, _ := filepath.Abs(filepath.Join("fixtures", "webtarget_orangehrm.json"))
	config.C.WebDiscoveryScript = abs
	config.C.NodeBin = "/nonexistent/node-binary"
	defer func() {
		config.C.WebDiscoveryScript, config.C.NodeBin = prevScript, prevNode
	}()

	headers, pid := webTargetProject(t)
	w := startTarget(t, headers, pid, []string{"api"}, "")
	job := pollTerminal(t, headers, jsonMap(t, w)["job_id"].(string))
	if job["status"] != "failed" || job["error_code"] != "browser_discovery_unavailable" {
		t.Fatalf("job = %v / %v", job["status"], job["error_code"])
	}
}

// ---------------------------------------------------------------------------
// 4. The recorded payload — per-type persistence
// ---------------------------------------------------------------------------

func TestWebTargetRecordedPayloadDrivesEverySelectedTrack(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	job, accepted := runTarget(t, headers, pid, allTypes())
	result := job["result"].(map[string]any)

	if result["target_id"] != accepted["target_id"] {
		t.Fatalf("target_id mismatch")
	}
	if result["title"] != "OrangeHRM" {
		t.Fatalf("title = %v", result["title"])
	}
	// endpoints: 4 from the captured xhr/fetch traffic (ids templated) plus the 2
	// the page DECLARES in its own markup — the login form's POST action and the
	// search form's GET back to the page itself.
	for key, want := range map[string]float64{
		"forms": 2, "controls": 3, "requests": 8, "endpoints": 5,
	} {
		if result[key].(float64) != want {
			t.Fatalf("%s = %v, want %v", key, result[key], want)
		}
	}
	if result["requirements"].(float64) < 5 {
		t.Fatalf("requirements = %v", result["requirements"])
	}
	byType := result["cases_by_type"].(map[string]any)
	for _, kind := range []string{"functional", "ui", "performance", "security", "api"} {
		if byType[kind].(float64) <= 0 {
			t.Fatalf("no %s cases: %v", kind, byType)
		}
	}

	var target models.WebTarget
	if err := db.DB.First(&target, "id = ?", accepted["target_id"]).Error; err != nil {
		t.Fatalf("target row: %v", err)
	}
	if target.Status != "discovered" || target.Title != "OrangeHRM" ||
		target.LastDiscovered == nil || !strings.HasSuffix(target.ScreenshotKey, ".png") {
		t.Fatalf("target row not finalised: %+v", target)
	}
}

func TestWebTargetAPITrackWritesDomEndpointsWithTemplatedIDs(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	runTarget(t, headers, pid, []string{"api"})

	rows := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)))
	byKey := map[string]map[string]any{}
	for _, raw := range rows {
		e := raw.(map[string]any)
		byKey[fmt.Sprintf("%v %v", e["method"], e["path"])] = e
		if e["source"] != "dom" {
			t.Fatalf("source = %v, want dom", e["source"])
		}
	}
	for _, want := range []string{
		"GET /web/index.php/api/v2/admin/validation/user-name",
		"GET /web/index.php/api/v2/pim/employees/{id}",
		"POST /web/index.php/api/v2/auth/session",
		// declared by the markup, not observed on the wire
		"POST /web/index.php/auth/validate",
		"GET /web/index.php/auth/login",
	} {
		if _, present := byKey[want]; !present {
			t.Fatalf("missing endpoint %q — got %v", want, keysOf(byKey))
		}
	}
	if len(byKey) != 5 {
		t.Fatalf("document/script/image requests must not become endpoints: %v", keysOf(byKey))
	}
	// The i18n call in this payload is served from cdn.orangehrm.example, an
	// origin the crawl never visited, so it is NOT adopted. That costs a real
	// endpoint when an app serves its own API from a second host — a loss the
	// result reports by origin and count — and it is the price of never adopting
	// an embedded third party's API, which the security builders would then aim
	// probes at.
	for key := range byKey {
		if strings.Contains(key, "i18n") {
			t.Fatalf("a foreign origin's call became this project's endpoint: %s", key)
		}
	}

	// A form's action is an operation the page declares. Its parameters are the
	// form's OWN fields, with required-ness exactly as the page marks it.
	validate := byKey["POST /web/index.php/auth/validate"]
	if validate["observed_count"].(float64) != 0 {
		t.Fatalf("a declared endpoint claimed %v observations", validate["observed_count"])
	}
	body := validate["request_schema"].(map[string]any)
	properties := body["properties"].(map[string]any)
	for _, name := range []string{"username", "password", "_token"} {
		if _, present := properties[name]; !present {
			t.Fatalf("the form's field %q is not in the body schema: %v", name, properties)
		}
	}
	if len(properties) != 3 {
		t.Fatalf("the body schema invented fields: %v", properties)
	}
	// the hidden token is not required — the page does not say it is
	required := body["required"].([]any)
	if len(required) != 2 || required[0] != "username" || required[1] != "password" {
		t.Fatalf("required = %v", required)
	}
	// a GET form puts its fields in the query string instead
	search := byKey["GET /web/index.php/auth/login"]
	if search["request_schema"] != nil {
		t.Fatalf("a GET form declared a request body: %v", search["request_schema"])
	}
	searchParams := search["parameters"].([]any)
	if len(searchParams) != 1 {
		t.Fatalf("parameters = %v", searchParams)
	}
	q := searchParams[0].(map[string]any)
	if q["name"] != "q" || q["location"] != "query" || q["required"] != false {
		t.Fatalf("the GET form's field became %v", q)
	}
	// the two concrete employee ids collapsed onto ONE templated endpoint
	employees := byKey["GET /web/index.php/api/v2/pim/employees/{id}"]
	if employees["observed_count"].(float64) != 2 {
		t.Fatalf("observed_count = %v", employees["observed_count"])
	}
	params := employees["parameters"].([]any)
	if len(params) != 1 {
		t.Fatalf("parameters = %v", params)
	}
	p := params[0].(map[string]any)
	if p["name"] != "id" || p["location"] != "path" || p["required"] != true {
		t.Fatalf("path parameter = %v", p)
	}
	// a query string becomes a query parameter carrying the observed example
	username := byKey["GET /web/index.php/api/v2/admin/validation/user-name"]
	qp := username["parameters"].([]any)[0].(map[string]any)
	if qp["name"] != "userName" || qp["location"] != "query" {
		t.Fatalf("query parameter = %v", qp)
	}
	if qp["constraints"].(map[string]any)["example"] != "Admin" {
		t.Fatalf("the observed value must be recorded: %v", qp["constraints"])
	}
}

func TestWebTargetNeverDowngradesASpecEndpoint(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	spec := M{
		"openapi": "3.0.3", "info": M{"title": "PIM", "version": "1"},
		"paths": M{"/web/index.php/api/v2/pim/employees/{id}": M{"get": M{
			"operationId": "getEmployee", "summary": "Declared by the spec",
			"parameters": []any{M{"name": "id", "in": "path", "required": true,
				"schema": M{"type": "integer"}}},
			"responses": M{"200": M{"description": "OK"}}}}},
	}
	raw, _ := json.Marshal(spec)
	w := uploadFile(t, "/v1/projects/"+pid+"/api-specs", "spec.json", raw,
		"application/json", headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("spec import: %d %.300s", w.Code, w.Body.String())
	}
	runTarget(t, headers, pid, []string{"api"})

	rows := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)))
	for _, item := range rows {
		e := item.(map[string]any)
		key := fmt.Sprintf("%v %v", e["method"], e["path"])
		if key == "GET /web/index.php/api/v2/pim/employees/{id}" {
			if e["source"] != "spec" || e["summary"] != "Declared by the spec" {
				t.Fatalf("a crawl overwrote a declared contract: %v", e)
			}
		}
		if key == "POST /web/index.php/api/v2/auth/session" && e["source"] != "dom" {
			t.Fatalf("the endpoints the spec never mentioned must still arrive: %v", e)
		}
	}
}

func TestWebTargetSpecOwnedPathIsNotDowngradedByAFormAction(t *testing.T) {
	// A form's action is read from markup — the weakest evidence there is. It
	// must never overwrite a contract a spec declared.
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	spec := M{
		"openapi": "3.0.3", "info": M{"title": "Auth", "version": "1"},
		"paths": M{"/web/index.php/auth/validate": M{"post": M{
			"operationId": "validate", "summary": "Declared by the spec",
			"responses": M{"200": M{"description": "OK"}}}}},
	}
	raw, _ := json.Marshal(spec)
	w := uploadFile(t, "/v1/projects/"+pid+"/api-specs", "spec.json", raw,
		"application/json", headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("spec import: %d %.300s", w.Code, w.Body.String())
	}
	runTarget(t, headers, pid, []string{"api"})

	found := false
	for _, item := range itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/endpoints",
		nil, headers))) {
		e := item.(map[string]any)
		if fmt.Sprintf("%v %v", e["method"], e["path"]) != "POST /web/index.php/auth/validate" {
			continue
		}
		found = true
		if e["source"] != "spec" || e["summary"] != "Declared by the spec" {
			t.Fatalf("a form action overwrote a declared contract: %v", e)
		}
	}
	if !found {
		t.Fatalf("the spec-declared path vanished")
	}
}

func TestWebTargetFunctionalTrackMakesARequirementPerForm(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	runTarget(t, headers, pid, []string{"functional"})

	var reqs []models.Requirement
	db.DB.Where("project_id = ?", pid).Find(&reqs)
	if len(reqs) != 2 {
		t.Fatalf("one requirement per discovered form, got %d", len(reqs))
	}
	var login *models.Requirement
	for i := range reqs {
		if strings.Contains(reqs[i].Description, "form.oxd-form") {
			login = &reqs[i]
		}
	}
	if login == nil {
		t.Fatalf("no requirement names the login form: %+v", reqs)
	}
	if login.State != "extracted" {
		t.Fatalf("state = %q, want extracted (awaiting confirmation)", login.State)
	}
	for _, want := range []string{"input[name=username]", "Required: Username, Password"} {
		if !strings.Contains(login.Description, want) {
			t.Fatalf("description must contain %q: %s", want, login.Description)
		}
	}
}

func TestWebTargetFunctionalCasesCarryTheFormSelectorsVerbatim(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	runTarget(t, headers, pid, []string{"functional"})

	var cases []models.TestCase
	db.DB.Preload("Steps").Where("project_id = ?", pid).Find(&cases)
	if len(cases) == 0 {
		t.Fatal("no functional cases were generated")
	}
	var titles, payloads []string
	for _, c := range cases {
		titles = append(titles, c.Title)
		for _, s := range c.Steps {
			form, _ := s.Request["form"].(string)
			if !strings.HasPrefix(form, "form.") && !strings.HasPrefix(form, "form#") {
				t.Fatalf("a case step does not name its form: %v", s.Request)
			}
			payloads = append(payloads, jsonOf(t, s.Request))
		}
	}
	joinedPayloads := strings.Join(payloads, " ")
	for _, want := range []string{"input[name=username]", "input[name=password]"} {
		if !strings.Contains(joinedPayloads, want) {
			t.Fatalf("the selectors must travel verbatim: missing %q", want)
		}
	}
	joinedTitles := strings.Join(titles, " | ")
	for _, want := range []string{
		"rejects submission with Username empty",
		"rejects submission with Password empty",
		"at most 120 characters",
		"enforces its declared pattern",
	} {
		if !strings.Contains(joinedTitles, want) {
			t.Fatalf("missing case %q in %s", want, joinedTitles)
		}
	}
}

func TestWebTargetUITrackExtractsFactsPaletteAndRemediation(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	_, accepted := runTarget(t, headers, pid, []string{"ui"})

	detail := jsonMap(t, do(t, "GET", "/v1/web-targets/"+accepted["target_id"].(string), nil, headers))
	designed := detail["design"].(map[string]any)
	if designed["fact_count"].(float64) < 8 {
		t.Fatalf("fact_count = %v", designed["fact_count"])
	}
	shares := map[string]float64{}
	for _, raw := range designed["palette"].([]any) {
		entry := raw.(map[string]any)
		shares[entry["hex"].(string)] = entry["share"].(float64)
	}
	for _, hex := range []string{"#FFFFFF", "#F0903F"} {
		if share, present := shares[hex]; !present || share <= 0 || share >= 1 {
			t.Fatalf("palette must carry %s with its share: %v", hex, shares)
		}
	}
	var failing map[string]any
	for _, raw := range designed["contrast"].([]any) {
		entry := raw.(map[string]any)
		if passes, _ := entry["passes_aa"].(bool); !passes {
			failing = entry
			break
		}
	}
	if failing == nil {
		t.Fatalf("the fixture screen has a failing ink: %v", designed["contrast"])
	}
	if failing["suggested"] == failing["ink"] {
		t.Fatalf("a failure without the passing colour leaves the designer guessing")
	}
	if failing["ratio_after"].(float64) < 4.5 || failing["achievable"] != true {
		t.Fatalf("remediation = %v", failing)
	}

	// every UI case cites a fact the design actually states
	stated := map[string]bool{}
	for _, raw := range designed["facts"].([]any) {
		stated[raw.(map[string]any)["id"].(string)] = true
	}
	var cases []models.TestCase
	db.DB.Preload("Steps").Where("project_id = ? AND technique IN ?", pid,
		[]string{"design", "a11y"}).Find(&cases)
	if len(cases) == 0 {
		t.Fatal("no UI cases were generated")
	}
	for _, c := range cases {
		fact, _ := c.Steps[0].Request["fact"].(string)
		if !stated[fact] {
			t.Fatalf("%s cites %q, which the design does not state", c.Title, fact)
		}
	}
}

func TestWebTargetPerformanceTrackStatesABudgetAgainstTheBaseline(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	runTarget(t, headers, pid, []string{"performance"})

	var req models.Requirement
	if err := db.DB.Where("project_id = ? AND type = ?", pid, "non_functional").
		First(&req).Error; err != nil {
		t.Fatalf("no performance requirement: %v", err)
	}
	if !strings.Contains(req.Description, "2410ms") {
		t.Fatalf("the observed baseline must be stated: %s", req.Description)
	}
	var kase models.TestCase
	if err := db.DB.Preload("Steps").Where("project_id = ? AND technique = ?", pid,
		"performance").First(&kase).Error; err != nil {
		t.Fatalf("no performance case: %v", err)
	}
	assertion := kase.Steps[0].Assertions[0].(map[string]any)
	if assertion["type"] != "page_load_ms" ||
		int(assertion["expected_max"].(float64)) != config.C.PageLoadBudgetMS ||
		int(assertion["observed_baseline_ms"].(float64)) != 2410 {
		t.Fatalf("assertion = %v", assertion)
	}
}

// TestWebTargetAPITrackGeneratesCasesBoundToTheCapturedRequests asserts that
// selecting `api` produces cases, not merely an endpoint inventory: every step
// must address an endpoint the crawl actually observed, since a case against a
// path the browser never called is exactly the fabrication BO-07 stops.
func TestWebTargetAPITrackGeneratesCasesBoundToTheCapturedRequests(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	job, _ := runTarget(t, headers, pid, []string{"api"})
	byType := job["result"].(map[string]any)["cases_by_type"].(map[string]any)
	if byType["api"].(float64) <= 0 {
		t.Fatalf("no api cases: %v", byType)
	}

	dom := map[string]string{}
	var endpoints []models.Endpoint
	db.DB.Where("project_id = ? AND source = ?", pid, "dom").Find(&endpoints)
	for _, e := range endpoints {
		dom[e.ID] = strings.ToUpper(e.Method) + " " + e.Path
	}
	if len(dom) == 0 {
		t.Fatal("no dom endpoints were recorded")
	}
	var cases []models.TestCase
	db.DB.Preload("Steps").Where("project_id = ?", pid).Find(&cases)
	if len(cases) == 0 {
		t.Fatal("no cases were written")
	}
	for _, c := range cases {
		if len(c.Steps) == 0 {
			t.Fatalf("case %q has no step", c.Title)
		}
		step := c.Steps[0]
		if step.EndpointID == nil {
			t.Fatalf("case %q is not bound to an endpoint", c.Title)
		}
		want, known := dom[*step.EndpointID]
		if !known {
			t.Fatalf("case %q cites an endpoint the crawl never found", c.Title)
		}
		if got := strings.ToUpper(step.Method) + " " + step.Path; got != want {
			t.Fatalf("case %q addresses %s, endpoint is %s", c.Title, got, want)
		}
		if len(step.Assertions) == 0 {
			t.Fatalf("case %q asserts nothing", c.Title)
		}
	}
}

func TestWebTargetSecurityTrackBuildsS0OnTheDiscoveredEndpoints(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	job, _ := runTarget(t, headers, pid, []string{"security"})
	byType := job["result"].(map[string]any)["cases_by_type"].(map[string]any)
	if byType["security"].(float64) <= 0 {
		t.Fatalf("no security cases: %v", byType)
	}

	domIDs := map[string]bool{}
	var endpoints []models.Endpoint
	db.DB.Where("project_id = ? AND source = ?", pid, "dom").Find(&endpoints)
	for _, e := range endpoints {
		domIDs[e.ID] = true
	}
	var cases []models.TestCase
	db.DB.Preload("Steps").Where("project_id = ? AND technique = ?", pid, "security").Find(&cases)
	if len(cases) == 0 {
		t.Fatal("no security cases were persisted")
	}
	for _, c := range cases {
		if c.WeaknessID == nil || *c.WeaknessID == "" {
			t.Fatalf("%s carries no weakness id", c.Title)
		}
		if c.Steps[0].EndpointID == nil || !domIDs[*c.Steps[0].EndpointID] {
			t.Fatalf("%s is not bound to a discovered endpoint", c.Title)
		}
	}
}

func TestWebTargetEveryCaseIsLinkedToARequirement(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	runTarget(t, headers, pid, allTypes())

	var cases []models.TestCase
	db.DB.Where("project_id = ?", pid).Find(&cases)
	if len(cases) == 0 {
		t.Fatal("nothing was generated")
	}
	for _, c := range cases {
		var links int64
		db.DB.Model(&models.RequirementTestCase{}).Where("test_case_id = ?", c.ID).Count(&links)
		if links == 0 {
			t.Fatalf("%s is linked to no requirement — it could never be traced", c.Title)
		}
	}
}

func TestWebTargetRerunRefreshesInsteadOfDuplicating(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	_, first := runTarget(t, headers, pid, allTypes())
	var casesBefore, reqsBefore int64
	db.DB.Model(&models.TestCase{}).Where("project_id = ?", pid).Count(&casesBefore)
	db.DB.Model(&models.Requirement{}).Where("project_id = ?", pid).Count(&reqsBefore)

	job, second := runTarget(t, headers, pid, allTypes())
	if second["target_id"] != first["target_id"] {
		t.Fatalf("a re-run forked the target")
	}
	if job["result"].(map[string]any)["duplicates"].(float64) <= 0 {
		t.Fatalf("the re-run did not recognise its own cases")
	}
	var targets, casesAfter, reqsAfter int64
	db.DB.Model(&models.WebTarget{}).Where("project_id = ?", pid).Count(&targets)
	db.DB.Model(&models.TestCase{}).Where("project_id = ?", pid).Count(&casesAfter)
	db.DB.Model(&models.Requirement{}).Where("project_id = ?", pid).Count(&reqsAfter)
	if targets != 1 || casesAfter != casesBefore || reqsAfter != reqsBefore {
		t.Fatalf("re-run duplicated: targets=%d cases %d->%d reqs %d->%d",
			targets, casesBefore, casesAfter, reqsBefore, reqsAfter)
	}
}

func TestWebTargetScreenshotRouteServesThePNG(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t)
	_, accepted := runTarget(t, headers, pid, []string{"ui"})
	w := do(t, "GET", "/v1/web-targets/"+accepted["target_id"].(string)+"/screenshot", nil, headers)
	if w.Code != 200 {
		t.Fatalf("screenshot: %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type = %q", ct)
	}
	if !strings.HasPrefix(w.Body.String(), "\x89PNG\r\n\x1a\n") {
		t.Fatalf("body is not a PNG")
	}
}

func TestWebTargetWithoutAScreenshotSaysSo(t *testing.T) {
	doc := recordedPayload(t)
	doc["screenshot"] = ""
	withSidecar(t, doc)
	headers, pid := webTargetProject(t)
	job, accepted := runTarget(t, headers, pid, []string{"ui"})
	if !skippedFor(job, "ui", "the sidecar produced no screenshot") {
		t.Fatalf("skipped = %v", job["result"].(map[string]any)["skipped"])
	}
	w := do(t, "GET", "/v1/web-targets/"+accepted["target_id"].(string)+"/screenshot", nil, headers)
	if w.Code != 404 || jsonMap(t, w)["detail"].(map[string]any)["code"] != "no_screenshot" {
		t.Fatalf("screenshot route: %d %.200s", w.Code, w.Body.String())
	}
}

// stripXHR removes the captured API traffic, leaving only how the page was
// delivered.
func stripXHR(doc map[string]any) map[string]any {
	kept := []any{}
	for _, raw := range doc["requests"].([]any) {
		r := raw.(map[string]any)
		if r["resourceType"] != "xhr" && r["resourceType"] != "fetch" {
			kept = append(kept, r)
		}
	}
	doc["requests"] = kept
	return doc
}

func TestWebTargetPageWithNoAPISurfaceAtAllReportsTheReason(t *testing.T) {
	// No XHR AND no form action. Either one on its own is an API surface, so the
	// reason is only honest when the page states neither.
	doc := stripXHR(recordedPayload(t))
	doc["forms"] = []any{}
	withSidecar(t, doc)
	headers, pid := webTargetProject(t)
	job, _ := runTarget(t, headers, pid, []string{"api", "security"})
	result := job["result"].(map[string]any)
	if result["endpoints"].(float64) != 0 {
		t.Fatalf("endpoints = %v", result["endpoints"])
	}
	for _, kind := range []string{"api", "security"} {
		if !skippedFor(job, kind, "XHR/fetch") || !skippedFor(job, kind, "form action") {
			t.Fatalf("%s must be skipped with its reason: %v", kind, result["skipped"])
		}
	}
}

func TestWebTargetFormActionAloneIsStillAnAPISurface(t *testing.T) {
	// The owner's report: a page whose server interaction is a classic form POST
	// used to discover ZERO endpoints, and every requirement then came back
	// unmappable because the inventory was empty.
	withSidecar(t, stripXHR(recordedPayload(t)))
	headers, pid := webTargetProject(t)
	job, _ := runTarget(t, headers, pid, []string{"api"})
	result := job["result"].(map[string]any)
	if result["endpoints"].(float64) != 2 {
		t.Fatalf("endpoints = %v (skipped: %v)", result["endpoints"], result["skipped"])
	}
	rows := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)))
	found := false
	for _, raw := range rows {
		e := raw.(map[string]any)
		if e["method"] == "POST" && e["path"] == "/web/index.php/auth/validate" {
			found = true
		}
	}
	if !found {
		t.Fatalf("the form's declared action never became an endpoint: %v", rows)
	}
	if result["cases_by_type"].(map[string]any)["api"].(float64) == 0 {
		t.Fatalf("a declared endpoint produced no cases")
	}
}

func TestWebTargetFormPostingToAnotherOriginIsSkippedWithTheReason(t *testing.T) {
	// Somebody else's endpoint is not this project's endpoint.
	doc := recordedPayload(t)
	doc["forms"].([]any)[0].(map[string]any)["action"] = "https://analytics.example.com/collect"
	withSidecar(t, doc)
	headers, pid := webTargetProject(t)
	job, _ := runTarget(t, headers, pid, []string{"api"})
	if !skippedFor(job, "api", "analytics.example.com") ||
		!skippedFor(job, "api", "different origin") {
		t.Fatalf("a cross-origin action was not refused with its reason: %v",
			job["result"].(map[string]any)["skipped"])
	}
	rows := itemsOf(jsonAny(t, do(t, "GET", "/v1/projects/"+pid+"/endpoints", nil, headers)))
	for _, raw := range rows {
		if strings.Contains(fmt.Sprint(raw.(map[string]any)["path"]), "analytics") {
			t.Fatalf("a cross-origin action became an endpoint: %v", raw)
		}
	}
}

// ---------------------------------------------------------------------------
// 5. Grounding — the rule that does not bend
// ---------------------------------------------------------------------------

func TestWebTargetArtefactSetIsExactlyWhatTheRenderFound(t *testing.T) {
	inv := webtarget.NormalisePayload(recordedPayload(t))
	ids := webtarget.ArtefactIDs(inv, nil)
	for _, want := range []string{
		"selector:input[name=username]", "selector:form.oxd-form",
		"request:GET https://opensource-demo.orangehrmlive.com/web/index.php/api/v2/pim/employees/7",
	} {
		if !ids[want] {
			t.Fatalf("missing artefact %q", want)
		}
	}
	if ids["selector:input[name=nonexistent]"] {
		t.Fatal("an artefact nobody found is in the set")
	}
}

func TestWebTargetACaseCitingAnUndiscoveredSelectorIsAViolation(t *testing.T) {
	inv := webtarget.NormalisePayload(recordedPayload(t))
	ids := webtarget.ArtefactIDs(inv, nil)
	if len(webtarget.GroundingViolations([]string{"selector:#totally-made-up"}, ids)) == 0 {
		t.Fatal("an invented selector must be a violation")
	}
	if v := webtarget.GroundingViolations(nil, ids); len(v) != 1 {
		t.Fatalf("a case with no artefact must be a violation: %v", v)
	}
	if v := webtarget.GroundingViolations([]string{"selector:input[name=password]"}, ids); len(v) != 0 {
		t.Fatalf("a real selector must be grounded: %v", v)
	}
}

func TestWebTargetEveryFormCaseIsGroundedInItsForm(t *testing.T) {
	inv := webtarget.NormalisePayload(recordedPayload(t))
	ids := webtarget.ArtefactIDs(inv, nil)
	for _, form := range inv.Forms {
		cases := webtarget.FormCases(form, inv)
		if len(cases) == 0 {
			t.Fatalf("form %s produced no case", form.Selector)
		}
		for _, c := range cases {
			if v := webtarget.GroundingViolations(c.Grounds, ids); len(v) > 0 {
				t.Fatalf("%s: %v", c.Title, v)
			}
		}
	}
}

// TestWebTargetLabelsANamelessFormByWhatThePageShows: a real SPA form usually
// carries neither name nor id. Falling straight through to the CSS selector
// produced titles that repeated a 200-character path twice, so the heading and
// the submit control — both already reported by the sidecar — are read first.
func TestWebTargetLabelsANamelessFormByWhatThePageShows(t *testing.T) {
	form := map[string]any{
		"selector": "#app > div:nth-of-type(1) > div > form",
		"heading":  "Login",
		"submits": []any{map[string]any{
			"selector": "#app form button", "name": "Login", "type": "submit"}},
		"fields": []any{map[string]any{
			"selector": "input[name=username]", "name": "username"}},
	}
	inv := webtarget.NormalisePayload(map[string]any{"forms": []any{form}})
	got := inv.Forms[0]
	if got.Submit != "#app form button" || got.SubmitName != "Login" || got.Heading != "Login" {
		t.Fatalf("submit control and heading must survive normalisation: %+v", got)
	}
	if label := webtarget.FormLabel(got); label != "Login" {
		t.Fatalf("label = %q, want Login", label)
	}

	form["name"] = "signin" // the page's own naming outranks both
	inv = webtarget.NormalisePayload(map[string]any{"forms": []any{form}})
	if label := webtarget.FormLabel(inv.Forms[0]); label != "signin" {
		t.Fatalf("label = %q, want signin", label)
	}

	// a form the page says nothing about still gets an unambiguous label
	inv = webtarget.NormalisePayload(map[string]any{"forms": []any{
		map[string]any{"selector": "form.x"}}})
	if label := webtarget.FormLabel(inv.Forms[0]); label != "form.x" {
		t.Fatalf("label = %q, want form.x", label)
	}
}

func TestWebTargetDropsAFieldWithoutASelector(t *testing.T) {
	inv := webtarget.NormalisePayload(map[string]any{"forms": []any{map[string]any{
		"selector": "form#a", "fields": []any{
			map[string]any{"name": "ghost", "required": true}, // no selector -> dropped
			map[string]any{"selector": "#real", "name": "real", "required": true},
		}}}})
	if len(inv.Forms) != 1 || len(inv.Forms[0].Fields) != 1 ||
		inv.Forms[0].Fields[0].Selector != "#real" {
		t.Fatalf("a field with no selector must be dropped, not invented: %+v", inv.Forms)
	}
}

func TestWebTargetToleratesUnknownSidecarKeys(t *testing.T) {
	doc := recordedPayload(t)
	doc["future_field"] = map[string]any{"anything": []any{1.0, 2.0}}
	doc["forms"].([]any)[0].(map[string]any)["shadow_root"] = true
	inv := webtarget.NormalisePayload(doc)
	if len(inv.Forms) != 2 || inv.ElapsedMS == nil || *inv.ElapsedMS != 2410 {
		t.Fatalf("unknown keys broke normalisation: %+v", inv)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func keysOf(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func jsonOf(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(raw)
}

func skippedFor(job M, kind, fragment string) bool {
	result, _ := job["result"].(map[string]any)
	for _, raw := range asAnyList(result["skipped"]) {
		entry, _ := raw.(map[string]any)
		if entry["type"] == kind && strings.Contains(fmt.Sprint(entry["reason"]), fragment) {
			return true
		}
	}
	return false
}

func asAnyList(v any) []any {
	l, _ := v.([]any)
	return l
}

// seedOrgUserInOrg adds a user with the given role to the organisation the
// supplied headers belong to.
func seedOrgUserInOrg(t *testing.T, headers map[string]string, role string) (map[string]string, string, string) {
	t.Helper()
	w := do(t, "POST", "/v1/members/invite", M{
		"email": fmt.Sprintf("member%s@example.sa", uuidLike()), "name": "Member",
		"role": role, "password": "Passw0rd!"}, headers)
	if w.Code != 200 && w.Code != 201 {
		t.Fatalf("invite %s: %d %.200s", role, w.Code, w.Body.String())
	}
	invited := jsonMap(t, w)
	email, _ := invited["email"].(string)
	if member, ok := invited["member"].(map[string]any); ok && email == "" {
		email, _ = member["email"].(string)
	}
	login := jsonMap(t, do(t, "POST", "/v1/auth/login",
		M{"email": email, "password": "Passw0rd!"}, nil))
	token, _ := login["token"].(string)
	if token == "" {
		t.Fatalf("no token for the invited %s: %v", role, login)
	}
	return map[string]string{"Authorization": "Bearer " + token}, "", ""
}

var uuidCounter int

func uuidLike() string {
	uuidCounter++
	return fmt.Sprintf("%d%d", time.Now().UnixNano(), uuidCounter)
}

// TestWebTargetHandsOverToTheAutopilotInAutoMode: a crawl's requirements must
// not stop at "extracted". The point of pointing Traceo at a URL and walking
// away is that the chain continues — confirm what the crawl extracted, then run
// the generator over it. Without this the URL path silently ends at the
// deterministic builders, a difference the case counts alone would not reveal.
// It still stops at DRAFT cases: approval and runs stay manual (BO-07).
func TestWebTargetHandsOverToTheAutopilotInAutoMode(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers := registerOrg(t, "Autopilot Org")
	w := do(t, "POST", "/v1/projects", M{"name": "Auto Project", "automation": "auto"}, headers)
	if w.Code != 201 && w.Code != 200 {
		t.Fatalf("create project: %d %s", w.Code, w.Body.String())
	}
	pid, _ := jsonMap(t, w)["id"].(string)

	job, _ := runTarget(t, headers, pid, webtarget.TestTypes)
	if job["status"] != "completed" {
		t.Fatalf("job = %v", job)
	}

	var requirements []models.Requirement
	db.DB.Where("project_id = ?", pid).Find(&requirements)
	if len(requirements) == 0 {
		t.Fatal("the crawl produced no requirements")
	}
	for _, r := range requirements {
		if r.State != "confirmed" {
			t.Fatalf("requirement %s left at %q — the autopilot did not run",
				r.ExternalID, r.State)
		}
	}

	var entries []models.AuditEntry
	db.DB.Where("action = ? AND object_id = ?", "auto.requirements.confirm_all", pid).
		Find(&entries)
	if len(entries) == 0 {
		t.Fatal("the auto confirm step left no audit entry")
	}
	if entries[0].Detail["source"] != "web_target" {
		t.Fatalf("audit detail = %v", entries[0].Detail)
	}

	var cases []models.TestCase
	db.DB.Where("project_id = ?", pid).Find(&cases)
	if len(cases) == 0 {
		t.Fatal("no cases were written")
	}
	for _, c := range cases {
		if c.State != "draft" {
			t.Fatalf("case %q is %q — the autopilot must stop at draft", c.Title, c.State)
		}
	}
}

// TestWebTargetManualModeLeavesTheCrawlsRequirementsAlone: manual means manual.
func TestWebTargetManualModeLeavesTheCrawlsRequirementsAlone(t *testing.T) {
	withSidecar(t, recordedPayload(t))
	headers, pid := webTargetProject(t) // createProject pins automation "manual"

	if job, _ := runTarget(t, headers, pid, webtarget.TestTypes); job["status"] != "completed" {
		t.Fatalf("job = %v", job)
	}

	var requirements []models.Requirement
	db.DB.Where("project_id = ?", pid).Find(&requirements)
	if len(requirements) == 0 {
		t.Fatal("the crawl produced no requirements")
	}
	for _, r := range requirements {
		if r.State != "extracted" {
			t.Fatalf("manual mode confirmed %s on the user's behalf", r.ExternalID)
		}
	}
}

// TestWebTargetThirdPartyCallsNeverBecomeThisProjectsEndpoints: a page that
// embeds a third party makes that party's calls from the same browser.
// Recording them would put somebody else's API into this project — and the
// security builders would then aim probes at a host the user never named.
// Measured on the real target: the Buzz page embeds YouTube, and without this
// filter the crawl adopted four Google endpoints and twelve security cases were
// built on them, one of them a rate-limit probe.
func TestWebTargetThirdPartyCallsNeverBecomeThisProjectsEndpoints(t *testing.T) {
	inv := webtarget.NormalisePayload(recordedPayload(t))
	ours := "https://opensource-demo.orangehrmlive.com"

	// copy a real capture so it survives the resource-type filter and is
	// rejected for its ORIGIN, which is what this test is about
	var embedded webtarget.Request
	for _, r := range inv.Requests {
		if r.ResourceType == "xhr" || r.ResourceType == "fetch" {
			embedded = r
			break
		}
	}
	if embedded.URL == "" {
		t.Fatal("the fixture has no captured xhr/fetch request")
	}
	embedded.URL = "https://www.youtube.com/youtubei/v1/log_event?alt=json"
	requests := append(append([]webtarget.Request{}, inv.Requests...), embedded)

	ops, reasons := webtarget.EndpointsFromRequests(requests, map[string]bool{ours: true})
	if len(ops) == 0 {
		t.Fatal("the target's own captures must still be recorded")
	}
	for _, op := range ops {
		if strings.Contains(op.Path, "youtubei") {
			t.Fatalf("a third party's call became this project's endpoint: %s", op.Path)
		}
	}
	named := false
	for _, r := range reasons {
		if strings.Contains(r, "youtube.com") {
			named = true
		}
	}
	if !named {
		t.Fatalf("the dropped origin must be reported: %v", reasons)
	}

	// with no origin set given, the filter is off — the older callers that pass
	// nothing must behave exactly as they did
	unfiltered, noReasons := webtarget.EndpointsFromRequests(requests, nil)
	if len(unfiltered) <= len(ops) || len(noReasons) != 0 {
		t.Fatalf("a nil origin set must disable the filter: %d vs %d, %v",
			len(unfiltered), len(ops), noReasons)
	}
}
