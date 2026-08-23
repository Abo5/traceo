// The unified coverage file — every case this project holds, in one document,
// grouped into the four categories a test plan is read in.
//
// The cases already exist as rows; what did not exist was one artefact you can
// hand to a reviewer and say "this is the coverage". Building it is therefore a
// projection, never a generation: no case is created, renamed or reworded here,
// and no category is inferred from the title text.
//
// # THE CLASSIFICATION IS DERIVED FROM COLUMNS, NOT GUESSED
//
// Each case lands in exactly one bucket, tested in this order:
//
//	edge      technique is edge_case or security, or the case carries an
//	          insight edge_category — the hostile and the exotic
//	quality   technique is design, a11y, performance or localisation — a claim
//	          about the rendered page, not about a user flow
//	boundary  type is boundary, or technique is bva — the limits themselves
//	invalid   type is negative — a value the system must refuse
//	happy     type is positive — the flow that should simply work
//	other     none of the above
//
// `quality` is a fifth section beyond the four a test plan names, and it is
// there because folding it into the fourth would misreport the coverage: on the
// first real target, 1102 of 2240 cases were contrast, design-token, timing and
// localisation assertions. Counted as "happy paths" they would have claimed 1272
// user flows where 286 exist. A category that flatters the number is worse than
// an extra heading.
//
// The `other` bucket is not decoration. A classification that silently drops
// what it cannot place would report a coverage number larger than the evidence
// behind it, so every case is placed and the totals are reconciled explicitly:
// `counts.total` must equal the sum of the buckets, and the response says so.
package reporting

import (
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"traceo/internal/db"
	"traceo/internal/httpx"
	"traceo/internal/models"
)

// coverageBuckets in the order they are tested and rendered.
var coverageBuckets = []struct {
	Key, Title, Blurb string
}{
	{"happy", "Happy paths", "Straightforward flows that must succeed."},
	{"boundary", "Valid & boundary", "Standard values, and the smallest and largest the rule allows."},
	{"invalid", "Invalid input", "Values the system has to refuse, and the message it must show."},
	{"edge", "Edge cases", "Exotic input, permission edges and the hostile path."},
	{"quality", "Design, accessibility & performance",
		"Claims about the rendered page itself — contrast, tokens, timing, localisation."},
	{"other", "Unclassified", "Cases whose type and technique match no category above."},
}

// classify places one case. Order is significant — see the package comment.
func classify(c *models.TestCase) string {
	technique := strings.ToLower(c.Technique)
	if technique == "edge_case" || technique == "security" || c.EdgeCategory != nil && *c.EdgeCategory != "" {
		return "edge"
	}
	switch technique {
	case "design", "a11y", "performance", "localisation":
		return "quality"
	}
	if strings.EqualFold(c.Type, "boundary") || technique == "bva" {
		return "boundary"
	}
	if strings.EqualFold(c.Type, "negative") {
		return "invalid"
	}
	if strings.EqualFold(c.Type, "positive") {
		return "happy"
	}
	return "other"
}

// stepTarget describes what one step touches, in the words the step recorded.
func stepTarget(s *models.TestStep) gin.H {
	out := gin.H{"order": s.Order}
	if s.Method != "" {
		out["method"] = s.Method
	}
	if s.Path != "" {
		out["path"] = s.Path
	}
	for _, key := range []string{"check", "url", "selector", "field", "value"} {
		if s.Request == nil {
			break
		}
		if v, ok := s.Request[key]; ok && v != nil && v != "" {
			out[key] = v
		}
	}
	if len(s.Assertions) > 0 {
		out["assertions"] = []any(s.Assertions)
	}
	return out
}

// buildCoverage projects the project's cases into the document both renderers use.
func buildCoverage(orgID, projectID string) (gin.H, error) {
	var project models.Project
	if err := db.DB.First(&project, "id = ? AND organisation_id = ?",
		projectID, orgID).Error; err != nil {
		return nil, err
	}

	var cases []models.TestCase
	db.DB.Where("project_id = ? AND organisation_id = ? AND state != ?",
		projectID, orgID, "archived").
		Order("technique asc, created_at asc").Find(&cases)

	ids := make([]string, 0, len(cases))
	for i := range cases {
		ids = append(ids, cases[i].ID)
	}
	reqs := requirementsByCase(ids)

	var steps []models.TestStep
	if len(ids) > 0 {
		db.DB.Where("test_case_id IN ?", ids).Order("step_order asc").Find(&steps)
	}
	stepsByCase := map[string][]*models.TestStep{}
	for i := range steps {
		s := &steps[i]
		stepsByCase[s.TestCaseID] = append(stepsByCase[s.TestCaseID], s)
	}

	// The screens this coverage was written from — the "what was explored" half
	// of the document, without which a reader cannot judge whether it is complete.
	var targets []models.WebTarget
	db.DB.Where("project_id = ? AND organisation_id = ?", projectID, orgID).
		Order("created_at asc").Find(&targets)
	explored := make([]gin.H, 0, len(targets))
	for i := range targets {
		t := &targets[i]
		entry := gin.H{"url": t.URL, "final_url": t.FinalURL, "title": t.Title,
			"viewport": t.Viewport, "status": t.Status}
		if t.Inventory != nil {
			// COUNTS, not the inventory itself. Inventory holds the full form,
			// control and request records — copying them here made one screen
			// serialise to megabytes and rendered a whole request log into a
			// single markdown table cell. What a coverage file needs from the
			// scan is how much there was, not what all of it was.
			for _, key := range []string{"forms", "controls", "requests", "pages"} {
				if v, ok := t.Inventory[key]; ok {
					entry[key] = countOf(v)
				}
			}
		}
		explored = append(explored, entry)
	}

	grouped := map[string][]gin.H{}
	counts := map[string]int{}
	for _, b := range coverageBuckets {
		grouped[b.Key] = []gin.H{}
		counts[b.Key] = 0
	}
	for i := range cases {
		c := &cases[i]
		bucket := classify(c)
		counts[bucket]++
		targetSteps := make([]gin.H, 0, len(stepsByCase[c.ID]))
		for _, s := range stepsByCase[c.ID] {
			targetSteps = append(targetSteps, stepTarget(s))
		}
		linked := make([]gin.H, 0, len(reqs[c.ID]))
		for _, r := range reqs[c.ID] {
			linked = append(linked, r.payload())
		}
		grouped[bucket] = append(grouped[bucket], gin.H{
			"id": c.ID, "title": c.Title, "expected": c.Description,
			"preconditions": c.Preconditions,
			"type":          c.Type, "technique": c.Technique, "priority": c.Priority,
			"state": c.State, "generated": c.Generated,
			// Provenance travels with the case: a coverage file that cannot say
			// which model wrote a line is not audit evidence.
			"model": c.Model, "prompt_version": c.PromptVersion,
			"requirements": linked, "steps": targetSteps,
		})
	}

	sections := make([]gin.H, 0, len(coverageBuckets))
	sum := 0
	for _, b := range coverageBuckets {
		sum += counts[b.Key]
		sections = append(sections, gin.H{
			"key": b.Key, "title": b.Title, "description": b.Blurb,
			"count": counts[b.Key], "cases": grouped[b.Key],
		})
	}

	return gin.H{
		"schema_version": 1,
		"project":        gin.H{"id": project.ID, "name": project.Name},
		"explored":       explored,
		"sections":       sections,
		"counts": gin.H{
			"total": len(cases), "happy": counts["happy"],
			"boundary": counts["boundary"], "invalid": counts["invalid"],
			"edge": counts["edge"], "quality": counts["quality"],
			"other": counts["other"],
			// Stated, not implied: a reader can check the arithmetic without
			// re-adding the sections, and a future bucket that forgets to
			// register itself shows up here as a mismatch instead of vanishing.
			"classified": sum,
			"reconciled": sum == len(cases),
		},
	}, nil
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

func exportCoverageJSON(c *gin.Context) {
	user := httpx.User(c)
	doc, err := buildCoverage(user.OrganisationID, c.Param("project_id"))
	if err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Project not found")
		return
	}
	c.Header("Content-Disposition", `attachment; filename="coverage.json"`)
	c.JSON(http.StatusOK, doc)
}

func exportCoverageMarkdown(c *gin.Context) {
	user := httpx.User(c)
	doc, err := buildCoverage(user.OrganisationID, c.Param("project_id"))
	if err != nil {
		httpx.Err(c, http.StatusNotFound, "not_found", "Project not found")
		return
	}
	c.Header("Content-Disposition", `attachment; filename="coverage.md"`)
	c.Data(http.StatusOK, "text/markdown; charset=utf-8", []byte(renderCoverageMarkdown(doc)))
}

func mdCell(v any) string {
	s := strings.TrimSpace(fmt.Sprint(v))
	s = strings.ReplaceAll(s, "|", "\\|")
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > 160 {
		s = string([]rune(s)[:159]) + "…"
	}
	return s
}

func renderCoverageMarkdown(doc gin.H) string {
	var b strings.Builder
	project, _ := doc["project"].(gin.H)
	counts, _ := doc["counts"].(gin.H)

	fmt.Fprintf(&b, "# Test coverage — %v\n\n", project["name"])
	fmt.Fprintf(&b, "%v cases: %v happy · %v valid/boundary · %v invalid · %v edge",
		counts["total"], counts["happy"], counts["boundary"],
		counts["invalid"], counts["edge"])
	if n, _ := counts["other"].(int); n > 0 {
		fmt.Fprintf(&b, " · %d unclassified", n)
	}
	b.WriteString("\n\n")
	if ok, _ := counts["reconciled"].(bool); !ok {
		// Loud, because a coverage file whose sections do not add up must not be
		// quotable as evidence.
		fmt.Fprintf(&b, "> **The sections do not add up to the total (%v classified of %v).** "+
			"Treat this document as incomplete.\n\n", counts["classified"], counts["total"])
	}

	if explored, _ := doc["explored"].([]gin.H); len(explored) > 0 {
		b.WriteString("## What was explored\n\n")
		b.WriteString("| Screen | URL | Forms | Controls | Requests |\n|---|---|---|---|---|\n")
		for _, e := range explored {
			url := e["final_url"]
			if url == nil || url == "" {
				url = e["url"]
			}
			fmt.Fprintf(&b, "| %s | %s | %v | %v | %v |\n",
				mdCell(e["title"]), mdCell(url),
				orDash(e["forms"]), orDash(e["controls"]), orDash(e["requests"]))
		}
		b.WriteString("\n")
	}

	sections, _ := doc["sections"].([]gin.H)
	for _, s := range sections {
		list, _ := s["cases"].([]gin.H)
		if len(list) == 0 {
			continue
		}
		fmt.Fprintf(&b, "## %v (%v)\n\n%v\n\n", s["title"], s["count"], s["description"])
		b.WriteString("| # | Case | Expected | Targets | Requirements |\n|---|---|---|---|---|\n")
		for i, cs := range list {
			fmt.Fprintf(&b, "| %d | %s | %s | %s | %s |\n", i+1,
				mdCell(cs["title"]), mdCell(cs["expected"]),
				mdCell(summariseTargets(cs["steps"])), mdCell(summariseReqs(cs["requirements"])))
		}
		b.WriteString("\n")
	}
	return b.String()
}

// countOf reduces an inventory value to a number: the length when it is a list,
// the value itself when the scan already recorded a count.
func countOf(v any) any {
	switch typed := v.(type) {
	case []any:
		return len(typed)
	case map[string]any:
		return len(typed)
	case float64, int, int64:
		return typed
	}
	return nil
}

func orDash(v any) any {
	if v == nil {
		return "—"
	}
	return v
}

// summariseTargets names what the case touches, from the step's own record.
func summariseTargets(v any) string {
	steps, _ := v.([]gin.H)
	seen := map[string]bool{}
	parts := []string{}
	for _, s := range steps {
		for _, key := range []string{"selector", "field", "path", "check"} {
			if val, ok := s[key]; ok && val != nil && val != "" {
				text := fmt.Sprint(val)
				if !seen[text] {
					seen[text] = true
					parts = append(parts, text)
				}
				break
			}
		}
	}
	sort.Strings(parts)
	if len(parts) > 4 {
		parts = append(parts[:4], fmt.Sprintf("+%d more", len(parts)-4))
	}
	return strings.Join(parts, ", ")
}

func summariseReqs(v any) string {
	reqs, _ := v.([]gin.H)
	parts := make([]string, 0, len(reqs))
	for _, r := range reqs {
		label := fmt.Sprint(r["external_id"])
		if label == "" || label == "<nil>" {
			id := fmt.Sprint(r["id"])
			if len(id) > 8 {
				id = id[:8]
			}
			label = id
		}
		parts = append(parts, label)
	}
	return strings.Join(parts, ", ")
}
