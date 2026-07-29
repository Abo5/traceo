// grounding.go — GROUNDING VALIDATOR, the hard gate (FR-GEN-06, BR-09).
// "The model proposes, the system verifies": a single fabricated endpoint,
// parameter, body field or assertion target means the case is DISCARDED —
// never repaired, never persisted, never shown (BO-07).
package generation

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"traceo/internal/models"
)

var safeHeaders = map[string]bool{"authorization": true, "content-type": true, "accept": true}

func firstJSONPathSegment(path string) string {
	p := strings.TrimLeft(path, "$")
	p = strings.TrimLeft(p, ".")
	if i := strings.IndexAny(p, ".["); i >= 0 {
		return p[:i]
	}
	return p
}

func validateBodyFields(body, schema map[string]any, ctx string, violations *[]string) {
	props := asMap(schema["properties"])
	keys := make([]string, 0, len(body))
	for k := range body {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, key := range keys {
		val := body[key]
		if _, in := props[key]; !in {
			*violations = append(*violations,
				fmt.Sprintf("%s: body field '%s' does not exist in the request schema", ctx, key))
			continue
		}
		sub := asMap(props[key])
		vm := asMap(val)
		if vm == nil || sub == nil {
			continue
		}
		if tv, ok := sub["type"]; ok {
			if s, isStr := tv.(string); !isStr || s != "object" {
				continue
			}
		}
		if asMap(sub["properties"]) == nil {
			continue
		}
		validateBodyFields(vm, sub, ctx+"."+key, violations)
	}
}

// isIntLike mirrors Python's "int and not bool" check: JSON integers decode to
// float64 in Go (int in Python), so integral floats are accepted; bools and
// fractional numbers are not.
func isIntLike(v any) bool {
	switch t := v.(type) {
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	case float64:
		return t == math.Trunc(t) && !math.IsInf(t, 0)
	}
	return false
}

// GroundingValidate validates a candidate case against the endpoint inventory
// (keys are "METHOD path"). It returns a list of violation strings — empty means
// grounded. Any violation means the case is discarded: never repaired, never
// persisted, never shown (BO-07).
func GroundingValidate(caseData map[string]any, endpointsByKey map[string]*models.Endpoint) []string {
	violations := []string{}
	if !truthy(caseData["requirement_ids"]) {
		violations = append(violations, "case is not linked to any requirement")
	}
	steps := asList(caseData["steps"])
	if len(steps) == 0 {
		violations = append(violations, "case has no steps")
	}
	for si, sv := range steps {
		step := asMap(sv)
		if step == nil {
			step = map[string]any{}
		}
		method := strings.ToUpper(getStrDefault(step, "method", ""))
		pathVal, hasPath := step["path"]
		path, pathIsStr := "", false
		if !hasPath {
			path, pathIsStr = "", true
		} else if s, ok := pathVal.(string); ok {
			path, pathIsStr = s, true
		}
		var ep *models.Endpoint
		if pathIsStr {
			ep = endpointsByKey[method+" "+path]
		}
		if ep == nil {
			pathText := path
			if !pathIsStr {
				pathText = pyStr(pathVal)
			}
			violations = append(violations,
				fmt.Sprintf("step %d: endpoint %s %s does not exist in the inventory", si, method, pathText))
			continue
		}
		var paramsDef []map[string]any
		for _, pv := range asList(ep.Parameters) {
			if m := asMap(pv); m != nil {
				paramsDef = append(paramsDef, m)
			}
		}
		paramNames := map[string]bool{}
		headerParamNames := map[string]bool{}
		for _, p := range paramsDef {
			paramNames[pyStr(p["name"])] = true
			if loc, _ := p["location"].(string); loc == "header" {
				headerParamNames[strings.ToLower(getStrDefault(p, "name", ""))] = true
			}
		}
		request := asMap(step["request"])

		reqParams := asMap(request["params"])
		pnames := make([]string, 0, len(reqParams))
		for k := range reqParams {
			pnames = append(pnames, k)
		}
		sort.Strings(pnames)
		for _, pname := range pnames {
			if !paramNames[pname] {
				violations = append(violations,
					fmt.Sprintf("step %d: parameter '%s' is not defined on %s %s", si, pname, method, path))
			}
		}

		reqHeaders := asMap(request["headers"])
		hnames := make([]string, 0, len(reqHeaders))
		for k := range reqHeaders {
			hnames = append(hnames, k)
		}
		sort.Strings(hnames)
		for _, hname := range hnames {
			hl := strings.ToLower(hname)
			if !safeHeaders[hl] && !strings.HasPrefix(hl, "x-") && !headerParamNames[hl] {
				violations = append(violations,
					fmt.Sprintf("step %d: header '%s' is neither allowlisted nor a defined header parameter", si, hname))
			}
		}

		if body := asMap(request["body"]); body != nil {
			if rs := bodyObjectSchema(ep); rs != nil {
				validateBodyFields(body, rs, fmt.Sprintf("step %d", si), &violations)
			}
		}

		// first 2xx response schema with properties — target space for json_field assertions
		rss := asMap(ep.ResponseSchemas)
		var respSchema map[string]any
		for _, k := range sortedKeys(rss) {
			if !allDigits(k) {
				continue
			}
			if n, err := strconv.Atoi(k); err != nil || n < 200 || n >= 300 {
				continue
			}
			if cand := asMap(rss[k]); cand != nil && asMap(cand["properties"]) != nil {
				respSchema = cand
				break
			}
		}

		for _, av := range asList(step["assertions"]) {
			a := asMap(av)
			if a == nil {
				violations = append(violations, fmt.Sprintf("step %d: assertion is not an object", si))
				continue
			}
			atype, _ := a["type"].(string)
			if atype == "status_code" {
				if !isIntLike(a["expected"]) {
					violations = append(violations,
						fmt.Sprintf("step %d: status_code assertion 'expected' must be an integer", si))
				}
				if anyOf, ok := a["expected_any"]; ok && anyOf != nil {
					lst := asList(anyOf)
					valid := lst != nil
					for _, x := range lst {
						if !isIntLike(x) {
							valid = false
							break
						}
					}
					if !valid {
						violations = append(violations,
							fmt.Sprintf("step %d: status_code 'expected_any' must be a list of integers", si))
					}
				}
			} else if atype == "json_field" && respSchema != nil {
				seg := firstJSONPathSegment(getStrDefault(a, "path", ""))
				if seg != "" {
					props := asMap(respSchema["properties"])
					if _, in := props[seg]; !in {
						violations = append(violations,
							fmt.Sprintf("step %d: json_field target '%s' is not a property of the response schema", si, seg))
					}
				}
			}
		}
	}
	return violations
}
