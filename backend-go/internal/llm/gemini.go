// Gemini provider — Google Generative Language API over plain HTTP, matching the
// Anthropic provider in this package rather than pulling in an SDK.
//
// Structured output is asked for twice over, because neither half is sufficient
// alone. Gemini's responseSchema speaks an OpenAPI-3.0 subset, not JSON Schema:
// it has no additionalProperties, and it needs an explicit type where JSON Schema
// infers one from enum — and this codebase's schemas use both. So the schema is
// translated before it is sent, and a request the API refuses outright falls back
// to plain JSON mode rather than failing the call.
package llm

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"traceo/internal/config"
)

const geminiAPIRoot = "https://generativelanguage.googleapis.com/v1beta"

// Schema keys with no equivalent in Gemini's dialect. Sending them can 400 the
// whole request, so they are dropped — never translated into something else.
var geminiUnsupported = map[string]bool{
	"additionalProperties": true,
	"$schema":              true,
	"$defs":                true,
	"definitions":          true,
	"patternProperties":    true,
	"allOf":                true,
	"oneOf":                true,
	"not":                  true,
	"const":                true,
}

// toGeminiSchema rewrites a JSON Schema into the subset Gemini accepts.
// It only ever LOOSENS: anything it cannot express is dropped, never invented.
func toGeminiSchema(node any) any {
	switch v := node.(type) {
	case []any:
		out := make([]any, 0, len(v))
		for _, item := range v {
			out = append(out, toGeminiSchema(item))
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for key, val := range v {
			if geminiUnsupported[key] {
				continue
			}
			switch key {
			case "properties":
				// A property NAME is not a schema keyword — recurse into values only.
				if props, ok := val.(map[string]any); ok {
					next := map[string]any{}
					for name, sub := range props {
						next[name] = toGeminiSchema(sub)
					}
					out[key] = next
					continue
				}
				out[key] = toGeminiSchema(val)
			case "items", "prefixItems":
				out[key] = toGeminiSchema(val)
			default:
				out[key] = val
			}
		}
		// {"enum": [...]} with no type is valid JSON Schema and invalid here.
		if enum, ok := out["enum"]; ok {
			if _, typed := out["type"]; !typed {
				allStrings := true
				if list, ok := enum.([]any); ok {
					for _, e := range list {
						if _, isStr := e.(string); !isStr {
							allStrings = false
							break
						}
					}
				} else {
					allStrings = false
				}
				if allStrings {
					out["type"] = "string"
				} else {
					delete(out, "enum")
				}
			}
		}
		return out
	default:
		return node
	}
}

type geminiProvider struct{ model string }

// geminiResponse is the slice of the API response this provider reads.
type geminiResponse struct {
	Candidates []struct {
		Content struct {
			Parts []struct {
				Text string `json:"text"`
				// Gemini 3.x returns reasoning as parts flagged Thought in the same
				// list as the answer; concatenating everything would hand the JSON
				// parser a prose preamble and fail every call on a thinking model.
				Thought bool `json:"thought"`
			} `json:"parts"`
		} `json:"content"`
		FinishReason string `json:"finishReason"`
	} `json:"candidates"`
	PromptFeedback struct {
		BlockReason string `json:"blockReason"`
	} `json:"promptFeedback"`
	Error struct {
		Message string `json:"message"`
	} `json:"error"`
}

// answerText returns the answer parts only, plus the finish reason, or an error
// naming why there is none.
//
// The finish reason travels with the text because it is the difference between
// two failures that look identical at the parse site: a model that answered with
// prose, and a model whose valid JSON was cut off mid-object because the token
// budget ran out. Reporting both as "non-JSON model output" sent a real
// truncation to the logs as an unactionable sentence.
func (r *geminiResponse) answerText() (string, string, error) {
	if len(r.Candidates) == 0 {
		if r.PromptFeedback.BlockReason != "" {
			return "", "", fmt.Errorf("gemini returned no candidate (prompt blocked: %s)",
				r.PromptFeedback.BlockReason)
		}
		return "", "", errors.New("gemini returned no candidate")
	}
	cand := r.Candidates[0]
	switch cand.FinishReason {
	case "SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION":
		return "", cand.FinishReason,
			fmt.Errorf("model declined the request (finishReason=%s)", cand.FinishReason)
	}
	var sb strings.Builder
	for _, part := range cand.Content.Parts {
		if !part.Thought {
			sb.WriteString(part.Text)
		}
	}
	text := sb.String()
	if strings.TrimSpace(text) == "" {
		if cand.FinishReason == "MAX_TOKENS" {
			return "", cand.FinishReason,
				errors.New("gemini hit maxOutputTokens before emitting an answer — " +
					"raise TRACEO_LLM_MAX_TOKENS (thinking models spend the budget first)")
		}
		return "{}", cand.FinishReason, nil
	}
	return text, cand.FinishReason, nil
}

func (g *geminiProvider) CompleteJSON(promptID, prompt string, schema map[string]any) (Result, error) {
	key := config.C.GeminiKey
	if key == "" {
		// Same degradation the Anthropic provider performs: a missing key is a
		// configuration state, not a request the pipeline should die on (NFR-REL-03).
		return (&mockProvider{}).CompleteJSON(promptID, prompt, schema)
	}
	client := &http.Client{Timeout: time.Duration(config.C.LLMTimeoutS) * time.Second}
	translated, _ := toGeminiSchema(schema).(map[string]any)
	useSchema := translated != nil

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		generationConfig := map[string]any{
			"responseMimeType": "application/json",
			"maxOutputTokens":  config.C.LLMMaxTokens,
			// This is extraction, not writing: reruns should agree.
			"temperature": 0,
		}
		if useSchema {
			generationConfig["responseSchema"] = translated
		}
		body, _ := json.Marshal(map[string]any{
			"contents": []map[string]any{{
				"role":  "user",
				"parts": []map[string]any{{"text": prompt}},
			}},
			"generationConfig": generationConfig,
		})
		url := fmt.Sprintf("%s/models/%s:generateContent", geminiAPIRoot, g.model)
		req, err := http.NewRequest("POST", url, bytes.NewReader(body))
		if err != nil {
			return Result{}, err
		}
		// The key travels as a header, never in the URL: a URL is what ends up in
		// access logs, proxy logs and error messages.
		req.Header.Set("x-goog-api-key", key)
		req.Header.Set("content-type", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()

		var parsed geminiResponse
		if err := json.Unmarshal(raw, &parsed); err != nil {
			lastErr = fmt.Errorf("gemini returned unparseable body: %w", err)
			continue
		}
		if resp.StatusCode >= 400 {
			detail := parsed.Error.Message
			if detail == "" {
				detail = strings.TrimSpace(string(raw))
				if len(detail) > 300 {
					detail = detail[:300]
				}
			}
			lastErr = fmt.Errorf("gemini %d: %s", resp.StatusCode, detail)
			// A 400 is the translated schema being refused, not the prompt. Drop it
			// and retry in plain JSON mode — a looser request that answers beats none.
			if resp.StatusCode == 400 && useSchema {
				useSchema = false
				continue
			}
			return Result{}, lastErr
		}

		text, finish, err := parsed.answerText()
		if err != nil {
			return Result{}, err
		}
		var data map[string]any
		if err := json.Unmarshal([]byte(text), &data); err != nil {
			if finish == "MAX_TOKENS" {
				// Retrying is pointless: the same prompt will truncate at the same
				// place. Say what to change instead of burning a second call.
				return Result{}, fmt.Errorf(
					"gemini answer was cut off at maxOutputTokens (%d) after %d characters — "+
						"raise TRACEO_LLM_MAX_TOKENS", config.C.LLMMaxTokens, len(text))
			}
			lastErr = fmt.Errorf("non-JSON model output (finishReason=%s, %d characters)",
				finish, len(text))
			prompt += "\n\nPrevious output was not valid JSON. Return ONLY valid JSON per the schema."
			continue
		}
		return Result{Data: data, Model: g.model, PromptVersion: config.C.PromptVer}, nil
	}
	if lastErr == nil {
		lastErr = errors.New("no usable model output")
	}
	return Result{}, lastErr
}
