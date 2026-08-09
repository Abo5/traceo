// exported.go — the deterministic pieces of the generator that sibling engines
// reuse instead of reimplementing. The insight engine (internal/modules/insight)
// builds its edge cases on exactly these primitives so that both engines derive
// values from the SAME endpoint inventory in the SAME way; GroundingValidate
// (grounding.go) is likewise reused, never duplicated.
package generation

import "traceo/internal/models"

// ValidRequest returns the deterministic valid (params, headers, body) triple for
// an endpoint — every value derived from the endpoint's own schema.
func ValidRequest(ep *models.Endpoint) (map[string]any, map[string]any, any) {
	return validRequest(ep)
}

// BodyObjectSchema returns the endpoint's request schema when it is an object
// with properties, else nil.
func BodyObjectSchema(ep *models.Endpoint) map[string]any { return bodyObjectSchema(ep) }

// FirstStatus returns the lowest documented response status in [lo, hi].
func FirstStatus(ep *models.Endpoint, lo, hi int) (int, bool) { return firstStatus(ep, lo, hi) }

// PositiveAssertions is the happy-path assertion set (documented 2xx + schema +
// response time).
func PositiveAssertions(ep *models.Endpoint) []any { return positiveAssertions(ep) }

// ErrorAssertion is the documented 4xx assertion, or a 400/422 fallback.
func ErrorAssertion(ep *models.Endpoint) map[string]any { return errorAssertion(ep) }

// Prefilter is the deterministic lexical requirement -> endpoint shortlist (no
// LLM). The generator hands the shortlist to the mapper; the insight engine uses
// it directly, which is what keeps that engine 100% offline (NFR-D1).
func Prefilter(reqText string, endpoints []*models.Endpoint) []*models.Endpoint {
	return prefilter(reqText, endpoints)
}

// ValueFor exposes the schema-driven representative value generator.
func ValueFor(schema any) any { return valueFor(schema, 0) }
