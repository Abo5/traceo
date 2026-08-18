// schema.go — JSON Schema inference from EXAMPLE payloads (contract item 2,
// "Request body"). Types come from the observed values; objects and arrays are
// recursed. Nothing is invented: no `required`, no formats, no descriptions,
// no fields the example did not contain.
package collections

import (
	"encoding/json"
	"strings"
)

// InferSchema derives a JSON Schema fragment from a decoded example value.
//
// Numbers are classified from the JSON LITERAL, not from its value, so the Go
// and Python importers agree: Python's json.loads makes "1" an int and "1.0" a
// float, which no float64-based test can reproduce ("1.0" would look integral).
// Callers therefore decode with json.Decoder.UseNumber (see decodeJSON).
func InferSchema(v any) map[string]any {
	switch t := v.(type) {
	case nil:
		return map[string]any{"type": "null"}
	case bool:
		return map[string]any{"type": "boolean"}
	case json.Number:
		if strings.ContainsAny(t.String(), ".eE") {
			return map[string]any{"type": "number"}
		}
		return map[string]any{"type": "integer"}
	case float64:
		if t == float64(int64(t)) {
			return map[string]any{"type": "integer"}
		}
		return map[string]any{"type": "number"}
	case string:
		return map[string]any{"type": "string"}
	case []any:
		items := map[string]any{}
		for _, el := range t {
			items = MergeSchema(items, InferSchema(el))
		}
		return map[string]any{"type": "array", "items": items}
	case map[string]any:
		props := map[string]any{}
		for _, k := range sortedKeys(t) {
			props[k] = InferSchema(t[k])
		}
		return map[string]any{"type": "object", "properties": props}
	}
	return map[string]any{}
}

// decodeJSON parses an example body preserving numeric literals (see InferSchema).
func decodeJSON(raw string) (any, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, false
	}
	dec := json.NewDecoder(strings.NewReader(trimmed))
	dec.UseNumber()
	var decoded any
	if err := dec.Decode(&decoded); err != nil {
		return nil, false
	}
	// Reject trailing garbage ("{} junk") the way a whole-document parse would.
	if dec.More() {
		return nil, false
	}
	return decoded, true
}

// InferSchemaFromJSON parses a raw JSON example body and infers its schema.
// ANY JSON value counts — including the bare literal `null`, which several
// exports use for "no body recorded". A body that is not JSON at all yields
// ok=false; the caller then records the media type and field names only.
func InferSchemaFromJSON(raw string) (map[string]any, bool) {
	decoded, ok := decodeJSON(raw)
	if !ok {
		return nil, false
	}
	return InferSchema(decoded), true
}

// BodyFromJSONText mirrors the Python importer's _body_from_json_text: a JSON
// example yields an inferred schema, an empty body yields nothing, and text that
// is not JSON is recorded as an opaque string body rather than being dropped.
func BodyFromJSONText(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if schema, ok := InferSchemaFromJSON(raw); ok {
		return schema
	}
	return map[string]any{"type": "string", mediaTypeKey: "text/plain"}
}

// MergeSchema unions two inferred schemas (duplicate requests for the same
// method+path, or heterogeneous array elements). Object properties union,
// array items merge recursively, and a genuine type conflict collapses to the
// empty (unconstrained) schema rather than picking a winner — the validator must
// never reject a field the collection actually contained.
func MergeSchema(a, b map[string]any) map[string]any {
	if len(a) == 0 {
		return b
	}
	if len(b) == 0 {
		return a
	}
	at, bt := str(a["type"]), str(b["type"])
	if at != bt {
		return map[string]any{}
	}
	switch at {
	case "object":
		props := map[string]any{}
		for k, v := range asMap(a["properties"]) {
			props[k] = v
		}
		for k, v := range asMap(b["properties"]) {
			if prior, present := props[k]; present {
				props[k] = MergeSchema(asMap(prior), asMap(v))
			} else {
				props[k] = v
			}
		}
		out := map[string]any{"type": "object", "properties": props}
		if mediaType := str(a[mediaTypeKey]); mediaType != "" {
			out[mediaTypeKey] = mediaType
		}
		return out
	case "array":
		return map[string]any{"type": "array",
			"items": MergeSchema(asMap(a["items"]), asMap(b["items"]))}
	}
	return a
}

// mediaTypeKey records the media type of a NON-JSON body (formdata, urlencoded,
// binary, graphql). Such bodies contribute field names only — never inferred
// value types, which the collection does not state.
const mediaTypeKey = "x-media-type"

// fieldsSchema builds the schema for a non-JSON body: the media type plus the
// declared field names, each an unconstrained string. A body with no declared
// fields carries NO "properties" key at all — an empty property bag would assert
// "this body has no fields", which the document never said.
func fieldsSchema(mediaType string, fields []string, binary map[string]bool) map[string]any {
	props := map[string]any{}
	for _, f := range fields {
		if f == "" {
			continue
		}
		if binary[f] {
			props[f] = map[string]any{"type": "string", "format": "binary"}
			continue
		}
		props[f] = map[string]any{"type": "string"}
	}
	out := map[string]any{"type": "object", mediaTypeKey: mediaType}
	if len(props) > 0 {
		out["properties"] = props
	}
	return out
}
