// mapper.go — lexical prefilter + closed-list LLM pick (TRD §4.3).
package generation

import (
	"regexp"
	"sort"
	"strings"

	"traceo/internal/llm"
	"traceo/internal/models"
)

const (
	minMapConfidence = 0.3
	maxCandidates    = 10
)

// mapInstructions/mapPromptSuffix frame the requirement text (user-supplied, and
// therefore untrusted) as DATA: the JSON payload is sandwiched between
// llm.UntrustedOpen/Close after an explicit "data, not instructions" note. The
// "PAYLOAD:\n" sentinel the deterministic mock splits on is unchanged and stays
// immediately before the JSON; the mock strips the closing delimiter before
// decoding, so mock output is identical to the unframed prompt.
const mapInstructions = "You map ONE software requirement onto API endpoints. Pick ONLY from the closed " +
	"candidate list below (TRD §4.3) — respond with the integer indices of the matching " +
	"candidates plus your confidence between 0 and 1. Never invent endpoints; an empty " +
	"selection is a valid answer.\n" + llm.UntrustedNote + llm.UntrustedOpen + "\n"

const mapPromptSuffix = "\n" + llm.UntrustedClose

var mapSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"selected":   map[string]any{"type": "array", "items": map[string]any{"type": "integer"}},
		"confidence": map[string]any{"type": "number"},
	},
	"required": []any{"selected", "confidence"},
}

var wordRe = regexp.MustCompile(`[a-z]{3,}`)

func tokens(text string) map[string]bool {
	out := map[string]bool{}
	for _, w := range wordRe.FindAllString(strings.ToLower(text), -1) {
		out[w] = true
	}
	return out
}

func overlapCount(toks, other map[string]bool) int {
	n := 0
	for w := range other {
		if toks[w] {
			n++
		}
	}
	return n
}

func prefilter(reqText string, endpoints []*models.Endpoint) []*models.Endpoint {
	toks := tokens(reqText)
	type scored struct {
		score int
		ep    *models.Endpoint
	}
	var list []scored
	for _, ep := range endpoints {
		var tagStrs []string
		for _, t := range ep.Tags {
			tagStrs = append(tagStrs, pyStr(t))
		}
		blob := strings.Join([]string{ep.Method, ep.Path, ep.Summary, ep.OperationID,
			strings.Join(tagStrs, " ")}, " ")
		overlap := overlapCount(toks, tokens(blob))
		pathOverlap := overlapCount(toks, tokens(strings.ReplaceAll(ep.Path, "/", " "))) // path segments count double
		score := overlap + pathOverlap
		if score > 0 {
			list = append(list, scored{score, ep})
		}
	}
	sort.SliceStable(list, func(a, b int) bool {
		if list[a].score != list[b].score {
			return list[a].score > list[b].score
		}
		if list[a].ep.Path != list[b].ep.Path {
			return list[a].ep.Path < list[b].ep.Path
		}
		return list[a].ep.Method < list[b].ep.Method
	})
	if len(list) > maxCandidates {
		list = list[:maxCandidates]
	}
	out := make([]*models.Endpoint, 0, len(list))
	for _, s := range list {
		out = append(out, s.ep)
	}
	return out
}
