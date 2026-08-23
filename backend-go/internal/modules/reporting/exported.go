package reporting

import (
	"encoding/json"

	"traceo/internal/models"
)

// EntriesFor exposes a run's report entries to the pipeline, which turns the
// failed ones into fix prompts. There must be exactly one implementation of
// "what does this run show", and the pipeline must read it rather than assemble
// a second one that could drift.
//
// The round-trip through JSON is deliberate, not laziness: payload() builds
// gin.H values, and gin.H is a DEFINED type rather than an alias for
// map[string]any, so a consumer type-asserting map[string]any on a nested
// test_case would get a failed assertion and silently produce an empty prompt.
// Marshalling normalises every level to the plain types the consumer expects —
// exactly the shapes the Python backend passes as dicts.
func EntriesFor(run *models.Run) []map[string]any {
	entries := reportEntries(run)
	out := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		raw, err := json.Marshal(e.payload())
		if err != nil {
			continue
		}
		var plain map[string]any
		if err := json.Unmarshal(raw, &plain); err != nil {
			continue
		}
		out = append(out, plain)
	}
	return out
}
