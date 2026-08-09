// insight.go — routes, deterministic planning and the generation job.
//
//	GET  /v1/projects/{id}/insights           capability "view"     — no job
//	POST /v1/projects/{id}/insights/generate  capability "generate" — 202 {job_id}
//
// The SAME planner feeds both: the GET reports how many new cases the builders
// could produce right now (suggestable_count) without creating anything, the
// POST persists exactly those cases. No LLM is involved on either path.
package insight

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())
	g.GET("/projects/:project_id/insights", httpx.Require("view"), getInsights)
	g.POST("/projects/:project_id/insights/generate", httpx.Require("generate"), startInsightGeneration)
}

// ---------------------------------------------------------------------------
// Planning — one code path, used by the report and by the job (no duplication)
// ---------------------------------------------------------------------------

// candidate is one planned case: the category it belongs to, the requirement it
// will be linked to, and the raw case payload handed to the grounding gate.
type candidate struct {
	category string
	req      *models.Requirement
	data     map[string]any
}

// dedupKey — a planned case is the same case as an existing/earlier one when the
// category, the entry step and the title all match.
func dedupKey(category, title string, data map[string]any) string {
	m, p := "", ""
	if steps, ok := data["steps"].([]any); ok && len(steps) > 0 {
		if s, ok := steps[0].(map[string]any); ok {
			m, _ = s["method"].(string)
			p, _ = s["path"].(string)
		}
	}
	return category + "|" + m + "|" + p + "|" + title
}

func existingKey(tc *models.TestCase, steps []models.TestStep) string {
	category := ""
	if tc.EdgeCategory != nil {
		category = *tc.EdgeCategory
	}
	m, p := "", ""
	if len(steps) > 0 {
		m = strings.ToUpper(steps[0].Method)
		p = steps[0].Path
	}
	return category + "|" + m + "|" + p + "|" + tc.Title
}

// projectCases loads the project's non-archived cases with their steps ordered.
func projectCases(orgID, projectID string) ([]*models.TestCase, map[string][]models.TestStep) {
	var cases []*models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ? AND state <> ?",
		projectID, orgID, "archived").Order("created_at asc, id asc").Find(&cases)
	ids := make([]string, 0, len(cases))
	for _, tc := range cases {
		ids = append(ids, tc.ID)
	}
	stepsByCase := map[string][]models.TestStep{}
	if len(ids) > 0 {
		var steps []models.TestStep
		db.DB.Where("test_case_id IN ?", ids).
			Order("test_case_id asc, step_order asc").Find(&steps)
		for _, s := range steps {
			stepsByCase[s.TestCaseID] = append(stepsByCase[s.TestCaseID], s)
		}
	}
	return cases, stepsByCase
}

// plan walks the project's inventory deterministically and returns the candidate
// cases for the requested categories that do NOT already exist. It creates
// nothing and calls no model.
//
// Requirement -> endpoint association is the generator's lexical prefilter, so
// the engine stays 100% offline; every case is linked to the requirement it was
// planned for (an unlinked case is rejected by the grounding gate anyway).
// plan returns the candidate cases the builders can ground right now, plus the
// number of candidates suppressed because an equivalent case already exists in
// the project (reported as `duplicates`, matching the Python engine).
func plan(orgID, projectID string, categories []string, requirementIDs []string) ([]candidate, int) {
	duplicates := 0
	var endpoints []*models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ? AND excluded = ?",
		projectID, orgID, false).Find(&endpoints)
	sort.SliceStable(endpoints, func(i, j int) bool {
		if endpoints[i].Path != endpoints[j].Path {
			return endpoints[i].Path < endpoints[j].Path
		}
		return method(endpoints[i]) < method(endpoints[j])
	})
	if len(endpoints) == 0 {
		return nil, duplicates
	}

	var reqs []*models.Requirement
	q := db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		projectID, orgID, "confirmed")
	if requirementIDs != nil {
		if len(requirementIDs) == 0 {
			return nil, duplicates
		}
		q = q.Where("id IN ?", requirementIDs)
	}
	q.Find(&reqs)
	sort.SliceStable(reqs, func(i, j int) bool {
		if reqs[i].ExternalID != reqs[j].ExternalID {
			return reqs[i].ExternalID < reqs[j].ExternalID
		}
		return reqs[i].ID < reqs[j].ID
	})
	if len(reqs) == 0 {
		return nil, duplicates
	}

	// `existing` is what the project ALREADY has; `seen` additionally absorbs the
	// cases planned so far. Only a collision with `existing` counts as a
	// duplicate — the same endpoint is reachable from several requirements, so
	// intra-plan collisions are ordinary de-duplication, not a finding. Same
	// split as the Python engine, whose build_plan de-dups by title silently.
	existing := map[string]bool{}
	cases, stepsByCase := projectCases(orgID, projectID)
	for _, tc := range cases {
		existing[existingKey(tc, stepsByCase[tc.ID])] = true
	}
	seen := map[string]bool{}
	for k := range existing {
		seen[k] = true
	}

	wanted := make([]string, 0, len(categories))
	for _, c := range Categories { // canonical order, ignore duplicates in the request
		for _, want := range categories {
			if c == want {
				wanted = append(wanted, c)
				break
			}
		}
	}

	var out []candidate
	for _, req := range reqs {
		parts := append([]string{req.Description}, stringsOf(req.AcceptanceCriteria)...)
		reqText := strings.TrimSpace(strings.Join(parts, " "))
		matched := generation.Prefilter(reqText, endpoints)
		if len(matched) == 0 {
			continue // no lexical anchor: invent nothing for this requirement
		}
		for _, ep := range matched {
			for _, category := range wanted {
				for _, data := range build(category, req, ep, endpoints) {
					key := dedupKey(category, str(data["title"]), data)
					if seen[key] {
						if existing[key] {
							duplicates++ // the project already covers this exact case
						}
						continue
					}
					seen[key] = true
					out = append(out, candidate{category: category, req: req, data: data})
				}
			}
		}
	}
	return out, duplicates
}

func stringsOf(l models.JSONList) []string {
	out := make([]string, 0, len(l))
	for _, v := range l {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// endpointsByKey — the inventory keyed as the grounding validator expects.
func endpointsByKey(orgID, projectID string) map[string]*models.Endpoint {
	var endpoints []*models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ? AND excluded = ?",
		projectID, orgID, false).Find(&endpoints)
	out := make(map[string]*models.Endpoint, len(endpoints))
	for _, ep := range endpoints {
		out[method(ep)+" "+ep.Path] = ep
	}
	return out
}

// ---------------------------------------------------------------------------
// GET /v1/projects/{id}/insights
// ---------------------------------------------------------------------------

func getInsights(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	c.JSON(http.StatusOK, Report(u.OrganisationID, projectID))
}

// Report computes the coverage report. Deterministic, read-only, no job.
//
//	covered_count     non-archived cases already in the category (edge_category
//	                  match, or Classify() for legacy cases)
//	suggestable_count NEW cases the builders could produce right now — the same
//	                  planner the generate job runs, filtered by the same
//	                  grounding gate, but nothing is persisted
//	status            "covered" when covered_count > 0; else "gap" when
//	                  suggestable_count > 0; else "n_a"
func Report(orgID, projectID string) gin.H {
	covered := map[string]int{}
	cases, stepsByCase := projectCases(orgID, projectID)
	for _, tc := range cases {
		if cat := Classify(tc, stepsByCase[tc.ID]); cat != "" {
			covered[cat]++
		}
	}

	suggestable := map[string]int{}
	inventory := endpointsByKey(orgID, projectID)
	planned, _ := plan(orgID, projectID, Categories, nil)
	for _, cand := range planned {
		// The report must promise only what the job can deliver: a candidate the
		// grounding gate would discard is not suggestable.
		if len(generation.GroundingValidate(cand.data, inventory)) == 0 {
			suggestable[cand.category]++
		}
	}

	rows := make([]gin.H, 0, len(Categories))
	totalCovered, totalSuggestable := 0, 0
	for _, id := range Categories {
		status := "n_a"
		switch {
		case covered[id] > 0:
			status = "covered"
		case suggestable[id] > 0:
			status = "gap"
		}
		rows = append(rows, gin.H{"id": id, "covered_count": covered[id],
			"suggestable_count": suggestable[id], "status": status})
		totalCovered += covered[id]
		totalSuggestable += suggestable[id]
	}
	return gin.H{"categories": rows, "total_cases": len(cases),
		"total_covered": totalCovered, "total_suggestable": totalSuggestable}
}

// ---------------------------------------------------------------------------
// POST /v1/projects/{id}/insights/generate
// ---------------------------------------------------------------------------

type generateRequest struct {
	Categories     []string `json:"categories"`
	RequirementIDs []string `json:"requirement_ids"`
}

func startInsightGeneration(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	var body generateRequest
	if c.Request.ContentLength != 0 {
		if err := c.ShouldBindJSON(&body); err != nil {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_body", "Malformed request body")
			return
		}
	}
	if len(body.Categories) == 0 {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_category",
			"categories must be a non-empty list of "+strings.Join(Categories, ", "))
		return
	}
	for _, cat := range body.Categories {
		if !IsCategory(cat) {
			httpx.Err(c, http.StatusUnprocessableEntity, "invalid_category",
				"unknown category '"+cat+"'; expected one of "+strings.Join(Categories, ", "))
			return
		}
	}
	categories := append([]string(nil), body.Categories...)
	var requirementIDs []string
	if body.RequirementIDs != nil {
		requirementIDs = append([]string{}, body.RequirementIDs...)
	}
	orgID, userID := u.OrganisationID, u.ID
	// Job kind follows the existing one-word convention ("ingest", "generate").
	job := jobs.SubmitForProject("insight", projectID, func(j *jobs.Job) (any, error) {
		return runInsightGeneration(j, orgID, userID, projectID, categories, requirementIDs)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID})
}

// Run executes the insight job body synchronously — exported for callers that
// already own a job (parity with generation.Run).
func Run(job *jobs.Job, orgID, userID, projectID string,
	categories, requirementIDs []string) (any, error) {
	return runInsightGeneration(job, orgID, userID, projectID, categories, requirementIDs)
}

func runInsightGeneration(job *jobs.Job, orgID, userID, projectID string,
	categories, requirementIDs []string) (any, error) {
	job.Set(0.05, "Planning edge cases")
	candidates, duplicates := plan(orgID, projectID, categories, requirementIDs)
	inventory := endpointsByKey(orgID, projectID)

	generated, discarded := 0, 0
	byCategory := map[string]int{}
	total := len(candidates)
	if total < 1 {
		total = 1
	}
	for i, cand := range candidates {
		job.Set(math.Round(float64(i)/float64(total)*0.95*1000)/1000,
			"Building "+cand.category+" cases")
		// HARD GATE — reused verbatim from the generator, never bypassed and
		// never reimplemented: a single fabricated identifier discards the case
		// (BO-07). Discards are counted, never shown.
		if len(generation.GroundingValidate(cand.data, inventory)) > 0 {
			discarded++
			continue
		}
		persistCase(orgID, projectID, cand)
		byCategory[cand.category]++
		generated++
	}

	job.Set(0.98, fmt.Sprintf("Generated %d, discarded %d (grounding)", generated, discarded))
	uid := userID
	httpx.Audit(orgID, &uid, "insight.generate", "project", projectID, models.JSONMap{
		"categories": categories, "created": generated, "discarded": discarded,
		"duplicates": duplicates})
	// by_category carries EVERY requested category, zeros included — a category
	// that produced nothing is a fact the caller needs, not a missing key.
	counts := map[string]any{}
	for _, id := range categories {
		if IsCategory(id) {
			counts[id] = byCategory[id]
		}
	}
	return map[string]any{"generated": generated, "discarded": discarded,
		"duplicates": duplicates, "categories": categories, "by_category": counts}, nil
}

func persistCase(orgID, projectID string, cand candidate) {
	steps, _ := cand.data["steps"].([]any)
	tsteps := make([]models.TestStep, 0, len(steps))
	for i, sv := range steps {
		s := asMap(sv)
		var epID *string
		if v := str(s["endpoint_id"]); v != "" {
			id := v
			epID = &id
		}
		tsteps = append(tsteps, models.TestStep{
			Order: i, EndpointID: epID,
			Method: str(s["method"]), Path: str(s["path"]),
			Request:     models.JSONMap(asMap(s["request"])),
			Assertions:  models.JSONList(asList(s["assertions"])),
			Extractions: models.JSONList{},
		})
	}
	category := cand.category
	tc := models.TestCase{
		OrganisationID: orgID, ProjectID: projectID,
		Title:       truncRunes(str(cand.data["title"]), 500),
		Description: str(cand.data["description"]),
		// Deterministic engine: no model, no prompt — the prompt version is kept
		// for provenance parity with the generator's rows.
		Preconditions: str(cand.data["preconditions"]),
		Type:          str(cand.data["type"]), Priority: str(cand.data["priority"]),
		State: "draft", Generated: true, Model: "deterministic",
		PromptVersion: config.C.PromptVer, Technique: Technique,
		EdgeCategory: &category, Version: 1, Steps: tsteps,
	}
	db.DB.Create(&tc)
	db.DB.Create(&models.RequirementTestCase{
		RequirementID: cand.req.ID, TestCaseID: tc.ID,
		LinkSource: "generated", RequirementVersionAtLink: cand.req.Version,
	})
}
