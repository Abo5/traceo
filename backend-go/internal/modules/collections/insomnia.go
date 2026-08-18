// insomnia.go — Insomnia v4 export -> endpoint inventory.
//
// Deterministic rules (contract item 2):
//   - only resources with "_type":"request" are imported, in file order;
//   - the url's leading environment variable ({{ _.baseUrl }}) or absolute origin
//     is stripped; ":param" segments become "{param}" and concrete identifier
//     segments are templated with the same documented heuristic HAR uses;
//   - "parameters" (plus anything left in the url's query string) become query
//     parameters; "headers" become header parameters;
//   - JSON bodies -> inferred JSON Schema, form bodies -> media type + field
//     names only;
//   - Insomnia carries no saved responses, so response_schemas stays empty.
//
// source stays "postman": the Endpoint.source enum is NOT extended, per the
// contract's preference for reusing existing values.
package collections

import (
	"strings"
)

func convertInsomnia(root map[string]any) ([]Operation, []Warning) {
	ops := []Operation{}
	warnings := []Warning{}
	resources := asList(root["resources"])
	vars := insomniaVariables(resources)
	groups := map[string]map[string]any{}
	for _, entry := range resources {
		if res := asMap(entry); res != nil && str(res["_type"]) == "request_group" {
			groups[str(res["_id"])] = res
		}
	}

	for _, entry := range resources {
		res := asMap(entry)
		if res == nil || str(res["_type"]) != "request" {
			continue
		}
		rawURL := strings.TrimSpace(str(res["url"]))
		if rawURL == "" {
			warnings = append(warnings, Warning{
				Path: str(res["name"]), Method: str(res["method"]),
				Error: "Insomnia request has no URL."})
			continue
		}
		method := strings.ToUpper(strings.TrimSpace(str(res["method"])))
		if method == "" {
			method = "GET"
		}
		path, query := splitURL(rawURL)
		templated, names := templateConcretePath(path)

		examples := insomniaPathExamples(res, vars)
		params := []map[string]any{}
		for _, name := range names {
			params = append(params, param(name, "path", true, examples[name]))
		}
		// The declared `parameters` list wins; the url's own query string is the
		// fallback for exports that keep the query inline (never both, so a
		// parameter is not counted twice with two different example values).
		declared := 0
		for _, q := range asList(res["parameters"]) {
			qm := asMap(q)
			if qm == nil {
				continue
			}
			name := strings.TrimSpace(str(qm["name"]))
			if name == "" {
				continue
			}
			declared++
			// `disabled` hides a value, never the API surface — see postman.go.
			params = append(params, paramDesc(name, "query", false,
				resolveVars(str(qm["value"]), vars), str(qm["description"])))
		}
		if declared == 0 {
			for _, pair := range parseQueryPairs(query) {
				params = append(params, param(pair[0], "query", false, pair[1]))
			}
		}
		params = append(params, headerParams(res["headers"], vars, "name", "key")...)

		name := strings.TrimSpace(str(res["name"]))
		ops = append(ops, Operation{
			Method:          method,
			Path:            templated,
			OperationID:     slug(name),
			Summary:         clip(name, 500),
			Parameters:      mergeParams(params, nil),
			RequestSchema:   insomniaBody(asMap(res["body"])),
			ResponseSchemas: map[string]any{},
			Security:        insomniaAuth(res["authentication"]),
			Tags:            folderChain(groups, res["parentId"]),
		})
	}
	return ops, warnings
}

// insomniaAuth maps Insomnia's authentication block onto the OpenAPI-shaped
// security list. "none" and a disabled block mean no security.
func insomniaAuth(v any) []any {
	m := asMap(v)
	if m == nil || truthy(m["disabled"]) {
		return []any{}
	}
	kind := strings.TrimSpace(str(m["type"]))
	if kind == "" || kind == "none" {
		return []any{}
	}
	return []any{map[string]any{kind: []any{}}}
}

// folderChain walks request_group parents up to the workspace and returns the
// folder names outermost-first, so they read like Postman's folder tags. The
// `seen` guard makes a corrupt export with a parent cycle terminate.
func folderChain(groups map[string]map[string]any, parentID any) []string {
	chain := []string{}
	seen := map[string]bool{}
	current := str(parentID)
	for {
		group, ok := groups[current]
		if !ok || seen[current] {
			break
		}
		seen[current] = true
		if name := str(group["name"]); name != "" {
			chain = append(chain, name)
		}
		current = str(group["parentId"])
	}
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain
}

// insomniaVariables collects environment variable values (base environments and
// sub-environments alike) in file order; the first definition of a name wins.
func insomniaVariables(resources []any) map[string]string {
	out := map[string]string{}
	for _, entry := range resources {
		res := asMap(entry)
		if res == nil || str(res["_type"]) != "environment" {
			continue
		}
		for _, key := range sortedKeys(asMap(res["data"])) {
			name := sanitizeParamName(key)
			if name == "" {
				continue
			}
			// First definition wins: base environments are exported before the
			// sub-environments that override them, and a deterministic winner
			// matters more than a clever one.
			if _, seen := out[name]; !seen {
				out[name] = str(asMap(res["data"])[key])
			}
		}
	}
	return out
}

// insomniaPathExamples resolves example values for templated path parameters
// from the request's pathParameters list, then the environment variables.
func insomniaPathExamples(res map[string]any, vars map[string]string) map[string]string {
	out := map[string]string{}
	for name, value := range vars {
		out[name] = value
	}
	for _, entry := range asList(res["pathParameters"]) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		name := sanitizeParamName(strings.Trim(str(m["name"]), "{} :"))
		if name == "" {
			continue
		}
		if value := str(m["value"]); value != "" {
			out[name] = value
		}
	}
	return out
}

// insomniaBody infers the request schema from body.text (JSON) or records the
// media type plus the declared form field names.
func insomniaBody(body map[string]any) map[string]any {
	if body == nil {
		return nil
	}
	mediaType := strings.TrimSpace(str(body["mimeType"]))
	if i := strings.Index(mediaType, ";"); i >= 0 {
		mediaType = strings.TrimSpace(mediaType[:i])
	}
	// A form body (declared params) is described by its field names only.
	fields := []string{}
	binary := map[string]bool{}
	for _, entry := range asList(body["params"]) {
		m := asMap(entry)
		if m == nil {
			continue
		}
		name := strings.TrimSpace(str(m["name"]))
		if name == "" {
			continue
		}
		fields = append(fields, name)
		if str(m["type"]) == "file" {
			binary[name] = true
		}
	}
	if len(fields) > 0 {
		if mediaType == "" {
			mediaType = "application/x-www-form-urlencoded"
		}
		return fieldsSchema(mediaType, fields, binary)
	}
	text := str(body["text"])
	if strings.TrimSpace(text) == "" {
		return nil
	}
	if strings.Contains(mediaType, "json") || mediaType == "" {
		return BodyFromJSONText(text)
	}
	return map[string]any{"type": "string", mediaTypeKey: mediaType}
}
