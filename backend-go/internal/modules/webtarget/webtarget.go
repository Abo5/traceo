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
	"traceo/internal/modules/autopilot"
	"traceo/internal/modules/design"
	"traceo/internal/modules/discovery"
	"traceo/internal/modules/generation"
	"traceo/internal/modules/pageintel"
	secmod "traceo/internal/modules/security"
	"traceo/internal/security"
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
	// Auth and MaxPages are decoded as `any` and validated by hand, so a bad
	// value gets the coded refusal this contract states rather than a silently
	// dropped field — and gets the SAME refusal the Python engine gives.
	Auth     any `json:"auth"`
	MaxPages any `json:"max_pages"`
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
	// Refused before anything is written: a target that was rejected must leave
	// no row, no credentials and no job behind.
	username, password, hasAuth, okAuth := ValidateAuth(body.Auth)
	if !okAuth {
		errWith(c, http.StatusUnprocessableEntity, "invalid_credentials",
			"Signing in needs both a username and a password. Neither may be blank.",
			[]string{"username", "password"})
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
	current := DefaultMaxPages
	if found && row.MaxPages > 0 {
		current = row.MaxPages
	}
	maxPages, okPages := ValidateMaxPages(body.MaxPages, current)
	if !okPages {
		errWith(c, http.StatusUnprocessableEntity, "invalid_max_pages",
			fmt.Sprintf("max_pages must be a whole number between %d and %d.",
				MinPages, MaxPages),
			[]string{strconv.Itoa(MinPages), strconv.Itoa(MaxPages)})
		return
	}
	if found {
		update := map[string]any{"status": "pending", "last_error": nil,
			"max_pages": maxPages, "updated_at": time.Now().UTC()}
		if hasAuth {
			// Sealed immediately and never read back. Credentials sent once keep
			// working on a re-run: the write-only rule means the caller CANNOT
			// resend what it can no longer read.
			update["auth_config_encrypted"] = security.Encrypt(
				map[string]any{"username": username, "password": password})
		}
		db.DB.Model(&models.WebTarget{}).Where("id = ?", row.ID).Updates(update)
		if hasAuth {
			row.AuthConfigEncrypted = update["auth_config_encrypted"].([]byte)
		}
		row.MaxPages = maxPages
	} else {
		row = models.WebTarget{OrganisationID: u.OrganisationID, ProjectID: projectID,
			URL: target, Viewport: viewport, Status: "pending", Inventory: models.JSONMap{},
			MaxPages: maxPages}
		if hasAuth {
			row.AuthConfigEncrypted = security.Encrypt(
				map[string]any{"username": username, "password": password})
		}
		if err := db.DB.Create(&row).Error; err != nil {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_request",
				"The web target could not be recorded.")
			return
		}
	}
	authConfigured := len(row.AuthConfigEncrypted) > 0
	httpx.Audit(u.OrganisationID, &u.ID, "web_target.requested", "web_target", row.ID,
		models.JSONMap{"url": target, "viewport": viewport, "test_types": testTypes,
			"max_pages": maxPages,
			// Provenance, never a value.
			"auth_configured": authConfigured})

	orgID, userID, targetID := u.OrganisationID, u.ID, row.ID
	job := jobs.SubmitForProject("discover", projectID, func(j *jobs.Job) (any, error) {
		return RunDiscovery(j, orgID, userID, projectID, targetID, target, viewport, testTypes)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID, "target_id": targetID,
		"test_types": testTypes, "max_pages": maxPages,
		"auth_configured": authConfigured})
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
		// WRITE-ONLY: whether credentials are stored, never what they are. There
		// is no route anywhere that returns the username or the password.
		"auth_configured": len(t.AuthConfigEncrypted) > 0,
		"max_pages":       t.MaxPages,
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
			"pages":          listOr("pages"),
			"crawl": func() any {
				if m := asMap(inv["crawl"]); m != nil {
					return m
				}
				return gin.H{}
			}(),
			"login":   inv["login"],
			"outcome": str(inv["outcome"]),
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

// casePreconditions is the case's preconditions with its page reference written
// into them. Until this ran, `page:<final_url>` existed only inside the
// grounding gate: it decided which cases were admitted and was then dropped, so
// a persisted case could not answer "which page is this about" without
// re-deriving it from the selectors. Mirrors webtarget.py::case_preconditions
// exactly — the two engines must store the same text.
func casePreconditions(kase Case) string {
	ref := ""
	for _, g := range kase.Grounds {
		if strings.HasPrefix(g, "page:") {
			ref = g
			break
		}
	}
	if ref == "" || strings.Contains(kase.Preconditions, ref) {
		return kase.Preconditions
	}
	if kase.Preconditions == "" {
		return ref
	}
	return kase.Preconditions + "\n" + ref
}

func persistCase(orgID, projectID string, req *models.Requirement, kase Case) {
	persistCaseAs(orgID, projectID, req, kase, modelName)
}

func persistCaseAs(orgID, projectID string, req *models.Requirement, kase Case,
	author string) {
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
		Preconditions: casePreconditions(kase), Type: kase.Type, Priority: kase.Priority,
		State: "draft", Generated: true, Model: author,
		PromptVersion: config.C.PromptVer, Technique: kase.Technique,
		Version: 1, Steps: steps,
	}
	db.DB.Create(&tc)
	db.DB.Create(&models.RequirementTestCase{
		RequirementID: req.ID, TestCaseID: tc.ID,
		LinkSource: "generated", RequirementVersionAtLink: req.Version,
	})
}

// intelPage translates a crawled page into the shape the model track reads. The
// two packages keep separate types on purpose: pageintel must not depend on the
// crawl's payload structs, or the closed list it builds would drift with them.
func intelPage(page Inventory) pageintel.Page {
	out := pageintel.Page{URL: firstNonEmpty(page.FinalURL, page.URL), Title: page.Title,
		Path: page.PagePath()}
	for _, form := range page.Forms {
		f := pageintel.Form{Selector: form.Selector, Name: form.Name, Heading: form.Heading,
			SubmitName: form.SubmitName, Method: form.Method, Action: form.Action}
		for _, field := range form.Fields {
			f.Fields = append(f.Fields, pageintel.Field{
				Selector: field.Selector, Name: field.Name, ID: field.ID,
				Label: field.Label, Type: field.Type, Required: field.Required,
				Placeholder: field.Placeholder, Pattern: field.Pattern,
				MaxLength: field.MaxLength,
			})
		}
		out.Forms = append(out.Forms, f)
	}
	for _, control := range page.Controls {
		out.Controls = append(out.Controls, pageintel.Control{
			Selector: control.Selector, Name: control.Name, Role: control.Role})
	}
	for _, req := range page.Requests {
		out.Requests = append(out.Requests, pageintel.Request{
			Method: req.Method, URL: req.URL, ResourceType: req.ResourceType})
	}
	return out
}

// behaviourCase turns an admissible proposal into this module's case shape. The
// step addresses the page's own selectors, resolved by pageintel from the ids the
// model cited — never from anything it wrote.
func behaviourCase(b pageintel.Case) Case {
	fields := b.Fields
	if fields == nil {
		fields = []string{}
	}
	controls := b.Controls
	if controls == nil {
		controls = []string{}
	}
	return Case{
		Title: b.Title, Description: b.Description, Preconditions: b.Preconditions,
		Type: b.Type, Priority: b.Priority, Technique: b.Technique,
		Grounds: b.Grounds,
		Steps: []Step{{
			Method: "GET", Path: b.Path,
			Request: map[string]any{"url": b.URL, "screen": b.Screen,
				"check": "behaviour", "fields": fields, "controls": controls},
			Assertions: []any{map[string]any{
				"type": "expected_outcome", "statement": b.Expected}},
		}},
	}
}

func containsEntry(list []map[string]any, want map[string]any) bool {
	for _, item := range list {
		if len(item) == len(want) {
			same := true
			for k, v := range want {
				if item[k] != v {
					same = false
					break
				}
			}
			if same {
				return true
			}
		}
	}
	return false
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
			prior.RequestSchema = models.JSONMap(op.RequestSchema)
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
			RequestSchema:   models.JSONMap(op.RequestSchema),
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

// planFor is what this target asks the browser to do, read from its own row.
//
// The credentials are decrypted HERE, inside the job, rather than being handed
// to it by the HTTP handler: the shorter the distance a password travels, the
// fewer places it can be logged from. The row is clamped rather than trusted — a
// value written before the ceiling existed must not make the crawl unbounded.
func planFor(targetID string) *CrawlPlan {
	plan := &CrawlPlan{MaxPages: DefaultMaxPages, MaxDepth: DefaultMaxDepth}
	var row models.WebTarget
	if err := db.DB.First(&row, "id = ?", targetID).Error; err != nil {
		return plan
	}
	if row.MaxPages > 0 {
		plan.MaxPages = row.MaxPages
	}
	if plan.MaxPages < MinPages {
		plan.MaxPages = MinPages
	}
	if plan.MaxPages > MaxPages {
		plan.MaxPages = MaxPages
	}
	auth := security.Decrypt(row.AuthConfigEncrypted)
	plan.Username = str(auth["username"])
	plan.Password = str(auth["password"])
	return plan
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

	plan := planFor(targetID)
	if plan.SignsIn() {
		job.Set(0.05, "Signing in and crawling "+target)
	} else {
		job.Set(0.05, "Rendering "+target)
	}
	payload, runErr := SidecarRunner(target, viewport, outDir, config.C.WebDiscoveryTimeout,
		plan)
	login := NormaliseLogin(payload, plan.SignsIn())
	// A crawl asked to sign in with the OPERATOR's credentials and unable to
	// PROVE it did must fail. Continuing would crawl the logged-out product and
	// report it as the real one — the failure mode that produces confident,
	// completely wrong test cases. Credentials the PAGE published are a different
	// matter: the page being wrong is not the operator being wrong, and that
	// degrades to the public surface further down instead.
	if runErr == nil && plan.SignsIn() && (login == nil || !login.Succeeded) {
		runErr = jobs.Fail(LoginFailed, LoginFailedMessage)
	}
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

	pages := NormalisePages(payload)
	crawl := NormaliseCrawl(payload)
	// `visited` is the number of pages THIS module normalised, not the sidecar's
	// own count: the number a user is shown has to be the number of pages that
	// actually produced requirements.
	crawl["visited"] = len(pages)
	if crawl["requested_max_pages"] == nil {
		crawl["requested_max_pages"] = plan.MaxPages
	}
	crawlSkipped := asList(crawl["skipped"])
	// The first crawled page IS the top-level page: everything that spoke about
	// "the page" before the crawl existed still speaks about this one.
	inv := pages[0]
	multi := len(pages) > 1
	if multi {
		job.Set(0.35, fmt.Sprintf("Reading %d pages", len(pages)))
	} else {
		job.Set(0.35, "Reading the rendered page")
	}
	tokens := make([]string, len(pages))
	screenshotKeys := make([]string, len(pages))
	for i, page := range pages {
		tokens[i] = PageToken(page, i)
		screenshotKeys[i] = storeScreenshot(targetID+tokens[i], page, outDir)
	}
	screenshotKey := screenshotKeys[0]

	// where names a skip's page only when there is more than one — a single-page
	// target reads exactly as it always has.
	where := func(page Inventory, reason string) string {
		if !multi {
			return reason
		}
		return reason + " (" + page.pageURL() + ")"
	}

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

	// modelName records WHO wrote a case. A reviewer reading a plan that mixes
	// deterministic builders with model proposals needs to know which is which,
	// and the case row is the only place that survives.
	emitAs := func(req *models.Requirement, kase Case, kind string,
		artefacts map[string]bool, author string) {
		if len(GroundingViolations(kase.Grounds, artefacts)) > 0 {
			discarded++
			return
		}
		key := kase.Technique + "|" + trunc(kase.Title, 500)
		if existing[key] {
			duplicates++
			return
		}
		persistCaseAs(orgID, projectID, req, kase, author)
		existing[key] = true
		casesByType[kind]++
	}
	emit := func(req *models.Requirement, kase Case, kind string, artefacts map[string]bool) {
		emitAs(req, kase, kind, artefacts, modelName)
	}

	// The API surface is a property of the CRAWL, not of one page: an endpoint
	// two pages both call is one endpoint. Everything else is a statement about a
	// single page and is derived per page below.
	requests := CrawlRequests(pages)

	// --- api / security: the captured request inventory ---------------------
	var ops []Operation
	var domEndpoints []models.Endpoint
	if selected["api"] || selected["security"] {
		job.Set(0.45, "Recording the captured requests")
		// The origins the crawl actually visited — every page it opened, not
		// merely the URL it was given, because a login can legitimately redirect
		// to an SSO host and that host is then part of the target.
		visitedOrigins := map[string]bool{}
		for _, pg := range pages {
			target := pg.FinalURL
			if target == "" {
				target = pg.URL
			}
			if parsed, err := url.Parse(target); err == nil && parsed.Host != "" {
				visitedOrigins[parsed.Scheme+"://"+parsed.Host] = true
			}
		}
		var foreignReasons []string
		ops, foreignReasons = EndpointsFromRequests(requests, visitedOrigins)
		for _, reason := range foreignReasons {
			if selected["api"] {
				skipped = append(skipped, map[string]any{"type": "api", "reason": reason})
			}
		}
		// A page that talks to its server through a classic form POST makes no
		// XHR at all. Its markup still DECLARES the operation, and a crawl that
		// only reads the network reports zero endpoints for it.
		observed := map[string]bool{}
		for _, op := range ops {
			observed[op.Method+" "+op.Path] = true
		}
		declared, declined := EndpointsFromForms(pages)
		// A captured request beats a declaration for the same operation: one is
		// what the page did, the other is what it says it would do.
		for _, op := range declared {
			if !observed[op.Method+" "+op.Path] {
				ops = append(ops, op)
			}
		}
		sort.Slice(ops, func(i, j int) bool {
			if ops[i].Method != ops[j].Method {
				return ops[i].Method < ops[j].Method
			}
			return ops[i].Path < ops[j].Path
		})
		if selected["api"] {
			for _, reason := range declined {
				skipped = append(skipped, map[string]any{"type": "api", "reason": reason})
			}
		}
		if len(ops) == 0 {
			reason := "the page made no XHR/fetch request and declares no form action, " +
				"so there is no API surface to record"
			if multi {
				reason = fmt.Sprintf("none of the %d pages the crawl visited made an "+
					"XHR/fetch request or declared a form action, so there is no API "+
					"surface to record", len(pages))
			}
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

	// The api and security tracks are checked against the whole crawl; the
	// per-page tracks are checked against their own page's set, which is what
	// stops a form case citing a selector from a different page.
	artefacts := CrawlArtefactIDs(pages, nil)
	// The artefact an endpoint-derived case stands on is the REQUEST the browser
	// was seen to make; the endpoint row is a derivation of it, so citing the
	// capture keeps the chain back to observed evidence.
	capturedByKey := map[string]string{}
	for _, op := range ops {
		if len(op.URLs) > 0 {
			capturedByKey[op.Method+" "+op.Path] = op.URLs[0]
		}
	}
	// Which page a capture was made from, so an endpoint case can say which page
	// it belongs to. First writer wins: the earliest page in breadth-first order
	// is the one the crawl reached that request from.
	pageOfRequest := map[string]string{}
	for _, page := range pages {
		ref := PageRef(page)
		for _, req := range page.Requests {
			key := "request:" + req.Method + " " + req.URL
			if _, present := pageOfRequest[key]; !present {
				pageOfRequest[key] = ref
			}
		}
	}
	// An endpoint the markup declared has no captured request to cite; what it
	// stands on is the form element itself and the page that rendered it.
	declaredByKey := map[string]*Declaration{}
	for i := range ops {
		if ops[i].DeclaredBy != nil {
			declaredByKey[ops[i].Method+" "+ops[i].Path] = ops[i].DeclaredBy
		}
	}
	// endpointGrounds is what a case built on this endpoint may cite, or nil when
	// nothing the discovery found supports it — in which case no case is built.
	endpointGrounds := func(method, path string) []string {
		if captured, present := capturedByKey[method+" "+path]; present {
			ground := "request:" + method + " " + captured
			if ref := pageOfRequest[ground]; ref != "" {
				return []string{ground, ref}
			}
			return []string{ground}
		}
		if declared, present := declaredByKey[method+" "+path]; present {
			refs := []string{"selector:" + declared.Selector}
			if declared.Page != "" {
				refs = append(refs, declared.Page)
			}
			return refs
		}
		return nil
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
				grounds := endpointGrounds(strings.ToUpper(ep.Method), ep.Path)
				if len(grounds) == 0 {
					continue
				}
				for _, kase := range generation.GenerateCases(apiReq, ep, "standard") {
					// Same second gate the API generator applies: a case may not
					// cite a parameter or status the endpoint never declared.
					if len(generation.GroundingValidate(kase, apiByKey)) > 0 {
						discarded++
						continue
					}
					emit(apiReq, caseFromMap(kase, grounds), "api", artefacts)
				}
			}
		}
	}

	// --- functional: one requirement per form, on every page ---------------
	if selected["functional"] {
		job.Set(0.55, "Extracting the forms")
		anyForm := false
		for _, page := range pages {
			if len(page.Forms) > 0 {
				anyForm = true
			}
		}
		if !anyForm {
			reason := "the rendered page contains no form"
			if multi {
				reason = fmt.Sprintf("none of the %d pages the crawl visited contains a form",
					len(pages))
			}
			skipped = append(skipped, map[string]any{"type": "functional", "reason": reason})
		}
		for index, page := range pages {
			pageArtefacts := ArtefactIDs(page, nil)
			for _, form := range page.Forms {
				description, criteria, sourceText := FormRequirementText(form, page)
				req, _ := upsertRequirement(orgID, projectID,
					fmt.Sprintf("WEB-%s%s-F%d", short, tokens[index], form.Index+1),
					description, criteria, "functional",
					map[string]any{"url": page.FinalURL, "selector": form.Selector},
					sourceText, "high")
				requirementCount++
				for _, kase := range FormCases(form, page) {
					emit(req, kase, "functional", pageArtefacts)
				}
			}

			// The deterministic builders above assert what the page CONTAINS.
			// What it is FOR is the one thing a model reads better than a rule,
			// so it is asked — over a closed list of this page's own artefacts,
			// and anything citing something else is discarded here exactly as a
			// fabricated endpoint is (BO-07). The track is additive: a provider
			// that is unavailable, slow or unhelpful costs behaviours, never the
			// crawl.
			behaviours, rejected, notes := pageintel.Propose(intelPage(page), nil)
			discarded += rejected
			if len(behaviours) > 0 {
				titles := make([]string, 0, len(behaviours))
				for _, b := range behaviours {
					titles = append(titles, b.Title)
				}
				sorted := append([]string{}, titles...)
				sort.Strings(sorted)
				breq, _ := upsertRequirement(orgID, projectID,
					fmt.Sprintf("WEB-%s%s-BEH", short, tokens[index]),
					fmt.Sprintf("The screen '%s' behaves as its %d stated cases require.",
						firstNonEmpty(page.Title, page.FinalURL), len(behaviours)),
					titles, "functional",
					map[string]any{"url": page.FinalURL},
					trunc(jsonString(sorted), 4000), "high")
				requirementCount++
				author := pageintel.ModelName(nil)
				for _, b := range behaviours {
					emitAs(breq, behaviourCase(b), "functional", pageArtefacts, author)
				}
			}
			for _, note := range notes {
				entry := map[string]any{"type": "functional", "reason": note}
				if !containsEntry(skipped, entry) {
					skipped = append(skipped, entry)
				}
			}
		}
	}

	// --- performance: every page carries its OWN baseline ------------------
	if selected["performance"] {
		job.Set(0.62, "Recording the load baseline")
		timed := 0
		budget := config.C.PageLoadBudgetMS
		for index, page := range pages {
			if page.ElapsedMS == nil {
				continue
			}
			timed++
			observed := *page.ElapsedMS
			priority := "medium"
			if observed > budget {
				priority = "high"
			}
			req, _ := upsertRequirement(orgID, projectID,
				"WEB-"+short+tokens[index]+"-PERF",
				fmt.Sprintf("The page %s must finish loading within %dms. The observed "+
					"baseline at discovery was %dms.", page.FinalURL, budget, observed),
				[]string{fmt.Sprintf("Page load completes in %dms or less", budget)},
				"non_functional", map[string]any{"url": page.FinalURL},
				jsonString(map[string]any{"budget_ms": budget, "observed_ms": observed}),
				priority)
			requirementCount++
			emit(req, PerformanceCase(page, budget), "performance", ArtefactIDs(page, nil))
		}
		if timed == 0 {
			skipped = append(skipped, map[string]any{"type": "performance",
				"reason": "the sidecar reported no elapsed_ms baseline"})
		}
	}

	// --- ui: design facts from each page's own screenshot ------------------
	designPayload := map[string]any{}
	pageDesigns := make([]map[string]any, len(pages))
	for i := range pageDesigns {
		pageDesigns[i] = map[string]any{}
	}
	if selected["ui"] {
		job.Set(0.70, "Extracting design facts")
		anyShot := false
		for _, key := range screenshotKeys {
			if key != "" {
				anyShot = true
			}
		}
		if !anyShot {
			skipped = append(skipped, map[string]any{"type": "ui",
				"reason": "the sidecar produced no screenshot"})
		}
		for index, page := range pages {
			key := screenshotKeys[index]
			if key == "" {
				if anyShot {
					skipped = append(skipped, map[string]any{"type": "ui",
						"reason": where(page, "the sidecar produced no screenshot")})
				}
				continue
			}
			img, decodeErr := design.DecodePNG(
				filepath.Join(config.C.StorageDir, filepath.FromSlash(key)),
				design.RGB{255, 255, 255})
			if decodeErr != nil {
				skipped = append(skipped, map[string]any{"type": "ui",
					"reason": where(page,
						"the screenshot could not be decoded: "+decodeErr.Error())})
				continue
			}
			analysed, note := design.FitForAnalysis(img, viewportHeight(viewport),
				config.C.DesignMaxPixels)
			facts := design.DesignFacts(analysed)
			pageDesigns[index] = designSummary(facts, note)
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
					"reason": where(page, "the screenshot states no extractable design fact")})
				continue
			}
			// The requirement names the screen a human would name; the cases name
			// the screen design.UICases has always named. Kept apart on purpose —
			// they are two different sentences with two different readers.
			named := firstNonEmpty(page.Title, page.FinalURL, target)
			screen := firstNonEmpty(page.Title, page.PagePath())
			sortedIDs := append([]string{}, factIDs...)
			sort.Strings(sortedIDs)
			req, _ := upsertRequirement(orgID, projectID,
				"WEB-"+short+tokens[index]+"-UI",
				fmt.Sprintf("The screen '%s' conforms to the %d design facts extracted "+
					"from its rendering at %s.", named, len(facts), viewport),
				statements, "interface",
				map[string]any{"url": page.FinalURL, "viewport": viewport},
				jsonString(sortedIDs), "medium")
			requirementCount++
			uiArtefacts := ArtefactIDs(page, factIDs)
			for _, kase := range uiCases(facts, page, screen) {
				emit(req, kase, "ui", uiArtefacts)
			}
		}
		// "design" has always meant the target page's design, and the detail route
		// and the UI both read it that way; the rest travel per page.
		designPayload = pageDesigns[0]
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
			grounds := endpointGrounds(strings.ToUpper(ep.Method), ep.Path)
			if len(grounds) == 0 {
				continue
			}
			for _, weakness := range secmod.Weaknesses() {
				ok, reason := secmod.Applicable(ep, weakness)
				if !ok {
					reasons[reason] = true
					continue
				}
				for _, data := range secmod.BuildCases(req, ep, weakness) {
					if len(GroundingViolations(grounds, artefacts)) > 0 {
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
					// secmod.PersistCase is shared with spec-derived generation,
					// which has no page to cite; the reference is written in here
					// so only web-target cases carry it.
					data["preconditions"] = casePreconditions(Case{
						Preconditions: str(data["preconditions"]), Grounds: grounds})
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
	for _, r := range requests {
		if APIResourceTypes[r.ResourceType] {
			apiRequests++
		}
	}
	totalForms, totalControls := 0, 0
	for _, page := range pages {
		totalForms += len(page.Forms)
		totalControls += len(page.Controls)
	}
	endpointDigest := make([]any, 0, len(ops))
	for _, op := range ops {
		endpointDigest = append(endpointDigest, map[string]any{
			"method": op.Method, "path": op.Path, "observed_count": op.ObservedCount,
			"origins": op.Origins, "statuses": op.Statuses})
	}
	// The sign-in gate is reported against the TARGET page: it is the page a login
	// form would be on, and after a successful sign-in it is the page the crawl
	// landed on instead.
	report := LoginOutcome(login, inv)
	totalSoFar := 0
	for _, n := range casesByType {
		totalSoFar += n
	}
	sentence := OutcomeSentence(report, len(pages), len(crawlSkipped),
		requirementCount, totalSoFar)
	// One digest per page. Bounded on purpose: the full forms and controls of a
	// 50-page crawl do not belong in a row that is read on every list.
	pageDigests := make([]any, 0, len(pages))
	for i, page := range pages {
		facts := 0
		if n, isInt := pageDesigns[i]["fact_count"].(int); isInt {
			facts = n
		}
		pageDigests = append(pageDigests, map[string]any{
			"url": page.URL, "final_url": page.FinalURL, "title": page.Title,
			"depth": page.Depth, "status": page.Status, "elapsed_ms": page.ElapsedMS,
			"has_screenshot": screenshotKeys[i] != "",
			"counts": map[string]any{"forms": len(page.Forms),
				"controls": len(page.Controls), "requests": len(page.Requests),
				"design_facts": facts},
		})
	}
	summary := models.JSONMap{
		"test_types": testTypes,
		"counts": map[string]any{
			"forms": totalForms, "controls": totalControls,
			"requests": len(requests), "api_requests": apiRequests,
			"endpoints": endpointCount, "pages": len(pages)},
		"elapsed_ms":     inv.ElapsedMS,
		"forms":          inv.Forms,
		"controls":       capControls(inv.Controls, 200),
		"requests":       capRequests(requests, 300),
		"endpoints":      endpointDigest,
		"console_errors": inv.ConsoleErrors,
		"design":         designPayload,
		"skipped":        skipped,
		"pages":          pageDigests,
		"crawl":          crawl,
		"login":          report,
		"outcome":        sentence,
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
		"forms": totalForms, "controls": totalControls,
		"requests": len(requests), "endpoints": endpointCount,
		"requirements": requirementCount, "cases_by_type": casesByType,
		"skipped": skipped, "discarded": discarded, "duplicates": duplicates,
		"pages_visited": len(pages), "pages_skipped": crawlSkipped,
		// Provenance and outcome only. There is no field in this shape a username
		// or a password could be written into by accident.
		"login": map[string]any{"succeeded": report["succeeded"],
			"strategy":           report["strategy"],
			"credentials_source": report["credentials_source"],
			"error":              report["error"],
			"required":           report["required"], "form": report["form"]},
		// Always present, null included: "we did not sign in" and "we signed in
		// somehow" must not look the same to a caller.
		"credentials_source": report["credentials_source"],
		"outcome":            sentence,
	}
	uid := userID
	httpx.Audit(orgID, &uid, "web_target.discovered", "web_target", targetID, models.JSONMap{
		"url": target, "viewport": viewport, "test_types": testTypes,
		"endpoints": endpointCount, "requirements": requirementCount,
		"cases": totalCases, "discarded": discarded,
		"pages_visited": len(pages), "login": report["succeeded"],
		"credentials_source": report["credentials_source"]})
	// Autopilot chain (automation contract 4a/4b) — auto mode only. Without it
	// the crawl's requirements stay "extracted" and the model-assisted generator
	// never runs. It still stops at DRAFT cases: approval and runs stay manual.
	job.Set(0.99, "Autopilot: confirming extracted requirements")
	autopilot.AfterWebTarget(projectID, orgID, userID)

	pageWord := "pages"
	if len(pages) == 1 {
		pageWord = "page"
	}
	job.Set(0.99, fmt.Sprintf("%d cases from %d forms on %d %s, %d endpoints",
		totalCases, totalForms, len(pages), pageWord, endpointCount))
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
	ref := PageRef(inv)
	out := make([]Case, 0, len(facts)*2)
	for _, uc := range design.UICases(facts, screen) {
		request := map[string]any{"url": pageURL, "screen": uc.Screen, "check": uc.Check,
			"fact": uc.FactID, "expected": uc.Expected}
		if uc.Evidence != nil {
			request["evidence"] = uc.Evidence
		} else {
			request["evidence"] = nil
		}
		grounds := []string{"fact:" + uc.FactID}
		if ref != "" {
			grounds = append(grounds, ref)
		}
		out = append(out, Case{
			Title: uc.Title, Description: uc.Description, Preconditions: uc.Preconditions,
			Type: uc.Type, Priority: uc.Priority, Technique: uc.Technique,
			Steps: []Step{{Method: "GET", Path: path, Request: request,
				Assertions: []any{map[string]any{"type": uc.Check, "expected": uc.Expected}}}},
			Grounds: grounds,
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
