// Package webtarget — point Traceo at a URL and pick what to test (web target
// contract §2/§3). Port of backend/app/modules/webtarget.py; the routes, JSON
// shapes and codes are identical, and the browser sidecar
// (tools/web-discovery/discover.mjs) is the SAME script both backends shell out
// to, so the two engines see the same page the same way.
//
// The measured constraint this module is built around: the example target is a
// Vue SPA whose plain HTTP GET returns a 3453-byte shell with ZERO forms, inputs
// and buttons. Everything is client-rendered, so server-side HTML parsing
// discovers nothing at all and browser rendering is not an optimisation — it is
// the only way the page states anything.
//
//	POST /v1/projects/{id}/web-targets      capability "import_spec" — 202 {job_id}
//	GET  /v1/projects/{id}/web-targets      capability "view"
//	GET  /v1/web-targets/{id}               capability "view"
//	GET  /v1/web-targets/{id}/screenshot    capability "view" — image/png
//
// GROUNDING is unchanged and non-negotiable: every case emitted here references
// an artefact the discovery ACTUALLY found — a form field selector, a captured
// request, or a design fact id — and is discarded otherwise. The security track
// additionally goes through generation.GroundingValidate, the same hard gate the
// functional and security generators use. A track with no artefact to stand on
// is reported as skipped WITH ITS REASON rather than quietly producing zero.
package webtarget

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/design"
	"traceo/internal/modules/discovery"
	"traceo/internal/modules/generation"
	secmod "traceo/internal/modules/security"
	"traceo/internal/testtypes"
)

// TestTypes are declared per project in internal/testtypes and aliased here,
// where the discovery job and its tests have always read them.
var TestTypes = testtypes.All

// ValidateTestTypes normalises the requested types; see testtypes.Validate.
func ValidateTestTypes(requested []string) ([]string, string, string) {
	return testtypes.Validate(requested, false)
}

const (
	defaultViewport = "1280x800"
	screenshotDir   = "webtargets"
	modelName       = "browser-discovery"
)

var viewportRe = regexp.MustCompile(`^(\d{3,5})x(\d{3,5})$`)

var (
	minViewport = [2]int{320, 240}
	maxViewport = [2]int{3840, 4320}
)

// domRank is this mode's place in the discovery fidelity order (SRS §L2):
// spec > traffic > dom > postman.
var sourceRank = map[string]int{"spec": 3, "traffic": 2, "dom": 1, "postman": 0}

const domRank = 1

// SidecarRunner is the seam the tests replace with a recorded document. The
// production path always renders.
var SidecarRunner = RunSidecar

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())
	g.POST("/projects/:project_id/web-targets", httpx.Require("import_spec"), createWebTarget)
	g.GET("/projects/:project_id/web-targets", httpx.Require("view"), listWebTargets)
	g.GET("/web-targets/:target_id", httpx.Require("view"), getWebTarget)
	g.GET("/web-targets/:target_id/screenshot", httpx.Require("view"), getScreenshot)
}

func errWith(c *gin.Context, status int, code, message string, errs []string) {
	c.AbortWithStatusJSON(status, gin.H{"detail": gin.H{
		"code": code, "message": message, "errors": errs}})
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

type createRequest struct {
	URL       string   `json:"url"`
	Viewport  string   `json:"viewport"`
	TestTypes []string `json:"test_types"`
}

// ValidateViewport returns the canonical WIDTHxHEIGHT, or ok=false.
func ValidateViewport(raw string) (string, bool) {
	viewport := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(raw), " ", ""))
	if viewport == "" {
		viewport = defaultViewport
	}
	m := viewportRe.FindStringSubmatch(viewport)
	if m == nil {
		return "", false
	}
	w, _ := strconv.Atoi(m[1])
	h, _ := strconv.Atoi(m[2])
	if w < minViewport[0] || w > maxViewport[0] || h < minViewport[1] || h > maxViewport[1] {
		return "", false
	}
	return fmt.Sprintf("%dx%d", w, h), true
}

func viewportHeight(viewport string) int {
	if m := viewportRe.FindStringSubmatch(viewport); m != nil {
		h, _ := strconv.Atoi(m[2])
		return h
	}
	return 0
}

// validateTargetURL: http/https only, and the same SSRF rule the spec fetcher
// applies. The sidecar enforces it too — it is the process that actually opens
// the socket — but a guard that only lives in the child would be bypassed by
// every other caller of this package.
func validateTargetURL(raw string) (string, string, string) {
	target := strings.TrimSpace(raw)
	parsed, err := url.Parse(target)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", "invalid_url", "Only absolute http/https URLs are allowed."
	}
	if !config.C.AllowPrivateTargets {
		if code, message := discovery.PublicHostError(parsed.Hostname()); code != "" {
			return "", code, message
		}
	}
	return target, "", ""
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

func createWebTarget(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	project, ok := httpx.ProjectScoped(c, projectID)
	if !ok {
		return
	}
	var body createRequest
	_ = c.ShouldBindJSON(&body)

	target, code, message := validateTargetURL(body.URL)
	if code != "" {
		httpx.Err(c, http.StatusUnprocessableEntity, code, message)
		return
	}
	viewport, okViewport := ValidateViewport(body.Viewport)
	if !okViewport {
		errWith(c, http.StatusUnprocessableEntity, "invalid_viewport",
			fmt.Sprintf("viewport must be WIDTHxHEIGHT within %dx%d–%dx%d (e.g. %s).",
				minViewport[0], minViewport[1], maxViewport[0], maxViewport[1], defaultViewport),
			[]string{defaultViewport, "1440x900", "390x844"})
		return
	}
	// Omitting the types runs what the project declared it is for; asking for a
	// type it excluded is refused, not quietly dropped. Silently narrowing would
	// report success for a track that never ran.
	declared := testtypes.OfProject(project.TestTypes)
	testTypes := declared
	if body.TestTypes != nil {
		chosen, tcode, tmessage := ValidateTestTypes(body.TestTypes)
		if tcode != "" {
			errWith(c, http.StatusUnprocessableEntity, tcode, tmessage, TestTypes)
			return
		}
		var outside []string
		for _, t := range chosen {
			if !contains(declared, t) {
				outside = append(outside, t)
			}
		}
		if len(outside) > 0 {
			errWith(c, http.StatusUnprocessableEntity, "test_type_not_in_project",
				"This project is not set up for: "+strings.Join(outside, ", ")+
					". Change its test types first.", declared)
			return
		}
		testTypes = chosen
	}

	var row models.WebTarget
	found := db.DB.Where("project_id = ? AND organisation_id = ? AND url = ? AND viewport = ?",
		projectID, u.OrganisationID, target, viewport).First(&row).Error == nil
	if found {
		db.DB.Model(&models.WebTarget{}).Where("id = ?", row.ID).
			Updates(map[string]any{"status": "pending", "last_error": nil,
				"updated_at": time.Now().UTC()})
	} else {
		row = models.WebTarget{OrganisationID: u.OrganisationID, ProjectID: projectID,
			URL: target, Viewport: viewport, Status: "pending", Inventory: models.JSONMap{}}
		if err := db.DB.Create(&row).Error; err != nil {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request",
				"The web target could not be recorded.")
			return
		}
	}
	httpx.Audit(u.OrganisationID, &u.ID, "web_target.requested", "web_target", row.ID,
		models.JSONMap{"url": target, "viewport": viewport, "test_types": testTypes})

	orgID, userID, targetID := u.OrganisationID, u.ID, row.ID
	job := jobs.SubmitForProject("discover", projectID, func(j *jobs.Job) (any, error) {
		return RunDiscovery(j, orgID, userID, projectID, targetID, target, viewport, testTypes)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID, "target_id": targetID,
		"test_types": testTypes})
}

func webTargetDict(t *models.WebTarget, detail bool) gin.H {
	inv := t.Inventory
	if inv == nil {
		inv = models.JSONMap{}
	}
	var lastDiscovered any
	if t.LastDiscovered != nil {
		lastDiscovered = t.LastDiscovered.UTC().Format(time.RFC3339)
	}
	testTypes := asList(inv["test_types"])
	if testTypes == nil {
		testTypes = []any{}
	}
	counts := asMap(inv["counts"])
	if counts == nil {
		counts = map[string]any{}
	}
	out := gin.H{
		"id": t.ID, "project_id": t.ProjectID, "url": t.URL, "viewport": t.Viewport,
		"status": t.Status, "title": t.Title, "final_url": t.FinalURL,
		"last_discovered_at": lastDiscovered,
		"has_screenshot":     t.ScreenshotKey != "",
		"error":              t.LastError,
		"test_types":         testTypes,
		"counts":             counts,
		"created_at":         t.CreatedAt.UTC().Format(time.RFC3339),
	}
	if detail {
		listOr := func(key string) any {
			if v := asList(inv[key]); v != nil {
				return v
			}
			return []any{}
		}
		out["inventory"] = gin.H{
			"forms": listOr("forms"), "controls": listOr("controls"),
			"requests": listOr("requests"), "endpoints": listOr("endpoints"),
			"console_errors": listOr("console_errors"),
			"elapsed_ms":     inv["elapsed_ms"],
			"skipped":        listOr("skipped"),
		}
		if d := asMap(inv["design"]); d != nil {
			out["design"] = d
		} else {
			out["design"] = gin.H{}
		}
	}
	return out
}

func listWebTargets(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var rows []models.WebTarget
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, u.OrganisationID).
		Order("created_at DESC").Find(&rows)
	out := make([]gin.H, 0, len(rows))
	for i := range rows {
		out = append(out, webTargetDict(&rows[i], false))
	}
	c.JSON(http.StatusOK, gin.H{"web_targets": out})
}

func targetScoped(c *gin.Context) (*models.WebTarget, bool) {
	u := httpx.User(c)
	var row models.WebTarget
	if err := db.DB.First(&row, "id = ? AND organisation_id = ?",
		c.Param("target_id"), u.OrganisationID).Error; err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Web target not found")
		return nil, false
	}
	return &row, true
}

func getWebTarget(c *gin.Context) {
	row, ok := targetScoped(c)
	if !ok {
		return
	}
	c.JSON(http.StatusOK, webTargetDict(row, true))
}

func getScreenshot(c *gin.Context) {
	row, ok := targetScoped(c)
	if !ok {
		return
	}
	if row.ScreenshotKey == "" {
		httpx.Err(c, http.StatusNotFound, "no_screenshot", "This target has no screenshot.")
		return
	}
	path := filepath.Join(config.C.StorageDir, filepath.FromSlash(row.ScreenshotKey))
	raw, err := os.ReadFile(path)
	if err != nil {
		httpx.Err(c, http.StatusNotFound, "no_screenshot",
			"The screenshot file is missing from storage.")
		return
	}
	c.Header("Cache-Control", "no-store")
	c.Data(http.StatusOK, "image/png", raw)
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

// upsertRequirement creates or refreshes the requirement this discovery states.
// Re-discovering a target must not fork its requirements, so the row is keyed on
// the external id derived from the target. A requirement the user already
// CONFIRMED keeps its state — a crawl is not a reason to un-confirm a human
// decision — but its text is refreshed and its version bumped when the page
// moved, which is what drives staleness (FR-TRC-04).
func upsertRequirement(orgID, projectID, externalID, description string, criteria []string,
	reqType string, sourceLocation map[string]any, sourceText, priority string,
) (*models.Requirement, bool) {
	sum := sha256.Sum256([]byte(sourceText))
	hash := hex.EncodeToString(sum[:])
	list := make(models.JSONList, 0, len(criteria))
	for _, c := range criteria {
		list = append(list, c)
	}
	var row models.Requirement
	found := db.DB.Where("project_id = ? AND organisation_id = ? AND external_id = ?",
		projectID, orgID, externalID).First(&row).Error == nil
	if !found {
		row = models.Requirement{
			OrganisationID: orgID, ProjectID: projectID, ExternalID: externalID,
			Description: description, AcceptanceCriteria: list, Type: reqType,
			Priority: priority, State: "extracted",
			SourceLocation: models.JSONMap(sourceLocation),
			SourceText:     trunc(sourceText, 8000), ContentHash: hash, Confidence: 1,
			Version: 1,
		}
		db.DB.Create(&row)
		return &row, true
	}
	if row.ContentHash != hash {
		row.Description = description
		row.AcceptanceCriteria = list
		row.SourceLocation = models.JSONMap(sourceLocation)
		row.SourceText = trunc(sourceText, 8000)
		row.ContentHash = hash
		row.Version++
		if row.State == "confirmed" {
			row.State = "changed" // the page moved under a confirmed statement
		}
		db.DB.Save(&row)
	}
	return &row, false
}

// persistCase writes one grounded case as a draft plus its requirement link.
// caseFromMap converts a case built by the shared generator into the struct
// form this engine persists. The generator speaks maps because it mirrors the
// Python engine field for field; the conversion is total, so a field the
// generator does not set stays empty rather than being invented.
func caseFromMap(data map[string]any, grounds []string) Case {
	kase := Case{
		Title:         str(data["title"]),
		Description:   str(data["description"]),
		Preconditions: str(data["preconditions"]),
		Type:          str(data["type"]),
		Priority:      str(data["priority"]),
		Technique:     str(data["technique"]),
		Grounds:       grounds,
	}
	for _, sv := range asList(data["steps"]) {
		s := asMap(sv)
		step := Step{
			Method:     str(s["method"]),
			Path:       str(s["path"]),
			Request:    asMap(s["request"]),
			Assertions: asList(s["assertions"]),
		}
		if id, ok := s["endpoint_id"].(string); ok && id != "" {
			step.EndpointID = &id
		}
		kase.Steps = append(kase.Steps, step)
	}
	return kase
}

func persistCase(orgID, projectID string, req *models.Requirement, kase Case) {
	steps := make([]models.TestStep, 0, len(kase.Steps))
	for i, s := range kase.Steps {
		assertions := models.JSONList(s.Assertions)
		if assertions == nil {
			assertions = models.JSONList{}
		}
		steps = append(steps, models.TestStep{
			Order: i, EndpointID: s.EndpointID, Method: s.Method, Path: s.Path,
			Request: models.JSONMap(s.Request), Assertions: assertions,
			Extractions: models.JSONList{},
		})
	}
	tc := models.TestCase{
		OrganisationID: orgID, ProjectID: projectID,
		Title: trunc(kase.Title, 500), Description: kase.Description,
		Preconditions: kase.Preconditions, Type: kase.Type, Priority: kase.Priority,
		State: "draft", Generated: true, Model: modelName,
		PromptVersion: config.C.PromptVer, Technique: kase.Technique,
		Version: 1, Steps: steps,
	}
	db.DB.Create(&tc)
	db.DB.Create(&models.RequirementTestCase{
		RequirementID: req.ID, TestCaseID: tc.ID,
		LinkSource: "generated", RequirementVersionAtLink: req.Version,
	})
}

// existingCaseKeys is (technique|title) of every live case — the duplicate key
// for a re-run.
func existingCaseKeys(orgID, projectID string) map[string]bool {
	type row struct {
		Technique string
		Title     string
	}
	var rows []row
	db.DB.Table("test_cases").Select("technique, title").
		Where("project_id = ? AND organisation_id = ? AND state != ?",
			projectID, orgID, "archived").Scan(&rows)
	out := map[string]bool{}
	for _, r := range rows {
		out[r.Technique+"|"+r.Title] = true
	}
	return out
}

// persistEndpoints writes the DOM-discovered operations under the fidelity
// precedence. "dom" outranks only "postman" (SRS §L2), so an endpoint already
// known from a spec or from captured traffic is LEFT ALONE — a crawl must never
// downgrade a declared contract. Nothing is ever deleted here: this mode
// observes a page, it does not enumerate the API, so its silence about an
// endpoint says nothing.
func persistEndpoints(orgID, projectID string, ops []Operation) (int, int) {
	var existing []models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, orgID).Find(&existing)
	byKey := map[string]*models.Endpoint{}
	for i := range existing {
		byKey[strings.ToUpper(existing[i].Method)+" "+existing[i].Path] = &existing[i]
	}
	written, superseded := 0, 0
	for _, op := range ops {
		key := op.Method + " " + op.Path
		prior, present := byKey[key]
		if present {
			rank, known := sourceRank[prior.Source]
			if !known {
				rank = sourceRank["spec"]
			}
			if rank > domRank {
				superseded++
				continue
			}
			prior.Summary = op.Summary
			prior.Parameters = models.JSONList(op.Parameters)
			prior.Source = "dom"
			prior.ObservedCount = op.ObservedCount
			db.DB.Save(prior)
			written++
			continue
		}
		row := models.Endpoint{
			OrganisationID: orgID, ProjectID: projectID,
			Method: op.Method, Path: op.Path, Summary: op.Summary,
			Parameters:      models.JSONList(op.Parameters),
			RequestSchema:   nil,
			ResponseSchemas: models.JSONMap{}, Security: models.JSONList{},
			Tags: models.JSONList{}, Source: "dom", ObservedCount: op.ObservedCount,
		}
		db.DB.Create(&row)
		byKey[key] = &row
		written++
	}
	return written, superseded
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

func markFailed(targetID, code, message string) {
	reason := trunc(code+": "+message, 4000)
	db.DB.Model(&models.WebTarget{}).Where("id = ?", targetID).
		Updates(map[string]any{"status": "failed", "last_error": reason,
			"updated_at": time.Now().UTC()})
}

func storeScreenshot(targetID string, inv Inventory, outDir string) string {
	if inv.Screenshot == "" {
		return ""
	}
	src := inv.Screenshot
	if !filepath.IsAbs(src) {
		src = filepath.Join(outDir, src)
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return ""
	}
	destDir := filepath.Join(config.C.StorageDir, screenshotDir)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return ""
	}
	if err := os.WriteFile(filepath.Join(destDir, targetID+".png"), raw, 0o644); err != nil {
		return ""
	}
	return screenshotDir + "/" + targetID + ".png"
}

// RunDiscovery renders, persists and generates — the job body behind
// POST /web-targets.
func RunDiscovery(job *jobs.Job, orgID, userID, projectID, targetID, target, viewport string,
	testTypes []string) (any, error) {
	outDir, err := os.MkdirTemp("", "traceo-webdisc-")
	if err != nil {
		return nil, jobs.Fail("discovery_failed", "No temporary directory is available.")
	}
	defer os.RemoveAll(outDir)

	job.Set(0.05, "Rendering "+target)
	payload, runErr := SidecarRunner(target, viewport, outDir, config.C.WebDiscoveryTimeout)
	if runErr != nil {
		code, message := "discovery_failed", runErr.Error()
		var coded *jobs.Error
		if errors.As(runErr, &coded) {
			code = coded.Code
		}
		markFailed(targetID, code, message)
		uid := userID
		httpx.Audit(orgID, &uid, "web_target.failed", "web_target", targetID,
			models.JSONMap{"url": target, "code": code})
		return nil, runErr
	}

	inv := NormalisePayload(payload)
	job.Set(0.35, "Reading the rendered page")
	screenshotKey := storeScreenshot(targetID, inv, outDir)

	skipped := []map[string]any{}
	casesByType := map[string]int{}
	for _, t := range testTypes {
		casesByType[t] = 0
	}
	selected := map[string]bool{}
	for _, t := range testTypes {
		selected[t] = true
	}
	requirementCount, endpointCount, discarded, duplicates := 0, 0, 0, 0
	existing := existingCaseKeys(orgID, projectID)
	short := targetID
	if len(short) > 8 {
		short = short[:8]
	}

	emit := func(req *models.Requirement, kase Case, kind string, artefacts map[string]bool) {
		if len(GroundingViolations(kase.Grounds, artefacts)) > 0 {
			discarded++
			return
		}
		key := kase.Technique + "|" + trunc(kase.Title, 500)
		if existing[key] {
			duplicates++
			return
		}
		persistCase(orgID, projectID, req, kase)
		existing[key] = true
		casesByType[kind]++
	}

	// --- api / security: the captured request inventory ---------------------
	var ops []Operation
	var domEndpoints []models.Endpoint
	if selected["api"] || selected["security"] {
		job.Set(0.45, "Recording the captured requests")
		ops = EndpointsFromRequests(inv.Requests)
		if len(ops) == 0 {
			reason := "the page made no XHR/fetch request while it was rendered, so " +
				"there is no API surface to record"
			for _, t := range []string{"api", "security"} {
				if selected[t] {
					skipped = append(skipped, map[string]any{"type": t, "reason": reason})
				}
			}
		} else {
			written, superseded := persistEndpoints(orgID, projectID, ops)
			endpointCount = written
			if superseded > 0 {
				skipped = append(skipped, map[string]any{"type": "api",
					"reason": fmt.Sprintf("higher-fidelity sources already own %d of the "+
						"observed endpoints (spec/traffic beat dom — SRS §L2)", superseded)})
			}
			wanted := map[string]bool{}
			for _, op := range ops {
				wanted[op.Method+" "+op.Path] = true
			}
			var all []models.Endpoint
			db.DB.Where("project_id = ? AND organisation_id = ? AND excluded = ?",
				projectID, orgID, false).Find(&all)
			for i := range all {
				if wanted[strings.ToUpper(all[i].Method)+" "+all[i].Path] {
					domEndpoints = append(domEndpoints, all[i])
				}
			}
		}
	}

	artefacts := ArtefactIDs(inv, nil)
	// The artefact an endpoint-derived case stands on is the REQUEST the browser
	// was seen to make; the endpoint row is a derivation of it, so citing the
	// capture keeps the chain back to observed evidence.
	capturedByKey := map[string]string{}
	for _, op := range ops {
		if len(op.URLs) > 0 {
			capturedByKey[op.Method+" "+op.Path] = op.URLs[0]
		}
	}

	// --- api: the generator's builders over the observed endpoints ---------
	if selected["api"] {
		job.Set(0.50, "Generating API cases")
		if len(domEndpoints) == 0 {
			seen := false
			for _, s := range skipped {
				if s["type"] == "api" {
					seen = true
				}
			}
			if !seen {
				skipped = append(skipped, map[string]any{"type": "api",
					"reason": "no observed request survived as an endpoint to generate against"})
			}
		} else {
			apiByKey := map[string]*models.Endpoint{}
			criteria := []string{}
			for i := range domEndpoints {
				ep := &domEndpoints[i]
				apiByKey[strings.ToUpper(ep.Method)+" "+ep.Path] = ep
				criteria = append(criteria, strings.ToUpper(ep.Method)+" "+ep.Path+
					" responds within its observed status class")
			}
			sort.Strings(criteria)
			apiReq, _ := upsertRequirement(orgID, projectID, "WEB-"+short+"-API",
				fmt.Sprintf("The %d backend endpoints called by %s must answer as they "+
					"were observed to.", len(domEndpoints), inv.FinalURL),
				criteria, "interface", map[string]any{"url": inv.FinalURL},
				jsonString(criteria), "high")
			requirementCount++
			for i := range domEndpoints {
				ep := &domEndpoints[i]
				captured, present := capturedByKey[strings.ToUpper(ep.Method)+" "+ep.Path]
				if !present {
					continue
				}
				ground := "request:" + strings.ToUpper(ep.Method) + " " + captured
				for _, kase := range generation.GenerateCases(apiReq, ep, "standard") {
					// Same second gate the API generator applies: a case may not
					// cite a parameter or status the endpoint never declared.
					if len(generation.GroundingValidate(kase, apiByKey)) > 0 {
						discarded++
						continue
					}
					emit(apiReq, caseFromMap(kase, []string{ground}), "api", artefacts)
				}
			}
		}
	}

	// --- functional: one requirement per form ------------------------------
	if selected["functional"] {
		job.Set(0.55, "Extracting the forms")
		if len(inv.Forms) == 0 {
			skipped = append(skipped, map[string]any{"type": "functional",
				"reason": "the rendered page contains no form"})
		}
		for _, form := range inv.Forms {
			description, criteria, sourceText := FormRequirementText(form, inv)
			req, _ := upsertRequirement(orgID, projectID,
				fmt.Sprintf("WEB-%s-F%d", short, form.Index+1),
				description, criteria, "functional",
				map[string]any{"url": inv.FinalURL, "selector": form.Selector},
				sourceText, "high")
			requirementCount++
			for _, kase := range FormCases(form, inv) {
				emit(req, kase, "functional", artefacts)
			}
		}
	}

	// --- performance -------------------------------------------------------
	if selected["performance"] {
		job.Set(0.62, "Recording the load baseline")
		if inv.ElapsedMS == nil {
			skipped = append(skipped, map[string]any{"type": "performance",
				"reason": "the sidecar reported no elapsed_ms baseline"})
		} else {
			budget := config.C.PageLoadBudgetMS
			observed := *inv.ElapsedMS
			priority := "medium"
			if observed > budget {
				priority = "high"
			}
			req, _ := upsertRequirement(orgID, projectID, "WEB-"+short+"-PERF",
				fmt.Sprintf("The page %s must finish loading within %dms. The observed "+
					"baseline at discovery was %dms.", inv.FinalURL, budget, observed),
				[]string{fmt.Sprintf("Page load completes in %dms or less", budget)},
				"non_functional", map[string]any{"url": inv.FinalURL},
				jsonString(map[string]any{"budget_ms": budget, "observed_ms": observed}),
				priority)
			requirementCount++
			emit(req, PerformanceCase(inv, budget), "performance", artefacts)
		}
	}

	// --- ui: design facts from the screenshot ------------------------------
	designPayload := map[string]any{}
	if selected["ui"] {
		job.Set(0.70, "Extracting design facts")
		switch {
		case screenshotKey == "":
			skipped = append(skipped, map[string]any{"type": "ui",
				"reason": "the sidecar produced no screenshot"})
		default:
			img, decodeErr := design.DecodePNG(
				filepath.Join(config.C.StorageDir, filepath.FromSlash(screenshotKey)),
				design.RGB{255, 255, 255})
			if decodeErr != nil {
				skipped = append(skipped, map[string]any{"type": "ui",
					"reason": "the screenshot could not be decoded: " + decodeErr.Error()})
				break
			}
			analysed, note := design.FitForAnalysis(img, viewportHeight(viewport),
				config.C.DesignMaxPixels)
			facts := design.DesignFacts(analysed)
			designPayload = designSummary(facts, note)
			factIDs := make([]string, 0, len(facts))
			statements := make([]string, 0, len(facts))
			for _, f := range facts {
				factIDs = append(factIDs, f.ID())
				if len(statements) < 200 {
					statements = append(statements, f.Statement)
				}
			}
			if len(facts) == 0 {
				skipped = append(skipped, map[string]any{"type": "ui",
					"reason": "the screenshot states no extractable design fact"})
				break
			}
			uiArtefacts := ArtefactIDs(inv, factIDs)
			screen := inv.Title
			if screen == "" {
				screen = inv.PagePath()
			}
			sortedIDs := append([]string{}, factIDs...)
			sort.Strings(sortedIDs)
			req, _ := upsertRequirement(orgID, projectID, "WEB-"+short+"-UI",
				fmt.Sprintf("The screen '%s' conforms to the %d design facts extracted "+
					"from its rendering at %s.", screen, len(facts), viewport),
				statements, "interface",
				map[string]any{"url": inv.FinalURL, "viewport": viewport},
				jsonString(sortedIDs), "medium")
			requirementCount++
			for _, kase := range uiCases(facts, inv, screen) {
				emit(req, kase, "ui", uiArtefacts)
			}
		}
	}

	// --- security: the S0 builders over the discovered endpoints -----------
	if selected["security"] && len(domEndpoints) > 0 {
		job.Set(0.85, "Building the security plan")
		endpointsByKey := map[string]*models.Endpoint{}
		criteria := make([]string, 0, len(domEndpoints))
		for i := range domEndpoints {
			ep := &domEndpoints[i]
			endpointsByKey[strings.ToUpper(ep.Method)+" "+ep.Path] = ep
			criteria = append(criteria,
				strings.ToUpper(ep.Method)+" "+ep.Path+" is free of catalogued weaknesses")
		}
		sort.Strings(criteria)
		req, _ := upsertRequirement(orgID, projectID, "WEB-"+short+"-SEC",
			fmt.Sprintf("The %d backend endpoints called by %s must not exhibit the "+
				"weakness classes in the shipped catalogue (version %s).",
				len(domEndpoints), inv.FinalURL, secmod.Version()),
			criteria, "interface", map[string]any{"url": inv.FinalURL},
			jsonString(criteria), "high")
		requirementCount++

		reasons := map[string]bool{}
		for i := range domEndpoints {
			ep := &domEndpoints[i]
			captured, present := capturedByKey[strings.ToUpper(ep.Method)+" "+ep.Path]
			if !present {
				continue
			}
			ground := "request:" + strings.ToUpper(ep.Method) + " " + captured
			for _, weakness := range secmod.Weaknesses() {
				ok, reason := secmod.Applicable(ep, weakness)
				if !ok {
					reasons[reason] = true
					continue
				}
				for _, data := range secmod.BuildCases(req, ep, weakness) {
					if len(GroundingViolations([]string{ground}, artefacts)) > 0 {
						discarded++
						continue
					}
					if len(generation.GroundingValidate(data, endpointsByKey)) > 0 {
						discarded++
						continue
					}
					title := trunc(str(data["title"]), 500)
					key := str(data["technique"]) + "|" + title
					if existing[key] {
						duplicates++
						continue
					}
					secmod.PersistCase(orgID, projectID, req, data)
					existing[key] = true
					casesByType["security"]++
				}
			}
		}
		if casesByType["security"] == 0 && len(reasons) > 0 {
			listed := make([]string, 0, len(reasons))
			for r := range reasons {
				listed = append(listed, r)
			}
			sort.Strings(listed)
			if len(listed) > 3 {
				listed = listed[:3]
			}
			skipped = append(skipped, map[string]any{"type": "security",
				"reason": "no weakness class applies to the observed endpoints: " +
					strings.Join(listed, "; ")})
		}
	}

	// --- persist the target ------------------------------------------------
	job.Set(0.95, "Recording the target")
	apiRequests := 0
	for _, r := range inv.Requests {
		if APIResourceTypes[r.ResourceType] {
			apiRequests++
		}
	}
	endpointDigest := make([]any, 0, len(ops))
	for _, op := range ops {
		endpointDigest = append(endpointDigest, map[string]any{
			"method": op.Method, "path": op.Path, "observed_count": op.ObservedCount,
			"origins": op.Origins, "statuses": op.Statuses})
	}
	summary := models.JSONMap{
		"test_types": testTypes,
		"counts": map[string]any{
			"forms": len(inv.Forms), "controls": len(inv.Controls),
			"requests": len(inv.Requests), "api_requests": apiRequests,
			"endpoints": endpointCount},
		"elapsed_ms":     inv.ElapsedMS,
		"forms":          inv.Forms,
		"controls":       capControls(inv.Controls, 200),
		"requests":       capRequests(inv.Requests, 300),
		"endpoints":      endpointDigest,
		"console_errors": inv.ConsoleErrors,
		"design":         designPayload,
		"skipped":        skipped,
	}
	now := time.Now().UTC()
	finalURL := inv.FinalURL
	if finalURL == "" {
		finalURL = target
	}
	db.DB.Model(&models.WebTarget{}).Where("id = ?", targetID).Updates(map[string]any{
		"status": "discovered", "title": inv.Title, "final_url": finalURL,
		"screenshot_key": screenshotKey, "last_discovered_at": now,
		"inventory": summary, "last_error": nil, "updated_at": now,
	})

	totalCases := 0
	for _, n := range casesByType {
		totalCases += n
	}
	result := map[string]any{
		"target_id": targetID, "title": inv.Title,
		"forms": len(inv.Forms), "controls": len(inv.Controls),
		"requests": len(inv.Requests), "endpoints": endpointCount,
		"requirements": requirementCount, "cases_by_type": casesByType,
		"skipped": skipped, "discarded": discarded, "duplicates": duplicates,
	}
	uid := userID
	httpx.Audit(orgID, &uid, "web_target.discovered", "web_target", targetID, models.JSONMap{
		"url": target, "viewport": viewport, "test_types": testTypes,
		"endpoints": endpointCount, "requirements": requirementCount,
		"cases": totalCases, "discarded": discarded})
	job.Set(0.99, fmt.Sprintf("%d cases from %d forms, %d endpoints",
		totalCases, len(inv.Forms), endpointCount))
	return result, nil
}

func capControls(list []Control, n int) []Control {
	if len(list) > n {
		return list[:n]
	}
	return list
}

func capRequests(list []Request, n int) []Request {
	if len(list) > n {
		return list[:n]
	}
	return list
}

// uiCases translates design.UICases into this module's case shape. The fact id
// travels into Grounds unchanged — design.UICases' own rule is that a case
// exists only for a fact in the inventory, and carrying the id through is what
// lets the same gate be re-checked here.
func uiCases(facts []design.Fact, inv Inventory, screen string) []Case {
	path := inv.PagePath()
	pageURL := inv.pageURL()
	out := make([]Case, 0, len(facts)*2)
	for _, uc := range design.UICases(facts, screen) {
		request := map[string]any{"url": pageURL, "screen": uc.Screen, "check": uc.Check,
			"fact": uc.FactID, "expected": uc.Expected}
		if uc.Evidence != nil {
			request["evidence"] = uc.Evidence
		} else {
			request["evidence"] = nil
		}
		out = append(out, Case{
			Title: uc.Title, Description: uc.Description, Preconditions: uc.Preconditions,
			Type: uc.Type, Priority: uc.Priority, Technique: uc.Technique,
			Steps: []Step{{Method: "GET", Path: path, Request: request,
				Assertions: []any{map[string]any{"type": uc.Check, "expected": uc.Expected}}}},
			Grounds: []string{"fact:" + uc.FactID},
		})
	}
	return out
}

var hexPairRe = regexp.MustCompile(`^(#[0-9A-F]{6})_on_(#[0-9A-F]{6})$`)

func parseHex(s string) design.RGB {
	var out design.RGB
	for i := 0; i < 3; i++ {
		v, _ := strconv.ParseInt(s[1+i*2:3+i*2], 16, 32)
		out[i] = int(v)
	}
	return out
}

func round(v float64, places int) float64 {
	pow := 1.0
	for i := 0; i < places; i++ {
		pow *= 10
	}
	return float64(int64(v*pow+0.5*sign(v))) / pow
}

func sign(v float64) float64 {
	if v < 0 {
		return -1
	}
	return 1
}

// designSummary is the design box the owner asked for: the palette with each
// colour's share, and every contrast finding with the colour that would pass.
//
// Derived from the FACTS rather than from a second pass over the raster, so what
// the UI shows and what the cases assert cannot drift apart. The suggestion
// comes from design.NearestAccessible — same hue and chroma, only lightness
// moves — so it is recognisably the same colour, not a different one that
// happens to pass.
func designSummary(facts []design.Fact, note design.RasterNote) map[string]any {
	palette := []any{}
	contrast := []any{}
	factList := make([]any, 0, len(facts))
	failing := 0
	for _, f := range facts {
		factList = append(factList, map[string]any{"id": f.ID(), "kind": f.Kind,
			"statement": f.Statement})
		switch f.Kind {
		case "surface":
			share, _ := f.Value["share"].(float64)
			palette = append(palette, map[string]any{
				"hex": f.Subject, "rgb": f.Value["colour"],
				"share": round(share, 6), "role": "surface"})
		case "contrast":
			m := hexPairRe.FindStringSubmatch(f.Subject)
			if m == nil {
				continue
			}
			ink, surface := parseHex(m[1]), parseHex(m[2])
			remedy := design.NearestAccessible(ink, surface, 4.5)
			ratio, _ := f.Value["ratio"].(float64)
			passes, _ := f.Value["passes_aa"].(bool)
			if !passes {
				failing++
			}
			contrast = append(contrast, map[string]any{
				"fact_id": f.ID(), "ink": m[1], "surface": m[2],
				"ratio": round(ratio, 3), "passes_aa": passes,
				"passes_aa_large": f.Value["passes_aa_large"],
				"suggested":       remedy.Suggested.Hex(),
				"ratio_after":     round(remedy.After, 3),
				"delta_e":         round(remedy.DeltaE, 3),
				"achievable":      remedy.Achievable,
			})
		}
	}
	return map[string]any{
		"raster": note, "palette": palette, "contrast": contrast,
		"facts": factList, "fact_count": len(facts), "failing_contrast": failing,
	}
}
