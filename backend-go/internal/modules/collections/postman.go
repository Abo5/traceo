// postman.go — Postman Collection v2.0 / v2.1 -> endpoint inventory.
//
// Deterministic rules (contract item 2):
//   - folders are walked depth-first, in file order;
//   - ":param" path segments and "{{var}}" path segments become "{param}";
//   - a leading base-url variable ({{baseUrl}}) or absolute origin is stripped so
//     every path is server-relative;
//   - url.query -> query parameters with their example values; request.header ->
//     header parameters (captured, never treated as query);
//   - raw JSON bodies -> inferred JSON Schema; formdata/urlencoded/file/graphql
//     bodies -> media type + field names only;
//   - saved response examples -> observed status codes (with a schema inferred
//     from the example body when it is JSON).
package collections

import (
	"encoding/json"
	"strconv"
	"strings"
)

func convertPostman(root map[string]any) ([]Operation, []Warning) {
	vars := postmanVariables(root["variable"])
	collectionAuth := postmanAuth(root["auth"])
	ops := []Operation{}
	warnings := []Warning{}
	walkPostmanItems(asList(root["item"]), nil, vars, collectionAuth, &ops, &warnings)
	return ops, warnings
}

// postmanAuth maps Postman's auth block onto the OpenAPI-shaped security list:
// {"type":"bearer"} -> [{"bearer": []}]. Absent or "noauth" -> empty.
func postmanAuth(v any) []any {
	m := asMap(v)
	if m == nil {
		return []any{}
	}
	kind := strings.TrimSpace(str(m["type"]))
	if kind == "" || kind == "noauth" {
		return []any{}
	}
	return []any{map[string]any{kind: []any{}}}
}

// postmanVariables flattens a Postman variable list ([{key,value}]) into a map.
// Collection- and environment-level variables are resolved from here.
func postmanVariables(v any) map[string]string {
	out := map[string]string{}
	for _, entry := range asList(v) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		// A DISABLED variable does not resolve: substituting it would fabricate a
		// path the collection never declared. The first definition of a name wins.
		if truthy(m["disabled"]) {
			continue
		}
		key := sanitizeParamName(strings.Trim(str(m["key"]), "{} :"))
		if key == "" {
			continue
		}
		if _, seen := out[key]; !seen {
			out[key] = str(m["value"])
		}
	}
	return out
}

// walkPostmanItems descends folders depth-first in file order, accumulating the
// folder names so each request carries its enclosing folders as tags.
func walkPostmanItems(items []any, folders []string, vars map[string]string,
	collectionAuth []any, ops *[]Operation, warnings *[]Warning) {
	for _, entry := range items {
		item := asMap(entry)
		if item == nil {
			continue
		}
		if children, isFolder := item["item"]; isFolder {
			walkPostmanItems(asList(children), append(folders, str(item["name"])),
				vars, collectionAuth, ops, warnings)
			continue
		}
		if _, hasRequest := item["request"]; !hasRequest {
			continue
		}
		op, err := postmanOperation(item, folders, vars, collectionAuth)
		if err != "" {
			*warnings = append(*warnings, Warning{
				Path: str(item["name"]), Method: "*", Error: err})
			continue
		}
		*ops = append(*ops, op)
	}
}

func postmanOperation(item map[string]any, folders []string, vars map[string]string,
	collectionAuth []any) (Operation, string) {
	method := "GET"
	var request map[string]any
	var rawURL any
	switch t := item["request"].(type) {
	case string:
		rawURL = t
	case map[string]any:
		request = t
		if m := strings.TrimSpace(str(t["method"])); m != "" {
			method = strings.ToUpper(m)
		}
		rawURL = t["url"]
	default:
		return Operation{}, "Request is neither a URL string nor an object."
	}

	path, params, err := postmanURL(rawURL, vars)
	if err != "" {
		return Operation{}, err
	}

	// header parameters — captured, never treated as query params
	security := collectionAuth
	if request != nil {
		params = append(params, headerParams(request["header"], vars, "key", "name")...)
		if requestAuth := postmanAuth(request["auth"]); len(requestAuth) > 0 {
			security = requestAuth
		}
	}

	name := strings.TrimSpace(str(item["name"]))
	summary := name
	if summary == "" && request != nil {
		summary = strings.TrimSpace(str(request["description"]))
	}

	var requestSchema map[string]any
	if request != nil {
		requestSchema = postmanBody(asMap(request["body"]))
	}

	tags := []string{}
	for _, folder := range folders {
		if folder != "" && !containsString(tags, folder) {
			tags = append(tags, folder)
		}
	}

	return Operation{
		Method:          method,
		Path:            path,
		OperationID:     slug(name),
		Summary:         clip(summary, 500),
		Parameters:      mergeParams(params, nil),
		RequestSchema:   requestSchema,
		ResponseSchemas: postmanResponses(item["response"]),
		Security:        security,
		Tags:            tags,
	}, ""
}

// postmanURL converts a Postman url (object or string) into a templated,
// server-relative path plus its path/query parameters.
func postmanURL(rawURL any, vars map[string]string) (string, []map[string]any, string) {
	params := []map[string]any{}
	switch t := rawURL.(type) {
	case string:
		path, query := splitURL(t)
		templated, names := templatePostmanPath(strings.Split(strings.TrimPrefix(path, "/"), "/"))
		for _, name := range names {
			params = append(params, param(name, "path", true, vars[name]))
		}
		for _, pair := range parseQueryPairs(query) {
			params = append(params, param(pair[0], "query", false, pair[1]))
		}
		return templated, params, ""
	case map[string]any:
		segments, ok := postmanPathSegments(t)
		if !ok {
			return "", nil, "Request URL has no usable path."
		}
		templated, names := templatePostmanPath(segments)
		examples := postmanPathExamples(t, vars)
		for _, name := range names {
			params = append(params, param(name, "path", true, examples[name]))
		}
		if query, present := t["query"]; present && len(asList(query)) > 0 {
			for _, q := range asList(query) {
				qm := asMap(q)
				if qm == nil {
					continue
				}
				name := strings.TrimSpace(str(qm["key"]))
				if name == "" {
					continue
				}
				// `disabled` is honoured for VALUES, ignored for SURFACE: Postman's
				// own OpenAPI converter exports every optional parameter disabled,
				// so skipping them would silently drop part of the API surface.
				// A disabled parameter is simply never required.
				params = append(params, paramDesc(name, "query", false,
					resolveVars(str(qm["value"]), vars), str(qm["description"])))
			}
		} else if raw := str(t["raw"]); raw != "" {
			_, query := splitURL(raw)
			for _, pair := range parseQueryPairs(query) {
				params = append(params, param(pair[0], "query", false, pair[1]))
			}
		}
		return templated, params, ""
	}
	return "", nil, "Request has no URL."
}

// postmanPathSegments prefers url.path (array or string) and falls back to
// url.raw. The host is dropped either way — paths are server-relative.
func postmanPathSegments(u map[string]any) ([]string, bool) {
	switch t := u["path"].(type) {
	case []any:
		segments := make([]string, 0, len(t))
		for _, seg := range t {
			if m := asMap(seg); m != nil {
				// v2.1 allows {"type":"string","value":"..."} path parts
				segments = append(segments, str(m["value"]))
				continue
			}
			segments = append(segments, str(seg))
		}
		return segments, true
	case string:
		path, _ := splitURL(t)
		return strings.Split(strings.TrimPrefix(path, "/"), "/"), true
	}
	if raw := str(u["raw"]); raw != "" {
		path, _ := splitURL(raw)
		return strings.Split(strings.TrimPrefix(path, "/"), "/"), true
	}
	return nil, false
}

// postmanPathExamples maps path parameter names onto example values taken from
// url.variable, falling back to the collection variables.
func postmanPathExamples(u map[string]any, vars map[string]string) map[string]string {
	out := map[string]string{}
	for name, value := range vars {
		out[name] = value
	}
	for _, entry := range asList(u["variable"]) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		key := sanitizeParamName(strings.Trim(str(m["key"]), "{} :"))
		if key == "" {
			continue
		}
		if value := str(m["value"]); value != "" {
			out[key] = value
		}
	}
	return out
}

// templatePostmanPath rewrites every segment and returns the path plus the
// ordered, de-duplicated list of path parameter names.
func templatePostmanPath(segments []string) (string, []string) {
	out := make([]string, 0, len(segments))
	names := []string{}
	seen := map[string]bool{}
	for _, seg := range segments {
		if seg == "" {
			continue
		}
		rewritten, declared := templateVarSegment(seg)
		out = append(out, rewritten)
		for _, name := range declared {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	return normalizePath("/" + strings.Join(out, "/")), names
}

// postmanBody infers the request schema. A raw body declared as JSON (or with no
// declared language) is parsed and its schema inferred; a raw body in any other
// language is an opaque string of that media type; every key/value mode records
// the media type and the declared field names only.
func postmanBody(body map[string]any) map[string]any {
	if body == nil || truthy(body["disabled"]) {
		return nil
	}
	switch str(body["mode"]) {
	case "raw":
		raw := str(body["raw"])
		if strings.TrimSpace(raw) == "" {
			return nil
		}
		language := ""
		if options := asMap(body["options"]); options != nil {
			if rawOpts := asMap(options["raw"]); rawOpts != nil {
				language = str(rawOpts["language"])
			}
		}
		if language != "" && language != "json" {
			return map[string]any{"type": "string", mediaTypeKey: "text/" + language}
		}
		return BodyFromJSONText(raw)
	case "urlencoded":
		// urlencoded carries no file parts, so no field is ever binary here.
		fields, _ := postmanFields(body["urlencoded"])
		return fieldsSchema("application/x-www-form-urlencoded", fields, nil)
	case "formdata":
		fields, binary := postmanFields(body["formdata"])
		return fieldsSchema("multipart/form-data", fields, binary)
	case "file", "binary":
		return map[string]any{"type": "string", "format": "binary",
			mediaTypeKey: "application/octet-stream"}
	case "graphql":
		return map[string]any{"type": "object", mediaTypeKey: "application/graphql"}
	}
	return nil
}

// postmanFields lists the declared field names of a key/value body part,
// flagging the file-typed ones as binary. As with query parameters, `disabled`
// hides a value but never hides the field from the API surface.
func postmanFields(v any) ([]string, map[string]bool) {
	fields := []string{}
	binary := map[string]bool{}
	for _, entry := range asList(v) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		name := strings.TrimSpace(str(m["key"]))
		if name == "" {
			continue
		}
		fields = append(fields, name)
		if str(m["type"]) == "file" {
			binary[name] = true
		}
	}
	return fields, binary
}

// postmanResponses records the status codes of saved response examples, with a
// schema inferred from the example body whenever that body is JSON.
func postmanResponses(v any) map[string]any {
	out := map[string]any{}
	for _, entry := range asList(v) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		status := ""
		switch code := m["code"].(type) {
		case float64:
			status = strconv.Itoa(int(code))
		case json.Number:
			status = code.String()
		case string:
			status = strings.TrimSpace(code)
		}
		if status == "" {
			continue
		}
		schema := BodyFromJSONText(str(m["body"]))
		if schema == nil {
			schema = map[string]any{}
		}
		if prior, present := out[status]; present {
			out[status] = MergeSchema(asMap(prior), schema)
			continue
		}
		out[status] = schema
	}
	return out
}
