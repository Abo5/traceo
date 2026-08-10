// enrich.go — AI ENRICHMENT (contract item 3): the "model proposes, the system
// verifies" layer on top of the deterministic collection import.
//
// The model is handed the DETERMINISTIC inventory only — methods, paths,
// parameter names and inferred body field names — NEVER the raw uploaded file
// text. It is asked for three purely descriptive things per endpoint: a one-line
// plain-English description, a resource group name, and a criticality hint.
//
// THE VALIDATION GATE IS INVIOLABLE. Every returned item is matched against the
// inventory by EXACT method+path; anything that references an unknown method,
// path, parameter or field is DISCARDED and counted. Enrichment can never
// create, rename or delete an endpoint, and never alters a path, parameter or
// field name — it only ever fills the three ai_* columns with plain text.
//
// The layer is entirely optional: if the provider errors, returns nothing, or
// returns garbage, the import still succeeds with zero enrichment.
package collections

import (
	"encoding/json"
	"strings"

	"traceo/internal/llm"
)

// EnrichPromptID is the prompt id the deterministic MockProvider keys on.
const EnrichPromptID = "enrich_endpoints"

// enrichBatch caps how many endpoints go into a single completion so a large
// collection stays within a sane prompt size. Batching does not change the
// result: the gate is per item.
const enrichBatch = 50

const (
	maxDescriptionRunes = 300
	maxGroupRunes       = 60
)

// Enrichment is the validated, plain-text metadata for one endpoint.
type Enrichment struct {
	Description string
	Group       string
	Criticality string
}

// EnrichResult carries the accepted enrichments plus the two counters the job
// result reports as "enriched" and "enrichment_discarded".
type EnrichResult struct {
	ByKey     map[string]Enrichment
	Enriched  int
	Discarded int
}

// Enrich asks the configured provider to describe the inventory and returns only
// what survives the validation gate. It never returns an error: enrichment
// failure is not import failure.
func Enrich(ops []Operation) EnrichResult {
	result := EnrichResult{ByKey: map[string]Enrichment{}}
	if len(ops) == 0 {
		return result
	}
	provider := llm.Get()
	for start := 0; start < len(ops); start += enrichBatch {
		end := start + enrichBatch
		if end > len(ops) {
			end = len(ops)
		}
		res, err := provider.CompleteJSON(EnrichPromptID, enrichPrompt(ops[start:end]), enrichSchema())
		if err != nil {
			continue // the import succeeds with zero enrichment for this batch
		}
		items, ok := res.Data["endpoints"].([]any)
		if !ok {
			continue
		}
		ValidateEnrichment(ops, items, &result)
	}
	return result
}

// ValidateEnrichment IS THE GATE. It is exported so it can be exercised directly
// with adversarial model output: every item is matched against the deterministic
// inventory by exact method+path, anything referencing an unknown method, path,
// parameter or field is discarded and counted, and only sanitized plain text is
// accepted. It appends to `result`, which may already hold earlier batches.
func ValidateEnrichment(ops []Operation, items []any, result *EnrichResult) {
	if result.ByKey == nil {
		result.ByKey = map[string]Enrichment{}
	}
	known := knownNames(ops)
	for _, entry := range items {
		item := asMap(entry)
		if item == nil {
			result.Discarded++
			continue
		}
		key := strings.ToUpper(strings.TrimSpace(str(item["method"]))) + " " +
			strings.TrimSpace(str(item["path"]))
		names, isKnown := known[key]
		if !isKnown {
			result.Discarded++ // unknown method+path — fabricated endpoint
			continue
		}
		if _, already := result.ByKey[key]; already {
			result.Discarded++ // duplicate item for the same endpoint
			continue
		}
		if referencesUnknownName(item, names) {
			result.Discarded++ // references a parameter/field we never saw
			continue
		}
		enrichment := Enrichment{
			Description: plainText(str(item["description"]), maxDescriptionRunes),
			Group:       plainText(str(item["group"]), maxGroupRunes),
			Criticality: criticality(str(item["criticality"])),
		}
		// An item is kept only when it is COMPLETE and in-vocabulary: a real
		// description and a criticality the enum allows. A half-answer is not a
		// cheaper answer, it is an unverified one — and this is the same bar the
		// Python gate applies, so both engines enrich and discard identically.
		if enrichment.Description == "" || enrichment.Criticality == "" {
			result.Discarded++ // nothing usable
			continue
		}
		result.ByKey[key] = enrichment
		result.Enriched++
	}
}

// knownNames maps "METHOD /path" onto the set of parameter and body field names
// that endpoint legitimately has — the closed list the gate checks against.
func knownNames(ops []Operation) map[string]map[string]bool {
	out := map[string]map[string]bool{}
	for _, op := range ops {
		names := map[string]bool{}
		for _, p := range op.Parameters {
			if name := str(p["name"]); name != "" {
				names[strings.ToLower(name)] = true
			}
		}
		collectSchemaNames(op.RequestSchema, names)
		out[op.Key()] = names
	}
	return out
}

func collectSchemaNames(schema map[string]any, into map[string]bool) {
	if schema == nil {
		return
	}
	for name, sub := range asMap(schema["properties"]) {
		into[strings.ToLower(name)] = true
		collectSchemaNames(asMap(sub), into)
	}
	collectSchemaNames(asMap(schema["items"]), into)
}

// referencesUnknownName rejects an item that volunteers parameter/field names
// outside the endpoint's closed list — the adversarial case the gate exists for.
func referencesUnknownName(item map[string]any, known map[string]bool) bool {
	for _, key := range []string{"params", "parameters", "fields", "body_fields"} {
		for _, entry := range asList(item[key]) {
			name := ""
			switch t := entry.(type) {
			case string:
				name = t
			case map[string]any:
				name = str(t["name"])
			}
			if name = strings.ToLower(strings.TrimSpace(name)); name == "" {
				continue
			}
			if !known[name] {
				return true
			}
		}
	}
	return false
}

// plainText strips control characters and markup-ish angle brackets, collapses
// whitespace and clips — enrichment is stored as PLAIN TEXT only.
func plainText(s string, max int) string {
	var b strings.Builder
	lastSpace := false
	for _, r := range s {
		switch {
		case r == '<' || r == '>':
			continue
		case r < 0x20 || r == 0x7f:
			r = ' '
		}
		if r == ' ' {
			if lastSpace || b.Len() == 0 {
				continue
			}
			lastSpace = true
			b.WriteRune(' ')
			continue
		}
		lastSpace = false
		b.WriteRune(r)
	}
	return clip(strings.TrimSpace(b.String()), max)
}

// criticality accepts exactly high|medium|low; anything else is dropped.
func criticality(v string) string {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "high":
		return "high"
	case "medium":
		return "medium"
	case "low":
		return "low"
	}
	return ""
}

// enrichPrompt frames the inventory as untrusted DATA (the same hardening the
// ingestion and generation prompts use) and asks ONLY for descriptive metadata.
// The payload carries names, never the uploaded file's text.
func enrichPrompt(ops []Operation) string {
	items := make([]map[string]any, 0, len(ops))
	for _, op := range ops {
		params := []string{}
		for _, p := range op.Parameters {
			if name := str(p["name"]); name != "" {
				params = append(params, name)
			}
		}
		fields := []string{}
		for _, name := range sortedKeys(asMap(op.RequestSchema["properties"])) {
			fields = append(fields, name)
		}
		items = append(items, map[string]any{
			"method": op.Method, "path": op.Path,
			"params": params, "body_fields": fields,
		})
	}
	payload, err := json.Marshal(map[string]any{"endpoints": items})
	if err != nil {
		payload = []byte(`{"endpoints":[]}`)
	}
	var b strings.Builder
	b.WriteString("You are documenting an API endpoint inventory that was derived " +
		"deterministically from an uploaded API collection.\n")
	b.WriteString("For EVERY endpoint in the inventory return exactly one item with:\n")
	b.WriteString("- method and path copied VERBATIM from the inventory,\n")
	b.WriteString("- description: one line of plain English saying what the endpoint does,\n")
	b.WriteString("- group: a short resource group name,\n")
	b.WriteString("- criticality: exactly one of \"high\", \"medium\", \"low\".\n")
	b.WriteString("Never invent, rename or drop an endpoint, path, parameter or field.\n")
	b.WriteString(llm.UntrustedNote)
	b.WriteString(llm.UntrustedOpen + "\n")
	b.WriteString("INVENTORY:\n")
	b.Write(payload)
	b.WriteString("\n" + llm.UntrustedClose)
	return b.String()
}

func enrichSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"endpoints": map[string]any{
				"type": "array",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"method":      map[string]any{"type": "string"},
						"path":        map[string]any{"type": "string"},
						"description": map[string]any{"type": "string"},
						"group":       map[string]any{"type": "string"},
						"criticality": map[string]any{"type": "string",
							"enum": []any{"high", "medium", "low"}},
					},
					"required": []any{"method", "path"},
				},
			},
		},
		"required": []any{"endpoints"},
	}
}
