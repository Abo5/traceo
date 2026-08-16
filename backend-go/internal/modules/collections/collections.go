// Package collections — API collection import (fixed contract "API collection
// import + AI enrichment", items 1 & 2).
//
// Three extra upload formats are accepted by the SAME endpoint that already takes
// OpenAPI/Swagger (POST /v1/projects/{id}/api-specs):
//
//	postman2   Postman Collection v2.0 / v2.1 — info.schema contains
//	           "getpostman.com/json/collection/v2"
//	har        HAR 1.2 — a top-level "log" object carrying "entries"
//	insomnia4  Insomnia v4 export — "_type":"export" plus "resources"
//
// Conversion is 100% DETERMINISTIC — no LLM anywhere in this package's Convert
// path. It is the grounding source of truth: whatever comes out of Convert is the
// only inventory the rest of the system (and the optional AI enrichment layer in
// enrich.go) is allowed to talk about.
//
// The output is the same endpoint inventory shape the OpenAPI importer produces:
// method + server-relative templated path, parameters
// ({name, location, type, required, constraints}), an inferred request JSON
// Schema, and response schemas keyed by observed status code.
package collections

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Format ids — these are the exact strings the api-specs response reports.
const (
	FormatPostman2  = "postman2"
	FormatHAR       = "har"
	FormatInsomnia4 = "insomnia4"
)

// SupportedFormatsNote is appended to the 422 invalid_spec error list so the
// message names the formats that are actually accepted (contract item 1).
const SupportedFormatsNote = "Supported formats: OpenAPI 3.x, Swagger 2.0, " +
	"Postman Collection v2.0/v2.1, HAR 1.2, Insomnia v4 export."

// Operation is one converted endpoint — the internal inventory row.
type Operation struct {
	Method string
	Path   string
	// OperationID is the slugified request name (Postman/Insomnia name their
	// requests; HAR does not, so it stays empty there).
	OperationID     string
	Summary         string
	Parameters      []map[string]any
	RequestSchema   map[string]any
	ResponseSchemas map[string]any
	// Security mirrors the OpenAPI importer's shape ([{"bearer": []}]) derived
	// from the collection's auth block.
	Security []any
	// Tags are the enclosing folder names, outermost first.
	Tags []string
	// ObservedCount is how many concrete requests produced this row. Only HAR
	// (real captured traffic) reports it; collections leave it at 0.
	ObservedCount int
}

// Key is the dedup/grounding key: "METHOD /path".
func (o Operation) Key() string { return strings.ToUpper(o.Method) + " " + o.Path }

// Warning mirrors the discovery importer's warning shape: a skipped request never
// sinks the import.
type Warning struct {
	Path   string
	Method string
	Error  string
}

// Detect returns the collection format id, or "" when the document is not one of
// the collection formats (in which case the caller falls back to OpenAPI/Swagger).
func Detect(doc any) string {
	root, ok := doc.(map[string]any)
	if !ok {
		return ""
	}
	if info, isMap := root["info"].(map[string]any); isMap {
		if schema, isStr := info["schema"].(string); isStr &&
			strings.Contains(schema, "getpostman.com/json/collection/v2") {
			return FormatPostman2
		}
	}
	if log, isMap := root["log"].(map[string]any); isMap {
		if _, hasEntries := log["entries"]; hasEntries {
			return FormatHAR
		}
	}
	if t, isStr := root["_type"].(string); isStr && t == "export" {
		if _, hasResources := root["resources"]; hasResources {
			return FormatInsomnia4
		}
	}
	return ""
}

// SourceFor maps a detected format onto the Endpoint.source enum. The enum is NOT
// extended: HAR is captured traffic, Postman and Insomnia are collections
// (contract item 2 — "prefer reusing existing values to avoid an enum change").
func SourceFor(format string) string {
	if format == FormatHAR {
		return "traffic"
	}
	return "postman"
}

// Title extracts a human title for the ApiSpec row (best effort, never fatal).
//
// It must return byte-for-byte what the Python reference backend returns for the
// same document: the title is now user-visible twice over — as the ApiSpec row's
// title and, via EnvironmentName, as the name of an auto-created environment —
// so a divergence here is a parity divergence in the api-specs response itself.
//
// Per format, the title is the name the DOCUMENT states for itself:
//   - Postman: info.name.
//   - HAR: the capturing tool, log.creator.name. The creator's version is
//     deliberately NOT appended — it names a tool build, not the document, and
//     "Chrome DevTools 1.0 (imported)" is a worse environment name than
//     "Chrome DevTools (imported)".
//   - Insomnia: the workspace resource's name. __export_source is the exporting
//     application's identifier ("insomnia.desktop.app:v8.0.0"), not a title.
func Title(format string, root map[string]any) string {
	switch format {
	case FormatPostman2:
		if info, ok := root["info"].(map[string]any); ok {
			return str(info["name"])
		}
	case FormatHAR:
		if log, ok := root["log"].(map[string]any); ok {
			if creator, ok := log["creator"].(map[string]any); ok {
				return str(creator["name"])
			}
		}
	case FormatInsomnia4:
		resources, _ := root["resources"].([]any)
		for _, raw := range resources {
			r, ok := raw.(map[string]any)
			if ok && str(r["_type"]) == "workspace" {
				return str(r["name"])
			}
		}
	}
	return ""
}

// Convert dispatches to the per-format converter and returns the deduplicated,
// deterministically ordered inventory. Unparseable individual requests are
// reported as warnings and skipped (never fatal).
func Convert(format string, root map[string]any) ([]Operation, []Warning) {
	var raw []Operation
	var warnings []Warning
	switch format {
	case FormatPostman2:
		raw, warnings = convertPostman(root)
	case FormatHAR:
		raw, warnings = convertHAR(root)
	case FormatInsomnia4:
		raw, warnings = convertInsomnia(root)
	default:
		return nil, nil
	}
	return dedupe(raw), warnings
}

// dedupe merges identical method+path rows: parameters union by name+location,
// request schema merged property-wise, response schemas merged per status code,
// observed counts summed. Output order: first-seen order of the source document.
func dedupe(ops []Operation) []Operation {
	order := []string{}
	byKey := map[string]*Operation{}
	for i := range ops {
		op := ops[i]
		key := op.Key()
		existing, seen := byKey[key]
		if !seen {
			cp := op
			if cp.Parameters == nil {
				cp.Parameters = []map[string]any{}
			}
			if cp.ResponseSchemas == nil {
				cp.ResponseSchemas = map[string]any{}
			}
			if cp.Security == nil {
				cp.Security = []any{}
			}
			if cp.Tags == nil {
				cp.Tags = []string{}
			}
			byKey[key] = &cp
			order = append(order, key)
			continue
		}
		existing.Parameters = mergeParams(existing.Parameters, op.Parameters)
		existing.RequestSchema = MergeSchema(existing.RequestSchema, op.RequestSchema)
		for status, schema := range op.ResponseSchemas {
			if prior, present := existing.ResponseSchemas[status]; present {
				existing.ResponseSchemas[status] = MergeSchema(asMap(prior), asMap(schema))
			} else {
				existing.ResponseSchemas[status] = schema
			}
		}
		if existing.Summary == "" {
			existing.Summary = op.Summary
		}
		if existing.OperationID == "" {
			existing.OperationID = op.OperationID
		}
		if len(existing.Security) == 0 {
			existing.Security = op.Security
		}
		for _, tag := range op.Tags {
			if tag != "" && !containsString(existing.Tags, tag) {
				existing.Tags = append(existing.Tags, tag)
			}
		}
		existing.ObservedCount += op.ObservedCount
	}
	out := make([]Operation, 0, len(order))
	for _, key := range order {
		out = append(out, *byKey[key])
	}
	return out
}

// mergeParams unions two parameter lists on (name, location). The first
// occurrence keeps its position; missing constraints are filled in from the
// later one; required is sticky.
func mergeParams(a, b []map[string]any) []map[string]any {
	order := []string{}
	byKey := map[string]map[string]any{}
	add := func(list []map[string]any) {
		for _, p := range list {
			key := str(p["name"]) + "|" + str(p["location"])
			prior, seen := byKey[key]
			if !seen {
				byKey[key] = p
				order = append(order, key)
				continue
			}
			if truthy(p["required"]) {
				prior["required"] = true
			}
			if str(prior["type"]) == "" {
				prior["type"] = p["type"]
			}
			pc, nc := asMap(prior["constraints"]), asMap(p["constraints"])
			if pc == nil {
				pc = map[string]any{}
				prior["constraints"] = pc
			}
			for k, v := range nc {
				if _, present := pc[k]; !present {
					pc[k] = v
				}
			}
		}
	}
	add(a)
	add(b)
	out := make([]map[string]any, 0, len(order))
	for _, key := range order {
		out = append(out, byKey[key])
	}
	return out
}

// --- shared parameter/url helpers ------------------------------------------------

// Param exposes the inventory parameter builder to the other discovery modes.
// The DOM crawler records query values exactly the way a HAR capture does, and
// two builders that must stay identical are one builder.
func Param(name, location string, required bool, example string) map[string]any {
	return param(name, location, required, example)
}

// TemplateConcretePath exposes the concrete-id templating rule (all-digits, UUID
// and ObjectId segments become {id}, {id2}, …) to the other discovery modes, so
// a URL captured in the browser is templated exactly as the same URL in a HAR.
func TemplateConcretePath(path string) (string, []string) {
	return templateConcretePath(path)
}

// param builds one inventory parameter in the exact shape the OpenAPI importer
// emits. The observed example value (when there is one) is recorded under
// constraints.example — collections carry examples, not JSON Schema constraints.
func param(name, location string, required bool, example string) map[string]any {
	return paramDesc(name, location, required, example, "")
}

// paramDesc is param plus the source description, which is the ONLY required-ness
// signal a collection carries (see isRequiredMarker).
func paramDesc(name, location string, required bool, example, description string) map[string]any {
	constraints := map[string]any{}
	typ := "string"
	if example != "" {
		constraints["example"] = example
		typ = scalarType(example)
	}
	return map[string]any{
		"name": name, "location": location, "type": typ,
		"required": required || isRequiredMarker(description), "constraints": constraints,
	}
}

// isRequiredMarker: Postman's own OpenAPI->collection converter prefixes the
// description of a required parameter with "(Required)". That prefix is the only
// required-ness signal in the file, so it is honoured.
func isRequiredMarker(description string) bool {
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(description)), "(required)")
}

// transportHeaders describe the transport rather than the API contract. Captured
// headers are useful (X-Api-Key, X-Tenant); these are noise on every request and
// would otherwise appear as a parameter on every endpoint in the inventory.
var transportHeaders = map[string]bool{
	"accept": true, "accept-charset": true, "accept-encoding": true,
	"accept-language": true, "cache-control": true, "connection": true,
	"content-length": true, "content-type": true, "cookie": true, "date": true,
	"expect": true, "host": true, "if-modified-since": true, "if-none-match": true,
	"origin": true, "pragma": true, "referer": true, "te": true,
	"transfer-encoding": true, "upgrade": true, "user-agent": true, "via": true,
}

// credentialHeaders never contribute an example value — a HAR capture or a
// working collection routinely carries live session credentials, and the
// inventory is rendered in the UI.
var credentialHeaders = map[string]bool{
	"authorization": true, "cookie": true, "set-cookie": true,
	"x-api-key": true, "x-auth-token": true, "proxy-authorization": true,
}

// headerParams converts a header list into header parameters. `nameKeys` lets the
// caller name the field the format uses ("key" in Postman, "name" in HAR and
// Insomnia). Headers become header parameters and NEVER query parameters; a
// `disabled` header is still part of the API surface and is captured.
func headerParams(headers any, vars map[string]string, nameKeys ...string) []map[string]any {
	out := []map[string]any{}
	for _, entry := range asList(headers) {
		hm := asMap(entry)
		if hm == nil {
			continue
		}
		name := ""
		for _, key := range nameKeys {
			if name = strings.TrimSpace(str(hm[key])); name != "" {
				break
			}
		}
		// HTTP/2 pseudo-headers (":method", ":authority") are transport, not API.
		if name == "" || transportHeaders[strings.ToLower(name)] ||
			strings.HasPrefix(name, ":") {
			continue
		}
		example := resolveVars(str(hm["value"]), vars)
		if credentialHeaders[strings.ToLower(name)] {
			example = "" // never record a credential VALUE in the inventory
		}
		out = append(out, paramDesc(name, "header", false, example,
			str(hm["description"])))
	}
	return out
}

// slug builds an operation_id from a request name: lowercase, every run of
// non-alphanumerics collapsed to "_", trimmed, capped at 200 characters.
func slug(text string) string {
	lowered := strings.ToLower(text)
	var b strings.Builder
	lastUnderscore := false
	for _, r := range lowered {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastUnderscore = false
			continue
		}
		if !lastUnderscore {
			b.WriteByte('_')
			lastUnderscore = true
		}
	}
	out := strings.Trim(b.String(), "_")
	if len(out) > 200 {
		out = out[:200]
	}
	return out
}

// resolveVars substitutes {{var}} / {{ _.var }} from the collection or
// environment variables. An UNKNOWN variable is left verbatim — guessing a value
// would be inventing data the document does not contain.
func resolveVars(text string, vars map[string]string) string {
	if !strings.Contains(text, "{{") || len(vars) == 0 {
		return text
	}
	var b strings.Builder
	for {
		open := strings.Index(text, "{{")
		if open < 0 {
			break
		}
		closeIdx := strings.Index(text[open:], "}}")
		if closeIdx < 0 {
			break
		}
		name := strings.TrimPrefix(strings.TrimSpace(text[open+2:open+closeIdx]), "_.")
		name = strings.TrimSpace(name)
		b.WriteString(text[:open])
		if value, known := vars[name]; known {
			b.WriteString(value)
		} else {
			b.WriteString(text[open : open+closeIdx+2])
		}
		text = text[open+closeIdx+2:]
	}
	b.WriteString(text)
	return b.String()
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}

// scalarType infers a JSON Schema type from a textual example value —
// deterministic and total: "true"/"false" -> boolean, integers -> integer,
// other numerics -> number, everything else -> string.
func scalarType(v string) string {
	switch strings.ToLower(v) {
	case "true", "false":
		return "boolean"
	}
	if _, err := strconv.ParseInt(v, 10, 64); err == nil {
		return "integer"
	}
	if _, err := strconv.ParseFloat(v, 64); err == nil {
		return "number"
	}
	return "string"
}

// splitURL cuts a raw URL-ish string (which may still contain {{variables}}) into
// its path and query halves, stripping the fragment plus any leading origin:
// a scheme://host prefix, a leading {{baseUrl}}-style variable, or a bare
// host[:port] first segment. The result is always server-relative, matching the
// OpenAPI importer's output.
func splitURL(raw string) (string, string) {
	raw = strings.TrimSpace(raw)
	if i := strings.Index(raw, "#"); i >= 0 {
		raw = raw[:i]
	}
	path, query := raw, ""
	if i := strings.Index(raw, "?"); i >= 0 {
		path, query = raw[:i], raw[i+1:]
	}
	// scheme://host/...
	if i := strings.Index(path, "://"); i >= 0 {
		rest := path[i+3:]
		if j := strings.Index(rest, "/"); j >= 0 {
			path = rest[j:]
		} else {
			path = "/"
		}
		return normalizePath(path), query
	}
	// leading {{var}} or {{ _.var }} origin token
	if strings.HasPrefix(path, "{{") {
		if j := strings.Index(path, "}}"); j >= 0 {
			path = path[j+2:]
		}
		return normalizePath(path), query
	}
	// bare host[:port] first segment (contains a dot or a port colon)
	if !strings.HasPrefix(path, "/") {
		head := path
		rest := ""
		if j := strings.Index(path, "/"); j >= 0 {
			head, rest = path[:j], path[j:]
		}
		if strings.Contains(head, ".") || strings.Contains(head, ":") {
			path = rest
		}
	}
	return normalizePath(path), query
}

// normalizePath guarantees a single leading slash and drops a trailing slash on
// non-root paths so "/a/b/" and "/a/b" dedupe to the same endpoint.
func normalizePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return "/"
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	if len(p) > 1 {
		p = strings.TrimRight(p, "/")
	}
	if p == "" {
		return "/"
	}
	return p
}

// parseQueryPairs splits a raw query string into ordered key/value pairs,
// preserving duplicates (the caller dedupes on name).
func parseQueryPairs(query string) [][2]string {
	out := [][2]string{}
	for _, chunk := range strings.Split(query, "&") {
		if chunk == "" {
			continue
		}
		key, value := chunk, ""
		if i := strings.Index(chunk, "="); i >= 0 {
			key, value = chunk[:i], chunk[i+1:]
		}
		if key = strings.TrimSpace(key); key == "" {
			continue
		}
		out = append(out, [2]string{key, value})
	}
	return out
}

// --- path templating --------------------------------------------------------------

// templateVarSegment rewrites one path segment written in collection syntax into
// OpenAPI templating:
//
//	":id"        -> "{id}"     (Postman / Insomnia path parameter)
//	"{{eventId}}" -> "{eventId}" (collection variable used as a path parameter)
//	"{id}"       -> "{id}"     (already templated — left alone)
//
// The returned name list is the path parameters the segment declares.
func templateVarSegment(seg string) (string, []string) {
	names := []string{}
	if strings.HasPrefix(seg, ":") && len(seg) > 1 {
		name := sanitizeParamName(seg[1:])
		if name == "" {
			return seg, names
		}
		return "{" + name + "}", append(names, name)
	}
	if strings.Contains(seg, "{{") {
		out := seg
		for {
			open := strings.Index(out, "{{")
			if open < 0 {
				break
			}
			closeIdx := strings.Index(out[open:], "}}")
			if closeIdx < 0 {
				break
			}
			inner := out[open+2 : open+closeIdx]
			name := sanitizeParamName(strings.TrimPrefix(strings.TrimSpace(inner), "_."))
			if name == "" {
				out = out[:open] + out[open+closeIdx+2:]
				continue
			}
			names = append(names, name)
			out = out[:open] + "{" + name + "}" + out[open+closeIdx+2:]
		}
		return out, names
	}
	if strings.HasPrefix(seg, "{") && strings.HasSuffix(seg, "}") && len(seg) > 2 {
		name := sanitizeParamName(seg[1 : len(seg)-1])
		if name != "" {
			return "{" + name + "}", append(names, name)
		}
	}
	return seg, names
}

// concreteIDName decides whether a CONCRETE path segment (HAR / Insomnia carry
// real ids, not templates) is an identifier that must be templated. The
// documented heuristic — deliberately narrow, so real resource names are never
// mangled — is: the segment is all digits, or a canonical UUID, or a hex/base-ish
// opaque token of 24+ characters. The first such segment becomes "{id}", the
// next "{id2}", then "{id3}", ... (idx is the 0-based count of segments already
// templated on this path).
func concreteIDName(seg string, idx int) (string, bool) {
	if !looksLikeID(seg) {
		return "", false
	}
	if idx == 0 {
		return "id", true
	}
	return "id" + strconv.Itoa(idx+1), true
}

func looksLikeID(seg string) bool {
	if seg == "" {
		return false
	}
	digits := true
	for _, r := range seg {
		if r < '0' || r > '9' {
			digits = false
			break
		}
	}
	if digits {
		return true
	}
	if isUUID(seg) {
		return true
	}
	if len(seg) >= 24 && isHexish(seg) {
		return true
	}
	return false
}

func isUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !isHexRune(r) {
				return false
			}
		}
	}
	return true
}

func isHexish(s string) bool {
	for _, r := range s {
		if !isHexRune(r) {
			return false
		}
	}
	return true
}

func isHexRune(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

// sanitizeParamName keeps parameter names to a safe, path-template-legal charset.
func sanitizeParamName(name string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(name) {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '_', r == '-', r == '.':
			b.WriteRune(r)
		}
	}
	return b.String()
}

// --- tiny shared helpers ------------------------------------------------------------

func str(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	}
	return fmt.Sprint(v)
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func asList(v any) []any {
	l, _ := v.([]any)
	return l
}

func truthy(v any) bool {
	switch t := v.(type) {
	case bool:
		return t
	case nil:
		return false
	case string:
		return t != "" && strings.ToLower(t) != "false"
	case float64:
		return t != 0
	}
	return v != nil
}

// clip truncates to n runes (summaries and titles are column-bounded).
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// sortedKeys gives deterministic iteration over a string-keyed map.
func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
