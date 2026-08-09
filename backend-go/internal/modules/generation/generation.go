// Package generation — Mapper (TRD §4.3) + deterministic Generator (§4.4) +
// Grounding Validator (§4.5, FR-GEN-06, BR-09). Port of
// backend/app/modules/generation.py.
//
// Philosophy: "the model proposes, the system verifies". The LLM is only consulted
// for the requirement -> endpoint mapping over a CLOSED candidate list. Test data,
// boundaries and assertions are derived deterministically from the endpoint
// inventory (ISTQB EP / BVA / negative / decision-table techniques). Before
// persistence every case passes the grounding gate: a single fabricated endpoint,
// parameter, body field or assertion target means the case is DISCARDED — never
// repaired, never shown (BO-07).
package generation

import (
	"fmt"
	"math"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"traceo/internal/config"
	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/jobs"
	"traceo/internal/llm"
	"traceo/internal/models"
)

var depths = []string{"smoke", "standard", "exhaustive"}

func Register(r *gin.RouterGroup) {
	r.POST("/projects/:project_id/generate", httpx.Auth(), httpx.Require("generate"), startGeneration)
}

type generateRequest struct {
	RequirementIDs []string `json:"requirement_ids"`
	Depth          *string  `json:"depth"`
}

func startGeneration(c *gin.Context) {
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
	depth := "standard"
	if body.Depth != nil {
		depth = *body.Depth
	}
	valid := false
	for _, d := range depths {
		if depth == d {
			valid = true
			break
		}
	}
	if !valid {
		httpx.Err(c, http.StatusUnprocessableEntity, "invalid_depth",
			"depth must be one of "+strings.Join(depths, ", "))
		return
	}
	orgID, userID := u.OrganisationID, u.ID
	var requirementIDs []string
	if len(body.RequirementIDs) > 0 {
		requirementIDs = append(requirementIDs, body.RequirementIDs...)
	}
	// Registered against the project so the autopilot double-trigger guard
	// (automation contract 4b) sees manual generation jobs too.
	job := jobs.SubmitForProject("generate", projectID, func(j *jobs.Job) (any, error) {
		return runGeneration(j, orgID, userID, projectID, requirementIDs, depth)
	})
	c.JSON(http.StatusAccepted, gin.H{"job_id": job.ID})
}

// Run executes a generation job body synchronously — exported for the autopilot
// auto-trigger. requirementIDs == nil means all confirmed requirements.
func Run(job *jobs.Job, orgID, userID, projectID string,
	requirementIDs []string, depth string) (any, error) {
	return runGeneration(job, orgID, userID, projectID, requirementIDs, depth)
}

type dupKey struct {
	technique, method, path, title string
}

func runGeneration(job *jobs.Job, orgID, userID, projectID string,
	requirementIDs []string, depth string) (any, error) {
	unmappable := []map[string]any{}
	var reqs []*models.Requirement
	if requirementIDs != nil {
		var found []*models.Requirement
		db.DB.Where("project_id = ? AND organisation_id = ? AND id IN ?",
			projectID, orgID, requirementIDs).Find(&found)
		foundIDs := map[string]bool{}
		for _, r := range found {
			foundIDs[r.ID] = true
		}
		for _, rid := range requirementIDs {
			if !foundIDs[rid] {
				unmappable = append(unmappable, map[string]any{
					"requirement_id": rid, "reason": "requirement not found in project"})
			}
		}
		for _, r := range found {
			if r.State != "confirmed" {
				unmappable = append(unmappable, map[string]any{
					"requirement_id": r.ID,
					"reason":         fmt.Sprintf("requirement state is '%s', not confirmed", r.State)})
			} else {
				reqs = append(reqs, r)
			}
		}
	} else {
		db.DB.Where("project_id = ? AND organisation_id = ? AND state = ?",
			projectID, orgID, "confirmed").Find(&reqs)
	}

	var endpoints []*models.Endpoint
	db.DB.Where("project_id = ? AND organisation_id = ? AND excluded = ?",
		projectID, orgID, false).Find(&endpoints)
	endpointsByKey := map[string]*models.Endpoint{}
	for _, e := range endpoints {
		endpointsByKey[strings.ToUpper(e.Method)+" "+e.Path] = e
	}

	// duplicate index over already-approved cases (FR-GEN-11)
	dupKeys := map[dupKey]bool{}
	var approved []*models.TestCase
	db.DB.Preload("Steps", func(tx *gorm.DB) *gorm.DB { return tx.Order("step_order asc") }).
		Where("project_id = ? AND organisation_id = ? AND state = ?", projectID, orgID, "approved").
		Find(&approved)
	for _, tc := range approved {
		m, p := "", ""
		if len(tc.Steps) > 0 {
			m = strings.ToUpper(tc.Steps[0].Method)
			p = tc.Steps[0].Path
		}
		dupKeys[dupKey{tc.Technique, m, p, tc.Title}] = true
	}

	provider := llm.Get()
	generated, discarded, duplicates := 0, 0, 0
	total := len(reqs)
	if total < 1 {
		total = 1
	}

	for idx, req := range reqs {
		ref := req.ExternalID
		if ref == "" {
			ref = req.ID[:8]
		}
		job.Set(math.Round(float64(idx)/float64(total)*0.95*1000)/1000, "Mapping requirement "+ref)
		if len(endpoints) == 0 {
			unmappable = append(unmappable, map[string]any{
				"requirement_id": req.ID, "reason": "endpoint inventory is empty"})
			continue
		}
		parts := []string{req.Description}
		for _, a := range req.AcceptanceCriteria {
			parts = append(parts, pyStr(a))
		}
		reqText := strings.TrimSpace(strings.Join(parts, " "))
		candidates := prefilter(reqText, endpoints)
		if len(candidates) == 0 {
			unmappable = append(unmappable, map[string]any{
				"requirement_id": req.ID, "reason": "no candidate endpoints matched the requirement text"})
			continue
		}
		candPayload := make([]map[string]any, 0, len(candidates))
		for _, e := range candidates {
			tags := asList(e.Tags)
			if tags == nil {
				tags = []any{}
			}
			candPayload = append(candPayload, map[string]any{
				"method": e.Method, "path": e.Path, "summary": e.Summary,
				"operation_id": e.OperationID, "tags": tags})
		}
		payload := marshalNoEscape(map[string]any{"requirement": reqText, "candidates": candPayload})
		result, err := provider.CompleteJSON("map_requirement",
			mapInstructions+"PAYLOAD:\n"+payload+mapPromptSuffix, mapSchema)
		if err != nil { // one bad mapping must not sink the job
			unmappable = append(unmappable, map[string]any{
				"requirement_id": req.ID, "reason": "mapping failed: " + err.Error()})
			continue
		}
		var selected []int
		for _, sv := range asList(result.Data["selected"]) {
			if _, isBool := sv.(bool); isBool {
				continue
			}
			if i, ok := asIntVal(sv); ok && i >= 0 && i < len(candidates) {
				selected = append(selected, i)
			}
		}
		confidence, _ := asFloat(result.Data["confidence"])
		if len(selected) == 0 {
			unmappable = append(unmappable, map[string]any{
				"requirement_id": req.ID, "reason": "mapper selected no endpoint"})
			continue
		}
		if confidence < minMapConfidence {
			unmappable = append(unmappable, map[string]any{
				"requirement_id": req.ID,
				"reason":         fmt.Sprintf("mapping confidence %.2f below 0.3", confidence)})
			continue
		}
		modelName := result.Model
		if modelName == "" {
			modelName = "deterministic"
		}

		seen := map[int]bool{}
		for _, ci := range selected { // de-dup, keep order
			if seen[ci] {
				continue
			}
			seen[ci] = true
			ep := candidates[ci]
			job.Set(-1, "Generating cases for "+strings.ToUpper(ep.Method)+" "+ep.Path)
			for _, caseData := range generateCases(req, ep, depth) {
				// HARD GATE — the model proposes, the system verifies (BR-09)
				if len(GroundingValidate(caseData, endpointsByKey)) > 0 {
					discarded++
					continue
				}
				first := asMap(asList(caseData["steps"])[0])
				k := dupKey{pyStr(caseData["technique"]), pyStr(first["method"]),
					pyStr(first["path"]), pyStr(caseData["title"])}
				if dupKeys[k] {
					duplicates++
					continue
				}
				persistCase(orgID, projectID, req, caseData, modelName)
				generated++
			}
		}
	}

	job.Set(0.98, fmt.Sprintf("Generated %d, discarded %d (grounding), %d unmappable",
		generated, discarded, len(unmappable)))
	uid := userID
	httpx.Audit(orgID, &uid, "generation.completed", "project", projectID, models.JSONMap{
		"generated": generated, "discarded": discarded, "duplicates": duplicates,
		"unmappable": len(unmappable), "depth": depth})
	// BO-07: discarded is reported as a count only — the cases themselves are never shown
	return map[string]any{"generated": generated, "discarded": discarded,
		"unmappable": unmappable, "duplicates": duplicates}, nil
}

func persistCase(orgID, projectID string, req *models.Requirement,
	caseData map[string]any, modelName string) {
	steps := asList(caseData["steps"])
	tsteps := make([]models.TestStep, 0, len(steps))
	for i, sv := range steps {
		s := asMap(sv)
		var epID *string
		if v, ok := s["endpoint_id"].(string); ok && v != "" {
			id := v
			epID = &id
		}
		extractions := asList(s["extractions"])
		if extractions == nil {
			extractions = []any{}
		}
		tsteps = append(tsteps, models.TestStep{
			Order: i, EndpointID: epID,
			Method: pyStr(s["method"]), Path: pyStr(s["path"]),
			Request:     models.JSONMap(asMap(s["request"])),
			Assertions:  models.JSONList(asList(s["assertions"])),
			Extractions: models.JSONList(extractions),
		})
	}
	tc := models.TestCase{
		OrganisationID: orgID, ProjectID: projectID,
		Title:       truncRunes(pyStr(caseData["title"]), 500),
		Description: pyStr(caseData["description"]), Preconditions: pyStr(caseData["preconditions"]),
		Type: pyStr(caseData["type"]), Priority: pyStr(caseData["priority"]),
		State: "draft", Generated: true, Model: modelName,
		PromptVersion: config.C.PromptVer, Technique: pyStr(caseData["technique"]),
		Version: 1, Steps: tsteps,
	}
	db.DB.Create(&tc)
	db.DB.Create(&models.RequirementTestCase{
		RequirementID: req.ID, TestCaseID: tc.ID,
		LinkSource: "generated", RequirementVersionAtLink: req.Version,
	})
}
