// Package insight — the sixth engine: QA Insight Agent.
//
// CONTRACT (non-negotiable, mirrored 1:1 by the Python backend):
//   - 100% DETERMINISTIC. ZERO LLM calls anywhere in this package — it must run
//     fully offline (NFR-D1). The requirement -> endpoint association uses the
//     generator's lexical prefilter, not the mapper.
//   - Every artifact it produces passes the EXISTING grounding gate
//     (generation.GroundingValidate, BO-07): no fabricated identifiers. Paths,
//     methods, parameters and body fields come only from the project's
//     discovered endpoint inventory; a category with nothing to ground itself in
//     produces zero cases and never invents an endpoint or a field.
//   - Opt-in: the engine owns its two routes and changes nothing else.
package insight

// Categories — the 9 canonical category ids. These exact strings are shared,
// character for character, with the Python backend and the frontend; the slice
// order is the response order of GET /v1/projects/{id}/insights.
//
//	boundary_surprise   off-by-one / limit edges BEYOND plain BVA (min-1, max+1,
//	                    maxLength+1 — the just-outside values the ISTQB BVA
//	                    builder never emits)
//	exotic_input        non-ASCII payloads (CJK, accented Latin, emoji),
//	                    NFC-vs-NFD normalisation, zero-width characters
//	control_chars       null bytes and control characters in string fields
//	idempotency         duplicate / replayed submit of the same mutating request
//	state_corruption    out-of-order or illegal state transitions
//	permission_edge     the same request issued by a lower-privileged actor
//	timing_dst          timezone / DST / date-rollover values on date-time fields
//	resource_exhaustion oversized payload / extreme pagination values
//	downstream_failure  dependency failure and error-propagation shapes
var Categories = []string{
	"boundary_surprise",
	"exotic_input",
	"control_chars",
	"idempotency",
	"state_corruption",
	"permission_edge",
	"timing_dst",
	"resource_exhaustion",
	"downstream_failure",
}

var categorySet = func() map[string]bool {
	m := make(map[string]bool, len(Categories))
	for _, c := range Categories {
		m[c] = true
	}
	return m
}()

// IsCategory reports whether id is one of the 9 canonical ids.
func IsCategory(id string) bool { return categorySet[id] }

// Technique is the TestCase.technique value every insight-generated case carries
// (a new legal value alongside ep|bva|decision_table|negative|manual).
const Technique = "edge_case"
