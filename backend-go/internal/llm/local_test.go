package llm

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"traceo/internal/config"
)

func TestStripFences(t *testing.T) {
	cases := map[string]string{
		"{\"a\":1}":                     "{\"a\":1}",
		"```json\n{\"a\":1}\n```":       "{\"a\":1}",
		"```\n{\"a\":1}\n```":           "{\"a\":1}",
		"  ```json\n{\"a\":1}\n```  ":   "{\"a\":1}",
		"```json\n{\"a\":[1,2]}\n```\n": "{\"a\":[1,2]}",
	}
	for in, want := range cases {
		if got := stripFences(in); got != want {
			t.Errorf("stripFences(%q) = %q, want %q", in, got, want)
		}
	}
}

// serve builds a fake OpenAI-compatible server. `reject` names the
// response_format types it 400s, so each server dialect can be simulated.
func serve(t *testing.T, reject map[string]bool, content string) (*httptest.Server, *[]string) {
	t.Helper()
	seen := &[]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req struct {
			ResponseFormat map[string]any `json:"response_format"`
		}
		json.Unmarshal(body, &req)
		kind := "none"
		if req.ResponseFormat != nil {
			kind, _ = req.ResponseFormat["type"].(string)
		}
		*seen = append(*seen, kind)
		if reject[kind] {
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":"response_format not supported"}`)
			return
		}
		w.Header().Set("content-type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"content": content},
				"finish_reason": "stop",
			}},
		})
	}))
	t.Cleanup(srv.Close)
	return srv, seen
}

func withLocal(t *testing.T, baseURL string) {
	t.Helper()
	config.Load()
	config.C.LocalLLMBaseURL = baseURL
	config.C.LLMMaxTokens = 512
	config.C.LLMTimeoutS = 10
}

var demoSchema = map[string]any{
	"type":       "object",
	"properties": map[string]any{"ok": map[string]any{"type": "boolean"}},
	"required":   []any{"ok"},
}

// A server that speaks the strict dialect is used at its strictest.
func TestLocalUsesJSONSchemaWhenAccepted(t *testing.T) {
	srv, seen := serve(t, nil, `{"ok":true}`)
	withLocal(t, srv.URL)
	res, err := (&localProvider{model: "m"}).CompleteJSON("p", "prompt", demoSchema)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Data["ok"] != true {
		t.Fatalf("bad data: %v", res.Data)
	}
	if len(*seen) != 1 || (*seen)[0] != "json_schema" {
		t.Fatalf("expected one json_schema call, got %v", *seen)
	}
}

// Ollama refuses json_schema; the provider must step down to json_object rather
// than fail — and must NOT burn a content retry doing it.
func TestLocalStepsDownToJSONObject(t *testing.T) {
	srv, seen := serve(t, map[string]bool{"json_schema": true}, `{"ok":true}`)
	withLocal(t, srv.URL)
	if _, err := (&localProvider{model: "m"}).CompleteJSON("p", "prompt", demoSchema); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(*seen, ",") != "json_schema,json_object" {
		t.Fatalf("expected step-down, got %v", *seen)
	}
}

// An old build refuses the field entirely: step all the way to no format.
func TestLocalStepsDownToNoFormat(t *testing.T) {
	srv, seen := serve(t, map[string]bool{"json_schema": true, "json_object": true}, `{"ok":true}`)
	withLocal(t, srv.URL)
	if _, err := (&localProvider{model: "m"}).CompleteJSON("p", "prompt", demoSchema); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Join(*seen, ",") != "json_schema,json_object,none" {
		t.Fatalf("expected full step-down, got %v", *seen)
	}
}

// A small model wrapping its answer in a markdown fence is still a usable answer.
func TestLocalAcceptsFencedJSON(t *testing.T) {
	srv, _ := serve(t, nil, "```json\n{\"ok\":true}\n```")
	withLocal(t, srv.URL)
	res, err := (&localProvider{model: "m"}).CompleteJSON("p", "prompt", demoSchema)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Data["ok"] != true {
		t.Fatalf("bad data: %v", res.Data)
	}
}

// No endpoint configured is a deployment state, not a crash: degrade to mock.
func TestLocalWithoutEndpointDegradesToMock(t *testing.T) {
	withLocal(t, "")
	res, err := (&localProvider{model: "m"}).CompleteJSON("extract_requirement",
		"SEGMENT:\nREQ-1: the system shall do the thing.", map[string]any{"type": "object"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Model != "mock-deterministic" {
		t.Fatalf("expected mock fallback, got %q", res.Model)
	}
}
