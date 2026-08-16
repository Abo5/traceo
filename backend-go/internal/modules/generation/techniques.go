// techniques.go — deterministic value derivation + ISTQB case builders.
// Faithful port of backend/app/modules/generation.py ("the model is not trusted
// to identify boundaries"): pattern-example generation, EP invalid classes, BVA,
// negative suite (incl. FR-033 oversized + injection), FR-034 localisation and
// exhaustive-depth enum sweeps / decision tables.
package generation

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"traceo/internal/models"
)

const (
	// FR-034 localisation samples: non-ASCII text (accented Latin + CJK) whose
	// round-trip through a free-text field must survive byte-for-byte.
	unicodeSample     = "José Ávila 東京"
	unicodeSampleLong = "Café Zürich — 東京プラットフォーム"
	maxCombos         = 8 // decision-table cap
	maxEnumSweep      = 8
)

var injectionPayloads = []string{"' OR 1=1--", "<script>alert(1)</script>"}

var constraintKeys = []string{"pattern", "enum", "minimum", "maximum", "minLength", "maxLength", "format"}

// ---------------------------------------------------------------------------
// Small dynamic-value helpers (Python-semantics adapters)
// ---------------------------------------------------------------------------

func asMap(v any) map[string]any {
	switch t := v.(type) {
	case map[string]any:
		return t
	case models.JSONMap:
		return t
	}
	return nil
}

func asList(v any) []any {
	switch t := v.(type) {
	case []any:
		return t
	case models.JSONList:
		return t
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out
	case []map[string]any:
		out := make([]any, len(t))
		for i, m := range t {
			out[i] = m
		}
		return out
	}
	return nil
}

// truthy mirrors Python bool(v).
func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case int:
		return t != 0
	case int64:
		return t != 0
	case float64:
		return t != 0
	case []any:
		return len(t) > 0
	case []string:
		return len(t) > 0
	case models.JSONList:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	case models.JSONMap:
		return len(t) > 0
	}
	return true
}

// pyStr mirrors Python str(v) for the value shapes we handle.
func pyStr(v any) string {
	switch t := v.(type) {
	case nil:
		return "None"
	case string:
		return t
	case bool:
		if t {
			return "True"
		}
		return "False"
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		s := strconv.FormatFloat(t, 'g', -1, 64)
		if !strings.ContainsAny(s, ".eEnN") {
			s += ".0" // Python str(5.0) == "5.0"
		}
		return s
	}
	return fmt.Sprint(v)
}

func asFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case float64:
		return t, true
	}
	return 0, false
}

// asIntVal accepts ints and integral floats (JSON numbers decode to float64 in Go
// where Python json yields int — this is the faithful equivalence).
func asIntVal(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case int64:
		return int(t), true
	case float64:
		if t == math.Trunc(t) && !math.IsInf(t, 0) {
			return int(t), true
		}
	}
	return 0, false
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

func copyMap(m map[string]any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func deepCopy(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, vv := range t {
			out[k] = deepCopy(vv)
		}
		return out
	case models.JSONMap:
		return deepCopy(map[string]any(t))
	case []any:
		out := make([]any, len(t))
		for i, vv := range t {
			out[i] = deepCopy(vv)
		}
		return out
	case models.JSONList:
		return deepCopy([]any(t))
	}
	return v
}

func marshalNoEscape(v any) string {
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimRight(sb.String(), "\n")
}

// ---------------------------------------------------------------------------
// Deterministic value derivation
// ---------------------------------------------------------------------------

type unit struct {
	gen func(k int) string
	n   int
}

func litGen(ch string) func(int) string { return func(int) string { return ch } }

func classGen(chars []rune) func(int) string {
	return func(k int) string { return string(chars[k%len(chars)]) }
}

func expandClass(body []rune) []rune {
	var chars []rune
	i := 0
	for i < len(body) {
		c := body[i]
		if c == '\\' && i+1 < len(body) {
			switch body[i+1] {
			case 'd':
				chars = append(chars, []rune("0123456789")...)
			case 'w':
				chars = append(chars, []rune("abcdefghijklmnopqrstuvwxyz0123456789")...)
			default:
				chars = append(chars, body[i+1])
			}
			i += 2
		} else if i+2 < len(body) && body[i+1] == '-' {
			a, b := c, body[i+2]
			if a <= b && b-a < 128 {
				for x := a; x <= b; x++ {
					chars = append(chars, x)
				}
			}
			i += 3
		} else {
			chars = append(chars, c)
			i++
		}
	}
	return chars
}

func indexRune(p []rune, r rune, from int) int {
	for i := from; i < len(p); i++ {
		if p[i] == r {
			return i
		}
	}
	return -1
}

// patternExample: tiny example generator for the common regex subset — literals,
// [..] classes, \d/\w escapes and {n} counts. Anything fancier falls back to
// "example". e.g. ^05[0-9]{8}$ -> "0501234567".
func patternExample(pattern string) string {
	p := []rune(pattern)
	if len(p) > 0 && p[0] == '^' {
		p = p[1:]
	}
	if len(p) > 0 && p[len(p)-1] == '$' && !(len(p) >= 2 && p[len(p)-2] == '\\') {
		p = p[:len(p)-1]
	}
	var units []unit
	i := 0
	for i < len(p) {
		c := p[i]
		switch {
		case c == '\\':
			if i+1 >= len(p) {
				return "example"
			}
			switch p[i+1] {
			case 'd':
				units = append(units, unit{classGen([]rune("0123456789")), 1})
			case 'w':
				units = append(units, unit{classGen([]rune("abcdefghijklmnopqrstuvwxyz0123456789")), 1})
			case 's':
				units = append(units, unit{litGen(" "), 1})
			default:
				units = append(units, unit{litGen(string(p[i+1])), 1})
			}
			i += 2
		case c == '[':
			j := indexRune(p, ']', i+1)
			if j == -1 {
				return "example"
			}
			body := p[i+1 : j]
			if len(body) == 0 || body[0] == '^' {
				return "example"
			}
			chars := expandClass(body)
			if len(chars) == 0 {
				return "example"
			}
			units = append(units, unit{classGen(chars), 1})
			i = j + 1
		case c == '{':
			j := indexRune(p, '}', i+1)
			if j == -1 || len(units) == 0 {
				return "example"
			}
			count := strings.TrimSpace(strings.SplitN(string(p[i+1:j]), ",", 2)[0])
			if !allDigits(count) {
				return "example"
			}
			n, _ := strconv.Atoi(count)
			if n > 64 {
				n = 64
			}
			units[len(units)-1].n = n
			i = j + 1
		case c == '+' || c == '*' || c == '?':
			i++ // one repetition already satisfies these quantifiers
		case c == '(' || c == ')' || c == '|' || c == '.':
			return "example" // groups/alternation/wildcards unsupported
		default:
			units = append(units, unit{litGen(string(c)), 1})
			i++
		}
	}
	var sb strings.Builder
	for _, u := range units {
		for k := 0; k < u.n; k++ {
			sb.WriteString(u.gen(k))
		}
	}
	out := sb.String()
	re, err := regexp.Compile(`\A(?:` + pattern + `)\z`)
	if err != nil || !re.MatchString(out) {
		return "example"
	}
	return out
}

// valueFor returns a valid representative value for a JSON-schema fragment /
// parameter constraints.
func valueFor(v any, depth int) any {
	schema := asMap(v)
	if schema == nil || depth > 8 {
		return "example"
	}
	if enum := asList(schema["enum"]); len(enum) > 0 {
		return enum[0]
	}
	rawType, _ := schema["type"]
	stype, _ := rawType.(string)
	if !truthy(rawType) {
		if asMap(schema["properties"]) != nil {
			stype = "object"
		} else if it, ok := schema["items"]; ok && it != nil {
			stype = "array"
		} else {
			stype = "string"
		}
	}
	switch stype {
	case "integer", "number":
		mn, hasMn := asFloat(schema["minimum"])
		mx, hasMx := asFloat(schema["maximum"])
		var val float64
		switch {
		case hasMn && hasMx:
			val = (mn + mx) / 2
		case hasMn:
			val = mn + 1
		case hasMx:
			val = mx - 1
		default:
			val = 1
		}
		if stype == "integer" {
			return int(val)
		}
		return val
	case "boolean":
		return true
	case "array":
		return []any{valueFor(schema["items"], depth+1)}
	case "object":
		props := asMap(schema["properties"])
		required := asList(schema["required"])
		var keys []string
		if len(required) > 0 {
			for _, r := range required {
				if k, ok := r.(string); ok {
					if _, in := props[k]; in {
						keys = append(keys, k)
					}
				}
			}
		} else {
			keys = sortedKeys(props)
		}
		out := map[string]any{}
		for _, k := range keys {
			out[k] = valueFor(props[k], depth+1)
		}
		return out
	}
	// string
	switch fmtv, _ := schema["format"].(string); fmtv {
	case "email":
		return "test@example.sa"
	case "date":
		return "2026-01-15"
	case "date-time":
		return "2026-01-15T10:30:00Z"
	case "uuid":
		return "123e4567-e89b-12d3-a456-426614174000"
	}
	if truthy(schema["pattern"]) {
		return patternExample(pyStr(schema["pattern"]))
	}
	s := "example"
	if mn, ok := asIntVal(schema["minLength"]); ok && utf8.RuneCountInString(s) < mn {
		rep := strings.Repeat(s, mn/len(s)+1)
		s = string([]rune(rep)[:mn])
	}
	if mx, ok := asIntVal(schema["maxLength"]); ok && mx > 0 && mx < utf8.RuneCountInString(s) {
		s = string([]rune(s)[:mx])
	}
	return s
}

// invalidFor returns one invalid-class value per constrained input (EP, FR-GEN-03):
// (value, violatedConstraint) or (nil, "").
func invalidFor(schema map[string]any) (any, string) {
	if truthy(schema["pattern"]) {
		return "123", "pattern"
	}
	if enum := asList(schema["enum"]); len(enum) > 0 {
		return "invalid_value", "enum"
	}
	if mn, ok := asFloat(schema["minimum"]); ok {
		return mn - 1, "minimum"
	}
	if mx, ok := asFloat(schema["maximum"]); ok {
		return mx + 1, "maximum"
	}
	if mn, ok := asIntVal(schema["minLength"]); ok && mn > 0 {
		return strings.Repeat("x", mn-1), "minLength"
	}
	if mx, ok := asIntVal(schema["maxLength"]); ok {
		return strings.Repeat("x", mx+1), "maxLength"
	}
	if truthy(schema["format"]) {
		return "invalid", "format"
	}
	if t, _ := schema["type"].(string); t == "integer" || t == "number" {
		return "not_a_number", "type"
	}
	if t, _ := schema["type"].(string); t == "boolean" {
		return "not_a_boolean", "type"
	}
	return nil, ""
}

// ---------------------------------------------------------------------------
// Endpoint introspection helpers
// ---------------------------------------------------------------------------

type inputSpec struct {
	name     string
	where    string // param | body
	location string
	schema   map[string]any
	required bool
}

func getStrDefault(m map[string]any, key, def string) string {
	if v, ok := m[key]; ok {
		return pyStr(v)
	}
	return def
}

func paramSchema(p map[string]any) map[string]any {
	sch := map[string]any{"type": "string"}
	if truthy(p["type"]) {
		sch["type"] = p["type"]
	}
	for k, v := range asMap(p["constraints"]) {
		if v != nil {
			sch[k] = v
		}
	}
	return sch
}

func isConstrained(sch map[string]any) bool {
	for _, k := range constraintKeys {
		v, ok := sch[k]
		if !ok || v == nil {
			continue
		}
		if s, isStr := v.(string); isStr && s == "" {
			continue
		}
		if l := asList(v); l != nil && len(l) == 0 {
			continue
		}
		return true
	}
	t, _ := sch["type"].(string)
	return t == "integer" || t == "number" || t == "boolean"
}

func bodyObjectSchema(ep *models.Endpoint) map[string]any {
	rs := asMap(ep.RequestSchema)
	if rs == nil {
		return nil
	}
	if tv, ok := rs["type"]; ok {
		if s, isStr := tv.(string); !isStr || s != "object" {
			return nil
		}
	}
	if asMap(rs["properties"]) == nil {
		return nil
	}
	return rs
}

func constrainedInputs(ep *models.Endpoint) []inputSpec {
	var inputs []inputSpec
	for _, pv := range asList(ep.Parameters) {
		p := asMap(pv)
		if p == nil || !truthy(p["name"]) {
			continue
		}
		sch := paramSchema(p)
		if isConstrained(sch) {
			inputs = append(inputs, inputSpec{name: pyStr(p["name"]), where: "param", schema: sch,
				required: truthy(p["required"]), location: getStrDefault(p, "location", "query")})
		}
	}
	if rs := bodyObjectSchema(ep); rs != nil {
		required := asList(rs["required"])
		reqSet := map[string]bool{}
		for _, r := range required {
			if k, ok := r.(string); ok {
				reqSet[k] = true
			}
		}
		props := asMap(rs["properties"])
		for _, name := range sortedKeys(props) {
			sch := asMap(props[name])
			if sch != nil && isConstrained(sch) {
				inputs = append(inputs, inputSpec{name: name, where: "body", schema: sch,
					required: reqSet[name], location: "body"})
			}
		}
	}
	return inputs
}

// isFreeText: free-text string — no enum, no pattern, no format.
func isFreeText(sch map[string]any) bool {
	if sch == nil {
		return false
	}
	if tv, ok := sch["type"]; ok {
		if s, isStr := tv.(string); !isStr || s != "string" {
			return false
		}
	}
	return !(truthy(sch["enum"]) || truthy(sch["pattern"]) || truthy(sch["format"]))
}

// freeTextBodyFields: top-level free-text string fields of the request body (FR-034).
func freeTextBodyFields(ep *models.Endpoint) []inputSpec {
	rs := bodyObjectSchema(ep)
	if rs == nil {
		return nil
	}
	reqSet := map[string]bool{}
	for _, r := range asList(rs["required"]) {
		if k, ok := r.(string); ok {
			reqSet[k] = true
		}
	}
	props := asMap(rs["properties"])
	var out []inputSpec
	for _, name := range sortedKeys(props) {
		sch := asMap(props[name])
		if sch != nil && isFreeText(sch) {
			out = append(out, inputSpec{name: name, where: "body", schema: sch,
				required: reqSet[name], location: "body"})
		}
	}
	return out
}

// requiredInputs: required params (non-path, non-header) + required top-level body
// fields, for the missing-required negatives.
func requiredInputs(ep *models.Endpoint) []inputSpec {
	var out []inputSpec
	for _, pv := range asList(ep.Parameters) {
		p := asMap(pv)
		if p == nil || !truthy(p["required"]) {
			continue
		}
		loc := getStrDefault(p, "location", "query")
		if loc == "path" || loc == "header" {
			continue
		}
		out = append(out, inputSpec{name: pyStr(p["name"]), where: "param"})
	}
	if rs := bodyObjectSchema(ep); rs != nil {
		props := asMap(rs["properties"])
		for _, r := range asList(rs["required"]) {
			name, ok := r.(string)
			if !ok {
				continue
			}
			if _, in := props[name]; in {
				out = append(out, inputSpec{name: name, where: "body"})
			}
		}
	}
	return out
}

// validRequest: deterministic valid params/headers/body for an endpoint.
func validRequest(ep *models.Endpoint) (map[string]any, map[string]any, any) {
	params := map[string]any{}
	headers := map[string]any{}
	for _, pv := range asList(ep.Parameters) {
		p := asMap(pv)
		if p == nil || !truthy(p["name"]) {
			continue
		}
		loc := getStrDefault(p, "location", "query")
		val := valueFor(paramSchema(p), 0)
		name := pyStr(p["name"])
		if loc == "header" {
			if truthy(p["required"]) {
				headers[name] = pyStr(val)
			}
		} else if loc == "path" || truthy(p["required"]) {
			params[name] = val
		}
	}
	var body any
	if rs := asMap(ep.RequestSchema); len(rs) > 0 {
		body = valueFor(rs, 0)
	}
	if body != nil {
		headers["Content-Type"] = "application/json"
	}
	if len(ep.Security) > 0 {
		headers["Authorization"] = "Bearer {{token}}"
	}
	return params, headers, body
}

func firstStatus(ep *models.Endpoint, lo, hi int) (int, bool) {
	best, found := 0, false
	for k := range asMap(ep.ResponseSchemas) {
		if !allDigits(k) {
			continue
		}
		n, err := strconv.Atoi(k)
		if err != nil || n < lo || n > hi {
			continue
		}
		if !found || n < best {
			best, found = n, true
		}
	}
	return best, found
}

func positiveAssertions(ep *models.Endpoint) []any {
	code, ok := firstStatus(ep, 200, 299)
	if !ok {
		code = 200
	}
	assertions := []any{map[string]any{"type": "status_code", "expected": code}}
	rss := asMap(ep.ResponseSchemas)
	if sch := asMap(rss[strconv.Itoa(code)]); len(sch) > 0 {
		assertions = append(assertions, map[string]any{"type": "json_schema"})
	}
	assertions = append(assertions, map[string]any{"type": "response_time_ms", "max": 2000})
	return assertions
}

func errorAssertion(ep *models.Endpoint) map[string]any {
	if code, ok := firstStatus(ep, 400, 499); ok {
		return map[string]any{"type": "status_code", "expected": code}
	}
	return map[string]any{"type": "status_code", "expected": 422, "expected_any": []any{400, 422}}
}

// ---------------------------------------------------------------------------
// Case builders (deterministic, techniques per ISTQB)
// ---------------------------------------------------------------------------

func applyInput(inp inputSpec, value any, params map[string]any, body any) (map[string]any, any) {
	p2 := copyMap(params)
	b2 := deepCopy(body)
	if inp.where == "param" {
		p2[inp.name] = value
	} else {
		bm := asMap(b2)
		if bm == nil {
			bm = map[string]any{}
		}
		bm[inp.name] = value
		b2 = bm
	}
	return p2, b2
}

func dropInput(inp inputSpec, params map[string]any, body any) (map[string]any, any) {
	p2 := copyMap(params)
	b2 := deepCopy(body)
	if inp.where == "param" {
		delete(p2, inp.name)
	} else if bm := asMap(b2); bm != nil {
		delete(bm, inp.name)
		b2 = bm
	}
	return p2, b2
}

func mkStep(ep *models.Endpoint, params, headers map[string]any, body any, assertions []any, rawBody any) map[string]any {
	request := map[string]any{"headers": headers, "params": params}
	if rawBody != nil {
		request["raw_body"] = rawBody
	} else if body != nil {
		request["body"] = body
	}
	return map[string]any{"order": 0, "endpoint_id": ep.ID, "method": strings.ToUpper(ep.Method),
		"path": ep.Path, "request": request, "assertions": assertions, "extractions": []any{}}
}

// GenerateCases exposes the deterministic builders to the other engines that
// generate against an endpoint inventory — the web-target crawl builds its API
// track from exactly these, so a crawled endpoint and a specified one get the
// same cases.
func GenerateCases(req *models.Requirement, ep *models.Endpoint, depth string) []map[string]any {
	return generateCases(req, ep, depth)
}

func generateCases(req *models.Requirement, ep *models.Endpoint, depth string) []map[string]any {
	suffix := strings.ToUpper(ep.Method) + " " + ep.Path
	reqRef := req.ExternalID
	if reqRef == "" {
		reqRef = req.ID[:8]
	}
	description := "Covers requirement " + reqRef + ": " + truncRunes(req.Description, 400)
	preconditions := ""
	if len(ep.Security) > 0 {
		preconditions = "Authenticated session"
	}
	priority := req.Priority
	if priority == "" {
		priority = "medium"
	}
	params, headers, body := validRequest(ep)
	inputs := constrainedInputs(ep)
	var cases []map[string]any

	mk := func(title, technique, ctype string, step map[string]any) map[string]any {
		return map[string]any{"title": truncRunes(title, 500), "description": description,
			"preconditions": preconditions, "type": ctype, "priority": priority,
			"technique": technique, "steps": []any{step}, "requirement_ids": []string{req.ID}}
	}

	// -- Positive (all depths): valid EP class with representative values
	cases = append(cases, mk("Positive: valid request — "+suffix, "ep", "positive",
		mkStep(ep, params, headers, body, positiveAssertions(ep), nil)))

	// -- Localisation (FR-034, all depths): non-ASCII round-trip through a free-text field
	freeText := freeTextBodyFields(ep)
	if len(freeText) > 0 {
		locInp := freeText[0]
		sch := locInp.schema
		sample, haveSample := unicodeSample, true
		if mn, ok := asIntVal(sch["minLength"]); ok && mn > utf8.RuneCountInString(sample) {
			if mn <= utf8.RuneCountInString(unicodeSampleLong) {
				sample = unicodeSampleLong
			} else {
				haveSample = false
			}
		}
		if haveSample {
			if mx, ok := asIntVal(sch["maxLength"]); ok && mx < utf8.RuneCountInString(sample) {
				haveSample = false
			}
		}
		if haveSample {
			p2, b2 := applyInput(locInp, sample, params, body)
			okCode, has := firstStatus(ep, 200, 299)
			if !has {
				okCode = 200
			}
			assertions := []any{map[string]any{"type": "status_code", "expected": okCode}}
			rss := asMap(ep.ResponseSchemas)
			respSch := asMap(rss[strconv.Itoa(okCode)])
			if props := asMap(respSch["properties"]); props != nil {
				if _, in := props[locInp.name]; in {
					assertions = append(assertions, map[string]any{"type": "json_field",
						"path": locInp.name, "op": "eq", "expected": sample})
				}
			}
			assertions = append(assertions, map[string]any{"type": "header", "name": "Content-Type",
				"op": "contains", "expected": "utf-8"})
			cases = append(cases, mk("Localisation: Unicode round-trip in "+locInp.name+" — "+suffix,
				"localisation", "positive", mkStep(ep, p2, headers, b2, assertions, nil)))
		}
	}

	if depth == "smoke" {
		return cases
	}

	// -- EP invalid-class: one case per constrained input (FR-GEN-03)
	for _, inp := range inputs {
		bad, constraint := invalidFor(inp.schema)
		if constraint == "" {
			continue
		}
		p2, b2 := applyInput(inp, bad, params, body)
		cases = append(cases, mk(fmt.Sprintf("EP: invalid %s (%s) — %s", inp.name, constraint, suffix),
			"ep", "negative", mkStep(ep, p2, headers, b2, []any{errorAssertion(ep)}, nil)))
	}

	// -- BVA: min / min+1 / max-1 / max — only explicit bounds (FR-GEN-04)
	for _, inp := range inputs {
		sch := inp.schema
		if enum := asList(sch["enum"]); len(enum) > 0 {
			continue
		}
		type boundary struct {
			label string
			val   any
		}
		var boundaries []boundary
		if t, _ := sch["type"].(string); t == "integer" || t == "number" {
			mn, hasMn := asFloat(sch["minimum"])
			mx, hasMx := asFloat(sch["maximum"])
			if hasMn {
				boundaries = append(boundaries, boundary{"minimum", mn})
				if !hasMx || mn+1 <= mx {
					boundaries = append(boundaries, boundary{"minimum+1", mn + 1})
				}
			}
			if hasMx {
				if !hasMn || mx-1 >= mn {
					boundaries = append(boundaries, boundary{"maximum-1", mx - 1})
				}
				boundaries = append(boundaries, boundary{"maximum", mx})
			}
		} else if !truthy(sch["pattern"]) {
			if mn, ok := asIntVal(sch["minLength"]); ok {
				boundaries = append(boundaries, boundary{"minLength", strings.Repeat("x", mn)})
			}
			if mx, ok := asIntVal(sch["maxLength"]); ok {
				boundaries = append(boundaries, boundary{"maxLength", strings.Repeat("x", mx)})
			}
		}
		seen := map[string]bool{}
		for _, b := range boundaries {
			key := fmt.Sprintf("%T:%v", b.val, b.val)
			if seen[key] {
				continue
			}
			seen[key] = true
			p2, b2 := applyInput(inp, b.val, params, body)
			cases = append(cases, mk(fmt.Sprintf("BVA: %s at %s boundary — %s", inp.name, b.label, suffix),
				"bva", "boundary", mkStep(ep, p2, headers, b2, positiveAssertions(ep), nil)))
		}
	}

	// -- Negative suite (FR-GEN-08)
	for _, missing := range requiredInputs(ep) {
		p2, b2 := dropInput(missing, params, body)
		cases = append(cases, mk(fmt.Sprintf("Negative: missing required %s — %s", missing.name, suffix),
			"negative", "negative", mkStep(ep, p2, headers, b2, []any{errorAssertion(ep)}, nil)))
	}

	for _, inp := range inputs {
		if t, _ := inp.schema["type"].(string); t == "integer" || t == "number" {
			p2, b2 := applyInput(inp, "not_a_number", params, body)
			cases = append(cases, mk(fmt.Sprintf("Negative: wrong type for %s — %s", inp.name, suffix),
				"negative", "negative", mkStep(ep, p2, headers, b2, []any{errorAssertion(ep)}, nil)))
			break // one wrong-type probe per endpoint
		}
	}

	if len(ep.Security) > 0 {
		anonHeaders := map[string]any{}
		for k, v := range headers {
			if strings.ToLower(k) != "authorization" {
				anonHeaders[k] = v
			}
		}
		unauthCase := mk("Negative: unauthenticated access — "+suffix, "negative", "negative",
			mkStep(ep, params, anonHeaders, body,
				[]any{map[string]any{"type": "status_code", "expected": 401, "expected_any": []any{401, 403}}}, nil))
		unauthCase["preconditions"] = ""
		cases = append(cases, unauthCase)
	}

	if body != nil {
		cases = append(cases, mk("Negative: malformed JSON body — "+suffix, "negative", "negative",
			mkStep(ep, params, headers, nil, []any{errorAssertion(ep)}, "{{malformed}}")))
	}

	// -- FR-033: oversized payload — one probe on the first bounded string input
	for _, inp := range inputs {
		sch := inp.schema
		t := "string"
		if tv, ok := sch["type"]; ok {
			if s, isStr := tv.(string); isStr {
				t = s
			} else {
				t = ""
			}
		}
		mx, hasMx := asIntVal(sch["maxLength"])
		if t == "string" && hasMx {
			p2, b2 := applyInput(inp, strings.Repeat("x", mx+1000), params, body)
			cases = append(cases, mk(fmt.Sprintf("Negative: oversized payload in %s — %s", inp.name, suffix),
				"negative", "negative",
				mkStep(ep, p2, headers, b2,
					[]any{map[string]any{"type": "status_code", "expected": 400, "expected_any": []any{400, 413, 422}}}, nil)))
			break
		}
	}

	// -- FR-033: injection-shaped strings — must be handled, never a 5xx
	if len(freeText) > 0 {
		injInp := freeText[0]
		for _, payload := range injectionPayloads {
			label := "script-shaped"
			if strings.HasPrefix(payload, "'") {
				label = "SQL-shaped"
			}
			p2, b2 := applyInput(injInp, payload, params, body)
			cases = append(cases, mk(fmt.Sprintf("Negative: injection-shaped input (%s) in %s — %s", label, injInp.name, suffix),
				"negative", "negative",
				mkStep(ep, p2, headers, b2,
					[]any{map[string]any{"type": "status_code", "expected": 200, "expected_any": []any{200, 201, 400, 422}}}, nil)))
		}
	}

	if depth != "exhaustive" {
		return cases
	}

	// -- Enum sweeps (FR-GEN-05)
	for _, inp := range inputs {
		enum := asList(inp.schema["enum"])
		if len(enum) == 0 {
			continue
		}
		if len(enum) > maxEnumSweep {
			enum = enum[:maxEnumSweep]
		}
		for _, val := range enum {
			p2, b2 := applyInput(inp, val, params, body)
			cases = append(cases, mk(fmt.Sprintf("EP: enum sweep %s=%s — %s", inp.name, pyStr(val), suffix),
				"ep", "positive", mkStep(ep, p2, headers, b2, positiveAssertions(ep), nil)))
		}
	}

	// -- Decision tables: valid/invalid combinations when >=2 constrained inputs interact
	if len(inputs) >= 2 {
		n := len(inputs)
		limit := maxCombos
		if n < 4 { // 2^n < 8 only when n < 3; compute exactly
			if total := 1 << n; total < limit {
				limit = total
			}
		}
		for ci := 0; ci < limit; ci++ {
			p2, b2 := copyMap(params), deepCopy(body)
			var labels []string
			for j, inp := range inputs {
				// product([True, False], repeat=n): bit 0 (MSB-first) means valid
				ok := (ci>>(n-1-j))&1 == 0
				if ok {
					labels = append(labels, inp.name+"=valid")
					continue
				}
				bad, constraint := invalidFor(inp.schema)
				if constraint == "" {
					labels = append(labels, inp.name+"=valid")
					continue
				}
				p2, b2 = applyInput(inp, bad, p2, b2)
				labels = append(labels, inp.name+"=invalid")
			}
			allValid := ci == 0
			var assertions []any
			ctype := "negative"
			if allValid {
				assertions = positiveAssertions(ep)
				ctype = "positive"
			} else {
				assertions = []any{errorAssertion(ep)}
			}
			cases = append(cases, mk(fmt.Sprintf("Decision table %d: %s — %s", ci+1, strings.Join(labels, ", "), suffix),
				"decision_table", ctype, mkStep(ep, p2, headers, b2, assertions, nil)))
		}
	}
	return cases
}
