// Package security (module) — security test generation and the coverage matrix,
// phase S0 of docs/SECURITY_TESTING_PLAN.md. Port of
// backend/app/modules/security.py.
//
//	GET  /v1/weaknesses                        capability "view"     — the shipped corpus
//	POST /v1/projects/{id}/security/generate   capability "generate" — 202 {job_id}
//	GET  /v1/projects/{id}/security/coverage   capability "view"     — the §11 matrix
//
// Security is a TECHNIQUE FAMILY inside generation, not a second engine: the
// requirement -> endpoint mapping, the case shape, the grounding gate, jobs,
// review, approval and the traceability matrix are all the existing ones. Zero
// LLM calls — the whole phase is deterministic and works air-gapped.
//
// The package name collides with traceo/internal/security (auth primitives);
// importers alias this one, e.g. `secmod "traceo/internal/modules/security"`.
package security

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

// noRequirementReason is the BO-07 reason: a security case that cannot be traced
// to a requirement is not generated at all. It is a distinct, stated reason in
// the coverage report — not a silent omission and not a bug.
const noRequirementReason = "endpoint is not mapped to any confirmed requirement, and a case with no " +
	"requirement cannot be traced or grounded (BO-07)"

const existingCaseReason = "an identical security case for this endpoint and weakness already exists"

func Register(r *gin.RouterGroup) {
	g := r.Group("", httpx.Auth())
	g.GET("/weaknesses", httpx.Require("view"), listWeaknesses)
	g.POST("/projects/:project_id/security/generate", httpx.Require("generate"), startSecurityGeneration)
	g.GET("/projects/:project_id/security/coverage", httpx.Require("view"), securityCoverage)
}

// ---------------------------------------------------------------------------
// GET /v1/weaknesses
// ---------------------------------------------------------------------------

func listWeaknesses(c *gin.Context) {
	c.JSON(http.StatusOK, Payload())
}

// ---------------------------------------------------------------------------
// Shared inventory helpers
// ---------------------------------------------------------------------------

// includedEndpoints returns the project's included endpoints in a stable order.
func includedEndpoints(orgID, projectID string) []*models.Endpoint {
	var endpoints []*models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ? AND excluded = ?",
		projectID, orgID, false).Find(&endpoints)
	sort.SliceStable(endpoints, func(i, j int) bool {
		if endpoints[i].Path != endpoints[j].Path {
			return endpoints[i].Path < endpoints[j].Path
		}
		return method(endpoints[i]) < method(endpoints[j])
	})
	return endpoints
}

// endpointRequirements maps each endpoint id to the confirmed requirements that
// anchor it, most authoritative first.
//
// Two sources, in this order:
//  1. EXISTING TRACEABILITY — a requirement already linked to a case that hits
//     this endpoint is the strongest statement of intent there is;
//  2. the generator's OWN lexical shortlist (generation.Prefilter, the list the
//     mapper is handed) — reused, not reimplemented, and deliberately the
//     offline half of it so this phase makes no model call.
//
// Each endpoint's list is sorted by (external_id, id), so the requirement that
// anchors a case is stable across runs and across backends.
func endpointRequirements(orgID, projectID string, endpoints []*models.Endpoint,
	requirementIDs []string) map[string][]*models.Requirement {
	mapping := map[string][]*models.Requirement{}
	if len(endpoints) == 0 {
		return mapping
	}
	var reqs []*models.Requirement
	q := db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
		projectID, orgID, "confirmed")
	if len(requirementIDs) > 0 {
		q = q.Where("id IN ?", requirementIDs)
	}
	q.Find(&reqs)
	if len(reqs) == 0 {
		return mapping
	}
	sort.SliceStable(reqs, func(i, j int) bool { return reqSortKey(reqs[i]) < reqSortKey(reqs[j]) })

	byID := map[string]*models.Requirement{}
	for _, r := range reqs {
		byID[r.ID] = r
	}
	byKey := map[string]*models.Endpoint{}
	known := map[string]bool{}
	for _, ep := range endpoints {
		byKey[endpointKey(ep)] = ep
		known[ep.ID] = true
		mapping[ep.ID] = nil
	}
	seen := map[string]bool{} // endpointID + "|" + requirementID

	// 1. existing traceability
	type linkRow struct {
		RequirementID string
		EndpointID    *string
		Method        string
		Path          string
	}
	var rows []linkRow
	db.DB.Table("requirement_test_cases").
		Select("requirement_test_cases.requirement_id, test_steps.endpoint_id, "+
			"test_steps.method, test_steps.path").
		Joins("JOIN test_cases ON test_cases.id = requirement_test_cases.test_case_id").
		Joins("JOIN test_steps ON test_steps.test_case_id = test_cases.id").
		Where("test_cases.project_id = ? AND test_cases.organisation_id = ? AND test_cases.state <> ?",
			projectID, orgID, "archived").
		Scan(&rows)
	for _, row := range rows {
		req := byID[row.RequirementID]
		if req == nil {
			continue
		}
		epID := ""
		if row.EndpointID != nil {
			epID = *row.EndpointID
		}
		if !known[epID] {
			match := byKey[strings.ToUpper(row.Method)+" "+row.Path]
			if match == nil {
				continue
			}
			epID = match.ID
		}
		if seen[epID+"|"+req.ID] {
			continue
		}
		seen[epID+"|"+req.ID] = true
		mapping[epID] = append(mapping[epID], req)
	}

	// 2. deterministic lexical prefilter
	for _, req := range reqs {
		parts := []string{req.Description}
		for _, ac := range req.AcceptanceCriteria {
			if s, ok := ac.(string); ok {
				parts = append(parts, s)
			}
		}
		text := strings.TrimSpace(strings.Join(parts, " "))
		for _, ep := range generation.Prefilter(text, endpoints) {
			if seen[ep.ID+"|"+req.ID] {
				continue
			}
			seen[ep.ID+"|"+req.ID] = true
			mapping[ep.ID] = append(mapping[ep.ID], req)
		}
	}

	for epID := range mapping {
		list := mapping[epID]
		sort.SliceStable(list, func(i, j int) bool { return reqSortKey(list[i]) < reqSortKey(list[j]) })
		mapping[epID] = list
	}
	return mapping
}

// reqSortKey orders requirements by external id then id; a requirement without
// an external id sorts last ("~" is above every printable identifier char).
func reqSortKey(r *models.Requirement) string {
	external := r.ExternalID
	if external == "" {
		external = "~"
	}
	return external + "\x00" + r.ID
}

func inventoryByKey(endpoints []*models.Endpoint) map[string]*models.Endpoint {
	out := make(map[string]*models.Endpoint, len(endpoints))
	for _, ep := range endpoints {
		out[endpointKey(ep)] = ep
	}
	return out
}

// existingRow is one (endpoint, weakness, title) triple the project already
// holds, read from the entry step of every non-archived security case.
type existingRow struct {
	EndpointID string
	WeaknessID string
	Title      string
}

func existingRows(orgID, projectID string) []existingRow {
	var rows []existingRow
	db.DB.Table("test_steps").
		Select("test_steps.endpoint_id as endpoint_id, test_cases.weakness_id as weakness_id, "+
			"test_cases.title as title").
		Joins("JOIN test_cases ON test_cases.id = test_steps.test_case_id").
		Where("test_cases.project_id = ? AND test_cases.organisation_id = ? AND "+
			"test_cases.state <> ? AND test_cases.weakness_id IS NOT NULL",
			projectID, orgID, "archived").
		Scan(&rows)
	out := make([]existingRow, 0, len(rows))
	for _, r := range rows {
		if r.EndpointID != "" {
			out = append(out, r)
		}
	}
	return out
}

// coveredPairs — (endpoint_id, weakness_id) already covered by a non-archived
// security case. PAIR granularity: the §11 matrix asks "is this pair covered",
// not "how many cases cover it", so a class that legitimately emits several
// cases (token handling emits an expired and an unsigned token) covers its pair
// once.
func coveredPairs(orgID, projectID string) map[string]bool {
	out := map[string]bool{}
	for _, r := range existingRows(orgID, projectID) {
		out[r.EndpointID+"|"+r.WeaknessID] = true
	}
	return out
}

// existingCaseKeys — (endpoint_id, weakness_id, title) is the DUPLICATE key,
// deliberately finer than the coverage pair so re-running is idempotent without
// silently dropping the second and subsequent cases a class emits for one pair.
func existingCaseKeys(orgID, projectID string) map[string]bool {
	out := map[string]bool{}
	for _, r := range existingRows(orgID, projectID) {
		out[r.EndpointID+"|"+r.WeaknessID+"|"+r.Title] = true
	}
	return out
}

// ---------------------------------------------------------------------------
// The plan — ONE code path, inspectable without side effects
// ---------------------------------------------------------------------------

// plannedCase is a case the corpus can ground, with the requirement that anchors it.
type plannedCase struct {
	req  *models.Requirement
	data map[string]any
}

// skipRecord is one (endpoint, weakness) pair that produced no case, with the
// reason. `applicable` distinguishes "the class does not apply here" from
// "it applies and something else stopped us" — the coverage report needs both.
type skipRecord struct {
	endpointID string
	method     string
	path       string
	weaknessID string
	reason     string
	applicable bool
}

// buildPlan deterministically builds every security case the corpus can ground.
// NOTHING is written, so the plan can be inspected — by a test, by a dry run —
// without side effects.
func buildPlan(orgID, projectID string, weaknessIDs, requirementIDs []string) (
	[]plannedCase, map[string]*models.Endpoint, []skipRecord) {
	wanted := selectedWeaknesses(weaknessIDs)
	endpoints := includedEndpoints(orgID, projectID)
	inventory := inventoryByKey(endpoints)
	var cases []plannedCase
	var skipped []skipRecord
	if len(endpoints) == 0 || len(wanted) == 0 {
		return cases, inventory, skipped
	}
	anchors := endpointRequirements(orgID, projectID, endpoints, requirementIDs)

	for _, ep := range endpoints {
		reqs := anchors[ep.ID]
		for _, w := range wanted {
			ok, reason := Applicable(ep, w)
			if !ok {
				skipped = append(skipped, skipRecord{ep.ID, method(ep), ep.Path, w.ID, reason, false})
				continue
			}
			if len(reqs) == 0 {
				// BO-07, not a bug: no requirement, no case — reported as its own reason.
				skipped = append(skipped, skipRecord{ep.ID, method(ep), ep.Path, w.ID,
					noRequirementReason, true})
				continue
			}
			built := BuildCases(reqs[0], ep, w)
			if len(built) == 0 {
				skipped = append(skipped, skipRecord{ep.ID, method(ep), ep.Path, w.ID,
					fmt.Sprintf("no builder produced a case for '%s'", w.ID), true})
				continue
			}
			for _, data := range built {
				cases = append(cases, plannedCase{req: reqs[0], data: data})
			}
		}
	}
	return cases, inventory, skipped
}

func selectedWeaknesses(weaknessIDs []string) []*Weakness {
	if len(weaknessIDs) == 0 {
		return Weaknesses()
	}
	requested := map[string]bool{}
	for _, id := range weaknessIDs {
		requested[id] = true
	}
	out := make([]*Weakness, 0, len(weaknessIDs))
	for _, w := range Weaknesses() { // catalogue order, duplicates ignored
		if requested[w.ID] {
			out = append(out, w)
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// POST /v1/projects/{id}/security/generate
// ---------------------------------------------------------------------------

type generateRequest struct {
	WeaknessIDs    []string `json:"weakness_ids"`
	RequirementIDs []string `json:"requirement_ids"`
}

func startSecurityGeneration(c *gin.Context) {
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
	// De-duplicate, keeping request order, then reject anything outside the corpus:
	// a typo must not silently generate nothing.
	var requested []string
	seen := map[string]bool{}
	var unknown []string
	for _, id := range body.WeaknessIDs {
		if seen[id] {
			continue
		}
		seen[id] = true
		requested = append(requested, id)
		if Find(id) == nil {
			unknown = append(unknown, id)
		}
	}
	if len(unknown) > 0 {
		known := make([]string, 0, len(Weaknesses()))
		for _, w := range Weaknesses() {
			known = append(known, w.ID)
		}
		sort.Strings(known)
		errWith(c, http.StatusUnprocessableEntity, "unknown_weakness",
			"Unknown weakness ids: "+strings.Join(unknown, ", "), known)
		return
	}
	var requirementIDs []string
	if len(body.RequirementIDs) > 0 {
		requirementIDs = append([]string{}, body.RequirementIDs...)
	}
	orgID, userID := u.OrganisationID, u.ID
	job := jobs.SubmitForProject("security", projectID, func(j *jobs.Job) (any, error) {
		return runSecurityGeneration(j, orgID, userID, projectID, requested, requirementIDs)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID})
}

// errWith writes the error envelope carrying an extra "errors" list.
func errWith(c *gin.Context, status int, code, message string, errs []string) {
	c.AbortWithStatusJSON(status, gin.H{"detail": gin.H{
		"code": code, "message": message, "errors": errs}})
}

// Run executes the security generation job body synchronously — exported for
// callers that already own a job (parity with generation.Run).
func Run(job *jobs.Job, orgID, userID, projectID string,
	weaknessIDs, requirementIDs []string) (any, error) {
	return runSecurityGeneration(job, orgID, userID, projectID, weaknessIDs, requirementIDs)
}

func runSecurityGeneration(job *jobs.Job, orgID, userID, projectID string,
	weaknessIDs, requirementIDs []string) (any, error) {
	job.Set(0.05, "Building the security plan")
	cases, inventory, skipped := buildPlan(orgID, projectID, weaknessIDs, requirementIDs)
	existing := existingCaseKeys(orgID, projectID)

	generated, discarded := 0, 0
	total := len(cases)
	if total < 1 {
		total = 1
	}
	for idx, planned := range cases {
		data := planned.data
		step := asMap(asList(data["steps"])[0])
		endpointID := str(step["endpoint_id"])
		wid := str(data["weakness_id"])
		title := truncRunes(str(data["title"]), 500)
		job.Set(math.Round(float64(idx)/float64(total)*0.95*1000)/1000,
			"Grounding "+wid+" on "+str(step["method"])+" "+str(step["path"]))
		key := endpointID + "|" + wid + "|" + title
		if existing[key] {
			skipped = append(skipped, skipRecord{endpointID, str(step["method"]),
				str(step["path"]), wid, existingCaseReason, true})
			continue
		}
		// HARD GATE — the same validator functional generation uses (BR-09).
		// A single fabricated identifier discards the case (BO-07).
		if len(generation.GroundingValidate(data, inventory)) > 0 {
			discarded++
			continue
		}
		persistCase(orgID, projectID, planned.req, data)
		existing[key] = true
		generated++
	}

	job.Set(0.98, fmt.Sprintf("Generated %d, discarded %d (grounding), %d pairs skipped",
		generated, discarded, len(skipped)))
	uid := userID
	reported := weaknessIDs
	if len(reported) == 0 {
		for _, w := range Weaknesses() {
			reported = append(reported, w.ID)
		}
	}
	httpx.Audit(orgID, &uid, "security.generate", "project", projectID, models.JSONMap{
		"generated": generated, "discarded": discarded, "skipped": len(skipped),
		"corpus_version": Version(), "weakness_ids": reported})
	// BO-07: discarded is a count only — a discarded case is never shown.
	out := make([]map[string]any, 0, len(skipped))
	for _, s := range skipped {
		out = append(out, map[string]any{"endpoint": s.method + " " + s.path,
			"weakness": s.weaknessID, "reason": s.reason})
	}
	return map[string]any{"generated": generated, "discarded": discarded, "skipped": out}, nil
}

func persistCase(orgID, projectID string, req *models.Requirement, caseData map[string]any) {
	steps := asList(caseData["steps"])
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
	weaknessID := str(caseData["weakness_id"])
	tc := models.TestCase{
		OrganisationID: orgID, ProjectID: projectID,
		Title:         truncRunes(str(caseData["title"]), 500),
		Description:   str(caseData["description"]),
		Preconditions: str(caseData["preconditions"]),
		Type:          str(caseData["type"]), Priority: str(caseData["priority"]),
		State: "draft", Generated: true, Model: Model,
		PromptVersion: config.C.PromptVer, Technique: str(caseData["technique"]),
		WeaknessID: &weaknessID, Version: 1, Steps: tsteps,
	}
	db.DB.Create(&tc)
	db.DB.Create(&models.RequirementTestCase{
		RequirementID: req.ID, TestCaseID: tc.ID,
		LinkSource: "generated", RequirementVersionAtLink: req.Version,
	})
}

// ---------------------------------------------------------------------------
// GET /v1/projects/{id}/security/coverage — the §11 matrix
// ---------------------------------------------------------------------------

func securityCoverage(c *gin.Context) {
	u := httpx.User(c)
	projectID := c.Param("project_id")
	if _, ok := httpx.ProjectScoped(c, projectID); !ok {
		return
	}
	c.JSON(http.StatusOK, Coverage(u.OrganisationID, projectID))
}

// Coverage computes the endpoint x weakness matrix (§11). Deterministic and
// read-only: it answers a narrower question than the plan (is this pair
// covered?), which is why it only needs Applicable and never builds the cases
// it counts.
//
//	covered        a case exists for the pair
//	not_applicable the class's precondition does not hold, with the reason
//	gap            applicable, but no case exists — the number that matters
//
// covered + not_applicable + gap == total, always.
func Coverage(orgID, projectID string) gin.H {
	endpoints := includedEndpoints(orgID, projectID)
	corpus := Weaknesses()
	existing := coveredPairs(orgID, projectID)
	anchors := map[string][]*models.Requirement{}
	if len(endpoints) > 0 {
		anchors = endpointRequirements(orgID, projectID, endpoints, nil)
	}

	type counters struct{ covered, notApplicable, gap int }
	perWeakness := map[string]*counters{}
	for _, w := range corpus {
		perWeakness[w.ID] = &counters{}
	}
	totals := counters{}
	skipped := []gin.H{}

	for _, ep := range endpoints {
		for _, w := range corpus {
			cw := perWeakness[w.ID]
			ok, reason := Applicable(ep, w)
			if !ok {
				totals.notApplicable++
				cw.notApplicable++
				skipped = append(skipped, gin.H{"endpoint_id": ep.ID, "method": method(ep),
					"path": ep.Path, "weakness_id": w.ID, "reason": reason})
				continue
			}
			if existing[ep.ID+"|"+w.ID] {
				totals.covered++
				cw.covered++
				continue
			}
			totals.gap++
			cw.gap++
			if len(anchors[ep.ID]) == 0 {
				// Applicable, uncovered, and it CANNOT be covered until a
				// requirement maps here — a distinct reason, stated as such.
				skipped = append(skipped, gin.H{"endpoint_id": ep.ID, "method": method(ep),
					"path": ep.Path, "weakness_id": w.ID, "reason": noRequirementReason})
			}
		}
	}

	byWeakness := make([]gin.H, 0, len(corpus))
	for _, w := range corpus {
		cw := perWeakness[w.ID]
		byWeakness = append(byWeakness, gin.H{"weakness_id": w.ID, "covered": cw.covered,
			"not_applicable": cw.notApplicable, "gap": cw.gap})
	}
	return gin.H{
		"corpus_version": Version(),
		"pairs": gin.H{"total": len(endpoints) * len(corpus), "covered": totals.covered,
			"not_applicable": totals.notApplicable, "gap": totals.gap},
		"by_weakness": byWeakness,
		"skipped":     skipped,
	}
}
