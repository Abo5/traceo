// Package fixprompt builds a paste-ready repair brief for one failed case.
//
// The product loop this closes: a run tells you THAT something is broken; a fix
// prompt tells the tool you are building with WHAT to change, in the words of the
// requirement it violated.
//
// Two rules shape everything here.
//
// It is deterministic and offline. No model is called. Every line is assembled
// from rows that already exist: the case, the requirement it traces to, and the
// failure evidence the executor recorded. The same failure yields the same prompt
// on every machine, which is what makes it quotable in a bug report — and it
// keeps the "no outbound connection" property the mock provider gives the rest of
// the stack (NFR-D1).
//
// It never invents. The instruction lines are selected from a table keyed by the
// assertion that actually failed; there is no free text describing a cause nobody
// observed. When the recorded evidence does not say something, the prompt omits
// it rather than guessing (BO-07).
//
// Secrets: the text is built only from TestResult.FailureReason and
// TestResult.Evidence, both of which the execution engine wrote through its
// redactor. Nothing here reads an environment's auth config, so a prompt cannot
// carry a credential the evidence did not already contain.
package fixprompt

import (
	"encoding/json"
	"fmt"
	"strings"
)

// actions says what to do about each kind of failed assertion, keyed by the
// assertion `type` the runner recorded. Every entry is an instruction about the
// SYSTEM UNDER TEST, never about the test: a case that fails because the app is
// wrong must not invite someone to "relax the assertion", which is how a suite
// quietly stops meaning anything.
var actions = map[string][]string{
	// --- browser / DOM checks (web-target scans) ---
	"validation_error": {
		"reject the submission while this field is empty, in the handler AND on the server",
		"show the user an error next to the field (aria-invalid + a message element)",
	},
	"no_navigation": {
		"do not navigate away when the submission is rejected",
	},
	"value_length_at_most": {
		"enforce the field's own maxlength — truncate or reject longer input",
		"apply the same limit on the server, so a direct request cannot exceed it",
	},
	"pattern_enforced": {
		"reject values that do not match the field's declared pattern",
		"validate the same pattern on the server",
	},
	"elements_present": {
		"render the missing element, or correct the selector if it was renamed",
	},
	"value_rejected": {
		"refuse this value — the field already declares the rule, so enforce it " +
			"in the handler AND on the server",
		"tell the user what is wrong, next to the field (aria-invalid + a message)",
	},
	"whitespace_rejected": {
		"treat a whitespace-only value as empty: trim before the required check",
		"refuse the submission and show the error next to the field",
	},
	"value_accepted": {
		"stop refusing a value the field's own declaration allows — the rule and " +
			"the check disagree, and the declaration is what the user can see",
	},
	// --- functionality ---
	"happy_path": {
		"make the form submit when every field holds a value it declares valid — " +
			"wire the submit handler, and stop swallowing the event",
	},
	"error_recovery": {
		"keep the other fields' values when a submission is refused; re-render " +
			"from the submitted values rather than resetting the form",
		"let the submission through once the field is corrected",
	},
	"submit_gated": {
		"block submission while the required checkbox is unticked, in the " +
			"handler AND on the server",
	},
	"conditional_fields": {
		"make the fields shown for an option depend only on that option, so the " +
			"same choice always shows the same form",
	},
	"initial_state": {
		"restore the control's documented initial value, or update the " +
			"requirement if the new default is intended",
	},
	"links_resolve": {
		"fix or remove the links that do not resolve",
	},
	"page_load_ms": {
		"bring the page load inside the stated budget " +
			"(defer non-critical scripts, compress the largest assets)",
	},
	// --- HTTP checks (spec/traffic-derived cases) ---
	"status":           {"return the expected status code for this request"},
	"json_path":        {"return the expected value at this JSON path"},
	"header":           {"send the expected response header"},
	"response_time_ms": {"bring this endpoint's response time inside the stated budget"},
	"json_schema":      {"make the response body match the schema this endpoint declares"},
}

var fallbackActions = []string{
	"make the observed behaviour match the expected behaviour recorded below",
}

// errorActions apply when a case never reached its assertion — the instruction
// is about reachability, not about the rule.
var errorActions = []string{
	"make the target reachable and responsive for this step " +
		"(the check could not complete, so the rule was never evaluated)",
}

const labelWidth = 16

func line(label, value string) string {
	if len(label) < labelWidth {
		label += strings.Repeat(" ", labelWidth-len(label))
	}
	return label + value
}

// clip renders any value as one collapsed line, truncated to limit runes.
func clip(value any, limit int) string {
	if value == nil {
		return ""
	}
	var text string
	switch v := value.(type) {
	case string:
		text = v
	case map[string]any, []any:
		if raw, err := json.Marshal(v); err == nil {
			text = string(raw)
		} else {
			text = fmt.Sprint(v)
		}
	default:
		text = fmt.Sprint(v)
	}
	text = strings.Join(strings.Fields(text), " ")
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit-1]) + "…"
}

// failureBits normalises the two shapes failure_reason is written in.
//
// The HTTP executor writes {assertion, expected, actual, step_index} (or
// {error, step_index} when the request itself failed); the browser runner writes
// {message, expected, actual, selector, assertion}. Readers should not have to
// know which engine produced the row.
func failureBits(failureReason any) map[string]string {
	out := map[string]string{}
	fr, ok := failureReason.(map[string]any)
	if !ok {
		if failureReason != nil {
			if s := clip(failureReason, 400); s != "" {
				out["message"] = s
			}
		}
		return out
	}
	if v := clip(fr["message"], 400); v != "" {
		out["message"] = v
	}
	if v := clip(fr["error"], 400); v != "" {
		out["error"] = v
	}
	if v := clip(fr["selector"], 200); v != "" {
		out["selector"] = v
	}
	switch assertion := fr["assertion"].(type) {
	case map[string]any:
		if t, ok := assertion["type"].(string); ok {
			out["assertion_type"] = t
		}
		if exp, present := assertion["expected"]; present {
			if _, already := out["expected"]; !already {
				out["expected"] = clip(exp, 400)
			}
		}
	case string:
		out["assertion_type"] = assertion
	}
	if fr["expected"] != nil {
		out["expected"] = clip(fr["expected"], 400)
	}
	if fr["actual"] != nil {
		out["actual"] = clip(fr["actual"], 400)
	}
	return out
}

// where names the place the failure happened — selector, or method + URL.
func where(evidence any, bits map[string]string) string {
	selector := bits["selector"]
	list, ok := evidence.([]any)
	if ok && len(list) > 0 {
		if first, ok := list[0].(map[string]any); ok {
			if req, ok := first["request"].(map[string]any); ok {
				url, _ := req["url"].(string)
				method, _ := req["method"].(string)
				method = strings.ToUpper(method)
				if selector != "" && url != "" {
					return selector + " on " + url
				}
				if url != "" {
					return strings.TrimSpace(method + " " + url)
				}
			}
		}
	}
	return selector
}

func requirementLine(requirements []any) string {
	if len(requirements) == 0 {
		return ""
	}
	req, ok := requirements[0].(map[string]any)
	if !ok {
		return ""
	}
	ext, _ := req["external_id"].(string)
	if ext == "" {
		ext, _ = req["id"].(string)
	}
	ext = strings.TrimSpace(ext)
	text := clip(req["description"], 300)
	if text == "" {
		text = clip(req["text"], 300)
	}
	if ext != "" && text != "" {
		return fmt.Sprintf("%s — %q", ext, text)
	}
	if ext != "" {
		return ext
	}
	return text
}

// Entry is the shape reporting's report entries produce, as a plain map so this
// package does not depend on the reporting package (which would be a cycle).
type Entry = map[string]any

// Build renders one paste-ready prompt for a failed or errored report entry.
func Build(entry Entry, runLabel string) string {
	caseMap, _ := entry["test_case"].(map[string]any)
	if caseMap == nil {
		caseMap = map[string]any{}
	}
	title := clip(caseMap["title"], 300)
	caseID, _ := caseMap["id"].(string)
	outcome, _ := entry["outcome"].(string)
	if outcome == "" {
		outcome = "failed"
	}
	bits := failureBits(entry["failure_reason"])

	shortID := caseID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	refParts := []string{}
	for _, part := range []string{runLabel, shortID} {
		if part != "" {
			refParts = append(refParts, part)
		}
	}
	ref := strings.Join(refParts, " · ")
	header := "# Fix request — generated by Traceo"
	if ref != "" {
		header += " · " + ref
	}
	lines := []string{header, ""}

	broken := bits["message"]
	if broken == "" {
		broken = bits["error"]
	}
	if broken == "" {
		broken = title + " — " + outcome
	}
	lines = append(lines, line("What is broken", broken))

	if w := where(entry["evidence"], bits); w != "" {
		lines = append(lines, line("Where", w))
	}
	reqs, _ := entry["requirements"].([]any)
	if r := requirementLine(reqs); r != "" {
		lines = append(lines, line("Requirement", r))
	}
	if sev := clip(entry["severity"], 100); sev != "" {
		lines = append(lines, line("Severity", sev))
	}
	if bits["expected"] != "" {
		lines = append(lines, line("Expected", bits["expected"]))
	}
	if bits["actual"] != "" {
		lines = append(lines, line("Observed", bits["actual"]))
	}

	var chosen []string
	if outcome == "errored" && bits["assertion_type"] == "" {
		chosen = errorActions
	} else if a, ok := actions[bits["assertion_type"]]; ok {
		chosen = a
	} else {
		chosen = fallbackActions
	}
	for i, action := range chosen {
		label := ""
		if i == 0 {
			label = "Do"
		}
		lines = append(lines, line(label, fmt.Sprintf("%d) %s", i+1, action)))
	}

	verify := "re-run this case"
	if title != "" {
		verify = fmt.Sprintf("re-run %q", title)
	}
	lines = append(lines, line("Verify", verify+" — when it passes, this closes"))
	lines = append(lines, "")
	lines = append(lines, "Change the application, not the test: this case states a rule the "+
		"product agreed to, so a passing test must mean the rule now holds.")
	return strings.Join(lines, "\n")
}

// For returns a prompt per failed/errored entry, in report order.
func For(entries []Entry, runLabel string) []map[string]any {
	out := []map[string]any{}
	for _, entry := range entries {
		outcome, _ := entry["outcome"].(string)
		if outcome != "failed" && outcome != "errored" {
			continue
		}
		caseMap, _ := entry["test_case"].(map[string]any)
		if caseMap == nil {
			caseMap = map[string]any{}
		}
		reqs, _ := entry["requirements"].([]any)
		if reqs == nil {
			reqs = []any{}
		}
		out = append(out, map[string]any{
			"test_case_id": caseMap["id"],
			"title":        caseMap["title"],
			"outcome":      outcome,
			"severity":     entry["severity"],
			"requirements": reqs,
			"prompt":       Build(entry, runLabel),
		})
	}
	return out
}
