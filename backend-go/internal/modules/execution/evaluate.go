// Package execution — evaluation primitives: {{var}} interpolation, JSON path
// resolution, Python-compatible loose equality, the assertion evaluator and a
// dependency-free "json_schema-lite" validator (GO_CONTRACT.md).
//
// Behavioural reference: backend/app/modules/execution.py.
package execution

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"traceo/internal/config"
)

var (
	varRe       = regexp.MustCompile(`\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.\[\]-]*)\s*\}\}`)
	varFullRe   = regexp.MustCompile(`^\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.\[\]-]*)\s*\}\}$`)
	pathTokenRe = regexp.MustCompile(`([^.\[\]]+)|\[(-?\d+)\]`)
)

// nonSecretCfgKeys — everything else in an auth config is treated as secret.
var nonSecretCfgKeys = map[string]bool{
	"header": true, "in": true, "location": true, "param": true, "name": true,
	"token_url": true, "username": true, "scope": true, "audience": true,
	"grant_type": true,
}

// ---------------------------------------------------------------------------
// Python-value helpers (JSON bodies decode with UseNumber, so integers survive)
// ---------------------------------------------------------------------------

// pyStr renders a value the way Python's str() would for the types that can
// appear in a decoded JSON document — placeholders substituted into URLs and
// bodies must not gain a spurious ".0".
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
	case json.Number:
		return t.String()
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	case float32:
		return pyStr(float64(t))
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	}
	if b, err := json.Marshal(v); err == nil {
		return string(b)
	}
	return fmt.Sprintf("%v", v)
}

// toNum ports Python's `float(v)` guarded by _num(): numerics, numeric strings
// and bools convert; everything else (incl. nil) fails.
func toNum(v any) (float64, bool) {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return f, err == nil
	}
	return 0, false
}

// numericValue reports whether v is a *numeric* python value (bool included, as
// Python's True == 1). Strings are excluded — "200" == 200 is False in Python.
func numericValue(v any) (float64, bool) {
	switch t := v.(type) {
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case int:
		return float64(t), true
	case int64:
		return float64(t), true
	case bool:
		if t {
			return 1, true
		}
		return 0, true
	}
	return 0, false
}

// pyEqualStrict ports Python's `==` for decoded-JSON values.
func pyEqualStrict(a, b any) bool {
	an, aok := numericValue(a)
	bn, bok := numericValue(b)
	if aok && bok {
		return an == bn
	}
	if aok != bok {
		return false
	}
	return reflect.DeepEqual(a, b)
}

// pyEq ports execution.py::_eq — exact, then numeric, then stringified.
func pyEq(actual, expected any) bool {
	if pyEqualStrict(actual, expected) {
		return true
	}
	a, aok := toNum(actual)
	b, bok := toNum(expected)
	if aok && bok {
		return a == b
	}
	return pyStr(actual) == pyStr(expected)
}

func toList(v any) ([]any, bool) {
	switch t := v.(type) {
	case []any:
		return t, true
	case []string:
		out := make([]any, len(t))
		for i, s := range t {
			out[i] = s
		}
		return out, true
	}
	return nil, false
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

func mapStr(m map[string]any, k string) string {
	if m == nil {
		return ""
	}
	s, _ := m[k].(string)
	return s
}

// ---------------------------------------------------------------------------
// JSON path resolution (dot/bracket, e.g. "a.b[0].c")
// ---------------------------------------------------------------------------

type pathError struct{ path string }

func (e *pathError) Error() string { return "path not found: " + e.path }

// resolvePath ports execution.py::_resolve_path. A conventional leading "json."
// prefix on extraction paths is tolerated.
func resolvePath(data any, path string) (any, error) {
	if data == nil {
		return nil, &pathError{path}
	}
	cur := data
	tokens := pathTokenRe.FindAllStringSubmatch(path, -1)
	if len(tokens) > 0 && tokens[0][1] == "json" {
		if m, ok := cur.(map[string]any); !ok {
			tokens = tokens[1:]
		} else if _, has := m["json"]; !has {
			tokens = tokens[1:]
		}
	}
	if len(tokens) == 0 {
		return nil, &pathError{path}
	}
	for _, tok := range tokens {
		name, idx := tok[1], tok[2]
		if name != "" {
			m, ok := cur.(map[string]any)
			if !ok {
				return nil, &pathError{path}
			}
			v, has := m[name]
			if !has {
				return nil, &pathError{path}
			}
			cur = v
			continue
		}
		i, err := strconv.Atoi(idx)
		if err != nil {
			return nil, &pathError{path}
		}
		lst, ok := cur.([]any)
		if !ok || i < -len(lst) || i >= len(lst) {
			return nil, &pathError{path}
		}
		if i < 0 {
			i += len(lst)
		}
		cur = lst[i]
	}
	return cur, nil
}

// ---------------------------------------------------------------------------
// Interpolation (FR-EXE-05)
// ---------------------------------------------------------------------------

// interpolate recursively substitutes {{name}} placeholders. A string that IS a
// single placeholder keeps the context value's native type.
func interpolate(value any, ctx map[string]any) any {
	switch t := value.(type) {
	case string:
		if m := varFullRe.FindStringSubmatch(strings.TrimSpace(t)); m != nil {
			if v, ok := ctx[m[1]]; ok {
				return v
			}
		}
		return varRe.ReplaceAllStringFunc(t, func(match string) string {
			g := varRe.FindStringSubmatch(match)
			if v, ok := ctx[g[1]]; ok {
				return pyStr(v)
			}
			return match
		})
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, v := range t {
			out[k] = interpolate(v, ctx)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, v := range t {
			out[i] = interpolate(v, ctx)
		}
		return out
	}
	return value
}

// ---------------------------------------------------------------------------
// Secrets + evidence truncation (NFR-SEC-03)
// ---------------------------------------------------------------------------

// collectSecrets returns every string value in the auth config except structural
// keys. Sorted longest-first so nested/overlapping secrets redact cleanly.
func collectSecrets(cfg map[string]any) []string {
	secrets := []string{}
	var walk func(obj any, key string)
	walk = func(obj any, key string) {
		switch t := obj.(type) {
		case string:
			if !nonSecretCfgKeys[key] && len(t) > 3 {
				secrets = append(secrets, t)
			}
		case map[string]any:
			keys := make([]string, 0, len(t))
			for k := range t {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				walk(t[k], k)
			}
		case []any:
			for _, v := range t {
				walk(v, key)
			}
		}
	}
	walk(cfg, "")
	sort.SliceStable(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	return secrets
}

// truncate caps evidence at EVIDENCE_MAX_BYTES characters (rune-wise, as Python).
func truncate(text string) string {
	limit := config.C.EvidenceMax
	if limit <= 0 || len(text) <= limit {
		return text
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…[truncated]"
}

// ---------------------------------------------------------------------------
// Assertion evaluator
// ---------------------------------------------------------------------------

// respView is the response surface the evaluator needs (kept minimal so the
// evaluator stays testable without a live transport).
type respView struct {
	StatusCode int
	Header     http.Header
}

// headerGet mirrors httpx.Headers.get — multiple values join with ", ";
// absence is distinguishable from an empty value.
func (r *respView) headerGet(name string) (string, bool) {
	if name == "" {
		return "", false
	}
	vals := r.Header.Values(name)
	if len(vals) == 0 {
		return "", false
	}
	return strings.Join(vals, ", "), true
}

// evalAssertion ports execution.py::_eval_assertion → (ok, actual, skipped).
// Unknown assertion types are skipped, never failed.
func evalAssertion(a map[string]any, resp *respView, respJSON any, elapsedMs int,
	endpointSchemas map[string]any) (bool, any, bool) {
	kind, _ := a["type"].(string)

	switch kind {
	case "status_code":
		actual := any(resp.StatusCode)
		if allowed, present := a["expected_any"]; present && allowed != nil {
			lst, ok := toList(allowed)
			if !ok {
				return false, actual, false
			}
			for _, e := range lst {
				if pyEqualStrict(resp.StatusCode, e) {
					return true, actual, false
				}
			}
			return false, actual, false
		}
		return pyEq(resp.StatusCode, a["expected"]), actual, false

	case "json_field":
		op := "eq"
		if s, ok := a["op"].(string); ok && s != "" {
			op = s
		}
		path, _ := a["path"].(string)
		actual, err := resolvePath(respJSON, path)
		found := err == nil
		if !found {
			actual = nil
		}
		if op == "exists" {
			if found {
				return true, actual, false
			}
			return false, "<missing>", false
		}
		if op == "absent" {
			if found {
				return false, actual, false
			}
			return true, "<missing>", false
		}
		if !found {
			return false, "<missing>", false
		}
		expected := a["expected"]
		allowed, allowedSet := a["expected_any"]
		switch op {
		case "eq":
			if allowedSet && allowed != nil {
				lst, ok := toList(allowed)
				if !ok {
					return false, actual, false
				}
				for _, e := range lst {
					if pyEq(actual, e) {
						return true, actual, false
					}
				}
				return false, actual, false
			}
			return pyEq(actual, expected), actual, false
		case "ne":
			return !pyEq(actual, expected), actual, false
		case "gt", "lt":
			av, aok := toNum(actual)
			ev, eok := toNum(expected)
			if !aok || !eok {
				return false, actual, false
			}
			if op == "gt" {
				return av > ev, actual, false
			}
			return av < ev, actual, false
		case "contains":
			if s, ok := actual.(string); ok {
				return strings.Contains(s, pyStr(expected)), actual, false
			}
			if lst, ok := actual.([]any); ok {
				for _, item := range lst {
					if pyEqualStrict(item, expected) {
						return true, actual, false
					}
				}
				return false, actual, false
			}
			if m, ok := actual.(map[string]any); ok {
				key, isStr := expected.(string)
				if !isStr {
					return false, actual, false
				}
				_, has := m[key]
				return has, actual, false
			}
			return false, actual, false // TypeError in Python
		case "regex":
			re, err := regexp.Compile(pyStr(expected))
			if err != nil {
				return false, actual, false
			}
			return re.MatchString(pyStr(actual)), actual, false
		}
		return false, actual, false

	case "response_time_ms":
		limit, present := a["max"]
		if !present || limit == nil {
			limit, present = a["expected"]
		}
		if !present || limit == nil {
			return true, elapsedMs, true
		}
		lv, ok := toNum(limit)
		if !ok {
			return false, elapsedMs, false
		}
		return float64(elapsedMs) <= lv, elapsedMs, false

	case "header":
		name, _ := a["name"].(string)
		actual, found := resp.headerGet(name)
		op := "eq"
		if s, ok := a["op"].(string); ok && s != "" {
			op = s
		}
		expected := a["expected"]
		allowed, allowedSet := a["expected_any"]
		if !found {
			return false, nil, false
		}
		if op == "contains" {
			return strings.Contains(actual, pyStr(expected)), actual, false
		}
		if allowedSet && allowed != nil {
			lst, ok := toList(allowed)
			if !ok {
				return false, actual, false
			}
			for _, e := range lst {
				if pyEq(actual, e) {
					return true, actual, false
				}
			}
			return false, actual, false
		}
		return pyEq(actual, expected), actual, false

	case "json_schema":
		if len(endpointSchemas) == 0 {
			return true, "skipped (no schema/validator)", true
		}
		schema := endpointSchemas[strconv.Itoa(resp.StatusCode)]
		if schema == nil {
			keys := make([]string, 0, len(endpointSchemas))
			for k := range endpointSchemas {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if strings.HasPrefix(k, "2") {
					schema = endpointSchemas[k]
					break
				}
			}
		}
		if schema == nil {
			schema = endpointSchemas["default"]
		}
		sm := asMap(schema)
		if sm == nil || len(sm) == 0 {
			return true, "skipped (no schema)", true
		}
		if respJSON == nil {
			return false, "response body is not JSON", false
		}
		ok, msg, usable := validateSchemaLite(respJSON, sm)
		if !usable {
			return true, "skipped (invalid schema)", true // malformed schema: never fail the case
		}
		if ok {
			return true, "valid", false
		}
		return false, msg, false
	}

	return true, nil, true // unknown assertion types are skipped
}

// ---------------------------------------------------------------------------
// json_schema-lite — dependency-free subset validator (GO_CONTRACT.md)
// ---------------------------------------------------------------------------

// validateSchemaLite returns (valid, message, usable). usable=false means the
// schema itself is malformed and the assertion must be skipped, matching the
// Python fallback that swallows non-ValidationError exceptions.
func validateSchemaLite(instance any, schema map[string]any) (bool, string, bool) {
	msg, usable := checkSchema(instance, schema, 0)
	if !usable {
		return false, "", false
	}
	if msg == "" {
		return true, "", true
	}
	return false, msg, true
}

func jsonRepr(v any) string {
	if s, ok := v.(string); ok {
		return "'" + s + "'"
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

// checkSchema returns (violationMessage, usable). An empty message means valid.
func checkSchema(instance any, schema map[string]any, depth int) (string, bool) {
	if depth > 24 {
		return "", false // pathological nesting / cycle: treat as unusable
	}
	if _, hasRef := schema["$ref"]; hasRef {
		return "", true // unresolved $ref: nothing to check
	}

	// type
	if t, present := schema["type"]; present {
		var types []string
		switch tv := t.(type) {
		case string:
			types = []string{tv}
		case []any:
			for _, x := range tv {
				if s, ok := x.(string); ok {
					types = append(types, s)
				}
			}
		}
		if len(types) == 0 {
			return "", false
		}
		matched := false
		for _, ty := range types {
			if matchesType(instance, ty) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Sprintf("%s is not of type %s", jsonRepr(instance),
				"'"+strings.Join(types, "', '")+"'"), true
		}
	}

	// enum
	if e, present := schema["enum"]; present {
		lst, ok := toList(e)
		if !ok {
			return "", false
		}
		found := false
		for _, cand := range lst {
			if pyEqualStrict(instance, cand) {
				found = true
				break
			}
		}
		if !found {
			parts := make([]string, len(lst))
			for i, cand := range lst {
				parts[i] = jsonRepr(cand)
			}
			return fmt.Sprintf("%s is not one of [%s]", jsonRepr(instance),
				strings.Join(parts, ", ")), true
		}
	}

	if obj, ok := instance.(map[string]any); ok {
		if req, present := schema["required"]; present {
			lst, ok := toList(req)
			if !ok {
				return "", false
			}
			for _, r := range lst {
				name, isStr := r.(string)
				if !isStr {
					return "", false
				}
				if _, has := obj[name]; !has {
					return fmt.Sprintf("'%s' is a required property", name), true
				}
			}
		}
		if props, present := schema["properties"]; present {
			pm := asMap(props)
			if pm == nil {
				return "", false
			}
			names := make([]string, 0, len(pm))
			for k := range pm {
				names = append(names, k)
			}
			sort.Strings(names)
			for _, name := range names {
				val, has := obj[name]
				if !has {
					continue
				}
				sub := asMap(pm[name])
				if sub == nil {
					continue
				}
				if msg, usable := checkSchema(val, sub, depth+1); !usable {
					return "", false
				} else if msg != "" {
					return msg, true
				}
			}
		}
	}

	if arr, ok := instance.([]any); ok {
		if items, present := schema["items"]; present {
			if sub := asMap(items); sub != nil {
				for _, item := range arr {
					if msg, usable := checkSchema(item, sub, depth+1); !usable {
						return "", false
					} else if msg != "" {
						return msg, true
					}
				}
			}
		}
		if mi, present := schema["minItems"]; present {
			if n, ok := toNum(mi); ok && float64(len(arr)) < n {
				return fmt.Sprintf("%s is too short", jsonRepr(instance)), true
			}
		}
		if ma, present := schema["maxItems"]; present {
			if n, ok := toNum(ma); ok && float64(len(arr)) > n {
				return fmt.Sprintf("%s is too long", jsonRepr(instance)), true
			}
		}
	}

	if s, ok := instance.(string); ok {
		if ml, present := schema["minLength"]; present {
			if n, ok := toNum(ml); ok && float64(len([]rune(s))) < n {
				return fmt.Sprintf("%s is too short", jsonRepr(instance)), true
			}
		}
		if ml, present := schema["maxLength"]; present {
			if n, ok := toNum(ml); ok && float64(len([]rune(s))) > n {
				return fmt.Sprintf("%s is too long", jsonRepr(instance)), true
			}
		}
	}

	if n, isNum := numericValue(instance); isNum {
		if _, isBool := instance.(bool); !isBool {
			if mv, present := schema["minimum"]; present {
				if lim, ok := toNum(mv); ok && n < lim {
					return fmt.Sprintf("%s is less than the minimum of %s",
						jsonRepr(instance), jsonRepr(mv)), true
				}
			}
			if mv, present := schema["maximum"]; present {
				if lim, ok := toNum(mv); ok && n > lim {
					return fmt.Sprintf("%s is greater than the maximum of %s",
						jsonRepr(instance), jsonRepr(mv)), true
				}
			}
		}
	}

	return "", true
}

func matchesType(instance any, ty string) bool {
	switch ty {
	case "object":
		_, ok := instance.(map[string]any)
		return ok
	case "array":
		_, ok := instance.([]any)
		return ok
	case "string":
		_, ok := instance.(string)
		return ok
	case "boolean":
		_, ok := instance.(bool)
		return ok
	case "null":
		return instance == nil
	case "number":
		if _, isBool := instance.(bool); isBool {
			return false
		}
		_, ok := numericValue(instance)
		return ok
	case "integer":
		if _, isBool := instance.(bool); isBool {
			return false
		}
		n, ok := numericValue(instance)
		return ok && n == math.Trunc(n)
	}
	return true // unknown type keyword: don't fail on it
}
