package webtarget

// What the markup DECLARES — port of the form-action half of the api track in
// backend/app/modules/webtarget.py.
//
// A form's action is the page saying, in its own markup, "this is the operation
// I submit to". Reading it is not submitting it: discovery stays read-only and
// the login form remains the only form ever submitted. Without it, a product
// whose server interaction is a classic form POST discovers ZERO endpoints, and
// the generator and the security builders then have nothing to stand on.

import (
	"fmt"
	"net/url"
	"sort"
	"strings"

	"traceo/internal/modules/collections"
)

// formFieldTypes translates an input's type to the JSON Schema type it obviously
// is. A translation of what the page states, not an inference: everything the
// page does not type is a string, because that is what an <input> submits.
var formFieldTypes = map[string]string{
	"number": "number", "range": "number", "checkbox": "boolean",
}

// FormEndpoint is the operation a form declares, or the reason it was skipped.
//
// Everything here comes from the page: the method (GET by the HTML spec when the
// markup omits it), the path, the field names, and required-ness exactly as the
// page marks it. A field with no name is dropped rather than invented, and a page
// that marks nothing required declares nothing required — "password" looking
// mandatory is not the page saying so.
func FormEndpoint(form Form, page Inventory) (*Operation, string) {
	pageURL := page.pageURL()
	action := strings.TrimSpace(form.Action)
	label := FormLabel(form)

	here, hereErr := url.Parse(pageURL)
	if hereErr != nil {
		return nil, fmt.Sprintf("the '%s' form is on a page with an unparseable URL", label)
	}
	// An empty action submits to the page's own URL (HTML spec).
	target := here
	if action != "" {
		parsed, err := here.Parse(action)
		if err != nil {
			return nil, fmt.Sprintf("the '%s' form submits to '%s', which is not an "+
				"http(s) endpoint", label, action)
		}
		target = parsed
	}
	if (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, fmt.Sprintf("the '%s' form submits to '%s', which is not an "+
			"http(s) endpoint", label, action)
	}
	if target.Scheme != here.Scheme || target.Host != here.Host {
		return nil, fmt.Sprintf("the '%s' form submits to %s://%s, a different origin — "+
			"that is somebody else's endpoint, not this project's",
			label, target.Scheme, target.Host)
	}

	method := strings.ToUpper(firstNonEmpty(form.Method, "GET"))
	path, pathNames := collections.TemplateConcretePath(target.Path)
	parameters := make([]any, 0, len(pathNames)+len(form.Fields))
	known := map[string]bool{}
	for _, name := range pathNames {
		parameters = append(parameters, collections.Param(name, "path", true, ""))
		known[name] = true
	}
	// A form action may carry its own query string; those are the page's
	// parameters just as much as its fields are. Kept in the order the action
	// states them, for the reason EndpointsFromRequests spells out: a sort here
	// makes this engine pick a different first parameter than webtarget.py.
	for _, pair := range queryNamesInOrder(target.RawQuery) {
		if pair.key == "" || known[pair.key] {
			continue
		}
		known[pair.key] = true
		parameters = append(parameters, collections.Param(pair.key, "query", false, pair.value))
	}

	var named []Field
	for _, f := range form.Fields {
		if f.Name != "" {
			named = append(named, f)
		}
	}
	var requestSchema map[string]any
	if method == "GET" {
		// A GET form puts its fields in the query string — that is what the
		// browser will do with them.
		for _, f := range named {
			if known[f.Name] {
				continue
			}
			known[f.Name] = true
			parameters = append(parameters, collections.Param(f.Name, "query", f.Required, ""))
		}
	} else if len(named) > 0 {
		properties := map[string]any{}
		required := []any{}
		for _, f := range named {
			kind := formFieldTypes[strings.ToLower(f.Type)]
			if kind == "" {
				kind = "string"
			}
			properties[f.Name] = map[string]any{"type": kind}
			if f.Required {
				required = append(required, f.Name)
			}
		}
		requestSchema = map[string]any{"type": "object", "properties": properties}
		if len(required) > 0 {
			requestSchema["required"] = required
		}
	}

	return &Operation{
		Method: method, Path: path,
		Summary: trunc(fmt.Sprintf("Declared by the '%s' form (%s) on %s",
			label, form.Selector, pageURL), 500),
		Parameters: parameters,
		// Declared, not observed: the crawl never submitted this form, so
		// claiming a request count would be a claim about something that never
		// happened.
		ObservedCount: 0,
		Origins:       []string{target.Scheme + "://" + target.Host},
		Statuses:      []int{}, URLs: []string{},
		RequestSchema: requestSchema,
		DeclaredBy:    &Declaration{Selector: form.Selector, Page: PageRef(page)},
	}, ""
}

// EndpointsFromForms is every form action the crawl saw, deduplicated by
// (method, path) across pages for the same reason the captured requests are: the
// same search form on four pages is one endpoint. The second return is the
// reasons forms were skipped, in first-seen order and without repeats.
func EndpointsFromForms(pages []Inventory) ([]Operation, []string) {
	byKey := map[string]*Operation{}
	var order []string
	var reasons []string
	for _, page := range pages {
		for _, form := range page.Forms {
			op, reason := FormEndpoint(form, page)
			if op == nil {
				if !contains(reasons, reason) {
					reasons = append(reasons, reason)
				}
				continue
			}
			key := op.Method + " " + op.Path
			if _, present := byKey[key]; present {
				continue
			}
			byKey[key] = op
			order = append(order, key)
		}
	}
	sort.Strings(order)
	out := make([]Operation, 0, len(order))
	for _, key := range order {
		out = append(out, *byKey[key])
	}
	return out, reasons
}
