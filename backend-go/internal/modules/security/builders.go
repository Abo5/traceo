// builders.go — deterministic security case builders (SECURITY_TESTING_PLAN
// §5.1, phase S0.2). No model is involved anywhere in this file, so the coverage
// matrix is complete and reproducible.
//
// Every case is built from the endpoint's OWN inventory: the valid request comes
// from generation.ValidRequest, the targets come from the generator's own input
// helpers, and the only identifiers a case may name are ones the endpoint
// already declares. That is what lets the shared grounding gate accept them —
// the builders never earn an exemption from it.
//
// Case dicts carry exactly the keys generation returns (title, description,
// preconditions, type, priority, technique, steps, requirement_ids) plus
// weakness_id, so review, approval and the traceability matrix treat a security
// case identically to a functional one.
//
// This file is a 1:1 port of backend/app/modules/security.py's builders: same
// titles, same probes, same assertions, same order.
package security

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

// Technique is the TestCase.technique value every security case carries.
const Technique = "security"

// Model is the provenance stamp on a security case: deterministic, no LLM.
const Model = "deterministic-security"

// errorSignatures are the response fragments that mean the server handed the
// caller an oracle: a stack trace, a framework version, a database error or an
// internal path. The executor's `body_not_matches` assertion (S1) fails a case
// that echoes any of them; today the type is unknown to the engine and skipped,
// which is why the list ships WITH the case rather than with the runner.
var errorSignatures = []any{
	"Traceback (most recent call last)",
	"java.lang.",
	"org.springframework",
	"System.Web",
	"psycopg2",
	"SQLSTATE",
	"SQL syntax",
	"ORA-0",
	"node_modules",
	"/usr/local/lib/python",
}

// injectionProbe is ONE probe string, not a copied exploit list: metacharacters
// that must be handled as data. It is truncated to the field's own maxLength so
// the case tests escaping rather than length validation.
const injectionProbe = "' OR 1=1;-- <img src=x>"

// Placeholders the environment supplies at run time (the same {{var}}
// interpolation the execution engine already performs). They are NOT invented
// values: an environment that cannot supply them fails the case loudly instead
// of the case quietly testing nothing.
const (
	foreignObjectID   = "{{foreign_object_id}}"
	lowPrivilegeToken = "Bearer {{low_privilege_token}}"
	expiredToken      = "Bearer {{expired_token}}"
	unsignedToken     = "Bearer {{unsigned_token}}"
)

// rateLimitRequests is bounded: a QA tool must not be the outage (§7).
const rateLimitRequests = 20

// ---------------------------------------------------------------------------
// Small builders shared by every class
// ---------------------------------------------------------------------------

func no5xx() map[string]any { return map[string]any{"type": "no_5xx"} }

func noLeak() map[string]any {
	return map[string]any{"type": "body_not_matches", "patterns": errorSignatures}
}

// fit clips a probe to the field's declared maxLength, so an injection case
// tests escaping instead of tripping length validation first.
func fit(value string, schema map[string]any) string {
	if mx, ok := intOf(schema["maxLength"]); ok && mx > 0 && mx < utf8.RuneCountInString(value) {
		return string([]rune(value)[:mx])
	}
	return value
}

// privilegedValue means "the client is claiming something it must not claim",
// derived from the field's OWN declared type so the case stays grounded.
func privilegedValue(schema map[string]any) any {
	if enum := asList(schema["enum"]); len(enum) > 0 {
		return enum[len(enum)-1]
	}
	switch schemaTypeOf(schema) {
	case "boolean":
		return true
	case "integer":
		return 999999
	case "number":
		return 999999.0
	case "array":
		return []any{"admin"}
	case "object":
		return map[string]any{}
	}
	return fit("admin", schema)
}

func schemaTypeOf(schema map[string]any) string {
	if t := str(schema["type"]); t != "" {
		return t
	}
	return "string"
}

func intOf(v any) (int, bool) {
	switch t := v.(type) {
	case int:
		return t, true
	case int64:
		return int(t), true
	case float64:
		if t == float64(int(t)) {
			return int(t), true
		}
	}
	return 0, false
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

func suffixOf(ep *models.Endpoint) string { return method(ep) + " " + ep.Path }

// ---------------------------------------------------------------------------
// BuildCases
// ---------------------------------------------------------------------------

type builder func(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any

var builders map[string]builder

func init() {
	builders = map[string]builder{
		"missing-authn":               buildMissingAuthn,
		"broken-object-level-authz":   buildBOLA,
		"broken-function-level-authz": buildFunctionLevelAuthz,
		"mass-assignment":             buildMassAssignment,
		"injection-surface":           buildInjectionSurface,
		"input-validation":            buildInputValidation,
		"error-leakage":               buildErrorLeakage,
		"security-headers":            buildSecurityHeaders,
		"token-handling":              buildTokenHandling,
		"rate-limiting":               buildRateLimiting,
	}
}

// BuildCases returns every case this weakness class can ground on this endpoint.
//
// Pure and deterministic: the same inputs yield identical titles, steps and
// order. It returns nothing when the class does not apply (Applicable is the
// authority) — callers report the reason, they never guess one.
//
// TRACEABILITY: requirement_ids is always non-empty. The caller resolves the
// requirement through the generator's own requirement -> endpoint mapping; an
// endpoint no requirement maps to produces NO security cases (BO-07).
func BuildCases(req *models.Requirement, ep *models.Endpoint, w *Weakness) []map[string]any {
	if req == nil || ep == nil || w == nil {
		return nil
	}
	if ok, _ := Applicable(ep, w); !ok {
		return nil
	}
	build, known := builders[w.ID]
	if !known {
		// A catalogue entry with no builder produces nothing rather than a
		// guessed case; the coverage report shows the pair as a gap, which is
		// the truth.
		return nil
	}
	params, headers, body := generation.ValidRequest(ep)
	return build(req, ep, w, params, headers, body)
}

// mk is the case dict, in exactly the shape the functional generator returns
// (plus weakness_id) so review, approval and the matrix treat it identically.
func mk(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	title, ctype string, step map[string]any, preconditions string) map[string]any {
	var refBits []string
	if w.Refs.OwaspAPI != nil && *w.Refs.OwaspAPI != "" {
		refBits = append(refBits, *w.Refs.OwaspAPI)
	}
	refBits = append(refBits, w.Refs.CWE...)
	reqRef := req.ExternalID
	if reqRef == "" {
		reqRef = req.ID
		if len(reqRef) > 8 {
			reqRef = reqRef[:8]
		}
	}
	refs := ""
	if len(refBits) > 0 {
		refs = ", " + strings.Join(refBits, ", ")
	}
	description := fmt.Sprintf("Covers requirement %s: %s — verifies weakness class '%s' (%s%s) on %s.",
		reqRef, truncRunes(req.Description, 300), w.ID, w.Title, refs, suffixOf(ep))
	return map[string]any{
		"title":         truncRunes(title, 500),
		"description":   description,
		"preconditions": preconditions,
		"type":          ctype,
		// Priority comes from the class's base severity, not from the
		// requirement: a critical weakness on a low-priority requirement is
		// still critical.
		"priority":        w.Severity,
		"technique":       Technique,
		"steps":           []any{step},
		"requirement_ids": []string{req.ID},
		"weakness_id":     w.ID,
	}
}

// ---------------------------------------------------------------------------
// One code path per weakness class
// ---------------------------------------------------------------------------

func buildMissingAuthn(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	anon := map[string]any{}
	for k, v := range headers {
		if !strings.EqualFold(k, "authorization") {
			anon[k] = v
		}
	}
	step := generation.Step(ep, params, anon, body, []any{
		map[string]any{"type": "status_code", "expected": 401, "expected_any": []any{401, 403}},
		no5xx(), noLeak(),
	}, nil)
	return []map[string]any{mk(req, ep, w,
		"Security: unauthenticated request is refused — "+suffixOf(ep), "negative", step,
		"No credentials are presented; the endpoint declares a security scheme.")}
}

func buildBOLA(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	pname := str(pathParams(ep)[0]["name"])
	p2 := copyMap(params)
	p2[pname] = foreignObjectID
	step := generation.Step(ep, p2, headers, body, []any{
		map[string]any{"type": "status_code", "expected": 403, "expected_any": []any{401, 403, 404}},
		no5xx(),
	}, nil)
	return []map[string]any{mk(req, ep, w,
		fmt.Sprintf("Security: object-level authorisation on '%s' — %s", pname, suffixOf(ep)),
		"negative", step,
		fmt.Sprintf("Authenticated as actor A; %s identifies an object owned by actor B.",
			foreignObjectID))}
}

func buildFunctionLevelAuthz(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	lower := copyMap(headers)
	lower["Authorization"] = lowPrivilegeToken
	step := generation.Step(ep, params, lower, body, []any{
		map[string]any{"type": "status_code", "expected": 403, "expected_any": []any{401, 403}},
		no5xx(),
	}, nil)
	return []map[string]any{mk(req, ep, w,
		"Security: function-level authorisation for a lower-privileged role — "+suffixOf(ep),
		"negative", step,
		fmt.Sprintf("%s authenticates a role without the capability this operation requires.",
			lowPrivilegeToken))}
}

func buildMassAssignment(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	field := privilegedFields(ep)[0]
	value := privilegedValue(field.Schema)
	p2, b2 := generation.ApplyInput(field, value, params, body)
	assertions := []any{
		map[string]any{"type": "status_code", "expected": 200,
			"expected_any": []any{200, 201, 202, 204, 400, 403, 422}},
		no5xx(),
	}
	// Only assert on the echoed property when the response schema declares it —
	// a json_field target outside the schema is a grounding violation.
	if resp := responseSchema(ep); resp != nil {
		if props := asMap(resp["properties"]); props != nil {
			if _, documented := props[field.Name]; documented {
				assertions = append([]any{assertions[0],
					map[string]any{"type": "json_field", "path": field.Name,
						"op": "ne", "expected": value}}, assertions[1:]...)
			}
		}
	}
	step := generation.Step(ep, p2, headers, b2, assertions, nil)
	return []map[string]any{mk(req, ep, w,
		fmt.Sprintf("Security: mass assignment of privileged field '%s' — %s",
			field.Name, suffixOf(ep)),
		"negative", step,
		"The client sets a property the server owns; the value must not take effect.")}
}

func buildInjectionSurface(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	target := stringTargets(ep)[0]
	payload := fit(injectionProbe, target.Schema)
	p2, b2 := generation.ApplyInput(target, payload, params, body)
	step := generation.Step(ep, p2, headers, b2, []any{
		no5xx(), noLeak(),
		map[string]any{"type": "status_code", "expected": 400,
			"expected_any": []any{200, 201, 202, 204, 400, 404, 409, 422}},
	}, nil)
	return []map[string]any{mk(req, ep, w,
		fmt.Sprintf("Security: injection metacharacters in '%s' are handled as data — %s",
			target.Name, suffixOf(ep)),
		"negative", step,
		"The field receives metacharacters only; no exploit is executed.")}
}

func buildInputValidation(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	inp := violableInputs(ep)[0]
	p2, b2 := generation.ApplyInput(inp.in, inp.value, params, body)
	step := generation.Step(ep, p2, headers, b2, []any{
		generation.ErrorAssertion(ep), no5xx(),
	}, nil)
	return []map[string]any{mk(req, ep, w,
		fmt.Sprintf("Security: constraint violation on '%s' (%s) is refused without a 5xx — %s",
			inp.in.Name, inp.constraint, suffixOf(ep)),
		"negative", step,
		"The request violates one declared constraint and nothing else.")}
}

func buildErrorLeakage(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	// Prefer a body the server must fail to parse; fall back to a hostile value
	// in the first declared input; otherwise observe the normal response.
	var step map[string]any
	precondition := ""
	switch {
	case body != nil:
		step = generation.Step(ep, params, headers, nil,
			[]any{no5xx(), noLeak()}, "{{malformed}}")
		precondition = "The request body is deliberately unparseable."
	default:
		var target *generation.Input
		var value any = "%00"
		if targets := stringTargets(ep); len(targets) > 0 {
			target = &targets[0]
		} else if violable := violableInputs(ep); len(violable) > 0 {
			target = &violable[0].in
			value = violable[0].value
		}
		if target == nil {
			step = generation.Step(ep, params, headers, body, []any{no5xx(), noLeak()}, nil)
			precondition = "A valid request; the response itself must not describe the stack."
			break
		}
		p2, b2 := generation.ApplyInput(*target, value, params, body)
		step = generation.Step(ep, p2, headers, b2, []any{no5xx(), noLeak()}, nil)
		precondition = fmt.Sprintf("'%s' carries a value the endpoint must reject.", target.Name)
	}
	return []map[string]any{mk(req, ep, w,
		"Security: error response leaks no stack trace or framework detail — "+suffixOf(ep),
		"negative", step, precondition)}
}

func buildSecurityHeaders(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	step := generation.Step(ep, params, headers, body, []any{
		map[string]any{"type": "header_present", "name": "Strict-Transport-Security"},
		map[string]any{"type": "header", "name": "X-Content-Type-Options",
			"op": "eq", "expected": "nosniff"},
		map[string]any{"type": "header_absent", "name": "X-Powered-By"},
		map[string]any{"type": "header_absent", "name": "X-AspNet-Version"},
		no5xx(),
	}, nil)
	return []map[string]any{mk(req, ep, w,
		"Security: response carries the security headers and no version banner — "+suffixOf(ep),
		"positive", step,
		"A valid request over TLS; only the response headers are under test.")}
}

func buildTokenHandling(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	probes := []struct{ label, token, title string }{
		{"expired", expiredToken, "an expired bearer token is rejected"},
		{"unsigned", unsignedToken, "a token with a stripped signature is rejected"},
	}
	out := make([]map[string]any, 0, len(probes))
	for _, p := range probes {
		h2 := copyMap(headers)
		h2["Authorization"] = p.token
		step := generation.Step(ep, params, h2, body, []any{
			map[string]any{"type": "status_code", "expected": 401, "expected_any": []any{401, 403}},
			no5xx(), noLeak(),
		}, nil)
		out = append(out, mk(req, ep, w,
			fmt.Sprintf("Security: %s — %s", p.title, suffixOf(ep)), "negative", step,
			fmt.Sprintf("%s is a well-formed but %s credential.", p.token, p.label)))
	}
	return out
}

func buildRateLimiting(req *models.Requirement, ep *models.Endpoint, w *Weakness,
	params, headers map[string]any, body any) []map[string]any {
	step := generation.Step(ep, params, headers, body, []any{
		map[string]any{"type": "rate_limited_within", "requests": rateLimitRequests,
			"expected_status": 429},
		no5xx(),
	}, nil)
	return []map[string]any{mk(req, ep, w,
		"Security: repeated requests are rate limited — "+suffixOf(ep), "negative", step,
		fmt.Sprintf("Bounded probe: at most %d requests, then back off. "+
			"ACTIVE class — never executed without explicit authorisation (S1).",
			rateLimitRequests))}
}
