// har.go — HAR 1.2 (captured traffic) -> endpoint inventory.
//
// Deterministic rules (contract item 2):
//   - the absolute origin is stripped, leaving a server-relative path;
//   - CONCRETE identifier segments are templated with the documented heuristic in
//     concreteIDName: all-digits, canonical UUID, or a 24+ character hex token
//     becomes "{id}" (then "{id2}", "{id3}", ... within the same path);
//   - queryString -> query parameters with example values; headers -> header
//     parameters (values of credential-bearing headers are NOT recorded);
//   - postData JSON text -> inferred JSON Schema, other media types -> media type
//     and field names only;
//   - response.status -> observed status codes, with a schema inferred from the
//     response body when it is JSON;
//   - every entry counts once towards observed_count (source "traffic").
package collections

import (
	"strconv"
	"strings"
)

func convertHAR(root map[string]any) ([]Operation, []Warning) {
	ops := []Operation{}
	warnings := []Warning{}
	log := asMap(root["log"])
	if log == nil {
		return ops, warnings
	}
	for i, entry := range asList(log["entries"]) {
		em := asMap(entry)
		if em == nil {
			continue
		}
		request := asMap(em["request"])
		if request == nil {
			warnings = append(warnings, Warning{
				Path: "entries[" + strconv.Itoa(i) + "]", Method: "*",
				Error: "HAR entry has no request object."})
			continue
		}
		rawURL := str(request["url"])
		if strings.TrimSpace(rawURL) == "" {
			warnings = append(warnings, Warning{
				Path: "entries[" + strconv.Itoa(i) + "]", Method: str(request["method"]),
				Error: "HAR entry has no URL."})
			continue
		}
		method := strings.ToUpper(strings.TrimSpace(str(request["method"])))
		if method == "" {
			method = "GET"
		}
		path, query := splitURL(rawURL)
		templated, names := templateConcretePath(path)

		params := []map[string]any{}
		for _, name := range names {
			params = append(params, param(name, "path", true, ""))
		}
		if qs, present := request["queryString"]; present && len(asList(qs)) > 0 {
			for _, q := range asList(qs) {
				qm := asMap(q)
				if qm == nil {
					continue
				}
				name := strings.TrimSpace(str(qm["name"]))
				if name == "" {
					continue
				}
				params = append(params, param(name, "query", false, str(qm["value"])))
			}
		} else {
			for _, pair := range parseQueryPairs(query) {
				params = append(params, param(pair[0], "query", false, pair[1]))
			}
		}
		params = append(params, headerParams(request["headers"], nil, "name", "key")...)

		ops = append(ops, Operation{
			Method:          method,
			Path:            templated,
			Security:        []any{},
			Tags:            []string{},
			Parameters:      mergeParams(params, nil),
			RequestSchema:   harBody(asMap(request["postData"])),
			ResponseSchemas: harResponse(asMap(em["response"])),
			ObservedCount:   1,
		})
	}
	return ops, warnings
}

// templateConcretePath rewrites concrete identifier segments into "{id}",
// "{id2}", ... and also honours any collection-style ":param"/"{{var}}" segment
// that a proxy may have left in place.
func templateConcretePath(path string) (string, []string) {
	segments := strings.Split(strings.TrimPrefix(path, "/"), "/")
	out := make([]string, 0, len(segments))
	names := []string{}
	seen := map[string]bool{}
	templated := 0
	for _, seg := range segments {
		if seg == "" {
			continue
		}
		if rewritten, declared := templateVarSegment(seg); len(declared) > 0 {
			out = append(out, rewritten)
			for _, name := range declared {
				if !seen[name] {
					seen[name] = true
					names = append(names, name)
				}
			}
			templated++
			continue
		}
		if name, isID := concreteIDName(seg, templated); isID {
			out = append(out, "{"+name+"}")
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
			templated++
			continue
		}
		out = append(out, seg)
	}
	return normalizePath("/" + strings.Join(out, "/")), names
}

// harBody infers the request schema from postData: JSON text is inferred as a
// real schema, params-style bodies contribute their field names, anything else
// records its media type only.
func harBody(postData map[string]any) map[string]any {
	if postData == nil {
		return nil
	}
	mediaType := strings.TrimSpace(str(postData["mimeType"]))
	if i := strings.Index(mediaType, ";"); i >= 0 {
		mediaType = strings.TrimSpace(mediaType[:i])
	}
	text := str(postData["text"])
	if strings.TrimSpace(text) != "" {
		if schema, ok := InferSchemaFromJSON(text); ok {
			return schema
		}
	}
	fields := []string{}
	binary := map[string]bool{}
	for _, entry := range asList(postData["params"]) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		name := strings.TrimSpace(str(m["name"]))
		if name == "" {
			continue
		}
		fields = append(fields, name)
		if str(m["fileName"]) != "" {
			binary[name] = true
		}
	}
	if mediaType == "" && len(fields) == 0 {
		return nil
	}
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return fieldsSchema(mediaType, fields, binary)
}

// harResponse records the observed status code (HAR has REAL responses), with a
// schema inferred from the response body when that body is JSON.
func harResponse(response map[string]any) map[string]any {
	out := map[string]any{}
	if response == nil {
		return out
	}
	code, ok := response["status"].(float64)
	if !ok || code <= 0 {
		return out
	}
	schema := map[string]any{}
	if content := asMap(response["content"]); content != nil {
		if inferred, isJSON := InferSchemaFromJSON(str(content["text"])); isJSON {
			schema = inferred
		}
	}
	out[strconv.Itoa(int(code))] = schema
	return out
}
