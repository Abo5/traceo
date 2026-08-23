// Package pipeline runs the whole testing process as one job.
//
// Traceo already had every stage as its own endpoint: parse a document, scan a
// URL, generate cases, run them, read the report. That is the right
// decomposition for an API and the wrong shape for the question a user actually
// arrives with — "here is my site, is it broken?" — because answering it meant
// driving five routes in the right order and knowing which ones to skip.
//
// This package composes those stages without duplicating any of them. It calls
// the same job bodies the individual endpoints call, so there is one
// implementation of each engine and this file only decides the order and what to
// do when a stage produces nothing.
//
//	document? ─▶ parse ─┐
//	                    ├─▶ scan URL ─▶ generate? ─┬─▶ browser run ─┐
//	url + test types ───┘                          └─▶ HTTP run ────┴─▶ counts + fix prompts
//
// Three properties worth stating.
//
// The document is optional, and its absence is not a degraded mode. With a BRD
// the scan's findings get checked against what you SAID should happen; without
// one they are checked against what the page itself declares (a `required`
// attribute is a claim, and a form that ignores it is a defect whether or not a
// document mentions it). Skipping the stage is recorded in stages, never
// silently.
//
// Scope is this target, not the project. A project with 500 existing cases does
// not re-run all of them because you pointed the pipeline at one page: the
// browser side selects by the scanned URL, the HTTP side by cases that call an
// endpoint discovered from it (plus anything this job created). Provenance, not
// recency — selecting on "new since I started" made a SECOND run over the same
// page skip the cases the first run had already created, including the one that
// failed.
//
// Nothing is approved. Cases run in whatever state they are in and stay there;
// approval remains a human act.
package pipeline

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/execution"
	"traceo/internal/modules/fixprompt"
	"traceo/internal/modules/generation"
	"traceo/internal/modules/ingestion"
	"traceo/internal/modules/reporting"
	"traceo/internal/modules/traceability"
	"traceo/internal/modules/webtarget"
)

// ---------------------------------------------------------------------------
// request
// ---------------------------------------------------------------------------

type request struct {
	URL       string   `json:"url"`
	Viewport  string   `json:"viewport"`
	TestTypes []string `json:"test_types"`
	// Optional: upload with POST /projects/{id}/documents first, pass the id here.
	DocumentID string `json:"document_id"`
	// Let a correctly-filled form actually submit. OFF by default because a real
	// submission creates data on the target; with it off the runner intercepts
	// and aborts the request instead, and any case that genuinely needs a real
	// submit is recorded skipped with that reason rather than passed.
	AllowSubmit bool `json:"allow_submit"`
}

// ---------------------------------------------------------------------------
// case selection
// ---------------------------------------------------------------------------

// discoveredEndpointIDs are the endpoints this project learned from a rendered
// page (source "dom").
func discoveredEndpointIDs(orgID, projectID string) map[string]bool {
	var ids []string
	db.DB.Model(&models.Endpoint{}).
		Where("project_id = ? AND organisation_id = ? AND source = ?", projectID, orgID, "dom").
		Pluck("id", &ids)
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// httpRunnable returns the HTTP-executable cases that belong to this target.
//
// A case qualifies when it has a step with a path and no DOM `check` — the same
// split the browser runner makes, read from the other side — AND it belongs to
// this run: either this job created it, or it calls an endpoint discovered from
// the page this job scanned.
//
// That second clause is load-bearing. Selecting purely on "created by this job"
// looked right and was wrong: on a SECOND run over the same page the scan
// recognises its cases as duplicates and does not recreate them, so they fall
// outside the new-id set and are never executed. The observed result was a re-run
// that quietly stopped checking the security case that had failed the first time
// and reported all-green — the exact failure this whole feature exists to
// prevent, one level up. Provenance is stable across re-runs; "new since I
// started" is not.
func httpRunnable(orgID, projectID string, onlyIDs, endpointIDs map[string]bool) []string {
	if len(onlyIDs) == 0 && len(endpointIDs) == 0 {
		return nil
	}
	var cases []models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ? AND state != ?",
		projectID, orgID, "archived").Find(&cases)
	if len(cases) == 0 {
		return nil
	}
	ids := make([]string, 0, len(cases))
	for i := range cases {
		ids = append(ids, cases[i].ID)
	}
	var steps []models.TestStep
	db.DB.Where("test_case_id IN ?", ids).Find(&steps)
	byCase := map[string][]*models.TestStep{}
	for i := range steps {
		s := &steps[i]
		byCase[s.TestCaseID] = append(byCase[s.TestCaseID], s)
	}

	out := []string{}
	for i := range cases {
		c := &cases[i]
		mine := byCase[c.ID]
		if len(mine) == 0 {
			continue
		}
		hasBrowserCheck, hasPath, endpointMatch := false, false, false
		for _, s := range mine {
			if s.Request != nil {
				if check, ok := s.Request["check"].(string); ok && check != "" {
					hasBrowserCheck = true
				}
			}
			if s.Path != "" {
				hasPath = true
			}
			if s.EndpointID != nil && endpointIDs[*s.EndpointID] {
				endpointMatch = true
			}
		}
		if hasBrowserCheck || !hasPath {
			continue
		}
		if onlyIDs[c.ID] || endpointMatch {
			out = append(out, c.ID)
		}
	}
	return out
}

func caseIDSet(orgID, projectID string) map[string]bool {
	var ids []string
	db.DB.Model(&models.TestCase{}).
		Where("project_id = ? AND organisation_id = ?", projectID, orgID).
		Pluck("id", &ids)
	out := make(map[string]bool, len(ids))
	for _, id := range ids {
		out[id] = true
	}
	return out
}

// ---------------------------------------------------------------------------
// the job
// ---------------------------------------------------------------------------

type stageNote map[string]any

// Run executes the whole chain and returns the composed result.
func Run(job *jobs.Job, orgID, userID, projectID, url, viewport string,
	testTypes []string, documentID string, allowSubmit bool) (any, error) {
	stages := []stageNote{}
	runsOut := []map[string]any{}

	note := func(name, status string, detail stageNote) {
		entry := stageNote{"stage": name, "status": status}
		for k, v := range detail {
			entry[k] = v
		}
		stages = append(stages, entry)
	}

	// Everything that already existed is not this run's business.
	before := caseIDSet(orgID, projectID)

	// ---- 1. requirements (optional) ---------------------------------------
	alreadyParsed := false
	if documentID != "" {
		var doc models.SourceDocument
		if err := db.DB.First(&doc, "id = ?", documentID).Error; err == nil {
			alreadyParsed = doc.ParseStatus == "parsed"
		}
	}
	switch {
	case documentID != "" && alreadyParsed:
		// The upload route parses on arrival, so a UI that shows you "28 rules
		// found" before you press Start has already done this stage. Re-running it
		// would re-diff the same file to a row of zeros and read like the document
		// had no content.
		note("requirements", "reused", stageNote{
			"reason": "This document was already parsed on upload; its requirements are in use."})
	case documentID != "":
		job.Set(0.02, "Reading the requirements document…")
		res, err := ingestion.RunIngest(job.Scoped(0.02, 0.18, "Requirements"),
			documentID, projectID, orgID, userID)
		if err != nil {
			// A document we cannot read must not sink the run: the scan alone is
			// still a real answer. Say so rather than failing everything.
			note("requirements", "failed", stageNote{"reason": clip(err.Error(), 300)})
		} else {
			note("requirements", "completed", stageNote{"counts": res})
		}
	default:
		note("requirements", "skipped", stageNote{
			"reason": "No document was provided — the scan checks the page against " +
				"what it declares about itself."})
	}

	// ---- 2. scan the target ------------------------------------------------
	job.Set(0.20, "Opening the page in a browser…")
	var target models.WebTarget
	err := db.DB.Where("project_id = ? AND organisation_id = ? AND url = ? AND viewport = ?",
		projectID, orgID, url, viewport).First(&target).Error
	if err != nil {
		target = models.WebTarget{OrganisationID: orgID, ProjectID: projectID,
			URL: url, Viewport: viewport, Status: "pending"}
		if err := db.DB.Create(&target).Error; err != nil {
			return nil, jobs.Fail("pipeline_failed", "Could not record the target: "+err.Error())
		}
	} else {
		target.Status = "pending"
		target.LastError = nil
		db.DB.Save(&target)
	}
	targetID := target.ID

	scan, err := webtarget.RunDiscovery(job.Scoped(0.20, 0.55, "Scan"),
		orgID, userID, projectID, targetID, url, viewport, testTypes)
	if err != nil {
		return nil, err
	}
	scanMap, _ := scan.(map[string]any)
	note("scan", "completed", stageNote{
		"forms": pick(scanMap, "forms"), "requests": pick(scanMap, "requests"),
		"endpoints": pick(scanMap, "endpoints"), "requirements": pick(scanMap, "requirements"),
		"cases_by_type": pick(scanMap, "cases_by_type"), "skipped": pick(scanMap, "skipped")})

	// ---- 3. generate from the requirements (only when something needs it) ---
	var endpointCount, uncovered int64
	db.DB.Model(&models.Endpoint{}).
		Where("project_id = ? AND organisation_id = ?", projectID, orgID).Count(&endpointCount)
	// Confirmed requirements that no case covers yet. Without this gate a re-run
	// regenerates over requirements that already have cases, and the project
	// accumulates a fresh near-duplicate on every run.
	db.DB.Model(&models.Requirement{}).
		Where("project_id = ? AND organisation_id = ? AND state = ?", projectID, orgID, "confirmed").
		Where("id NOT IN (?)", db.DB.Model(&models.RequirementTestCase{}).Select("requirement_id")).
		Count(&uncovered)

	// Generation is gated on a document because that is what supplies rules the
	// page does not state about itself; it needs an endpoint inventory to ground
	// against, and something left to cover.
	switch {
	case documentID != "" && endpointCount > 0 && uncovered > 0:
		job.Set(0.58, "Writing test cases from your requirements…")
		gen, err := generation.Run(job.Scoped(0.58, 0.68, "Generation"),
			orgID, userID, projectID, nil, "standard")
		if err != nil {
			note("generation", "failed", stageNote{"reason": clip(err.Error(), 300)})
		} else {
			genMap, _ := gen.(map[string]any)
			note("generation", "completed", stageNote{
				"generated": pick(genMap, "generated"), "discarded": pick(genMap, "discarded")})
		}
	case documentID != "" && endpointCount == 0:
		note("generation", "skipped", stageNote{
			"reason": "No API endpoints were discovered, so requirement-derived API " +
				"cases would have nothing to call. Enable the 'api' test type " +
				"or import a spec."})
	case documentID != "":
		note("generation", "skipped", stageNote{
			"reason": "Every confirmed requirement already has cases — re-generating " +
				"would only add near-duplicates."})
	default:
		note("generation", "skipped", stageNote{
			"reason": "No document, so no requirements to generate from."})
	}

	// ---- 4. run the DOM cases in the browser -------------------------------
	job.Set(0.70, "Running the page checks in a browser…")
	if err := db.DB.First(&target, "id = ?", targetID).Error; err != nil {
		return nil, jobs.Fail("not_found", "The target disappeared mid-run.")
	}
	browserCases := webtarget.CollectBrowserCases(orgID, projectID, &target)
	env, err := webtarget.EnsureEnvironment(orgID, projectID, &target)
	if err != nil {
		return nil, jobs.Fail("pipeline_failed", "Could not derive an environment: "+err.Error())
	}
	envID := env.ID

	browserRunID := ""
	if len(browserCases) > 0 {
		run := &models.Run{OrganisationID: orgID, ProjectID: projectID,
			EnvironmentID: envID, Kind: "functional", State: "queued",
			Counts: models.JSONMap{"total": len(browserCases), "passed": 0,
				"failed": 0, "errored": 0},
			InitiatedBy: userID}
		if err := db.DB.Create(run).Error; err == nil {
			browserRunID = run.ID
		}
	}
	if browserRunID != "" {
		_, err := webtarget.RunVerify(job.Scoped(0.70, 0.88, "Browser checks"),
			orgID, userID, projectID, targetID, browserRunID, allowSubmit)
		if err != nil {
			detail := stageNote{"reason": clip(err.Error(), 300)}
			var coded *jobs.Error
			if asJobError(err, &coded) {
				detail["code"] = coded.Code
				detail["reason"] = coded.Message
			}
			note("browser_run", "failed", detail)
		} else {
			runsOut = append(runsOut, map[string]any{"run_id": browserRunID, "kind": "browser"})
			note("browser_run", "completed", stageNote{"cases": len(browserCases)})
		}
	} else {
		note("browser_run", "skipped", stageNote{
			"reason": "The scan found no form or page check to run — enable the " +
				"'functional' or 'performance' test type."})
	}

	// ---- 5. run the HTTP cases against the site ----------------------------
	job.Set(0.90, "Calling the APIs the page uses…")
	after := caseIDSet(orgID, projectID)
	newIDs := map[string]bool{}
	for id := range after {
		if !before[id] {
			newIDs[id] = true
		}
	}
	httpIDs := httpRunnable(orgID, projectID, newIDs, discoveredEndpointIDs(orgID, projectID))
	httpRunID := ""
	if len(httpIDs) > 0 {
		run := &models.Run{OrganisationID: orgID, ProjectID: projectID,
			EnvironmentID: envID, Kind: "functional", State: "queued",
			Counts: models.JSONMap{}, InitiatedBy: userID}
		if err := db.DB.Create(run).Error; err == nil {
			httpRunID = run.ID
		}
	}
	if httpRunID != "" {
		_, err := execution.ExecuteRun(job.Scoped(0.90, 0.99, "API checks"), httpRunID, httpIDs)
		if err != nil {
			note("http_run", "failed", stageNote{"reason": clip(err.Error(), 300)})
		} else {
			runsOut = append(runsOut, map[string]any{"run_id": httpRunID, "kind": "http"})
			note("http_run", "completed", stageNote{"cases": len(httpIDs)})
		}
	} else {
		note("http_run", "skipped", stageNote{
			"reason": "This run produced no HTTP-callable case — the 'api' and " +
				"'security' types build those from captured requests."})
	}

	// ---- 6. combined verdict ----------------------------------------------
	job.Set(0.99, "Collecting results…")
	totals := map[string]int{"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0}
	prompts := []map[string]any{}
	for _, entry := range runsOut {
		runID, _ := entry["run_id"].(string)
		var run models.Run
		if err := db.DB.First(&run, "id = ?", runID).Error; err != nil {
			continue
		}
		for key := range totals {
			totals[key] += intOf(run.Counts[key])
		}
		display := traceability.RunDisplayID(&run)
		entry["counts"] = run.Counts
		entry["display_id"] = display
		prompts = append(prompts,
			fixprompt.For(reporting.EntriesFor(&run), fmt.Sprintf("RUN-%d", display))...)
	}

	detail := models.JSONMap{"url": url, "test_types": testTypes}
	for k, v := range totals {
		detail[k] = v
	}
	httpx.Audit(orgID, &userID, "pipeline.completed", "web_target", targetID, detail)

	countsOut := map[string]any{}
	for k, v := range totals {
		countsOut[k] = v
	}
	return map[string]any{
		"target_id": targetID, "url": url, "environment_id": envID,
		"test_types": testTypes, "allow_submit": allowSubmit,
		"stages": stages, "runs": runsOut,
		"counts": countsOut, "fix_prompts": prompts,
	}, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func pick(m map[string]any, key string) any {
	if m == nil {
		return nil
	}
	return m[key]
}

func intOf(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		return int(n)
	}
	return 0
}

func clip(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// asJobError reports whether err carries a coded jobs.Error, so a browser
// failure keeps the machine-readable code the UI branches on.
func asJobError(err error, out **jobs.Error) bool {
	if coded, ok := err.(*jobs.Error); ok {
		*out = coded
		return true
	}
	return false
}

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())
	g.POST("/projects/:project_id/pipeline", httpx.Require("trigger_run"), startPipeline)
}

// startPipeline scans a URL, builds tests from it (and any document), runs them
// and reports.
func startPipeline(c *gin.Context) {
	projectID := c.Param("project_id")
	project, ok := httpx.ProjectScoped(c, projectID)
	if !ok {
		return
	}
	var body request
	if err := c.ShouldBindJSON(&body); err != nil {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request", err.Error())
		return
	}
	url, code, message := webtarget.ValidateTargetURL(body.URL)
	if code != "" {
		httpx.Err(c, http.StatusUnprocessableEntity, code, message)
		return
	}
	viewport, viewportOK := webtarget.ValidateViewport(body.Viewport)
	if !viewportOK {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_viewport",
			"Viewport must look like 1280x800.")
		return
	}
	testTypes, ttCode, ttMessage := webtarget.ValidateTestTypes(body.TestTypes)
	if ttCode != "" {
		httpx.Err(c, http.StatusUnprocessableEntity, ttCode, ttMessage)
		return
	}

	user := httpx.User(c)
	documentID := ""
	if body.DocumentID != "" {
		var doc models.SourceDocument
		if err := db.DB.First(&doc, "id = ?", body.DocumentID).Error; err != nil ||
			doc.ProjectID != projectID || doc.OrganisationID != user.OrganisationID {
			httpx.Err(c, http.StatusNotFound, "not_found", "Document not found in this project")
			return
		}
		documentID = doc.ID
	}

	httpx.Audit(user.OrganisationID, &user.ID, "pipeline.requested", "project", projectID,
		models.JSONMap{"url": url, "viewport": viewport, "test_types": testTypes,
			"document_id": documentID, "allow_submit": body.AllowSubmit})

	orgID, userID := user.OrganisationID, user.ID
	allowSubmit := body.AllowSubmit
	// One pipeline per project at a time: two of them would scan the same URL
	// into the same target row and interleave their case sets.
	job, accepted := jobs.TrySubmitForProject("pipeline", project.ID, func(j *jobs.Job) (any, error) {
		return Run(j, orgID, userID, projectID, url, viewport, testTypes, documentID, allowSubmit)
	})
	if !accepted {
		httpx.Err(c, http.StatusConflict, "pipeline_in_progress",
			"A test run is already in progress for this project.")
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID, "url": url,
		"test_types": testTypes, "document_id": documentID,
		"allow_submit": allowSubmit})
}
