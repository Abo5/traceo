// Package pageintel asks the model what a crawled screen is FOR — "the model
// proposes, the system verifies". Port of backend/app/modules/pageintel.py; the
// payload, the prompt, the gate and the resulting cases are identical, so a
// client cannot tell the two engines apart.
//
// WHY IT EXISTS. The crawl reads a page exactly: every form, field, label,
// control and captured request. What it cannot do is understand what the screen
// is for. Measured on a 22-page crawl of the OrangeHRM demo, the deterministic
// tracks produced 1649 cases of which 987 read "Design: surface #FFFFFF is
// present" and 15 were functional — structurally true, and nearly silent about
// the product.
//
// WHAT THE MODEL MAY AND MAY NOT DECIDE. It may decide intent: which flows
// matter, what a sensible value looks like, what the product should do. It may
// NOT decide what exists. Every proposal must address artefacts by ids from a
// CLOSED list built from the crawl; anything else is discarded, never repaired
// (BO-07). A hallucinated field cannot reach a test plan; a hallucinated
// expectation is what the human reviewer is there to judge, which is why these
// land as drafts like everything else.
//
// The model never sees a credential: the payload is built from the inventory,
// and the inventory never carried one.
package pageintel

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"traceo/internal/config"
	"traceo/internal/llm"
)

// Enough of a page to reason about, small enough that a 25-page crawl does not
// blow the context window. A page with more fields than this is truncated rather
// than dropped: half a form still yields real cases.
const (
	MaxFieldsPerForm = 25
	MaxFormsPerPage  = 6
	MaxControls      = 30
	MaxEndpoints     = 15
	MaxCasesPerPage  = 12

	PromptID = "pageintel.v1"
)

var Instructions = "You are writing functional test cases for ONE screen of a web application. " +
	"The payload describes what a browser actually rendered: the screen's URL and " +
	"title, its forms with every field, the controls a user can activate, and the " +
	"requests the page issued.\n\n" +
	"Write the cases a competent tester would write for THIS screen — the " +
	"behaviours that matter, not a description of the markup. Prefer: required " +
	"and format rules a user will hit, the outcome of a successful submission, " +
	"what must happen when a value is wrong or absent, and state the screen " +
	"implies (an empty list, an item that already exists).\n\n" +
	"RULES THAT DECIDE WHETHER YOUR CASE IS KEPT:\n" +
	"  * `field_ids` and `control_ids` may ONLY contain ids that appear in the " +
	"payload. An id you invent means the whole case is discarded — an empty list " +
	"is a valid answer, a guessed id is not.\n" +
	"  * `title` is one line naming the behaviour, not the element. Write " +
	"\"Submitting with no username is rejected\", never \"the username input " +
	"exists\" — the deterministic tracks already assert what is present.\n" +
	"  * `expected` is what the PRODUCT must do, in one sentence, observable on " +
	"this screen.\n" +
	"  * `type` is positive when the flow should succeed, negative when the " +
	"product must refuse.\n" +
	"  * Do not invent screens, URLs, endpoints, roles or data that the payload " +
	"does not contain. Do not write cases about pages other than this one.\n" +
	fmt.Sprintf("  * At most %d cases. Fewer good ones beat more thin ones.\n", MaxCasesPerPage) +
	llm.UntrustedNote

// Field, Form, Control and Page mirror the shapes the crawl already produces.
type Field struct {
	Selector    string
	Name        string
	ID          string
	Label       string
	Type        string
	Required    bool
	Placeholder string
	Pattern     string
	MaxLength   *int
}

type Form struct {
	Selector   string
	Name       string
	Heading    string
	SubmitName string
	Method     string
	Action     string
	Fields     []Field
}

type Control struct {
	Selector string
	Name     string
	Role     string
}

type Request struct {
	Method       string
	URL          string
	ResourceType string
}

type Page struct {
	URL      string
	Title    string
	Path     string
	Forms    []Form
	Controls []Control
	Requests []Request
}

// Case is one admissible proposal, in the shape the crawl persists.
type Case struct {
	Title         string
	Description   string
	Preconditions string
	Type          string
	Priority      string
	Technique     string
	Fields        []string
	Controls      []string
	Expected      string
	Path          string
	URL           string
	Screen        string
	Grounds       []string
}

// Payload is the closed description of one page, and the only thing the model
// sees. Ids are positional ("f0.2" = form 0, field 2) rather than CSS selectors:
// a selector is a 200-character path that wastes context and invites the model
// to edit it, while a short id it cannot plausibly guess makes fabrication
// obvious at the gate.
func Payload(page Page) map[string]any {
	forms := make([]any, 0, len(page.Forms))
	for fi, form := range page.Forms {
		if fi >= MaxFormsPerPage {
			break
		}
		fields := make([]any, 0, len(form.Fields))
		for xi, field := range form.Fields {
			if xi >= MaxFieldsPerForm {
				break
			}
			entry := map[string]any{
				"id":       fmt.Sprintf("f%d.%d", fi, xi),
				"label":    firstNonEmpty(field.Label, field.Name, field.ID),
				"type":     firstNonEmpty(field.Type, "text"),
				"required": field.Required,
			}
			if field.Placeholder != "" {
				entry["placeholder"] = field.Placeholder
			}
			if field.Pattern != "" {
				entry["pattern"] = field.Pattern
			}
			if field.MaxLength != nil {
				entry["maxlength"] = *field.MaxLength
			}
			fields = append(fields, entry)
		}
		forms = append(forms, map[string]any{
			"id":         fmt.Sprintf("f%d", fi),
			"name":       firstNonEmpty(form.Name, form.Heading, form.SubmitName),
			"method":     firstNonEmpty(form.Method, "GET"),
			"submits_to": form.Action,
			"fields":     fields,
		})
	}

	controls := make([]any, 0, len(page.Controls))
	for ci, control := range page.Controls {
		if ci >= MaxControls {
			break
		}
		name := strings.TrimSpace(control.Name)
		if name == "" {
			continue // an unnamed control cannot be described, so it cannot be cited
		}
		controls = append(controls, map[string]any{
			"id": fmt.Sprintf("c%d", ci), "name": trunc(name, 120),
			"role": firstNonEmpty(control.Role, "button"),
		})
	}

	calls := make([]any, 0, MaxEndpoints)
	seen := map[string]bool{}
	for _, req := range page.Requests {
		if req.ResourceType != "xhr" && req.ResourceType != "fetch" {
			continue
		}
		base := req.URL
		if i := strings.Index(base, "?"); i >= 0 {
			base = base[:i]
		}
		method := firstNonEmpty(req.Method, "GET")
		key := method + " " + base
		if seen[key] {
			continue
		}
		seen[key] = true
		calls = append(calls, map[string]any{"method": method, "url": base})
		if len(calls) >= MaxEndpoints {
			break
		}
	}

	return map[string]any{
		"url": page.URL, "title": page.Title, "path": page.Path,
		"forms": forms, "controls": controls, "requests_the_page_made": calls,
	}
}

// Index returns the closed lists the gate checks against.
func Index(payload map[string]any) (map[string]map[string]any, map[string]map[string]any) {
	fields := map[string]map[string]any{}
	controls := map[string]map[string]any{}
	for _, rawForm := range asList(payload["forms"]) {
		form, _ := rawForm.(map[string]any)
		for _, rawField := range asList(form["fields"]) {
			field, _ := rawField.(map[string]any)
			if id, _ := field["id"].(string); id != "" {
				fields[id] = field
			}
		}
	}
	for _, rawControl := range asList(payload["controls"]) {
		control, _ := rawControl.(map[string]any)
		if id, _ := control["id"].(string); id != "" {
			controls[id] = control
		}
	}
	return fields, controls
}

// Violations is why a proposal is not admissible, or nil if it is. Separate from
// the caller so the rule can be tested directly and shown to reject a fabricated
// case before it is trusted to accept a real one.
func Violations(proposal map[string]any, fields, controls map[string]map[string]any) []string {
	var problems []string
	if strings.TrimSpace(str(proposal["title"])) == "" {
		problems = append(problems, "case has no title")
	}
	if strings.TrimSpace(str(proposal["expected"])) == "" {
		problems = append(problems, "case states no expected outcome")
	}
	fieldIDs := stringList(proposal["field_ids"])
	controlIDs := stringList(proposal["control_ids"])
	if len(fieldIDs)+len(controlIDs) == 0 {
		problems = append(problems, "case cites no field or control from this page")
	}
	for _, id := range fieldIDs {
		if _, ok := fields[id]; !ok {
			problems = append(problems, fmt.Sprintf("field '%s' is not on this page", id))
		}
	}
	for _, id := range controlIDs {
		if _, ok := controls[id]; !ok {
			problems = append(problems, fmt.Sprintf("control '%s' is not on this page", id))
		}
	}
	return problems
}

// Propose returns (cases, discarded, notes) for one crawled page. A provider
// failure is not a job failure: this track is an addition to the deterministic
// ones, and a page that yields no proposals is reported, not fatal.
func Propose(page Page, provider llm.Provider) ([]Case, int, []string) {
	payload := Payload(page)
	if len(asList(payload["forms"])) == 0 && len(asList(payload["controls"])) == 0 {
		return nil, 0, []string{"the page has no form or named control to write behaviour about"}
	}
	if provider == nil {
		provider = llm.Get()
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, []string{"the page could not be described for the model"}
	}
	// Framed exactly the way the other prompts frame untrusted input: the page's
	// own text is DATA, and a page that contains "ignore your instructions" must
	// not become an instruction.
	framed := llm.UntrustedOpen + "\n" + string(encoded) + "\n" + llm.UntrustedClose
	result, err := provider.CompleteJSON(PromptID, Instructions+"PAYLOAD:\n"+framed, nil)
	if err != nil {
		return nil, 0, []string{"the model could not be consulted: " + err.Error()}
	}

	fields, controls := Index(payload)
	var cases []Case
	discarded := 0
	var notes []string
	for i, raw := range asList(result.Data["cases"]) {
		if i >= MaxCasesPerPage {
			break
		}
		proposal, ok := raw.(map[string]any)
		if !ok {
			discarded++
			continue
		}
		if problems := Violations(proposal, fields, controls); len(problems) > 0 {
			discarded++
			if !containsString(notes, problems[0]) {
				notes = append(notes, problems[0])
			}
			continue
		}
		cases = append(cases, build(proposal, payload, page, fields))
	}
	return cases, discarded, notes
}

func build(proposal, payload map[string]any, page Page,
	fields map[string]map[string]any) Case {
	citedFields := map[string]bool{}
	for _, id := range stringList(proposal["field_ids"]) {
		citedFields[id] = true
	}
	citedControls := map[string]bool{}
	for _, id := range stringList(proposal["control_ids"]) {
		citedControls[id] = true
	}

	// The step carries the page's OWN selectors, resolved here from the ids the
	// model cited, never from anything it wrote. Both start empty rather than
	// nil: a nil slice marshals to `null` while Python's empty list marshals to
	// `[]`, and a client reading one engine's case would see a different shape
	// from the other's for the same page.
	selectors, controlSelectors := []string{}, []string{}
	for fi, form := range page.Forms {
		if fi >= MaxFormsPerPage {
			break
		}
		for xi, field := range form.Fields {
			if xi >= MaxFieldsPerForm {
				break
			}
			if citedFields[fmt.Sprintf("f%d.%d", fi, xi)] {
				selectors = append(selectors, field.Selector)
			}
		}
	}
	for ci, control := range page.Controls {
		if ci >= MaxControls {
			break
		}
		if citedControls[fmt.Sprintf("c%d", ci)] {
			controlSelectors = append(controlSelectors, control.Selector)
		}
	}

	url := str(payload["url"])
	var labels []string
	for _, id := range stringList(proposal["field_ids"]) {
		if field, ok := fields[id]; ok {
			if label := str(field["label"]); label != "" {
				labels = append(labels, label)
			}
		}
	}
	if len(labels) > 6 {
		labels = labels[:6]
	}
	description := fmt.Sprintf("Behaviour proposed for the screen '%s' from what the crawl found there",
		firstNonEmpty(str(payload["title"]), url))
	if len(labels) > 0 {
		description += ": " + strings.Join(labels, ", ") + "."
	} else {
		description += "."
	}

	grounds := make([]string, 0, len(selectors)+len(controlSelectors)+1)
	for _, s := range append(append([]string{}, selectors...), controlSelectors...) {
		grounds = append(grounds, "selector:"+s)
	}
	if url != "" {
		grounds = append(grounds, "page:"+url)
	}

	return Case{
		Title:         trunc(str(proposal["title"]), 500),
		Description:   description,
		Preconditions: "The page " + url + " is loaded in a browser",
		Type:          firstNonEmpty(str(proposal["type"]), "positive"),
		Priority:      firstNonEmpty(str(proposal["priority"]), "medium"),
		Technique:     "scenario",
		Fields:        selectors,
		Controls:      controlSelectors,
		Expected:      trunc(str(proposal["expected"]), 500),
		Path:          firstNonEmpty(str(payload["path"]), "/"),
		URL:           url,
		Screen:        firstNonEmpty(str(payload["title"]), url),
		Grounds:       grounds,
	}
}

// ModelName records WHO wrote a case. A reviewer reading a plan that mixes
// deterministic builders with model proposals needs to know which is which.
func ModelName(provider llm.Provider) string {
	if provider == nil {
		provider = llm.Get()
	}
	if named, ok := provider.(interface{ Model() string }); ok {
		if name := named.Model(); name != "" {
			return name
		}
	}
	if config.C.LLMModel != "" {
		return config.C.LLMModel
	}
	return "mock-deterministic"
}

// --- small helpers -----------------------------------------------------------

func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func stringList(v any) []string {
	out := []string{}
	for _, item := range asList(v) {
		if s, ok := item.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return false }) // order preserved
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func trunc(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
