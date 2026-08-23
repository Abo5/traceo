package llm

import (
	"encoding/json"
	"os"
	"testing"

	"traceo/internal/config"
)

// The schema translator is pure and must be provable without a network.
func TestToGeminiSchemaDropsUnsupportedAndInfersEnumType(t *testing.T) {
	src := map[string]any{
		"type": "object",
		"properties": map[string]any{
			// a bare enum: valid JSON Schema, invalid in Gemini's dialect
			"type": map[string]any{"enum": []any{"functional", "data"}},
			// a property literally NAMED items must not be read as the keyword
			"items": map[string]any{
				"type":                 "array",
				"items":                map[string]any{"type": "string"},
				"additionalProperties": false,
			},
		},
		"required":             []any{"type"},
		"additionalProperties": false,
	}
	got, _ := toGeminiSchema(src).(map[string]any)
	if _, present := got["additionalProperties"]; present {
		t.Fatal("additionalProperties survived translation")
	}
	props := got["properties"].(map[string]any)
	enumNode := props["type"].(map[string]any)
	if enumNode["type"] != "string" {
		t.Fatalf("bare enum did not gain a type: %v", enumNode)
	}
	itemsProp := props["items"].(map[string]any)
	if _, present := itemsProp["additionalProperties"]; present {
		t.Fatal("nested additionalProperties survived translation")
	}
	if itemsProp["type"] != "array" {
		t.Fatalf("property named items was mangled: %v", itemsProp)
	}
}

// A mixed-type enum cannot be expressed, so it is dropped rather than sent.
func TestToGeminiSchemaDropsMixedEnum(t *testing.T) {
	got, _ := toGeminiSchema(map[string]any{"enum": []any{"a", 1}}).(map[string]any)
	if _, present := got["enum"]; present {
		t.Fatalf("mixed-type enum should be dropped, got %v", got)
	}
}

// Live call — skipped unless a key is present, so CI stays offline.
func TestGeminiLive(t *testing.T) {
	key := os.Getenv("GEMINI_API_KEY")
	if key == "" {
		t.Skip("GEMINI_API_KEY not set")
	}
	config.Load()
	p := &geminiProvider{model: config.C.GeminiModel}
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"external_id":         map[string]any{"type": "string"},
			"description":         map[string]any{"type": "string"},
			"acceptance_criteria": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"type":                map[string]any{"enum": []any{"functional", "data", "security"}},
			"priority":            map[string]any{"type": "string"},
			"confidence":          map[string]any{"type": "number"},
		},
		"required":             []any{"external_id", "description", "type"},
		"additionalProperties": false,
	}
	res, err := p.CompleteJSON("extract_requirement",
		"Extract the single requirement from this text as JSON.\n\n"+
			"REQ-014: The system shall reject a phone number that is not exactly 10 digits "+
			"starting with 05, returning HTTP 422. Priority: high.", schema)
	if err != nil {
		t.Fatalf("live call failed: %v", err)
	}
	if res.Model != config.C.GeminiModel {
		t.Fatalf("provenance wrong: got %q want %q", res.Model, config.C.GeminiModel)
	}
	if res.Data["external_id"] != "REQ-014" {
		t.Fatalf("extraction wrong: %v", res.Data)
	}
	out, _ := json.Marshal(res.Data)
	t.Logf("model=%s data=%s", res.Model, out)
}
