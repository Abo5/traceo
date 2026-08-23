// Self-hosted model provider — any server speaking the OpenAI chat-completions
// shape (Ollama, llama.cpp, vLLM, TGI).
//
// This is the provider that makes the air-gapped mode real. The mock provider
// keeps the pipeline running offline, but it is deterministic heuristics, not a
// model: it cannot read a screen it has never seen. An on-premises deployment
// that must not reach the public internet needs a model INSIDE the perimeter,
// and this is how it is reached.
//
// Structured output is negotiated downward rather than assumed, because the
// servers in this family disagree about it: vLLM and recent llama.cpp accept
// `response_format: {type: "json_schema", …}`, Ollama accepts
// `{type: "json_object"}`, and older builds accept neither and 400 the request.
// Sending the strictest form and stepping down on refusal is what lets one
// provider address all of them without the operator having to declare which
// dialect their server speaks.
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

type localProvider struct{ model string }

// stripFences removes a markdown code fence around a JSON body.
//
// A hosted model told to answer in JSON answers in JSON. A 7B model running on
// someone's GPU very often answers with ```json … ``` regardless, and refusing
// that output would make the offline mode look broken for a reason that has
// nothing to do with the content.
func stripFences(text string) string {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "```") {
		return trimmed
	}
	trimmed = strings.TrimPrefix(trimmed, "```")
	// The opening fence may carry a language tag: ```json
	if idx := strings.IndexByte(trimmed, '\n'); idx >= 0 {
		firstLine := strings.TrimSpace(trimmed[:idx])
		if firstLine == "" || !strings.ContainsAny(firstLine, "{[") {
			trimmed = trimmed[idx+1:]
		}
	}
	if idx := strings.LastIndex(trimmed, "```"); idx >= 0 {
		trimmed = trimmed[:idx]
	}
	return strings.TrimSpace(trimmed)
}

// responseFormats are tried in order, strictest first. A nil entry means "send
// no response_format at all" — the last resort for a server that refuses the
// field itself.
func (l *localProvider) responseFormats(schema map[string]any) []map[string]any {
	out := []map[string]any{}
	if schema != nil {
		out = append(out, map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name": "traceo_response", "strict": false, "schema": schema,
			},
		})
	}
	out = append(out, map[string]any{"type": "json_object"})
	out = append(out, nil)
	return out
}

func (l *localProvider) CompleteJSON(promptID, prompt string, schema map[string]any) (Result, error) {
	base := config.C.LocalLLMBaseURL
	if base == "" {
		// Same degradation the other providers perform: an unconfigured endpoint
		// is a deployment state, not a request the pipeline should die on.
		return (&mockProvider{}).CompleteJSON(promptID, prompt, schema)
	}
	client := &http.Client{Timeout: time.Duration(config.C.LLMTimeoutS) * time.Second}
	formats := l.responseFormats(schema)
	formatIdx := 0

	var lastErr error
	// Two content attempts, each of which may step down through the dialects. The
	// step-down does not consume a content attempt: being refused the strict form
	// is not the model getting the answer wrong.
	for attempt := 0; attempt < 2; attempt++ {
		for formatIdx < len(formats) {
			payload := map[string]any{
				"model":    l.model,
				"messages": []map[string]any{{"role": "user", "content": prompt}},
				// This is extraction, not writing: reruns should agree.
				"temperature": 0,
				"max_tokens":  config.C.LLMMaxTokens,
				"stream":      false,
			}
			if formats[formatIdx] != nil {
				payload["response_format"] = formats[formatIdx]
			}
			body, _ := json.Marshal(payload)
			req, err := http.NewRequest("POST", base+"/chat/completions", bytes.NewReader(body))
			if err != nil {
				return Result{}, err
			}
			req.Header.Set("content-type", "application/json")
			if config.C.LocalLLMKey != "" {
				req.Header.Set("authorization", "Bearer "+config.C.LocalLLMKey)
			}

			resp, err := client.Do(req)
			if err != nil {
				return Result{}, fmt.Errorf(
					"the self-hosted model at %s could not be reached: %w", base, err)
			}
			raw, _ := io.ReadAll(resp.Body)
			resp.Body.Close()

			if resp.StatusCode >= 400 {
				detail := strings.TrimSpace(string(raw))
				if len(detail) > 300 {
					detail = detail[:300]
				}
				lastErr = fmt.Errorf("self-hosted model %d: %s", resp.StatusCode, detail)
				// A 4xx on a request that only differs by response_format is the
				// server rejecting the dialect, not the prompt. Step down and retry.
				if resp.StatusCode < 500 && formatIdx+1 < len(formats) {
					formatIdx++
					continue
				}
				return Result{}, lastErr
			}

			var parsed struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
					FinishReason string `json:"finish_reason"`
				} `json:"choices"`
			}
			if err := json.Unmarshal(raw, &parsed); err != nil {
				return Result{}, fmt.Errorf("self-hosted model returned unparseable body: %w", err)
			}
			if len(parsed.Choices) == 0 {
				return Result{}, errors.New("self-hosted model returned no choice")
			}
			choice := parsed.Choices[0]
			text := stripFences(choice.Message.Content)

			var data map[string]any
			if err := json.Unmarshal([]byte(text), &data); err != nil {
				if choice.FinishReason == "length" {
					// Retrying truncates at the same place; say what to change.
					return Result{}, fmt.Errorf(
						"the self-hosted model's answer was cut off at max_tokens (%d) "+
							"after %d characters — raise TRACEO_LLM_MAX_TOKENS",
						config.C.LLMMaxTokens, len(text))
				}
				lastErr = fmt.Errorf("non-JSON model output (finish_reason=%s, %d characters)",
					choice.FinishReason, len(text))
				prompt += "\n\nPrevious output was not valid JSON. Return ONLY valid JSON per the schema."
				break // next content attempt, same dialect
			}
			return Result{Data: data, Model: l.model, PromptVersion: config.C.PromptVer}, nil
		}
		if formatIdx >= len(formats) {
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no usable model output")
	}
	return Result{}, lastErr
}
