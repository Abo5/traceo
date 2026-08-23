// Browser verification runs — execute the cases a web-target scan generated.
//
// A scan writes grounded draft cases from what the render actually contained.
// Those cases assert DOM facts (elements_present, validation_error,
// pattern_enforced, …) and the HTTP execution engine's evaluator skips assertion
// types it does not know rather than failing them — so running scanned cases
// through it reported every one green while checking none of them. A green badge
// over an unverified page is worse than no badge, so this file gives those cases
// the runner they were written for: the same real browser that discovered them,
// driven by tools/web-discovery/check.mjs.
//
// It lives in the webtarget package, not a webverify one as in the Python
// backend, because every sidecar helper it needs — the error taxonomy, the
// install hint, the JSON-document reader — is unexported here. Splitting the
// file would mean widening webtarget's API purely to satisfy a file boundary.
//
// Two decisions worth stating.
//
// Drafts run; nothing is auto-approved. A verification run executes the target's
// cases in whatever state they are in and never changes that state — it answers
// "what would these find?", the question you have BEFORE you approve.
//
// A skipped check is never a pass. The sidecar reports `skipped` with a reason
// for anything it cannot evaluate, and those land in the result as skipped. The
// failure mode this whole file exists to remove must not reappear one level up.
package webtarget

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
)

// browserChecks are the checks this runner understands. A case whose steps carry
// none of them is not a browser case and belongs to the HTTP engine instead.
var browserChecks = map[string]bool{
	"elements_present": true, "required_field_enforced": true,
	"maxlength_enforced": true, "pattern_enforced": true, "page_load_ms": true,
	// input validation: a concrete value typed into the field, and whether the
	// page stands by the rule it declared about it
	"value_rejected": true, "value_accepted": true, "whitespace_rejected": true,
	// functionality: what the form DOES once it is filled in correctly
	"happy_path": true, "error_recovery": true, "submit_gated": true,
	"conditional_fields": true, "initial_state": true, "links_resolve": true,
}

// ---------------------------------------------------------------------------
// sidecar
// ---------------------------------------------------------------------------

// CheckCommand is the argv for the browser-check sidecar.
func CheckCommand(planPath string, timeoutMS int) []string {
	return []string{config.C.NodeBin, config.C.WebCheckScript,
		"--plan", planPath, "--timeout", fmt.Sprintf("%d", timeoutMS)}
}

// RunCheckSidecar drives the browser over `plan` and returns the sidecar's JSON
// document. Mirrors RunSidecar, including its one non-negotiable: a missing
// sidecar raises rather than returning an empty result, because "no findings"
// and "nothing ran" must never look the same to a caller.
func RunCheckSidecar(plan map[string]any, timeoutS float64) (map[string]any, error) {
	script := config.C.WebCheckScript
	if info, err := os.Stat(script); err != nil || info.IsDir() {
		return nil, jobs.Fail(BrowserUnavailable,
			installHint("The browser-check sidecar is missing at "+script+"."))
	}
	if timeoutS <= 0 {
		timeoutS = config.C.WebCheckTimeout
	}

	tmp, err := os.CreateTemp("", "traceo-plan-*.json")
	if err != nil {
		return nil, jobs.Fail("check_failed", "Could not write the check plan: "+err.Error())
	}
	planPath := tmp.Name()
	defer os.Remove(planPath)
	if err := json.NewEncoder(tmp).Encode(plan); err != nil {
		tmp.Close()
		return nil, jobs.Fail("check_failed", "Could not write the check plan: "+err.Error())
	}
	tmp.Close()

	ctx, cancel := context.WithTimeout(context.Background(),
		time.Duration((timeoutS+30.0)*float64(time.Second)))
	defer cancel()

	// --timeout is the sidecar's PER-CHECK navigation ceiling, capped at 120s;
	// the process kill deadline above is the whole-plan one.
	perCheckMS := int(timeoutS * 1000)
	if perCheckMS > 120000 {
		perCheckMS = 120000
	}
	argv := CheckCommand(planPath, perCheckMS)
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = filepath.Dir(script)
	cmd.Env = SidecarEnv(nil)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	if ctx.Err() == context.DeadlineExceeded {
		return nil, jobs.Fail("check_timeout", fmt.Sprintf(
			"The browser did not finish the checks within %.0fs — raise "+
				"TRACEO_WEB_CHECK_TIMEOUT_S or narrow the run.", timeoutS+30.0))
	}
	var execErr *exec.Error
	if errors.As(runErr, &execErr) || errors.Is(runErr, exec.ErrNotFound) ||
		errors.Is(runErr, fs.ErrNotExist) || errors.Is(runErr, fs.ErrPermission) {
		return nil, jobs.Fail(BrowserUnavailable, installHint(
			fmt.Sprintf("Node.js was not found (tried '%s').", config.C.NodeBin)))
	}

	errText := strings.TrimSpace(stderr.String())
	lower := strings.ToLower(errText)
	for _, marker := range unavailableMarkers {
		if strings.Contains(lower, marker) {
			return nil, jobs.Fail(BrowserUnavailable,
				installHint("The browser-check sidecar could not start Playwright."))
		}
	}
	doc := firstJSONObject(stdout.String())
	if doc == nil {
		if runErr != nil {
			detail := errText
			if detail == "" {
				detail = "no output"
			}
			if len(detail) > 500 {
				detail = detail[:500]
			}
			return nil, jobs.Fail("check_failed",
				"The browser-check sidecar exited with an error: "+detail)
		}
		return nil, jobs.Fail("check_failed",
			"The browser-check sidecar produced no JSON document.")
	}
	if code, message, reported := payloadError(doc); reported {
		if unavailableCodes[code] {
			return nil, jobs.Fail(BrowserUnavailable, installHint(message))
		}
		return nil, jobs.Fail(code, message)
	}
	return doc, nil
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

func stepReqString(step *models.TestStep, key string) string {
	if step.Request == nil {
		return ""
	}
	if v, ok := step.Request[key].(string); ok {
		return v
	}
	return ""
}

// BrowserCase pairs a case with the browser steps that belong to this target.
type BrowserCase struct {
	Case  *models.TestCase
	Steps []*models.TestStep
}

// CollectBrowserCases returns this target's browser cases.
//
// A case belongs to the target when its steps carry one of browserChecks and
// name the URL this target rendered. Matching on the recorded URL (rather than
// on "everything in the project") is what keeps two targets in one project from
// verifying each other's pages.
func CollectBrowserCases(orgID, projectID string, target *models.WebTarget) []BrowserCase {
	urls := map[string]bool{}
	for _, u := range []string{target.URL, target.FinalURL} {
		if u != "" {
			urls[u] = true
		}
	}

	var cases []models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ? AND state != ?",
		projectID, orgID, "archived").Order("created_at asc").Find(&cases)
	if len(cases) == 0 {
		return nil
	}
	ids := make([]string, 0, len(cases))
	for i := range cases {
		ids = append(ids, cases[i].ID)
	}
	var steps []models.TestStep
	db.DB.Where("test_case_id IN ?", ids).Order("step_order asc").Find(&steps)
	byCase := map[string][]*models.TestStep{}
	for i := range steps {
		s := &steps[i]
		byCase[s.TestCaseID] = append(byCase[s.TestCaseID], s)
	}

	out := []BrowserCase{}
	for i := range cases {
		c := &cases[i]
		var browserSteps []*models.TestStep
		for _, s := range byCase[c.ID] {
			if browserChecks[stepReqString(s, "check")] {
				browserSteps = append(browserSteps, s)
			}
		}
		if len(browserSteps) == 0 {
			continue
		}
		if len(urls) > 0 {
			matched := false
			for _, s := range browserSteps {
				if urls[stepReqString(s, "url")] {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
		}
		out = append(out, BrowserCase{Case: c, Steps: browserSteps})
	}
	return out
}

// EnsureEnvironment returns the environment a scanned run points at, derived
// from the target itself. A Run requires an environment; a scanned page already
// states its own origin, so asking the user to type one would be asking for
// something we know. The row is reused on later verifications of the same origin.
func EnsureEnvironment(orgID, projectID string, target *models.WebTarget) (*models.Environment, error) {
	originSrc := target.FinalURL
	if originSrc == "" {
		originSrc = target.URL
	}
	baseURL := originSrc
	host := "target"
	scheme := ""
	if parsed, err := url.Parse(originSrc); err == nil && parsed.Scheme != "" && parsed.Host != "" {
		baseURL = parsed.Scheme + "://" + parsed.Host
		host = parsed.Host
		scheme = parsed.Scheme
	}

	var existing models.Environment
	if err := db.DB.Where("project_id = ? AND organisation_id = ? AND base_url = ?",
		projectID, orgID, baseURL).First(&existing).Error; err == nil {
		return &existing, nil
	}

	name := host + " (scanned)"
	if len(name) > 100 {
		name = name[:100]
	}
	if len(baseURL) > 500 {
		baseURL = baseURL[:500]
	}
	strict := scheme != "http"
	env := &models.Environment{
		OrganisationID: orgID, ProjectID: projectID,
		Name: name, BaseURL: baseURL, AuthType: "none",
		Variables: models.JSONMap{}, TLSStrict: &strict,
	}
	if err := db.DB.Create(env).Error; err != nil {
		return nil, err
	}
	return env, nil
}

// ---------------------------------------------------------------------------
// the job
// ---------------------------------------------------------------------------

func planCase(bc BrowserCase) map[string]any {
	checks := make([]map[string]any, 0, len(bc.Steps))
	for _, s := range bc.Steps {
		req := map[string]any{}
		for k, v := range s.Request {
			req[k] = v
		}
		assertions := []any{}
		if s.Assertions != nil {
			assertions = append(assertions, s.Assertions...)
		}
		checks = append(checks, map[string]any{"request": req, "assertions": assertions})
	}
	return map[string]any{"id": bc.Case.ID, "title": bc.Case.Title, "checks": checks}
}

// evidenceFor builds one evidence block per case, in the shape the report renders.
func evidenceFor(assertions []any, durationMs int, pageURL string) models.JSONList {
	rendered := make([]any, 0, len(assertions))
	for _, raw := range assertions {
		a, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		spec := map[string]any{"type": a["type"], "expected": a["expected"]}
		if sel, ok := a["selector"].(string); ok && sel != "" {
			spec["selector"] = sel
		}
		entry := map[string]any{
			"assertion": spec,
			"outcome":   a["outcome"],
			"actual":    a["actual"],
		}
		if msg, ok := a["message"].(string); ok && msg != "" {
			entry["message"] = msg
		}
		rendered = append(rendered, entry)
	}
	return models.JSONList{map[string]any{
		"request": map[string]any{
			"method": "BROWSER", "url": pageURL,
			"headers": map[string]any{}, "body": nil,
		},
		"response": map[string]any{
			"status": nil, "headers": map[string]any{},
			"body": fmt.Sprintf("%d browser assertion(s)", len(rendered)),
		},
		"elapsed_ms": durationMs,
		"assertions": rendered,
	}}
}

// RunVerify executes a target's browser cases and records one TestResult each.
func RunVerify(job *jobs.Job, orgID, userID, projectID, targetID, runID string,
	allowSubmit bool) (any, error) {
	var target models.WebTarget
	var run models.Run
	if err := db.DB.First(&target, "id = ?", targetID).Error; err != nil {
		return nil, jobs.Fail("not_found", "The target or run disappeared before the check started.")
	}
	if err := db.DB.First(&run, "id = ?", runID).Error; err != nil {
		return nil, jobs.Fail("not_found", "The target or run disappeared before the check started.")
	}

	selected := CollectBrowserCases(orgID, projectID, &target)
	now := time.Now().UTC()
	run.State = "running"
	run.StartedAt = &now
	db.DB.Save(&run)

	if len(selected) == 0 {
		finish := time.Now().UTC()
		run.State = "completed"
		run.FinishedAt = &finish
		run.Counts = models.JSONMap{"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0}
		db.DB.Save(&run)
		return map[string]any{"run_id": run.ID, "counts": run.Counts,
			"note": "This target has no browser cases — scan it with the " +
				"functional or performance test type first."}, nil
	}

	pageURL := target.FinalURL
	if pageURL == "" {
		pageURL = target.URL
	}
	viewport := target.Viewport
	if viewport == "" {
		viewport = "1280x800"
	}
	planCases := make([]map[string]any, 0, len(selected))
	for _, bc := range selected {
		planCases = append(planCases, planCase(bc))
	}
	plan := map[string]any{
		"url":      pageURL,
		"viewport": viewport,
		// OFF by default: a real submission creates data on the target. The runner
		// intercepts and aborts the outbound request instead, which still proves
		// the form wired its submit up.
		"allow_submit": allowSubmit,
		"cases":        planCases,
	}

	job.Set(0.1, fmt.Sprintf("Checking %d case(s) in a browser", len(selected)))
	doc, err := RunCheckSidecar(plan, 0)
	if err != nil {
		aborted := time.Now().UTC()
		run.State = "aborted"
		run.FinishedAt = &aborted
		db.DB.Save(&run)
		return nil, err
	}

	byID := map[string]map[string]any{}
	if results, ok := doc["results"].([]any); ok {
		for _, raw := range results {
			if r, ok := raw.(map[string]any); ok {
				if id, ok := r["case_id"].(string); ok {
					byID[id] = r
				}
			}
		}
	}

	counts := map[string]int{"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0}
	for _, bc := range selected {
		result, present := byID[bc.Case.ID]
		outcome := "errored"
		duration := 0
		var failure models.JSONMap
		var assertions []any
		if !present {
			// The sidecar returns one entry per planned case; a gap means the
			// browser died mid-plan. Recording it as errored keeps the run's
			// arithmetic honest instead of quietly shrinking the total.
			failure = models.JSONMap{
				"message":  "The browser produced no result for this case.",
				"expected": nil, "actual": nil, "selector": nil, "assertion": nil,
			}
		} else {
			if v, ok := result["outcome"].(string); ok && v != "" {
				outcome = v
			}
			if v, ok := result["duration_ms"].(float64); ok {
				duration = int(v)
			}
			if v, ok := result["failure"].(map[string]any); ok {
				failure = models.JSONMap(v)
			}
			if v, ok := result["assertions"].([]any); ok {
				assertions = v
			}
		}

		counts["total"]++
		counts[outcome]++
		var reason models.JSONMap
		if outcome == "failed" || outcome == "errored" {
			reason = failure
		}
		db.DB.Create(&models.TestResult{
			RunID: run.ID, TestCaseID: bc.Case.ID, TestCaseVersion: 1,
			// A skipped case is not a passed case: the DB stores what happened.
			Outcome: outcome, DurationMs: duration,
			FailureReason: reason,
			Evidence:      evidenceFor(assertions, duration, pageURL),
		})
	}

	finish := time.Now().UTC()
	run.State = "completed"
	run.FinishedAt = &finish
	run.Counts = models.JSONMap{}
	for k, v := range counts {
		run.Counts[k] = v
	}
	db.DB.Save(&run)

	detail := models.JSONMap{"target_id": targetID, "url": pageURL}
	for k, v := range counts {
		detail[k] = v
	}
	httpx.Audit(orgID, &userID, "web_target.verified", "run", run.ID, detail)

	return map[string]any{"run_id": run.ID, "counts": run.Counts,
		"url": pageURL, "load_ms": doc["load_ms"]}, nil
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

// registerVerify mounts the verification route. Called from Register so the
// package keeps presenting one registration point to main.
func registerVerify(g *gin.RouterGroup) {
	g.POST("/web-targets/:target_id/verify", httpx.Require("trigger_run"),
		func(c *gin.Context) {
			target, ok := targetScoped(c)
			if !ok {
				return
			}
			if target.Status != "discovered" {
				httpx.Err(c, http.StatusConflict, "target_not_ready",
					"Scan this target successfully before verifying it.")
				return
			}
			user := httpx.User(c)
			selected := CollectBrowserCases(user.OrganisationID, target.ProjectID, target)
			if len(selected) == 0 {
				httpx.Err(c, http.StatusUnprocessableEntity, "no_browser_cases",
					"This target has no browser-checkable cases. Re-scan it with "+
						"the functional or performance test type enabled.")
				return
			}
			env, err := EnsureEnvironment(user.OrganisationID, target.ProjectID, target)
			if err != nil {
				httpx.Err(c, http.StatusInternalServerError, "environment_failed", err.Error())
				return
			}
			run := &models.Run{
				OrganisationID: user.OrganisationID, ProjectID: target.ProjectID,
				EnvironmentID: env.ID, Kind: "functional", State: "queued",
				Counts: models.JSONMap{"total": len(selected), "passed": 0,
					"failed": 0, "errored": 0},
				InitiatedBy: user.ID,
			}
			if err := db.DB.Create(run).Error; err != nil {
				httpx.Err(c, http.StatusInternalServerError, "run_failed", err.Error())
				return
			}
			pageURL := target.FinalURL
			if pageURL == "" {
				pageURL = target.URL
			}
			httpx.Audit(user.OrganisationID, &user.ID, "web_target.verify_requested",
				"web_target", target.ID,
				models.JSONMap{"cases": len(selected), "url": pageURL})

			orgID, userID, projectID, targetID, runID :=
				user.OrganisationID, user.ID, target.ProjectID, target.ID, run.ID
			job := jobs.SubmitForProject("web_verify", projectID, func(j *jobs.Job) (any, error) {
				return RunVerify(j, orgID, userID, projectID, targetID, runID, false)
			})
			c.JSON(http.StatusAccepted, gin.H{
				"job_id": job.ID, "run_id": runID, "cases": len(selected),
				"environment_id": env.ID})
		})
}
