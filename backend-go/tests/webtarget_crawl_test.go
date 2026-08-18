package tests_test

// The authenticated crawl — parity gate for backend/tests/test_webtarget_crawl.py.
// The same claims, the same recorded document, the same ids and sentences, so a
// client cannot tell the two backends apart.
//
// The claims, each one a thing that would be a real incident if it stopped
// holding:
//   - a credential NEVER reaches the wire, the argv, the audit log or an error
//     message. The password travels in the child's environment and nowhere else;
//   - a crawl asked to sign in with the OPERATOR's credentials and unable to
//     prove it did FAILS with login_failed, generically — it never crawls the
//     logged-out product and reports success;
//   - a page that asks to be signed into with nothing to try is reported as
//     login_required with the form's own selectors: an outcome, not an error;
//   - credentials the login page publishes about ITSELF are a fact about the
//     page and may be used and named; a credential the user supplied never is;
//   - every page the crawl visited produces its own requirements, keyed so a
//     re-crawl refreshes them instead of forking them;
//   - grounding does not bend: a case may only cite artefacts from the page it
//     is about. The oracle for that is shown failing before it is trusted.
//
// Nothing here starts a browser: the sidecar seam is replaced with a recorded
// multi-page document.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/models"
	"traceo/internal/modules/webtarget"
)

const (
	crawlLoginURL = "http://localhost:8017/web/index.php/auth/login"
	crawlUsername = "Admin"
	crawlPassword = "admin123"
)

// crawlPayload is the recorded three-page crawl behind a login, with the skip
// list the safety rule produced: a logout link, a delete control, an off-origin
// link.
func crawlPayload(t *testing.T) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("fixtures", "webtarget_crawl.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("fixture is not JSON: %v", err)
	}
	shot, err := filepath.Abs(filepath.Join("fixtures", "webtarget_screen.png"))
	if err != nil {
		t.Fatalf("fixture path: %v", err)
	}
	doc["screenshot"] = shot
	for _, entry := range doc["pages"].([]any) {
		page := entry.(map[string]any)
		if s, _ := page["screenshot"].(string); s != "" {
			page["screenshot"] = shot
		}
	}
	return doc
}

// loginPagePayload is the single page a crawl sees when it cannot get in.
func loginPagePayload() map[string]any {
	return map[string]any{
		"url": crawlLoginURL, "final_url": crawlLoginURL, "title": "OrangeHRM",
		"viewport": "1280x800", "elapsed_ms": float64(900), "screenshot": "",
		"forms": []any{map[string]any{
			"selector": "form.oxd-form",
			"heading":  "Login",
			"submits": []any{map[string]any{
				"selector": "form.oxd-form button[type=submit]", "name": "Login"}},
			"fields": []any{
				map[string]any{"selector": "input[name=username]", "name": "username",
					"type": "text", "required": true},
				map[string]any{"selector": "input[name=password]", "name": "password",
					"type": "password", "required": true},
			},
		}},
		"controls": []any{}, "requests": []any{}, "console_errors": []any{},
	}
}

// withCrawlSidecar installs a recorded document and captures the plan the job
// handed the browser — the password's route is asserted from it.
func withCrawlSidecar(t *testing.T, doc map[string]any) *[]*webtarget.CrawlPlan {
	t.Helper()
	plans := []*webtarget.CrawlPlan{}
	previousRunner := webtarget.SidecarRunner
	previousPrivate := config.C.AllowPrivateTargets
	webtarget.SidecarRunner = func(url, viewport, outDir string, timeoutS float64,
		plan *webtarget.CrawlPlan) (map[string]any, error) {
		plans = append(plans, plan)
		return doc, nil
	}
	config.C.AllowPrivateTargets = true
	t.Cleanup(func() {
		webtarget.SidecarRunner = previousRunner
		config.C.AllowPrivateTargets = previousPrivate
	})
	return &plans
}

func crawlProject(t *testing.T) (map[string]string, string) {
	t.Helper()
	headers := registerOrg(t, "Crawl Org")
	return headers, createProject(t, headers, "Crawl Project")
}

func startCrawl(t *testing.T, headers map[string]string, projectID string, body M) M {
	t.Helper()
	if _, present := body["url"]; !present {
		body["url"] = crawlLoginURL
	}
	if _, present := body["test_types"]; !present {
		body["test_types"] = []string{"functional", "performance"}
	}
	w := do(t, "POST", "/v1/projects/"+projectID+"/web-targets", body, headers)
	if w.Code != 202 {
		t.Fatalf("start failed: %d %.300s", w.Code, w.Body.String())
	}
	return jsonMap(t, w)
}

func runCrawl(t *testing.T, headers map[string]string, projectID string, body M) (M, M) {
	t.Helper()
	accepted := startCrawl(t, headers, projectID, body)
	job := pollTerminal(t, headers, accepted["job_id"].(string))
	return job, accepted
}

func resultOf(t *testing.T, job M) M {
	t.Helper()
	if job["status"] != "completed" {
		t.Fatalf("job failed: %v", job["error"])
	}
	result, ok := job["result"].(map[string]any)
	if !ok {
		t.Fatalf("job carried no result: %v", job)
	}
	return result
}

// ---------------------------------------------------------------------------
// 1. The page budget
// ---------------------------------------------------------------------------

func TestCrawlPageBudgetOutsideTheRangeIsRefusedWithTheRange(t *testing.T) {
	allowPrivate(t)
	headers, pid := crawlProject(t)
	for _, value := range []any{0, 51, -1, "abc", 2.5, true} {
		w := do(t, "POST", "/v1/projects/"+pid+"/web-targets",
			M{"url": crawlLoginURL, "max_pages": value}, headers)
		if w.Code != 422 {
			t.Fatalf("max_pages %v was accepted: %d %.200s", value, w.Code, w.Body.String())
		}
		detail := jsonMap(t, w)["detail"].(map[string]any)
		if detail["code"] != "invalid_max_pages" {
			t.Fatalf("max_pages %v: code %v", value, detail["code"])
		}
		// The bounds travel with the refusal, so a caller can fix it without docs.
		errs := detail["errors"].([]any)
		if len(errs) != 2 || errs[0] != "1" || errs[1] != "50" {
			t.Fatalf("max_pages %v: errors %v", value, errs)
		}
	}
	// and a refused request leaves nothing behind
	listed := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, headers))
	if len(listed["web_targets"].([]any)) != 0 {
		t.Fatalf("a refused request created a target: %v", listed)
	}
}

func TestCrawlDefaultExploresRatherThanWaitingToBeAsked(t *testing.T) {
	// The owner's complaint, encoded: a URL handed to Traceo means "look at the
	// product", not "look at one screen".
	plans := withCrawlSidecar(t, loginPagePayload())
	headers, pid := crawlProject(t)
	accepted := startCrawl(t, headers, pid, M{})
	pollTerminal(t, headers, accepted["job_id"].(string))

	if accepted["max_pages"] != float64(webtarget.DefaultMaxPages) {
		t.Fatalf("default budget is %v, want %d", accepted["max_pages"],
			webtarget.DefaultMaxPages)
	}
	if webtarget.DefaultMaxPages != 25 {
		t.Fatalf("the default stopped exploring: %d", webtarget.DefaultMaxPages)
	}
	if len(*plans) == 0 || (*plans)[0].MaxPages != 25 {
		t.Fatalf("the browser was not asked to crawl: %+v", *plans)
	}
}

func TestCrawlReRunKeepsTheBudgetTheTargetWasConfiguredWith(t *testing.T) {
	withCrawlSidecar(t, loginPagePayload())
	headers, pid := crawlProject(t)
	if got := startCrawl(t, headers, pid, M{"max_pages": 7})["max_pages"]; got != float64(7) {
		t.Fatalf("max_pages 7 was not honoured: %v", got)
	}
	// omitting it is not "reset to the default"
	if got := startCrawl(t, headers, pid, M{})["max_pages"]; got != float64(7) {
		t.Fatalf("a re-run reset the budget: %v", got)
	}
}

// ---------------------------------------------------------------------------
// 2. Credentials — refused blank, and never on the wire
// ---------------------------------------------------------------------------

func TestCrawlHalfACredentialIsRefusedWithoutNamingWhichHalf(t *testing.T) {
	allowPrivate(t)
	headers, pid := crawlProject(t)
	cases := []any{
		M{"username": "", "password": crawlPassword},
		M{"username": "   ", "password": crawlPassword},
		M{"username": crawlUsername, "password": ""},
		M{"username": crawlUsername, "password": "   "},
		M{"username": crawlUsername},
		M{"password": crawlPassword},
		"Admin:admin123",
	}
	for _, auth := range cases {
		w := do(t, "POST", "/v1/projects/"+pid+"/web-targets",
			M{"url": crawlLoginURL, "auth": auth}, headers)
		if w.Code != 422 {
			t.Fatalf("auth %v was accepted: %d", auth, w.Code)
		}
		detail := jsonMap(t, w)["detail"].(map[string]any)
		if detail["code"] != "invalid_credentials" {
			t.Fatalf("auth %v: code %v", auth, detail["code"])
		}
		message := detail["message"].(string)
		// It must not say which of the two was blank, nor echo either.
		if strings.Contains(message, crawlUsername) || strings.Contains(message, crawlPassword) {
			t.Fatalf("the refusal echoed a credential: %s", message)
		}
	}
	listed := jsonMap(t, do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, headers))
	if len(listed["web_targets"].([]any)) != 0 {
		t.Fatalf("a refused request created a target")
	}
}

func TestCrawlAStoredCredentialNeverComesBackOut(t *testing.T) {
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	accepted := startCrawl(t, headers, pid,
		M{"auth": M{"username": crawlUsername, "password": crawlPassword}})
	if accepted["auth_configured"] != true {
		t.Fatalf("credentials were not recorded: %v", accepted)
	}
	pollTerminal(t, headers, accepted["job_id"].(string))
	targetID := accepted["target_id"].(string)

	detail := do(t, "GET", "/v1/web-targets/"+targetID, nil, headers)
	// The whole serialised payload, not just the fields we thought to check.
	if strings.Contains(detail.Body.String(), crawlPassword) {
		t.Fatalf("the detail payload leaked the password")
	}
	if jsonMap(t, detail)["auth_configured"] != true {
		t.Fatalf("auth_configured did not survive the crawl")
	}
	listed := do(t, "GET", "/v1/projects/"+pid+"/web-targets", nil, headers)
	if strings.Contains(listed.Body.String(), crawlPassword) {
		t.Fatalf("the list payload leaked the password")
	}

	// and the row itself holds ciphertext, not a readable secret
	var row models.WebTarget
	if err := db.DB.First(&row, "id = ?", targetID).Error; err != nil {
		t.Fatalf("target row: %v", err)
	}
	if len(row.AuthConfigEncrypted) == 0 {
		t.Fatalf("nothing was sealed")
	}
	if strings.Contains(string(row.AuthConfigEncrypted), crawlPassword) {
		t.Fatalf("the stored blob is not encrypted")
	}
}

func TestCrawlThePasswordTravelsInTheEnvironmentAndNeverInArgv(t *testing.T) {
	// `ps` is readable by every user on the host. A password in argv is an
	// incident even when the job log is clean.
	plan := &webtarget.CrawlPlan{MaxPages: 5, MaxDepth: 3,
		Username: crawlUsername, Password: crawlPassword}
	argv := webtarget.SidecarCommand(crawlLoginURL, "1280x800", "/tmp/out", 30000, plan)
	joined := strings.Join(argv, " ")
	if strings.Contains(joined, crawlPassword) {
		t.Fatalf("the password reached argv: %s", joined)
	}
	if !strings.Contains(joined, "--max-pages 5") {
		t.Fatalf("the budget never reached the browser: %s", joined)
	}
	// the username is not a secret; it identifies the run
	if !strings.Contains(joined, crawlUsername) {
		t.Fatalf("the username never reached the browser: %s", joined)
	}

	env := webtarget.SidecarEnv(plan)
	if !hasEntry(env, webtarget.CrawlPasswordEnv+"="+crawlPassword) {
		t.Fatalf("the password never reached the child's environment")
	}
}

func TestCrawlAnInheritedPasswordCannotLeakIntoAnAnonymousCrawl(t *testing.T) {
	// A server process that happens to carry the variable must not make an
	// unauthenticated crawl sign in as somebody else.
	t.Setenv(webtarget.CrawlPasswordEnv, "somebody-elses-secret")
	for _, plan := range []*webtarget.CrawlPlan{nil, {MaxPages: 3}} {
		for _, entry := range webtarget.SidecarEnv(plan) {
			if strings.HasPrefix(entry, webtarget.CrawlPasswordEnv+"=") {
				t.Fatalf("an inherited secret survived into the child: %s", entry)
			}
		}
	}
}

func TestCrawlTheAuditTrailRecordsThatThereWereCredentialsNotWhatTheyWere(t *testing.T) {
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	accepted := startCrawl(t, headers, pid,
		M{"auth": M{"username": crawlUsername, "password": crawlPassword}})
	pollTerminal(t, headers, accepted["job_id"].(string))

	w := do(t, "GET", "/v1/audit", nil, headers)
	if w.Code != 200 {
		t.Fatalf("audit: %d %.200s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), crawlPassword) {
		t.Fatalf("the audit log leaked the password")
	}
	found := false
	for _, item := range jsonMap(t, w)["items"].([]any) {
		entry := item.(map[string]any)
		if entry["action"] != "web_target.requested" {
			continue
		}
		if entry["detail"].(map[string]any)["auth_configured"] == true {
			found = true
		}
	}
	if !found {
		t.Fatalf("the audit trail did not record that credentials were configured")
	}
}

// ---------------------------------------------------------------------------
// 3. A sign-in that fails is a failure, not a quieter success
// ---------------------------------------------------------------------------

func TestCrawlSuppliedCredentialsThatAreRejectedFailTheJob(t *testing.T) {
	for name, block := range map[string]any{
		"reported": map[string]any{"attempted": true, "succeeded": false,
			"error": "invalid credentials for Admin / admin123"},
		"silent": nil, // the sidecar said nothing at all about signing in
	} {
		t.Run(name, func(t *testing.T) {
			doc := loginPagePayload()
			if block != nil {
				doc["login"] = block
			}
			withCrawlSidecar(t, doc)
			headers, pid := crawlProject(t)
			job, accepted := runCrawl(t, headers, pid,
				M{"auth": M{"username": crawlUsername, "password": crawlPassword}})

			if job["status"] != "failed" {
				t.Fatalf("a rejected sign-in did not fail the job: %v", job)
			}
			code, _ := job["error_code"].(string)
			if code != "login_failed" {
				t.Fatalf("error_code %q, want login_failed", code)
			}
			message, _ := job["error"].(string)
			// Generic on purpose: naming the wrong half confirms the other exists.
			if strings.Contains(message, crawlUsername) ||
				strings.Contains(message, crawlPassword) {
				t.Fatalf("the failure echoed a credential: %s", message)
			}
			lower := strings.ToLower(message)
			if !strings.Contains(lower, "username") || !strings.Contains(lower, "password") {
				t.Fatalf("the failure does not say what to check: %s", message)
			}
			// the sidecar's own message carried both values; it was replaced
			if strings.Contains(lower, "invalid credentials") {
				t.Fatalf("the sidecar's message was forwarded verbatim: %s", message)
			}

			target := jsonMap(t, do(t, "GET",
				"/v1/web-targets/"+accepted["target_id"].(string), nil, headers))
			if target["status"] != "failed" {
				t.Fatalf("the target was not marked failed: %v", target["status"])
			}
		})
	}
}

func TestCrawlARejectedSignInPersistsNothingFromTheLoggedOutPage(t *testing.T) {
	// The failure mode this rule exists to stop: testing the logged-out product
	// and calling it the product.
	doc := loginPagePayload()
	doc["login"] = map[string]any{"attempted": true, "succeeded": false}
	withCrawlSidecar(t, doc)
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid,
		M{"auth": M{"username": crawlUsername, "password": crawlPassword}})
	if job["status"] != "failed" {
		t.Fatalf("expected a failed job")
	}
	var count int64
	db.DB.Model(&models.Requirement{}).Where("project_id = ?", pid).Count(&count)
	if count != 0 {
		t.Fatalf("a refused crawl persisted %d requirements", count)
	}
}

// ---------------------------------------------------------------------------
// 4. No credentials at all is an OUTCOME, not an error
// ---------------------------------------------------------------------------

func TestCrawlALoginPageWithNothingToTryReportsLoginRequired(t *testing.T) {
	withCrawlSidecar(t, loginPagePayload())
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid, M{})
	result := resultOf(t, job)

	if result["credentials_source"] != nil {
		t.Fatalf("a crawl with no credentials claimed a source: %v", result["credentials_source"])
	}
	login := result["login"].(map[string]any)
	if login["succeeded"] != false || login["required"] != true {
		t.Fatalf("login outcome %v", login)
	}
	// the form's OWN selectors, so the UI points at what the page rendered
	form := login["form"].(map[string]any)
	if form["selector"] != "form.oxd-form" {
		t.Fatalf("the login form was not named: %v", form)
	}
	if !hasEntry(anyList(form["fields"]), "input[name=password]") {
		t.Fatalf("the password field was not named: %v", form)
	}
	if !strings.Contains(result["outcome"].(string), "username and password") {
		t.Fatalf("the outcome does not say what would unlock the rest: %v", result["outcome"])
	}
	// and the public surface it COULD see was still reported
	if result["forms"] != float64(1) {
		t.Fatalf("the public surface was discarded: %v", result["forms"])
	}
}

func TestCrawlThePublicSurfaceIsStillWorthSomething(t *testing.T) {
	withCrawlSidecar(t, loginPagePayload())
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid, M{})
	total := 0.0
	for _, n := range resultOf(t, job)["cases_by_type"].(map[string]any) {
		total += n.(float64)
	}
	if total == 0 {
		t.Fatalf("a public page produced nothing at all")
	}
}

// ---------------------------------------------------------------------------
// 5. Where a credential came from is itself reported
// ---------------------------------------------------------------------------

func TestCrawlCredentialsThePagePublishesAboutItselfAreNamedAsSuch(t *testing.T) {
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid, M{})
	result := resultOf(t, job)

	if result["login"].(map[string]any)["succeeded"] != true {
		t.Fatalf("the recorded crawl did not report a sign-in")
	}
	if result["credentials_source"] != "page" {
		t.Fatalf("credentials_source %v, want page", result["credentials_source"])
	}
	if !strings.Contains(result["outcome"].(string), "publishes about itself") {
		t.Fatalf("the outcome hid where the credentials came from: %v", result["outcome"])
	}
}

func TestCrawlASuppliedCredentialIsNeverRelabelledAsAPageFact(t *testing.T) {
	// The document reports "page". When the operator supplied the credentials,
	// only THIS process knows that — and it is what decides.
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid,
		M{"auth": M{"username": crawlUsername, "password": crawlPassword}})
	result := resultOf(t, job)
	if result["credentials_source"] != "user" {
		t.Fatalf("a supplied credential was relabelled: %v", result["credentials_source"])
	}
	if strings.Contains(result["outcome"].(string), "publishes about itself") {
		t.Fatalf("the outcome misattributed the credentials: %v", result["outcome"])
	}
	blob, _ := json.Marshal(result)
	if strings.Contains(string(blob), crawlPassword) {
		t.Fatalf("the result leaked the password")
	}
}

func TestCrawlNormaliseLoginDropsTheOneFieldACredentialCouldHideIn(t *testing.T) {
	doc := map[string]any{"login": map[string]any{
		"attempted": true, "succeeded": true, "strategy": "url_changed",
		"credentials_source": "page", "error": "tried Admin / admin123"}}
	login := webtarget.NormaliseLogin(doc, false)
	blob, _ := json.Marshal(login)
	if strings.Contains(string(blob), crawlPassword) {
		t.Fatalf("the normalised login carried a credential: %s", blob)
	}
	// an unknown provenance is not passed through as though it meant something
	doc["login"].(map[string]any)["credentials_source"] = "telepathy"
	if got := webtarget.NormaliseLogin(doc, false).CredentialsSource; got != "" {
		t.Fatalf("an invented provenance survived: %q", got)
	}
}

func TestCrawlNormaliseLoginKeepsTheCodeAndDropsTheSentence(t *testing.T) {
	// The sidecar's login error is a {code, message} pair. The CODE is the
	// outcome and must survive — login_required lives in it — while the message
	// is free text about a failed sign-in, which is where a credential would hide.
	doc := map[string]any{"login": map[string]any{
		"attempted": true, "succeeded": true, "strategy": "url_changed",
		"credentials_source": "page",
		"error": map[string]any{"code": "login_required",
			"message": "tried " + crawlUsername + " / " + crawlPassword}}}
	login := webtarget.NormaliseLogin(doc, false)
	if login.Error != "login_required" {
		t.Fatalf("the login verdict was lost: %q", login.Error)
	}
	blob, _ := json.Marshal(login)
	if strings.Contains(string(blob), crawlPassword) ||
		strings.Contains(string(blob), crawlUsername) {
		t.Fatalf("the normalised login carried a credential: %s", blob)
	}
	// an invented code is not passed through as though it were meaningful
	doc["login"].(map[string]any)["error"] = map[string]any{
		"code": "definitely_fine", "message": "x"}
	if got := webtarget.NormaliseLogin(doc, false).Error; got != "" {
		t.Fatalf("an invented code survived: %q", got)
	}
	// ...and neither is a bare sentence with no code at all
	doc["login"].(map[string]any)["error"] = "tried " + crawlUsername + " / " + crawlPassword
	if got := webtarget.NormaliseLogin(doc, false).Error; got != "" {
		t.Fatalf("a free-text error survived: %q", got)
	}
}

func TestCrawlLoginRequiredReachesThePayloadFromTheSidecarsVerdict(t *testing.T) {
	// The crawler's own verdict, not only our re-reading of the DOM: a page whose
	// form we could not parse must still be reported as gated.
	doc := loginPagePayload()
	doc["login"] = map[string]any{"attempted": false, "succeeded": false,
		"error": map[string]any{"code": "login_required",
			"message": "no credentials were available"}}
	doc["forms"] = []any{} // nothing for LoginForm() to find
	withCrawlSidecar(t, doc)
	headers, pid := crawlProject(t)
	job, accepted := runCrawl(t, headers, pid, M{})
	result := resultOf(t, job)

	login := result["login"].(map[string]any)
	if login["error"] != "login_required" || login["required"] != true ||
		login["succeeded"] != false {
		t.Fatalf("a gated page was not reported as gated: %v", login)
	}
	if !strings.Contains(result["outcome"].(string), "username and password") {
		t.Fatalf("the outcome does not say what would unlock it: %v", result["outcome"])
	}
	detail := jsonMap(t, do(t, "GET",
		"/v1/web-targets/"+accepted["target_id"].(string), nil, headers))
	stored := detail["inventory"].(map[string]any)["login"].(map[string]any)
	if stored["error"] != "login_required" {
		t.Fatalf("the stored inventory lost the verdict: %v", stored)
	}
}

// ---------------------------------------------------------------------------
// 6. Every page the crawl reached produces its own work
// ---------------------------------------------------------------------------

func TestCrawlAccountsForEveryPageVisitedAndEveryPageRefused(t *testing.T) {
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid, M{})
	result := resultOf(t, job)

	if result["pages_visited"] != float64(3) {
		t.Fatalf("pages_visited %v, want 3", result["pages_visited"])
	}
	reasons := []string{}
	for _, entry := range result["pages_skipped"].([]any) {
		reasons = append(reasons, entry.(map[string]any)["reason"].(string))
	}
	if len(reasons) != 4 {
		t.Fatalf("pages_skipped %v", reasons)
	}
	// the safety rule, visible in the report rather than only in the crawler
	joined := strings.Join(reasons, " | ")
	for _, want := range []string{"Logout", "Delete", "origin"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("the skip list never mentions %s: %s", want, joined)
		}
	}
}

func TestCrawlEachPageStatesItsOwnRequirementsUnderItsOwnID(t *testing.T) {
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	job, _ := runCrawl(t, headers, pid,
		M{"test_types": []string{"functional", "performance"}})
	resultOf(t, job)

	var rows []models.Requirement
	db.DB.Where("project_id = ?", pid).Find(&rows)
	functional, performance := 0, 0
	seen := map[string]bool{}
	for _, r := range rows {
		if seen[r.ExternalID] {
			t.Fatalf("two requirements share the id %s", r.ExternalID)
		}
		seen[r.ExternalID] = true
		switch {
		case strings.HasSuffix(r.ExternalID, "-PERF"):
			performance++
		case strings.Contains(r.ExternalID, "-F"):
			functional++
		}
	}
	// one requirement per form, and the three pages each carry one
	if functional != 3 {
		t.Fatalf("functional requirements: %d, want 3 (%v)", functional, seen)
	}
	// every page with a baseline gets its own performance statement
	if performance != 3 {
		t.Fatalf("performance requirements: %d, want 3 (%v)", performance, seen)
	}
}

func TestCrawlReCrawlingRefreshesTheSameRequirementsInsteadOfForkingThem(t *testing.T) {
	withCrawlSidecar(t, crawlPayload(t))
	headers, pid := crawlProject(t)
	ids := func() []string {
		var rows []models.Requirement
		db.DB.Where("project_id = ?", pid).Order("external_id").Find(&rows)
		out := []string{}
		for _, r := range rows {
			out = append(out, r.ExternalID)
		}
		return out
	}
	runCrawl(t, headers, pid, M{"test_types": []string{"functional"}})
	first := ids()
	runCrawl(t, headers, pid, M{"test_types": []string{"functional"}})
	second := ids()

	if len(first) == 0 || strings.Join(first, ",") != strings.Join(second, ",") {
		t.Fatalf("a re-crawl forked the requirements:\n  %v\n  %v", first, second)
	}
}

func TestCrawlAPageTokenIsAPropertyOfThePageNotOfItsPosition(t *testing.T) {
	pages := []webtarget.Inventory{
		{FinalURL: "http://x/a"}, {FinalURL: "http://x/b"}, {FinalURL: "http://x/c"},
	}
	tokens := []string{}
	for i, page := range pages {
		tokens = append(tokens, webtarget.PageToken(page, i))
	}
	// the target itself keeps the established scheme
	if tokens[0] != "" {
		t.Fatalf("the target page was re-keyed: %q", tokens[0])
	}
	if tokens[1] == tokens[2] {
		t.Fatalf("two pages share a token: %v", tokens)
	}
	// the same page keeps its token when something ahead of it disappears
	if webtarget.PageToken(pages[2], 1) != webtarget.PageToken(pages[2], 2) {
		t.Fatalf("a page's id depends on its position in the crawl")
	}
}

func TestCrawlRequestsAreDeduplicatedAcrossPagesButNotWithinOne(t *testing.T) {
	status := 200
	shell := webtarget.Request{Method: "GET", URL: "http://x/api/me",
		ResourceType: "xhr", Status: &status}
	pages := []webtarget.Inventory{
		{Requests: []webtarget.Request{shell, shell}}, // called twice on one page
		{Requests: []webtarget.Request{shell}},        // the same call on the next page
	}
	if got := len(webtarget.CrawlRequests(pages)); got != 2 {
		t.Fatalf("crawl requests: %d, want 2 (a repeat within a page is a second "+
			"observation; the same capture on the next page is not)", got)
	}
}

// ---------------------------------------------------------------------------
// 7. Grounding — with an oracle shown failing before it is trusted
// ---------------------------------------------------------------------------

func TestCrawlTheGroundingOracleCanFail(t *testing.T) {
	// A gate that has never rejected anything is not evidence.
	pages := webtarget.NormalisePages(crawlPayload(t))
	pageOne := webtarget.ArtefactIDs(pages[0], nil)
	pageTwo := webtarget.ArtefactIDs(pages[1], nil)
	borrowed := []string{"selector:" + pages[1].Forms[0].Selector}

	if len(webtarget.GroundingViolations(borrowed, pageOne)) == 0 {
		t.Fatalf("the oracle accepted a selector from another page")
	}
	if len(webtarget.GroundingViolations(borrowed, pageTwo)) != 0 {
		t.Fatalf("the oracle rejected a selector the page does have")
	}
}

func TestCrawlNoCaseMayCiteAPageTheCrawlNeverVisited(t *testing.T) {
	pages := webtarget.NormalisePages(crawlPayload(t))
	ids := webtarget.ArtefactIDs(pages[0], nil)
	unvisited := []string{"page:http://localhost:8017/web/index.php/admin/secret"}
	if len(webtarget.GroundingViolations(unvisited, ids)) == 0 {
		t.Fatalf("a case cited a page the crawl never visited")
	}
}

func TestCrawlEveryCaseFromAPageCitesThatPage(t *testing.T) {
	pages := webtarget.NormalisePages(crawlPayload(t))
	for _, page := range pages {
		ids := webtarget.ArtefactIDs(page, nil)
		for _, form := range page.Forms {
			cases := webtarget.FormCases(form, page)
			if len(cases) == 0 {
				t.Fatalf("a form produced no case at all: %s", form.Selector)
			}
			for _, kase := range cases {
				if len(webtarget.GroundingViolations(kase.Grounds, ids)) != 0 {
					t.Fatalf("case %q cites something this page never produced: %v",
						kase.Title, kase.Grounds)
				}
				cited := false
				for _, g := range kase.Grounds {
					if strings.HasPrefix(g, "page:") {
						cited = true
					}
				}
				if !cited {
					t.Fatalf("case %q does not say which page it is about", kase.Title)
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 8. The outcome reads like a report
// ---------------------------------------------------------------------------

func TestCrawlEveryOutcomeIsASentenceWithTheNumbersInIt(t *testing.T) {
	signedInByPage := webtarget.LoginOutcome(&webtarget.LoginReport{
		Attempted: true, Succeeded: true, Strategy: "url_changed",
		CredentialsSource: "page"}, webtarget.Inventory{})
	sentence := webtarget.OutcomeSentence(signedInByPage, 12, 3, 8, 40)
	if !strings.HasPrefix(sentence,
		"Signed in with the credentials the sign-in page publishes") {
		t.Fatalf("outcome: %s", sentence)
	}
	if !strings.Contains(sentence, "12 pages (3 skipped)") ||
		!strings.Contains(sentence, "40 test cases") {
		t.Fatalf("the outcome lost its numbers: %s", sentence)
	}

	gated := webtarget.LoginOutcome(nil, webtarget.Inventory{Forms: []webtarget.Form{{
		Selector: "form", Fields: []webtarget.Field{{Selector: "#p", Type: "password"}}}}})
	if !strings.Contains(webtarget.OutcomeSentence(gated, 1, 0, 1, 2),
		"unlocks the pages behind the form") {
		t.Fatalf("a gated crawl did not say what would unlock it")
	}

	plain := webtarget.LoginOutcome(nil, webtarget.Inventory{})
	if got := webtarget.OutcomeSentence(plain, 1, 0, 1, 1); got !=
		"Crawled 1 page, producing 1 requirement and 1 test case." {
		t.Fatalf("plain outcome: %q", got)
	}
}

// hasEntry is membership in a string slice.
func hasEntry(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// anyList renders a []any of strings for comparison.
func anyList(v any) []string {
	out := []string{}
	for _, item := range v.([]any) {
		out = append(out, item.(string))
	}
	return out
}
