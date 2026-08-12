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

// Input is one place a case can put a value: a declared parameter or a
// top-level body property. It is the exported face of the generator's internal
// inputSpec, so sibling engines (insight, security) target exactly the inputs
// the generator itself recognises instead of re-deriving them.
type Input struct {
	Name     string
	Where    string // param | body
	Location string // query | path | header | body
	Schema   map[string]any
	Required bool
}

func exportInputs(specs []inputSpec) []Input {
	out := make([]Input, 0, len(specs))
	for _, s := range specs {
		out = append(out, Input{Name: s.name, Where: s.where, Location: s.location,
			Schema: s.schema, Required: s.required})
	}
	return out
}

// ConstrainedInputs lists the endpoint's inputs that carry an explicit
// constraint — parameters in declaration order, then body properties.
func ConstrainedInputs(ep *models.Endpoint) []Input { return exportInputs(constrainedInputs(ep)) }

// FreeTextBodyFields lists the top-level free-text string properties of the
// request body (no enum, no pattern, no format).
func FreeTextBodyFields(ep *models.Endpoint) []Input { return exportInputs(freeTextBodyFields(ep)) }

// ParamSchema is the JSON-schema fragment a declared parameter describes.
func ParamSchema(p map[string]any) map[string]any { return paramSchema(p) }

// IsFreeText reports whether a schema fragment is an unconstrained string.
func IsFreeText(schema map[string]any) bool { return isFreeText(schema) }

// InvalidFor derives one value that violates the schema's declared constraint,
// with the name of the constraint it violates ("" when none can be derived).
func InvalidFor(schema map[string]any) (any, string) { return invalidFor(schema) }

// ApplyInput writes a value into the params map or the body, returning copies.
func ApplyInput(in Input, value any, params map[string]any, body any) (map[string]any, any) {
	return applyInput(inputSpec{name: in.Name, where: in.Where, location: in.Location,
		schema: in.Schema, required: in.Required}, value, params, body)
}

// Step builds the single-step payload every generated case carries. rawBody is
// sent verbatim when non-nil; otherwise body is serialised as JSON.
func Step(ep *models.Endpoint, params, headers map[string]any, body any,
	assertions []any, rawBody any) map[string]any {
	return mkStep(ep, params, headers, body, assertions, rawBody)
}
