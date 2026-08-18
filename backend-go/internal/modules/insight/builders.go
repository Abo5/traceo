// builders.go — the 9 deterministic edge-case builders.
//
// Every builder is a pure function of (requirement, endpoint, inventory). It
// derives values ONLY from the endpoint's own schema: it mutates an EXISTING
// field, replays an EXISTING request, or targets an EXISTING declared status.
// When a category has nothing to ground itself in — no free-text field, no
// date-time field, no pagination parameter, no documented 5xx — the builder
// returns zero cases. It never invents an endpoint, parameter or field, and the
// output still goes through generation.GroundingValidate before persistence.
package insight

import (
	"fmt"
	"sort"
	"strings"

	"traceo/internal/models"
	"traceo/internal/modules/generation"
)

// Deterministic payloads. Fixed constants, never randomised — two runs over the
// same inventory must produce byte-identical cases.
const (
	// Mixed-script text: CJK ideographs next to accented Latin \u2014 "\u65b0\u898f order caf\u00e9".
	mixedScriptPayload = "\u65b0\u898f order caf\u00e9 2026"
	// Emoji outside the BMP plus a regional-indicator flag pair.
	emojiPayload = "order \U0001F680 urgent \U0001F1EF\U0001F1F5"
	// The same text in NFC (composed U+00E9) and in NFD (e + combining U+0301): a
	// server that does not normalise round-trips different bytes than it received.
	nfcPayload = "caf\u00e9 \u5317\u4eac"
	nfdPayload = "cafe\u0301 \u5317\u4eac"
	// Zero-width space, zero-width joiner and a BOM inside the value.
	zeroWidthPayload = "ab\u200bc\u200dd\ufeff"
	// NUL byte, C0 control characters and DEL inside a string field.
	nullBytePayload   = "ab\u0000cd"
	controlCharsInput = "ab\u0001\u0002\u001fcd\u007f"
	dstGapDateTime    = "2026-03-08T02:30:00-05:00" // instant inside a DST spring-forward gap
	yearRolloverTime  = "2026-12-31T23:59:59Z"      // date rollover at midnight UTC
	leapDayDateTime   = "2024-02-29T23:59:59+14:00" // leap day at the maximum UTC offset
	leapDayDate       = "2024-02-29"                // leap day
	rolloverDate      = "2026-12-31"                // year rollover
	lowerPrivToken    = "Bearer {{lower_privilege_token}}"
)

const (
	longTextRunes    = 256   // "very long string" probe (exotic_input)
	oversizedRunes   = 10000 // oversized payload probe (resource_exhaustion)
	extremePageValue = 1000000
	maxPerCategory   = 4 // cap per (endpoint, category) — keeps volumes reviewable
)

// ---------------------------------------------------------------------------
// Case scaffolding
// ---------------------------------------------------------------------------

// mkStep builds one grounded step. method/path/endpoint_id all come from ep.
func mkStep(ep *models.Endpoint, order int, params, headers map[string]any,
	body any, assertions []any) map[string]any {
	request := map[string]any{"headers": headers, "params": params}
	if body != nil {
		request["body"] = body
	}
	return map[string]any{
		"order": order, "endpoint_id": ep.ID, "method": method(ep), "path": ep.Path,
		"request": request, "assertions": assertions, "extractions": []any{},
	}
}

// applyField writes value onto an EXISTING field, returning fresh copies.
func applyField(f field, value any, params map[string]any, body any) (map[string]any, any) {
	p2 := copyMap(params)
	b2 := deepCopy(body)
	if f.where == "param" {
		p2[f.name] = value
		return p2, b2
	}
	bm := asMap(b2)
	if bm == nil {
		bm = map[string]any{}
	}
	bm[f.name] = value
	return p2, bm
}

// statusIn asserts a status code, allowing a documented set — the shared shape
// for "must be handled, never a 5xx".
func statusIn(expected int, allowed ...int) map[string]any {
	any_ := make([]any, 0, len(allowed))
	for _, a := range allowed {
		any_ = append(any_, a)
	}
	return map[string]any{"type": "status_code", "expected": expected, "expected_any": any_}
}

// handledAssertions — accepted or cleanly rejected, but never a server error.
func handledAssertions(ep *models.Endpoint) []any {
	ok, has := generation.FirstStatus(ep, 200, 299)
	if !has {
		ok = 200
	}
	allowed := []int{ok, 400, 422}
	if ok != 200 {
		allowed = append([]int{ok, 200}, 400, 422)
	}
	return []any{statusIn(ok, allowed...), map[string]any{"type": "response_time_ms", "max": 5000}}
}

// rejectedAssertions — the input is out of contract, so a 4xx is the only
// acceptable answer (documented 4xx when the spec declares one).
func rejectedAssertions(ep *models.Endpoint) []any {
	return []any{generation.ErrorAssertion(ep)}
}

type caseBuilder struct {
	req      *models.Requirement
	ep       *models.Endpoint
	suffix   string
	desc     string
	priority string
	precond  string
}

func newCaseBuilder(req *models.Requirement, ep *models.Endpoint) caseBuilder {
	ref := req.ExternalID
	if ref == "" && len(req.ID) >= 8 {
		ref = req.ID[:8]
	}
	precond := ""
	if len(ep.Security) > 0 {
		precond = "Authenticated session"
	}
	priority := req.Priority
	if priority == "" {
		priority = "medium"
	}
	return caseBuilder{
		req: req, ep: ep,
		suffix:   method(ep) + " " + ep.Path,
		desc:     "Covers requirement " + ref + ": " + truncRunes(req.Description, 400),
		priority: priority, precond: precond,
	}
}

func (b caseBuilder) mk(category, title, ctype, extraPrecond string, steps ...map[string]any) map[string]any {
	precond := b.precond
	if extraPrecond != "" {
		if precond != "" {
			precond += ". "
		}
		precond += extraPrecond
	}
	list := make([]any, 0, len(steps))
	for i, s := range steps {
		s["order"] = i
		list = append(list, s)
	}
	return map[string]any{
		"title": truncRunes(title, 500), "description": b.desc, "preconditions": precond,
		"type": ctype, "priority": b.priority, "technique": Technique,
		"edge_category": category, "steps": list,
		"requirement_ids": []string{b.req.ID},
	}
}

// ---------------------------------------------------------------------------
// build — dispatch
// ---------------------------------------------------------------------------

// build produces the candidate cases of ONE category for ONE (requirement,
// endpoint) pair. inventory is the project's full included endpoint list; only
// state_corruption needs it (it pairs endpoints that share a path).
func build(category string, req *models.Requirement, ep *models.Endpoint,
	inventory []*models.Endpoint) []map[string]any {
	b := newCaseBuilder(req, ep)
	params, headers, body := generation.ValidRequest(ep)
	switch category {
	case "boundary_surprise":
		return buildBoundarySurprise(b, params, headers, body)
	case "exotic_input":
		return buildExoticInput(b, params, headers, body)
	case "control_chars":
		return buildControlChars(b, params, headers, body)
	case "idempotency":
		return buildIdempotency(b, params, headers, body)
	case "state_corruption":
		return buildStateCorruption(b, inventory)
	case "permission_edge":
		return buildPermissionEdge(b, params, headers, body)
	case "timing_dst":
		return buildTimingDST(b, params, headers, body)
	case "resource_exhaustion":
		return buildResourceExhaustion(b, params, headers, body)
	case "downstream_failure":
		return buildDownstreamFailure(b, params, headers, body)
	}
	return nil
}

// ---------------------------------------------------------------------------
// 1. boundary_surprise — the values just OUTSIDE the declared limits.
//
// Plain BVA (generation/techniques.go) only emits min, min+1, max-1, max, and
// the EP builder emits a single invalid class per input (the first constraint
// it finds). The just-outside partners — minimum-1, maximum+1, maxLength+1,
// minLength-1 — are what this builder adds.
// ---------------------------------------------------------------------------

func buildBoundarySurprise(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	var out []map[string]any
	for _, f := range allFields(b.ep) {
		if f.location == "path" {
			continue // a path value cannot be omitted or bent without changing the route
		}
		sch := f.schema
		t := schemaType(sch)
		type probe struct {
			label string
			value any
		}
		var probes []probe
		if t == "integer" || t == "number" {
			if mn, ok := asFloat(sch["minimum"]); ok {
				probes = append(probes, probe{"minimum-1", numLike(t, mn-1)})
			}
			if mx, ok := asFloat(sch["maximum"]); ok {
				probes = append(probes, probe{"maximum+1", numLike(t, mx+1)})
			}
		} else if t == "string" || t == "" {
			if str(sch["pattern"]) != "" {
				continue // a pattern already pins the shape; length edges are meaningless
			}
			if mx, ok := asInt(sch["maxLength"]); ok && mx >= 0 {
				probes = append(probes, probe{"maxLength+1", strings.Repeat("x", mx+1)})
			}
			if mn, ok := asInt(sch["minLength"]); ok && mn > 0 {
				probes = append(probes, probe{"minLength-1", strings.Repeat("x", mn-1)})
			}
		}
		for _, p := range probes {
			p2, b2 := applyField(f, p.value, params, body)
			out = append(out, b.mk("boundary_surprise",
				fmt.Sprintf("Edge: %s just outside %s — %s", f.name, p.label, b.suffix),
				"boundary", "",
				mkStep(b.ep, 0, p2, headers, b2, rejectedAssertions(b.ep))))
		}
	}
	return out
}

func numLike(t string, v float64) any {
	if t == "integer" {
		return int(v)
	}
	return v
}

// ---------------------------------------------------------------------------
// 2. exotic_input — mixed-script text, emoji, NFC-vs-NFD, zero-width characters,
// all written into an EXISTING free-text string field.
// ---------------------------------------------------------------------------

func buildExoticInput(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	fields := stringProbeFields(b.ep)
	if len(fields) == 0 {
		return nil // nothing to mutate — the category simply produces nothing
	}
	f := fields[0]

	type probe struct {
		label string
		value string
	}
	// Exactly the four character-set probes contract item D names for this
	// category. "Very long strings" are NOT here: D assigns the oversized-value
	// probe to resource_exhaustion, and emitting it twice would double-count the
	// same weakness under two categories.
	probes := []probe{
		{"mixed-script text (CJK and accented Latin)", mixedScriptPayload},
		{"emoji (astral plane)", emojiPayload},
		{"NFD-decomposed text", nfdPayload},
		{"zero-width characters", zeroWidthPayload},
	}
	respProps := responseProperties(b.ep)
	var out []map[string]any
	for _, p := range probes {
		if !fitsSchema(f.schema, p.value) {
			continue // the field's own length bounds win — no invented headroom
		}
		p2, b2 := applyField(f, p.value, params, body)
		assertions := handledAssertions(b.ep)
		// NFC/NFD: when the field echoes back in the documented 2xx response the
		// contract is round-trip stability — the API must normalise to NFC.
		if p.label == "NFD-decomposed text" && respProps != nil {
			if _, in := respProps[f.name]; in {
				assertions = append(assertions, map[string]any{"type": "json_field",
					"path": f.name, "op": "eq", "expected": nfcPayload})
			}
		}
		out = append(out, b.mk("exotic_input",
			fmt.Sprintf("Exotic input: %s in %s — %s", p.label, f.name, b.suffix),
			"boundary", "", mkStep(b.ep, 0, p2, headers, b2, assertions)))
	}
	return out
}

// ---------------------------------------------------------------------------
// 3. control_chars — NUL bytes and C0/DEL control characters in a string field.
// ---------------------------------------------------------------------------

func buildControlChars(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	fields := stringProbeFields(b.ep)
	if len(fields) == 0 {
		return nil
	}
	f := fields[0]
	var out []map[string]any
	for _, p := range []struct {
		label string
		value string
	}{
		{"embedded null byte", nullBytePayload},
		{"C0 control characters", controlCharsInput},
	} {
		if !fitsSchema(f.schema, p.value) {
			continue
		}
		p2, b2 := applyField(f, p.value, params, body)
		out = append(out, b.mk("control_chars",
			fmt.Sprintf("Control characters: %s in %s — %s", p.label, f.name, b.suffix),
			"negative", "", mkStep(b.ep, 0, p2, headers, b2, handledAssertions(b.ep))))
	}
	return out
}

// ---------------------------------------------------------------------------
// 4. idempotency — the SAME mutating request submitted twice.
// ---------------------------------------------------------------------------

func buildIdempotency(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	if !isMutating(b.ep) {
		return nil
	}
	ok, has := generation.FirstStatus(b.ep, 200, 299)
	if !has {
		ok = 200
	}
	first := mkStep(b.ep, 0, params, headers, body, generation.PositiveAssertions(b.ep))
	// The replay must be handled: accepted idempotently, or refused as a
	// conflict — never a server error, and never a second side effect.
	second := mkStep(b.ep, 1, copyMap(params), copyMap(headers), deepCopy(body),
		[]any{statusIn(ok, ok, 200, 409, 422),
			map[string]any{"type": "response_time_ms", "max": 5000}})
	return []map[string]any{b.mk("idempotency",
		"Idempotency: identical request submitted twice — "+b.suffix,
		"negative",
		"Verify no duplicate side effect is created by the replayed request",
		first, second)}
}

// ---------------------------------------------------------------------------
// 5. state_corruption — an illegal transition composed from EXISTING endpoints
// that share a path: act on the resource AFTER it was deleted.
// ---------------------------------------------------------------------------

// Built only from the MUTATING side of the pair, so the mirrored case is never
// emitted twice, and exactly one case per qualifying endpoint — same rule as the
// Python engine, so both backends report the same suggestable_count.
func buildStateCorruption(b caseBuilder, inventory []*models.Endpoint) []map[string]any {
	m := method(b.ep)
	family := pathFamily(b.ep.Path)
	if family == "" || (m != "DELETE" && m != "PUT" && m != "PATCH") {
		return nil
	}
	var siblings []*models.Endpoint
	for _, other := range inventory {
		if other.ID != b.ep.ID && pathFamily(other.Path) == family {
			siblings = append(siblings, other)
		}
	}
	if len(siblings) == 0 {
		return nil
	}

	// Deterministic partner choice: the same path wins over a family sibling,
	// then the caller's method preference, then alphabetical.
	pick := func(methods []string) *models.Endpoint {
		rank := map[string]int{}
		for i, mm := range methods {
			rank[mm] = i
		}
		var ranked []*models.Endpoint
		for _, e := range siblings {
			if _, ok := rank[method(e)]; ok {
				ranked = append(ranked, e)
			}
		}
		if len(ranked) == 0 {
			return nil
		}
		sort.SliceStable(ranked, func(i, j int) bool {
			a, c := ranked[i], ranked[j]
			if (a.Path == b.ep.Path) != (c.Path == b.ep.Path) {
				return a.Path == b.ep.Path
			}
			if rank[method(a)] != rank[method(c)] {
				return rank[method(a)] < rank[method(c)]
			}
			if a.Path != c.Path {
				return a.Path < c.Path
			}
			return method(a) < method(c)
		})
		return ranked[0]
	}

	var partner, firstEp, secondEp *models.Endpoint
	var firstAssert, secondAssert []any
	var title, precond string
	if m == "DELETE" {
		if partner = pick([]string{"GET", "PUT", "PATCH"}); partner == nil {
			return nil
		}
		firstEp, secondEp = b.ep, partner
		gone, ok := generation.FirstStatus(partner, 400, 499)
		if !ok {
			gone = 404
		}
		firstAssert = generation.PositiveAssertions(b.ep)
		secondAssert = []any{statusIn(gone, gone, 404, 409, 410, 422)}
		title = fmt.Sprintf("State corruption: %s %s after DELETE %s",
			method(partner), partner.Path, b.ep.Path)
		precond = "The resource is deleted by the first step"
	} else {
		if partner = pick([]string{"POST"}); partner == nil {
			return nil
		}
		firstEp, secondEp = b.ep, partner
		missing, ok := generation.FirstStatus(b.ep, 400, 499)
		if !ok {
			missing = 404
		}
		firstAssert = []any{statusIn(missing, missing, 400, 404, 409, 422)}
		secondAssert = generation.PositiveAssertions(partner)
		title = fmt.Sprintf("State corruption: %s %s before POST %s",
			m, b.ep.Path, partner.Path)
		precond = "The resource has not been created yet when the first step runs"
	}

	p1, h1, b1 := generation.ValidRequest(firstEp)
	p2, h2, b2 := generation.ValidRequest(secondEp)
	return []map[string]any{b.mk("state_corruption", title, "negative", precond,
		mkStep(firstEp, 0, p1, h1, b1, firstAssert),
		mkStep(secondEp, 1, p2, h2, b2, secondAssert))}
}

// ---------------------------------------------------------------------------
// 6. permission_edge — the exact same request as a lower-privileged actor.
// ---------------------------------------------------------------------------

func buildPermissionEdge(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	if len(b.ep.Security) == 0 {
		return nil // the endpoint declares no auth: there is no privilege to lower
	}
	h2 := copyMap(headers)
	h2["Authorization"] = lowerPrivToken
	return []map[string]any{b.mk("permission_edge",
		"Permission edge: same request as a lower-privileged actor — "+b.suffix,
		"negative",
		"A lower-privileged actor (viewer) is authenticated instead of the owning role",
		mkStep(b.ep, 0, copyMap(params), h2, deepCopy(body),
			[]any{statusIn(403, 401, 403, 404)}))}
}

// ---------------------------------------------------------------------------
// 7. timing_dst — DST gaps, rollovers and leap days on date/date-time fields.
// Fires ONLY when the inventory declares such a field.
// ---------------------------------------------------------------------------

func buildTimingDST(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	fields := dateFields(b.ep)
	if len(fields) == 0 {
		return nil
	}
	f := fields[0]
	dateOnly := str(f.schema["format"]) == "date" || schemaType(f.schema) == "date"
	probes := []struct {
		label string
		value string
	}{
		{"DST spring-forward gap instant", dstGapDateTime},
		{"year rollover at midnight UTC", yearRolloverTime},
		{"leap day at maximum UTC offset", leapDayDateTime},
	}
	if dateOnly {
		probes = []struct {
			label string
			value string
		}{
			{"leap day", leapDayDate},
			{"year rollover", rolloverDate},
		}
	}
	var out []map[string]any
	for _, p := range probes {
		p2, b2 := applyField(f, p.value, params, body)
		out = append(out, b.mk("timing_dst",
			fmt.Sprintf("Timing: %s in %s — %s", p.label, f.name, b.suffix),
			"boundary", "", mkStep(b.ep, 0, p2, headers, b2, handledAssertions(b.ep))))
	}
	return out
}

// ---------------------------------------------------------------------------
// 8. resource_exhaustion — extreme pagination values on an EXISTING pagination
// parameter, or an oversized value in an EXISTING string field.
// ---------------------------------------------------------------------------

func buildResourceExhaustion(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	var out []map[string]any
	for _, f := range paginationFields(b.ep) {
		for _, p := range []struct {
			label string
			value any
		}{
			{"extreme value", extremePageValue},
			{"negative value", -1},
		} {
			p2, b2 := applyField(f, p.value, params, body)
			out = append(out, b.mk("resource_exhaustion",
				fmt.Sprintf("Resource exhaustion: %s for %s — %s", p.label, f.name, b.suffix),
				"boundary", "",
				mkStep(b.ep, 0, p2, headers, b2,
					[]any{statusIn(400, 200, 400, 413, 422),
						map[string]any{"type": "response_time_ms", "max": 5000}})))
		}
	}
	// ...AND an oversized value for an existing string field. Contract item D
	// lists both probes for this category, so an endpoint that paginates does not
	// lose its oversized-payload case: the two describe different weaknesses
	// (an unclamped query vs an unbounded write).
	bounded := boundedStringFields(b.ep)
	if len(bounded) == 0 {
		return out
	}
	f := bounded[0]
	size := oversizedRunes
	if mx, ok := asInt(f.schema["maxLength"]); ok {
		size = mx + oversizedRunes
	}
	p2, b2 := applyField(f, strings.Repeat("x", size), params, body)
	return append(out, b.mk("resource_exhaustion",
		fmt.Sprintf("Resource exhaustion: oversized payload in %s — %s", f.name, b.suffix),
		"negative", "",
		mkStep(b.ep, 0, p2, headers, b2,
			[]any{statusIn(413, 400, 413, 422),
				map[string]any{"type": "response_time_ms", "max": 5000}})))
}

// ---------------------------------------------------------------------------
// 9. downstream_failure — only when the endpoint DOCUMENTS a 5xx: the declared
// error shape is what the test asserts when the dependency is faulted.
// ---------------------------------------------------------------------------

func buildDownstreamFailure(b caseBuilder, params, headers map[string]any, body any) []map[string]any {
	codes := declaredStatuses(b.ep, 500, 599)
	if len(codes) == 0 {
		return nil // nothing documented to propagate — invent nothing
	}
	// One case, from the FIRST documented 5xx: the probe is "does the declared
	// failure shape reach the caller", which one code answers for the endpoint.
	code := codes[0]
	return []map[string]any{b.mk("downstream_failure",
		fmt.Sprintf("Downstream failure: documented %d propagation — %s", code, b.suffix),
		"negative",
		"The downstream dependency of "+b.suffix+" is faulted in the test environment",
		mkStep(b.ep, 0, copyMap(params), copyMap(headers), deepCopy(body),
			[]any{statusIn(code, code, 502, 503, 504),
				map[string]any{"type": "response_time_ms", "max": 5000}}))}
}
