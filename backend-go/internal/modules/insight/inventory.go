// inventory.go — introspection over the DISCOVERED endpoint inventory. Every
// helper here answers "what does this project actually have?"; nothing invents.
// The builders (builders.go) may only reference names returned from here.
package insight

import (
	"sort"
	"strconv"
	"strings"

	"traceo/internal/models"
)

// ---------------------------------------------------------------------------
// Tiny dynamic-value helpers (JSON columns decode to any)
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
	}
	return nil
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
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

func asInt(v any) (int, bool) {
	if f, ok := asFloat(v); ok && f == float64(int(f)) {
		return int(f), true
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

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

// field is one addressable input of an endpoint: a declared parameter or a
// top-level request-body property. Nothing else is addressable — that is the
// whole point of the grounding contract.
type field struct {
	name     string
	where    string // "param" | "body"
	location string // query|path|header|body
	schema   map[string]any
}

func paramSchema(p map[string]any) map[string]any {
	sch := map[string]any{"type": "string"}
	if t := str(p["type"]); t != "" {
		sch["type"] = t
	}
	for k, v := range asMap(p["constraints"]) {
		if v != nil {
			sch[k] = v
		}
	}
	return sch
}

// bodyFields — top-level properties of the request body object schema, sorted.
func bodyFields(ep *models.Endpoint) []field {
	rs := bodyObjectSchema(ep)
	if rs == nil {
		return nil
	}
	props := asMap(rs["properties"])
	out := make([]field, 0, len(props))
	for _, name := range sortedKeys(props) {
		if sch := asMap(props[name]); sch != nil {
			out = append(out, field{name: name, where: "body", location: "body", schema: sch})
		}
	}
	return out
}

// paramFields — declared parameters, header parameters excluded (mutating a
// header would collide with the grounding validator's header allowlist).
func paramFields(ep *models.Endpoint) []field {
	var out []field
	for _, pv := range asList(ep.Parameters) {
		p := asMap(pv)
		if p == nil {
			continue
		}
		name := str(p["name"])
		if name == "" {
			continue
		}
		loc := str(p["location"])
		if loc == "" {
			loc = "query"
		}
		if loc == "header" {
			continue
		}
		out = append(out, field{name: name, where: "param", location: loc, schema: paramSchema(p)})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

// allFields — body fields first, then parameters; a stable, deterministic order.
func allFields(ep *models.Endpoint) []field {
	return append(bodyFields(ep), paramFields(ep)...)
}

func schemaType(sch map[string]any) string {
	if t := str(sch["type"]); t != "" {
		return t
	}
	if asMap(sch["properties"]) != nil {
		return "object"
	}
	return ""
}

// isFreeText — a string field with no enum, pattern or format: the only kind of
// field where exotic/control-character payloads are a meaningful probe rather
// than a trivially rejected format violation.
func isFreeText(sch map[string]any) bool {
	if t := schemaType(sch); t != "" && t != "string" {
		return false
	}
	return sch["enum"] == nil && str(sch["pattern"]) == "" && str(sch["format"]) == ""
}

func freeTextFields(ep *models.Endpoint) []field {
	var out []field
	for _, f := range allFields(ep) {
		if isFreeText(f.schema) {
			out = append(out, f)
		}
	}
	return out
}

// maxStringProbeFields — the exotic/control-character probes write to the FIRST
// free-text field only, not to every one of them. Same cap as the Python
// reference engine (MAX_STRING_PROBE_FIELDS), so both backends emit the same
// number of cases for the same inventory.
const maxStringProbeFields = 1

// stringProbeFields — the inputs the exotic_input and control_chars builders may
// write to: request-body free-text fields first, then free-text QUERY parameters.
//
// Path parameters are deliberately excluded, matching the Python engine: a path
// value is part of the route, so bending it changes WHICH resource is addressed
// rather than how a value is handled — that is a routing probe, not a payload
// probe. Header parameters are excluded too (the grounding validator keeps its
// own header allowlist).
func stringProbeFields(ep *models.Endpoint) []field {
	var out []field
	for _, f := range bodyFields(ep) {
		if isFreeText(f.schema) {
			out = append(out, f)
		}
	}
	for _, f := range paramFields(ep) {
		if f.location == "query" && isFreeText(f.schema) {
			out = append(out, f)
		}
	}
	if len(out) > maxStringProbeFields {
		out = out[:maxStringProbeFields]
	}
	return out
}

// boundedStringFields — string inputs the oversized-payload probe can grow:
// top-level body string properties (enums excluded — an enum has no headroom)
// plus free-text query parameters.
func boundedStringFields(ep *models.Endpoint) []field {
	var out []field
	for _, f := range bodyFields(ep) {
		if t := schemaType(f.schema); (t == "" || t == "string") && f.schema["enum"] == nil {
			out = append(out, f)
		}
	}
	for _, f := range paramFields(ep) {
		if f.location == "query" && isFreeText(f.schema) {
			out = append(out, f)
		}
	}
	return out
}

// fitsSchema — the field's OWN declared length bounds win. A probe payload that
// would violate them is dropped rather than handed invented headroom, so the
// case never tests the length rule when it meant to test the character set.
func fitsSchema(sch map[string]any, v string) bool {
	n := len([]rune(v))
	if mn, ok := asInt(sch["minLength"]); ok && n < mn {
		return false
	}
	if mx, ok := asInt(sch["maxLength"]); ok && n > mx {
		return false
	}
	return true
}

// pathFamily — the first non-templated path segment, i.e. the resource family two
// endpoints share ("/orders/{id}/cancel" -> "orders").
func pathFamily(p string) string {
	for _, seg := range strings.Split(strings.Trim(p, "/"), "/") {
		if seg != "" && !strings.HasPrefix(seg, "{") {
			return seg
		}
	}
	return ""
}

// isDateLike — schema type/format marks the field as a date or date-time. This
// is the ONLY trigger for the timing_dst builder; a project with no such field
// makes that category n_a.
func isDateLike(sch map[string]any) bool {
	f := str(sch["format"])
	if f == "date" || f == "date-time" {
		return true
	}
	t := schemaType(sch)
	return t == "date" || t == "date-time"
}

func dateFields(ep *models.Endpoint) []field {
	var out []field
	for _, f := range allFields(ep) {
		if isDateLike(f.schema) {
			out = append(out, f)
		}
	}
	return out
}

// paginationNames — parameter names that denote pagination / result-size limits.
var paginationNames = map[string]bool{
	"limit": true, "offset": true, "page": true, "page_size": true, "pagesize": true,
	"per_page": true, "perpage": true, "size": true, "count": true, "top": true, "skip": true,
}

func paginationFields(ep *models.Endpoint) []field {
	var out []field
	for _, f := range paramFields(ep) {
		if paginationNames[strings.ToLower(f.name)] {
			out = append(out, f)
		}
	}
	return out
}

var mutatingMethods = map[string]bool{"POST": true, "PUT": true, "PATCH": true}

func method(ep *models.Endpoint) string { return strings.ToUpper(ep.Method) }

func isMutating(ep *models.Endpoint) bool { return mutatingMethods[method(ep)] }

// declaredStatuses returns the documented response codes in [lo, hi], ascending.
func declaredStatuses(ep *models.Endpoint, lo, hi int) []int {
	var out []int
	for k := range asMap(ep.ResponseSchemas) {
		n, err := strconv.Atoi(k)
		if err != nil || n < lo || n > hi {
			continue
		}
		out = append(out, n)
	}
	sort.Ints(out)
	return out
}

// bodyObjectSchema mirrors the generator's rule: an object schema with
// properties, else nil.
func bodyObjectSchema(ep *models.Endpoint) map[string]any {
	rs := asMap(ep.RequestSchema)
	if rs == nil {
		return nil
	}
	if t := str(rs["type"]); t != "" && t != "object" {
		return nil
	}
	if asMap(rs["properties"]) == nil {
		return nil
	}
	return rs
}

// responseProperties — properties of the first documented 2xx response schema;
// the only legal targets for a json_field assertion (grounding.go enforces it).
func responseProperties(ep *models.Endpoint) map[string]any {
	rss := asMap(ep.ResponseSchemas)
	for _, code := range declaredStatuses(ep, 200, 299) {
		if sch := asMap(rss[strconv.Itoa(code)]); sch != nil {
			if props := asMap(sch["properties"]); props != nil {
				return props
			}
		}
	}
	return nil
}
