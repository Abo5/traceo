package webtarget

import (
	"fmt"
	"net/url"
	"sort"
	"strings"

	"traceo/internal/modules/collections"
)

// ---------------------------------------------------------------------------
// The normalised sidecar document
// ---------------------------------------------------------------------------

// Field is one form input. A field with no selector never gets here: a case that
// cannot name the element it acts on is not grounded, and inventing a selector
// for it is exactly the fabrication the grounding gate exists to stop.
type Field struct {
	Selector    string `json:"selector"`
	Name        string `json:"name"`
	ID          string `json:"id"`
	Type        string `json:"type"`
	Required    bool   `json:"required"`
	Placeholder string `json:"placeholder"`
	Label       string `json:"label"`
	MaxLength   *int   `json:"maxlength"`
	Pattern     string `json:"pattern"`
}

type Form struct {
	Index    int     `json:"index"`
	Selector string  `json:"selector"`
	Name     string  `json:"name"`
	ID       string  `json:"id"`
	Action   string  `json:"action"`
	Method   string  `json:"method"`
	Fields   []Field `json:"fields"`
	Submit   string  `json:"submit"`
	// SubmitName is the accessible name of that control, and Heading the
	// nearest heading above the form — both are what a reader calls the form
	// when the page gives it no name of its own.
	SubmitName string `json:"submit_name"`
	Heading    string `json:"heading"`
}

type Control struct {
	Selector string `json:"selector"`
	Role     string `json:"role"`
	Name     string `json:"name"`
	Href     string `json:"href"`
}

type Request struct {
	Method       string `json:"method"`
	URL          string `json:"url"`
	ResourceType string `json:"resource_type"`
	Status       *int   `json:"status"`
}

type Inventory struct {
	URL           string    `json:"url"`
	FinalURL      string    `json:"final_url"`
	Title         string    `json:"title"`
	Viewport      string    `json:"viewport"`
	ElapsedMS     *int      `json:"elapsed_ms"`
	Screenshot    string    `json:"screenshot"`
	Forms         []Form    `json:"forms"`
	Controls      []Control `json:"controls"`
	Requests      []Request `json:"requests"`
	ConsoleErrors []string  `json:"console_errors"`
	// Depth and Status exist only for a crawled page: how many links from the
	// target it was reached at, and what the navigation answered. A single-page
	// discovery leaves them at their zero values, which is what it has always
	// reported by saying nothing.
	Depth  int  `json:"depth"`
	Status *int `json:"status"`
}

// APIResourceTypes: the XHR/fetch inventory IS the API surface a page exposes.
// The other resource types are how the page is delivered, not what it calls.
var APIResourceTypes = map[string]bool{"xhr": true, "fetch": true}

// NormalisePayload reduces the sidecar document to what this module will act on.
// Deliberately tolerant of extra keys — the sidecar is free to report more than
// we consume — and deliberately intolerant of missing selectors, which are the
// only thing that makes a DOM case checkable.
func NormalisePayload(doc map[string]any) Inventory {
	inv := Inventory{
		URL:        trunc(str(doc["url"]), 1000),
		Title:      trunc(str(doc["title"]), 500),
		Viewport:   trunc(str(doc["viewport"]), 20),
		Screenshot: trunc(firstNonEmpty(str(doc["screenshot"])), 1000),
		ElapsedMS:  intPtr(pick(doc, "elapsed_ms", "elapsedMs")),
	}
	inv.FinalURL = trunc(firstNonEmpty(str(pick(doc, "final_url", "finalUrl")), inv.URL), 1000)

	for _, raw := range asList(doc["forms"]) {
		fm := asMap(raw)
		if fm == nil {
			continue
		}
		selector := strings.TrimSpace(trunc(str(fm["selector"]), 300))
		if selector == "" {
			continue
		}
		form := Form{
			Index: len(inv.Forms), Selector: selector,
			Name: trunc(str(fm["name"]), 200), ID: trunc(str(fm["id"]), 200),
			Action:  trunc(str(fm["action"]), 500),
			Method:  strings.ToUpper(firstNonEmpty(trunc(str(fm["method"]), 10), "GET")),
			Submit:  trunc(str(fm["submit"]), 300),
			Heading: trunc(str(fm["heading"]), 200),
			Fields:  []Field{},
		}
		// The sidecar reports every submit-capable control in `submits`; the
		// first is the form's primary action, and a bare <button> inside a form
		// submits it by the HTML spec. Older payloads carried a single `submit`
		// selector — both are accepted.
		for _, rawSubmit := range asList(fm["submits"]) {
			sm := asMap(rawSubmit)
			if sm == nil {
				continue
			}
			if form.Submit == "" {
				form.Submit = trunc(str(sm["selector"]), 300)
			}
			if form.SubmitName == "" {
				form.SubmitName = trunc(str(sm["name"]), 300)
			}
		}
		for _, rawField := range asList(fm["fields"]) {
			fd := asMap(rawField)
			if fd == nil {
				continue
			}
			fieldSelector := strings.TrimSpace(trunc(str(fd["selector"]), 300))
			if fieldSelector == "" {
				continue
			}
			form.Fields = append(form.Fields, Field{
				Selector: fieldSelector,
				Name:     trunc(str(fd["name"]), 200), ID: trunc(str(fd["id"]), 200),
				Type:        firstNonEmpty(trunc(str(fd["type"]), 40), "text"),
				Required:    truthy(fd["required"]),
				Placeholder: trunc(str(fd["placeholder"]), 300),
				Label:       trunc(str(fd["label"]), 300),
				MaxLength:   intPtr(pick(fd, "maxlength", "maxLength")),
				Pattern:     trunc(str(fd["pattern"]), 300),
			})
		}
		inv.Forms = append(inv.Forms, form)
	}

	for _, raw := range asList(doc["controls"]) {
		cm := asMap(raw)
		if cm == nil {
			continue
		}
		selector := strings.TrimSpace(trunc(str(cm["selector"]), 300))
		if selector == "" {
			continue
		}
		inv.Controls = append(inv.Controls, Control{
			Selector: selector,
			Role:     trunc(str(cm["role"]), 40),
			Name: trunc(firstNonEmpty(str(cm["name"]), str(cm["accessible_name"]),
				str(cm["accessibleName"])), 300),
			Href: trunc(str(cm["href"]), 500),
		})
	}

	for _, raw := range asList(doc["requests"]) {
		rm := asMap(raw)
		if rm == nil {
			continue
		}
		target := strings.TrimSpace(trunc(str(rm["url"]), 1000))
		if target == "" {
			continue
		}
		inv.Requests = append(inv.Requests, Request{
			Method: strings.ToUpper(firstNonEmpty(trunc(str(rm["method"]), 10), "GET")),
			URL:    target,
			ResourceType: strings.ToLower(trunc(str(pick(rm, "resourceType",
				"resource_type")), 40)),
			Status: intPtr(rm["status"]),
		})
	}

	for _, raw := range asList(pick(doc, "console_errors", "consoleErrors")) {
		if len(inv.ConsoleErrors) >= 50 {
			break
		}
		inv.ConsoleErrors = append(inv.ConsoleErrors, trunc(str(raw), 500))
	}
	if inv.Forms == nil {
		inv.Forms = []Form{}
	}
	if inv.Controls == nil {
		inv.Controls = []Control{}
	}
	if inv.Requests == nil {
		inv.Requests = []Request{}
	}
	if inv.ConsoleErrors == nil {
		inv.ConsoleErrors = []string{}
	}
	return inv
}

// PagePath is the server-relative path of the rendered page.
func (inv Inventory) PagePath() string {
	target := inv.FinalURL
	if target == "" {
		target = inv.URL
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Path == "" {
		return "/"
	}
	return trunc(parsed.Path, 500)
}

func (inv Inventory) pageURL() string {
	if inv.FinalURL != "" {
		return inv.FinalURL
	}
	return inv.URL
}

// ---------------------------------------------------------------------------
// Grounding — one artefact set, checked by every track
// ---------------------------------------------------------------------------

// PageRef is the `page:<final_url>` reference every case on this page also
// cites. It is what makes a case answer "which page is this about" without
// reading its steps, and what lets the gate reject a case attributed to a page
// the crawl never visited.
func PageRef(inv Inventory) string {
	if url := inv.pageURL(); url != "" {
		return "page:" + url
	}
	return ""
}

// ArtefactIDs is everything this discovery actually found, as reference ids. A
// case may only cite ids from this set; an artefact that never survived
// normalisation cannot be cited either.
func ArtefactIDs(inv Inventory, factIDs []string) map[string]bool {
	out := map[string]bool{}
	for _, form := range inv.Forms {
		out["selector:"+form.Selector] = true
		if form.Submit != "" {
			out["selector:"+form.Submit] = true
		}
		for _, f := range form.Fields {
			out["selector:"+f.Selector] = true
		}
	}
	for _, control := range inv.Controls {
		out["selector:"+control.Selector] = true
	}
	for _, req := range inv.Requests {
		out["request:"+req.Method+" "+req.URL] = true
	}
	if ref := PageRef(inv); ref != "" {
		out[ref] = true
	}
	for _, id := range factIDs {
		out["fact:"+id] = true
	}
	return out
}

// GroundingViolations is the universal rule: a case cites at least one
// discovered artefact, and every artefact it cites was discovered.
func GroundingViolations(grounds []string, artefacts map[string]bool) []string {
	if len(grounds) == 0 {
		return []string{"case references no discovered artefact"}
	}
	var out []string
	for _, ref := range grounds {
		if !artefacts[ref] {
			out = append(out, "'"+ref+"' was not found by the discovery")
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// api track — the captured XHR/fetch inventory
// ---------------------------------------------------------------------------

// Operation is one inventory row derived from the captured requests, in the
// exact shape the OpenAPI importer produces.
type Operation struct {
	Method        string
	Path          string
	Summary       string
	Parameters    []any
	ObservedCount int
	Origins       []string
	Statuses      []int
	URLs          []string
	// RequestSchema is set only for an operation a FORM declares: the browser
	// was never seen to call it, so there is no captured body to infer from —
	// the schema IS the form's own fields.
	RequestSchema map[string]any
	// DeclaredBy names the form element and page that declared this operation,
	// which is what a case built on it cites. Nil for a captured request: that
	// stands on the request itself.
	DeclaredBy *Declaration
}

// Declaration is the markup that declared an operation.
type Declaration struct {
	Selector string
	Page     string
}

// EndpointsFromRequests turns captured XHR/fetch requests into inventory
// operations.
//
// Paths are templated by the SAME function the HAR importer uses
// (collections.TemplateConcretePath), because these are real captured URLs
// carrying concrete ids — so /api/v2/employees/7 becomes /api/v2/employees/{id}
// here exactly as it would from a HAR file. Query values become
// constraints.example on a query parameter. Nothing is invented: a request with
// no query string yields no query parameters.
// EndpointsFromRequests returns (operations, skip reasons) for the captured
// XHR/fetch requests. ONLY requests to an origin the crawl itself visited become
// endpoints. A page that embeds a third party — a video, a map, an analytics tag
// — makes that party's calls from the same browser, and recording them would put
// somebody else's API into this project's inventory. Measured on the owner's
// target: the Buzz page embeds YouTube, and without this filter the crawl
// adopted four Google endpoints and the security builders aimed twelve probes at
// them, including a rate-limit probe. Traceo must never generate a test that
// attacks a host the user did not point it at.
//
// A nil origins set disables the filter, which is what the older callers that
// pass nothing expect.
// queryPair is one name=value of a query string, kept in the order it appeared.
type queryPair struct {
	key   string
	value string
}

// queryNamesInOrder reads a raw query string the way Python's parse_qsl does
// with keep_blank_values=True: split on "&", split each pair on the first "=",
// percent-decode both halves and turn "+" into a space. A half that cannot be
// decoded is kept verbatim rather than dropping the parameter, because a
// parameter the page really sent is a fact even when its encoding is broken.
func queryNamesInOrder(raw string) []queryPair {
	if raw == "" {
		return nil
	}
	unescape := func(s string) string {
		if decoded, err := url.QueryUnescape(s); err == nil {
			return decoded
		}
		return s
	}
	out := make([]queryPair, 0, 8)
	for _, pair := range strings.Split(raw, "&") {
		if pair == "" {
			continue
		}
		name, value := pair, ""
		if i := strings.Index(pair, "="); i >= 0 {
			name, value = pair[:i], pair[i+1:]
		}
		out = append(out, queryPair{key: unescape(name), value: unescape(value)})
	}
	return out
}

func EndpointsFromRequests(requests []Request, origins map[string]bool) ([]Operation, []string) {
	type entry struct {
		op    *Operation
		known map[string]bool
	}
	byKey := map[string]*entry{}
	foreign := map[string]int{}
	var order []string
	for _, req := range requests {
		if !APIResourceTypes[req.ResourceType] {
			continue
		}
		parsed, err := url.Parse(req.URL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			continue
		}
		requestOrigin := parsed.Scheme + "://" + parsed.Host
		if origins != nil && !origins[requestOrigin] {
			foreign[requestOrigin]++
			continue
		}
		path, names := collections.TemplateConcretePath(parsed.Path)
		key := req.Method + " " + path
		e, present := byKey[key]
		if !present {
			params := make([]any, 0, len(names))
			for _, name := range names {
				params = append(params, collections.Param(name, "path", true, ""))
			}
			e = &entry{op: &Operation{Method: req.Method, Path: path,
				Parameters: params}, known: map[string]bool{}}
			for _, name := range names {
				e.known[name] = true
			}
			byKey[key] = e
			order = append(order, key)
		}
		e.op.ObservedCount++
		origin := parsed.Scheme + "://" + parsed.Host
		if !contains(e.op.Origins, origin) {
			e.op.Origins = append(e.op.Origins, origin)
		}
		if req.Status != nil && !containsInt(e.op.Statuses, *req.Status) {
			e.op.Statuses = append(e.op.Statuses, *req.Status)
		}
		if !contains(e.op.URLs, req.URL) {
			e.op.URLs = append(e.op.URLs, req.URL)
		}
		// In the order the request's own query string stated them. url.Query()
		// returns a map, and taming a map's iteration order with a sort makes
		// this engine disagree with webtarget.py, which reads the string in
		// order with parse_qsl. The parameter list's order is not cosmetic: the
		// security builders test the FIRST parameter of a kind, so on the real
		// target the two engines built a different case for 3 of 139 security
		// cases from the same document.
		for _, name := range queryNamesInOrder(parsed.RawQuery) {
			if name.key == "" || e.known[name.key] {
				continue
			}
			e.known[name.key] = true
			e.op.Parameters = append(e.op.Parameters,
				collections.Param(name.key, "query", false, name.value))
		}
	}
	sort.Strings(order)
	out := make([]Operation, 0, len(order))
	for _, key := range order {
		op := byKey[key].op
		sort.Strings(op.Origins)
		sort.Ints(op.Statuses)
		plural := "requests"
		if op.ObservedCount == 1 {
			plural = "request"
		}
		op.Summary = trunc(fmt.Sprintf("Observed in the browser: %d %s to %s",
			op.ObservedCount, plural, strings.Join(op.Origins, ", ")), 500)
		out = append(out, *op)
	}
	var reasons []string
	if len(foreign) > 0 {
		hosts := make([]string, 0, len(foreign))
		total := 0
		for origin, n := range foreign {
			hosts = append(hosts, fmt.Sprintf("%s (%d)", origin, n))
			total += n
		}
		sort.Strings(hosts)
		reasons = append(reasons, fmt.Sprintf(
			"%d captured request(s) went to an origin the crawl never visited and were "+
				"not recorded: %s", total, strings.Join(hosts, ", ")))
	}
	return out, reasons
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

type Step struct {
	Method string
	Path   string
	// EndpointID binds the step to a discovered endpoint row. DOM and design
	// steps address a selector rather than an operation and leave it nil; API
	// and security steps always carry it.
	EndpointID *string
	Request    map[string]any
	Assertions []any
}

type Case struct {
	Title         string
	Description   string
	Preconditions string
	Type          string
	Priority      string
	Technique     string
	Steps         []Step
	Grounds       []string
}

// FormLabel is what a human calls this form.
// FormLabel is what a human calls this form, in descending order of authority.
// A page that names its form is believed first; otherwise the heading above it
// and then its submit control. The raw selector is the last resort — it is
// unambiguous but unreadable, and a title built from it repeats a whole CSS path.
func FormLabel(form Form) string {
	return firstNonEmpty(form.Name, form.ID, form.Heading, form.SubmitName, form.Selector)
}

// FieldLabel is what a human calls this field.
func FieldLabel(f Field) string {
	return firstNonEmpty(f.Label, f.Name, f.ID, f.Selector)
}

// FormRequirementText builds the description, acceptance criteria and source
// text of the requirement one discovered form states. Every sentence names
// something the render produced; the required fields are the form's own
// `required` flags, not a guess from the field names.
func FormRequirementText(form Form, inv Inventory) (string, []string, string) {
	label := FormLabel(form)
	where := inv.pageURL()
	listed := "no input fields"
	if len(form.Fields) > 0 {
		parts := make([]string, 0, len(form.Fields))
		for _, f := range form.Fields {
			parts = append(parts, FieldLabel(f)+" ("+f.Selector+")")
		}
		listed = strings.Join(parts, ", ")
	}
	var required []Field
	for _, f := range form.Fields {
		if f.Required {
			required = append(required, f)
		}
	}
	tail := "No field is marked required by the page."
	if len(required) > 0 {
		names := make([]string, 0, len(required))
		for _, f := range required {
			names = append(names, FieldLabel(f))
		}
		tail = "Required: " + strings.Join(names, ", ") + "."
	}
	description := trunc(fmt.Sprintf("The '%s' form (%s) on %s accepts %s. %s",
		label, form.Selector, where, listed, tail), 2000)

	criteria := make([]string, 0, len(form.Fields)+len(required))
	for _, f := range form.Fields {
		criteria = append(criteria, fmt.Sprintf("The field %s (%s) is present on the '%s' form",
			FieldLabel(f), f.Selector, label))
	}
	for _, f := range required {
		criteria = append(criteria, fmt.Sprintf("Submitting the '%s' form without %s (%s) is rejected",
			label, FieldLabel(f), f.Selector))
	}
	return description, criteria, jsonString(map[string]any{
		"selector": form.Selector, "name": form.Name, "method": form.Method,
		"action": form.Action, "fields": form.Fields})
}

// FormCases builds the deterministic functional cases for one form. The
// selectors travel VERBATIM into the step request — that is what makes the case
// runnable against the page and auditable back to the render. Every case also
// cites the page it came from, so a crawl of twenty pages cannot end up with a
// case that is checkable but unplaceable.
func FormCases(form Form, inv Inventory) []Case {
	label := FormLabel(form)
	pageURL := inv.pageURL()
	path := inv.PagePath()
	ref := PageRef(inv)
	var cases []Case

	mk := func(title, ctype, technique, check string, request map[string]any,
		assertions []any, grounds []string, priority string) Case {
		req := map[string]any{"url": pageURL, "screen": label, "check": check,
			"form": form.Selector}
		for k, v := range request {
			req[k] = v
		}
		if ref != "" {
			grounds = append(append([]string{}, grounds...), ref)
		}
		return Case{
			Title: trunc(title, 500),
			Description: fmt.Sprintf("Derived from the '%s' form (%s) rendered at %s.",
				label, form.Selector, pageURL),
			Preconditions: "The page " + pageURL + " is loaded in a browser",
			Type:          ctype, Priority: priority, Technique: technique,
			Steps:   []Step{{Method: "GET", Path: path, Request: req, Assertions: assertions}},
			Grounds: grounds,
		}
	}

	if len(form.Fields) > 0 {
		selectors := make([]any, 0, len(form.Fields))
		grounds := []string{"selector:" + form.Selector}
		for _, f := range form.Fields {
			selectors = append(selectors, f.Selector)
			grounds = append(grounds, "selector:"+f.Selector)
		}
		cases = append(cases, mk(
			fmt.Sprintf("Form: '%s' renders every discovered field", label),
			"positive", "ep", "elements_present",
			map[string]any{"selectors": selectors},
			[]any{map[string]any{"type": "elements_present", "selectors": selectors}},
			grounds, "medium"))
	}

	for _, f := range form.Fields {
		if !f.Required {
			continue
		}
		others := make([]any, 0, len(form.Fields))
		for _, other := range form.Fields {
			if other.Selector != f.Selector {
				others = append(others, other.Selector)
			}
		}
		cases = append(cases, mk(
			fmt.Sprintf("Form: '%s' rejects submission with %s empty", label, FieldLabel(f)),
			"negative", "negative", "required_field_enforced",
			map[string]any{"empty": f.Selector, "filled": others},
			[]any{
				map[string]any{"type": "validation_error", "selector": f.Selector},
				map[string]any{"type": "no_navigation"},
			},
			[]string{"selector:" + form.Selector, "selector:" + f.Selector}, "high"))
	}

	for _, f := range form.Fields {
		if f.MaxLength != nil && *f.MaxLength > 0 {
			cases = append(cases, mk(
				fmt.Sprintf("Form: %s accepts at most %d characters", FieldLabel(f), *f.MaxLength),
				"boundary", "bva", "maxlength_enforced",
				map[string]any{"selector": f.Selector, "maxlength": *f.MaxLength},
				[]any{map[string]any{"type": "value_length_at_most",
					"selector": f.Selector, "expected": *f.MaxLength}},
				[]string{"selector:" + form.Selector, "selector:" + f.Selector}, "medium"))
		}
		if f.Pattern != "" {
			cases = append(cases, mk(
				fmt.Sprintf("Form: %s enforces its declared pattern", FieldLabel(f)),
				"negative", "negative", "pattern_enforced",
				map[string]any{"selector": f.Selector, "pattern": f.Pattern},
				[]any{map[string]any{"type": "pattern_enforced",
					"selector": f.Selector, "expected": f.Pattern}},
				[]string{"selector:" + form.Selector, "selector:" + f.Selector}, "medium"))
		}
	}
	return cases
}

// PerformanceCase asserts the stated budget with the observed render as its
// baseline. When the baseline is already over budget the case fails on its first
// run, which is the honest outcome: the page is the defect, not the assertion.
func PerformanceCase(inv Inventory, budgetMS int) Case {
	pageURL := inv.pageURL()
	var observed any
	ctype, priority := "positive", "medium"
	if inv.ElapsedMS != nil {
		observed = *inv.ElapsedMS
		if *inv.ElapsedMS > budgetMS {
			ctype, priority = "negative", "high"
		}
	}
	return Case{
		Title: trunc(fmt.Sprintf("Performance: %s loads within %dms", pageURL, budgetMS), 500),
		Description: fmt.Sprintf("The page load budget is %dms. The observed baseline from "+
			"the discovery render was %vms.", budgetMS, observed),
		Preconditions: "A cold browser context at the discovery viewport",
		Type:          ctype, Priority: priority, Technique: "performance",
		Steps: []Step{{Method: "GET", Path: inv.PagePath(),
			Request: map[string]any{"url": pageURL, "check": "page_load_ms",
				"observed_baseline_ms": observed},
			Assertions: []any{map[string]any{"type": "page_load_ms",
				"expected_max": budgetMS, "observed_baseline_ms": observed}}}},
		Grounds: []string{"page:" + pageURL},
	}
}
