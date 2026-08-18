// catalogue.go — the SHIPPED, VERSIONED weakness corpus (SECURITY_TESTING_PLAN
// §3.1, phase S0.1) and the pure applicability predicate (§S0.2).
//
// The corpus is a DATA FILE, not a table: data/weaknesses.json is reviewable in a
// pull request, embedded at build time, and stamped into every coverage report as
// `corpus_version`. It is a byte-for-byte copy of backend/app/data/weaknesses.json
// — go:embed cannot reach outside the module, so the copy is synced by
// scripts/sync-weaknesses.sh and guarded by tests/weakness_catalogue_test.go,
// which FAILS the build if the two files diverge.
//
// Every precondition is expressed in a small CLOSED vocabulary evaluated here.
// An unknown key is never guessed: the pair becomes not-applicable with that as
// its reason, so a catalogue typo is visible in the report instead of silently
// generating (or silently skipping) cases.
package security

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

//go:generate ../../../scripts/sync-weaknesses.sh

//go:embed data/weaknesses.json
var catalogueJSON []byte

// Refs are the standard references a class maps to (OWASP API Top 10, CWE,
// ASVS). OwaspAPI is a POINTER because the corpus states null where the 2023 API
// Top 10 has no matching entry — an absent mapping is recorded as absent rather
// than forced into the nearest category.
type Refs struct {
	OwaspAPI *string  `json:"owasp_api"`
	CWE      []string `json:"cwe"`
	ASVS     []string `json:"asvs"`
}

// Weakness is one catalogue entry.
type Weakness struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Refs        Refs   `json:"refs"`
	// Severity is the BASE severity, before endpoint context (§10).
	Severity string `json:"severity"` // critical|high|medium|low
	// Activity gates execution (§7): "passive" is safe by default; "active"
	// writes or floods and is GENERATED but never executed until the S1
	// authorisation flag exists.
	Activity string `json:"activity"` // passive|active
	// Precondition is machine-checkable — see applicable().
	Precondition map[string]bool `json:"precondition"`
	// Checks names the assertion families the builder emits.
	Checks []string `json:"checks"`
}

type catalogue struct {
	Version    string      `json:"version"`
	Weaknesses []*Weakness `json:"weaknesses"`
}

var corpus catalogue

func init() {
	if err := json.Unmarshal(catalogueJSON, &corpus); err != nil {
		panic("weakness catalogue is not valid JSON: " + err.Error())
	}
}

// Version is the corpus version stamped into every report.
func Version() string { return corpus.Version }

// Weaknesses returns the catalogue in file order (which is the response order).
func Weaknesses() []*Weakness { return corpus.Weaknesses }

// Find returns the entry with this id, or nil.
func Find(id string) *Weakness {
	for _, w := range corpus.Weaknesses {
		if w.ID == id {
			return w
		}
	}
	return nil
}

// IsActive reports whether a weakness id names an ACTIVE class. The executor
// consults this before running a case: S0 generates active classes and marks
// them, it never runs them (§7, phase S0.1).
func IsActive(weaknessID string) bool {
	w := Find(weaknessID)
	return w != nil && w.Activity == "active"
}

// Payload is the JSON shape of GET /v1/weaknesses.
func Payload() map[string]any {
	items := make([]map[string]any, 0, len(corpus.Weaknesses))
	for _, w := range corpus.Weaknesses {
		items = append(items, map[string]any{
			"id": w.ID, "title": w.Title, "description": w.Description,
			"refs": map[string]any{"owasp_api": w.Refs.OwaspAPI,
				"cwe": strList(w.Refs.CWE), "asvs": strList(w.Refs.ASVS)},
			"severity": w.Severity, "activity": w.Activity,
			"precondition": w.Precondition, "checks": strList(w.Checks),
		})
	}
	return map[string]any{"version": corpus.Version, "weaknesses": items}
}

func strList(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

// ---------------------------------------------------------------------------
// The closed precondition vocabulary
// ---------------------------------------------------------------------------

// preconditions is the CLOSED vocabulary: one named predicate over the endpoint
// record, plus the reason printed when it does not hold. Nothing else may appear
// in the data file — a catalogue entry naming a term this table does not define
// is reported as such, so the corpus can never quietly stop being evaluated.
var preconditions = map[string]struct {
	holds  func(ep *models.Endpoint) bool
	reason string
}{
	"always": {
		func(*models.Endpoint) bool { return true },
		"the class applies to every endpoint",
	},
	"declares_security": {
		func(ep *models.Endpoint) bool { return len(ep.Security) > 0 },
		"endpoint declares no security scheme, so there is no authentication to subvert",
	},
	"path_has_parameter": {
		func(ep *models.Endpoint) bool { return len(pathParams(ep)) > 0 },
		"path takes no identifier parameter, so there is no object to address as another actor",
	},
	"request_has_body": {
		func(ep *models.Endpoint) bool { return bodySchema(ep) != nil },
		"endpoint declares no object request body",
	},
	"has_string_field": {
		func(ep *models.Endpoint) bool { return len(stringTargets(ep)) > 0 },
		"endpoint declares no free-text string field to carry a payload",
	},
	"has_constrained_input": {
		func(ep *models.Endpoint) bool { return len(violableInputs(ep)) > 0 },
		"endpoint declares no constrained input, so there is no stated rule to violate",
	},
	"request_has_privileged_field": {
		func(ep *models.Endpoint) bool { return len(privilegedFields(ep)) > 0 },
		"request schema declares no server-owned property (id/role/owner/permissions/...), " +
			"and a field the schema does not declare cannot be tested without fabricating it",
	},
}

// Applicable is the pure applicability predicate (phase S0.2).
//
// Returns (true, "") or (false, reason) — the reason is REQUIRED when the answer
// is false, because a skipped pair with no reason is indistinguishable from a
// pair nobody thought about.
func Applicable(ep *models.Endpoint, w *Weakness) (bool, string) {
	if ep == nil || w == nil {
		return false, "endpoint or weakness is missing"
	}
	if len(w.Precondition) == 0 {
		return false, fmt.Sprintf("weakness '%s' declares no precondition", w.ID)
	}
	terms := make([]string, 0, len(w.Precondition))
	for term := range w.Precondition {
		terms = append(terms, term)
	}
	sort.Strings(terms) // deterministic reason when several terms fail
	for _, term := range terms {
		entry, known := preconditions[term]
		if !known {
			return false, fmt.Sprintf("unknown precondition term '%s' in weakness '%s'", term, w.ID)
		}
		expected := w.Precondition[term]
		if entry.holds(ep) == expected {
			continue
		}
		if expected {
			return false, entry.reason
		}
		return false, fmt.Sprintf("precondition '%s' holds but the class requires it not to", term)
	}
	return true, ""
}

// ---------------------------------------------------------------------------
// Endpoint introspection — the primitives the vocabulary and the builders share
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

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func method(ep *models.Endpoint) string { return strings.ToUpper(ep.Method) }

func endpointKey(ep *models.Endpoint) string { return method(ep) + " " + ep.Path }

// params returns the endpoint's declared parameters as maps, in declaration order.
func params(ep *models.Endpoint) []map[string]any {
	var out []map[string]any
	for _, pv := range asList(ep.Parameters) {
		if m := asMap(pv); m != nil && str(m["name"]) != "" {
			out = append(out, m)
		}
	}
	return out
}

func paramLocation(p map[string]any) string {
	if loc := str(p["location"]); loc != "" {
		return loc
	}
	return "query"
}

// pathParams are the declared path parameters — the object identifiers BOLA
// needs. Nothing is invented: an endpoint whose "{id}" is not declared as a
// parameter has no identifier this engine may address.
func pathParams(ep *models.Endpoint) []map[string]any {
	var out []map[string]any
	for _, p := range params(ep) {
		if paramLocation(p) == "path" {
			out = append(out, p)
		}
	}
	return out
}

// bodySchema is the request schema when it is an object with properties.
func bodySchema(ep *models.Endpoint) map[string]any {
	return generation.BodyObjectSchema(ep)
}

// responseSchema mirrors the grounding validator's selection EXACTLY (first
// documented 2xx with properties, string-sorted keys) so a json_field assertion
// built from it can never be discarded by the gate.
func responseSchema(ep *models.Endpoint) map[string]any {
	rss := asMap(ep.ResponseSchemas)
	for _, k := range sortedKeys(rss) {
		n, err := strconv.Atoi(k)
		if err != nil || n < 200 || n >= 300 {
			continue
		}
		if cand := asMap(rss[k]); cand != nil && asMap(cand["properties"]) != nil {
			return cand
		}
	}
	return nil
}

// stringTargets are the free-text inputs a payload can travel in: body fields
// first (richer), then non-header parameters. The definition of "free text" is
// the GENERATOR'S (no enum, no pattern, no format), reused rather than restated.
func stringTargets(ep *models.Endpoint) []generation.Input {
	targets := generation.FreeTextBodyFields(ep)
	for _, p := range params(ep) {
		if paramLocation(p) == "header" {
			continue
		}
		sch := generation.ParamSchema(p)
		if generation.IsFreeText(sch) {
			targets = append(targets, generation.Input{Name: str(p["name"]), Where: "param",
				Location: paramLocation(p), Schema: sch, Required: truthy(p["required"])})
		}
	}
	return targets
}

// violableInput is a constrained input for which a concrete invalid value can be
// derived — the generator derives both, so the security engine and the
// functional engine violate a constraint the same way.
type violableInput struct {
	in         generation.Input
	value      any
	constraint string
}

func violableInputs(ep *models.Endpoint) []violableInput {
	var out []violableInput
	for _, in := range generation.ConstrainedInputs(ep) {
		bad, constraint := generation.InvalidFor(in.Schema)
		if constraint != "" {
			out = append(out, violableInput{in: in, value: bad, constraint: constraint})
		}
	}
	return out
}

// privilegedFields are DECLARED body properties whose name marks them as
// server-owned. Mass assignment is only testable against a field the request
// schema already declares — inventing a body field would (rightly) be discarded
// by the grounding gate.
func privilegedFields(ep *models.Endpoint) []generation.Input {
	rs := bodySchema(ep)
	if rs == nil {
		return nil
	}
	required := map[string]bool{}
	for _, r := range asList(rs["required"]) {
		if name, ok := r.(string); ok {
			required[name] = true
		}
	}
	props := asMap(rs["properties"])
	var out []generation.Input
	// Go maps carry no order, so the declaration order of a JSON object cannot be
	// recovered: sorted order is the deterministic equivalent.
	for _, name := range sortedKeys(props) {
		sch := asMap(props[name])
		if sch != nil && privilegedNames[strings.ToLower(name)] {
			out = append(out, generation.Input{Name: name, Where: "body", Location: "body",
				Schema: sch, Required: required[name]})
		}
	}
	return out
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int:
		return t != 0
	}
	return true
}

// privilegedNames — properties a client must not be able to set on itself. The
// list is closed and deterministic on purpose (mirrors PRIVILEGED_FIELDS in the
// Python module, which is the same corpus contract).
var privilegedNames = map[string]bool{
	"id": true, "role": true, "roles": true, "admin": true, "is_admin": true,
	"isadmin": true, "superuser": true, "is_superuser": true, "owner": true,
	"owner_id": true, "ownerid": true, "user_id": true, "userid": true,
	"organisation_id": true, "organization_id": true, "org_id": true,
	"tenant_id": true, "permissions": true, "scope": true, "scopes": true,
	"verified": true, "is_verified": true, "email_verified": true,
	"balance": true, "credit": true, "credits": true, "password_hash": true,
	"created_at": true, "updated_at": true, "deleted_at": true,
}
