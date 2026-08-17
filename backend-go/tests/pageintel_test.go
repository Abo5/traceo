package tests_test

// The model reads a crawled screen and proposes behaviours — under the same gate.
// Parity gate for backend/tests/test_pageintel.py: the same claims, so a client
// cannot tell the two engines apart.
//
// What these hold onto is the division of labour that makes the track safe: the
// model may decide what is worth testing and what the product should do; it may
// NOT decide what exists. A proposal citing an element the crawl never found is
// discarded and counted, exactly as a fabricated endpoint is. The gate is proved
// capable of FAILING before it is trusted to pass anything.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"traceo/internal/llm"
	"traceo/internal/modules/pageintel"
)

func maxLen(n int) *int { return &n }

func loginScreen() pageintel.Page {
	return pageintel.Page{
		URL:   "https://demo.example/web/index.php/auth/login",
		Title: "Login",
		Path:  "/web/index.php/auth/login",
		Forms: []pageintel.Form{{
			Selector: "form.oxd-form", Name: "Login", Method: "POST",
			Action: "/web/index.php/auth/validate",
			Fields: []pageintel.Field{
				{Selector: "input[name=username]", Name: "username", Label: "Username",
					Type: "text", Required: true},
				{Selector: "input[name=password]", Name: "password", Label: "Password",
					Type: "password", Required: true, MaxLength: maxLen(64)},
				{Selector: "input[name=_token]", Name: "_token", Type: "hidden"},
			},
		}},
		Controls: []pageintel.Control{
			{Selector: "button[type=submit]", Name: "Login", Role: "button"},
			{Selector: "a.forgot", Name: "Forgot your password?", Role: "link"},
		},
		Requests: []pageintel.Request{{Method: "GET",
			URL: "https://demo.example/api/v2/session?x=1", ResourceType: "xhr"}},
	}
}

// --- the closed list ---------------------------------------------------------

func TestPageIntelPayloadDescribesThePageAndNothingElse(t *testing.T) {
	payload := pageintel.Payload(loginScreen())
	if payload["url"] != "https://demo.example/web/index.php/auth/login" {
		t.Fatalf("url = %v", payload["url"])
	}
	forms := payload["forms"].([]any)
	fields := forms[0].(map[string]any)["fields"].([]any)
	ids := []string{}
	for _, f := range fields {
		ids = append(ids, f.(map[string]any)["id"].(string))
	}
	if strings.Join(ids, ",") != "f0.0,f0.1,f0.2" {
		t.Fatalf("field ids = %v", ids)
	}
	if fields[1].(map[string]any)["maxlength"] != 64 {
		t.Fatalf("maxlength = %v", fields[1].(map[string]any)["maxlength"])
	}
	// the calls the page made, without their query strings — a captured value is
	// not part of what the screen IS
	calls := payload["requests_the_page_made"].([]any)
	if len(calls) != 1 || calls[0].(map[string]any)["url"] != "https://demo.example/api/v2/session" {
		t.Fatalf("calls = %v", calls)
	}
}

func TestPageIntelPayloadCarriesNoCredential(t *testing.T) {
	payload := pageintel.Payload(loginScreen())
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// The password FIELD is described — that is the point — but no VALUE of any
	// field is, and no key that could carry one exists.
	if !strings.Contains(string(encoded), "Password") {
		t.Fatal("the payload must describe the password field")
	}
	if strings.Contains(string(encoded), "admin123") {
		t.Fatal("a credential reached the payload")
	}
	allowed := map[string]bool{"id": true, "label": true, "type": true, "required": true,
		"placeholder": true, "pattern": true, "maxlength": true}
	for _, rawForm := range payload["forms"].([]any) {
		for _, rawField := range rawForm.(map[string]any)["fields"].([]any) {
			for key := range rawField.(map[string]any) {
				if !allowed[key] {
					t.Fatalf("unexpected field key %q — it could carry a value", key)
				}
			}
		}
	}
}

// --- the gate, shown fallible first ------------------------------------------

func TestPageIntelGateRejectsAFabricatedProposal(t *testing.T) {
	payload := pageintel.Payload(loginScreen())
	fields, controls := pageintel.Index(payload)

	for _, tc := range []struct {
		name     string
		proposal map[string]any
		want     string
	}{
		{"invented field", map[string]any{"title": "t", "expected": "e", "type": "negative",
			"field_ids": []any{"f9.9"}}, "field 'f9.9' is not on this page"},
		{"invented control", map[string]any{"title": "t", "expected": "e", "type": "positive",
			"control_ids": []any{"c42"}}, "control 'c42' is not on this page"},
		{"cites nothing", map[string]any{"title": "t", "expected": "e", "type": "positive"},
			"case cites no field or control from this page"},
		{"no title", map[string]any{"title": "", "expected": "e", "type": "positive",
			"field_ids": []any{"f0.0"}}, "case has no title"},
		{"no expectation", map[string]any{"title": "t", "expected": "  ", "type": "positive",
			"field_ids": []any{"f0.0"}}, "case states no expected outcome"},
	} {
		got := pageintel.Violations(tc.proposal, fields, controls)
		if len(got) == 0 || got[0] != tc.want {
			t.Fatalf("%s: got %v, want %q first", tc.name, got, tc.want)
		}
	}

	real := map[string]any{"title": "Submitting without a username is rejected",
		"expected": "The form refuses.", "type": "negative",
		"field_ids": []any{"f0.0"}, "control_ids": []any{"c0"}}
	if got := pageintel.Violations(real, fields, controls); len(got) != 0 {
		t.Fatalf("a real proposal was rejected: %v", got)
	}
}

// --- end to end over the provider seam ---------------------------------------

func TestPageIntelProposalsBecomeCasesBoundToThePagesOwnSelectors(t *testing.T) {
	page := loginScreen()
	cases, discarded, notes := pageintel.Propose(page, llm.Get())
	if len(cases) == 0 || discarded != 0 || len(notes) != 0 {
		t.Fatalf("cases=%d discarded=%d notes=%v", len(cases), discarded, notes)
	}
	known := map[string]bool{"input[name=username]": true, "input[name=password]": true,
		"input[name=_token]": true, "button[type=submit]": true, "a.forgot": true}
	for _, c := range cases {
		if c.Technique != "scenario" {
			t.Fatalf("technique = %q", c.Technique)
		}
		if c.Expected == "" {
			t.Fatalf("case %q states no expected outcome", c.Title)
		}
		cited := append(append([]string{}, c.Fields...), c.Controls...)
		if len(cited) == 0 {
			t.Fatalf("case %q cites nothing", c.Title)
		}
		for _, selector := range cited {
			if !known[selector] {
				t.Fatalf("case %q cites a selector the page never had: %s", c.Title, selector)
			}
		}
		if !containsStr(c.Grounds, "page:"+page.URL) {
			t.Fatalf("case %q is not anchored to its page: %v", c.Title, c.Grounds)
		}
	}
}

type fabricator struct{}

func (fabricator) CompleteJSON(_, _ string, _ map[string]any) (llm.Result, error) {
	return llm.Result{Data: map[string]any{"cases": []any{
		map[string]any{"title": "Two-factor code is required", "expected": "It asks for a code.",
			"type": "negative", "field_ids": []any{"f0.7"}}, // invented
		map[string]any{"title": "Submitting without a username is rejected",
			"expected": "The form refuses.", "type": "negative",
			"field_ids": []any{"f0.0"}}, // real
	}}, Model: "fabricator"}, nil
}

func TestPageIntelDiscardsAndCountsAFabricatedProposal(t *testing.T) {
	cases, discarded, notes := pageintel.Propose(loginScreen(), fabricator{})
	if len(cases) != 1 || cases[0].Title != "Submitting without a username is rejected" {
		t.Fatalf("cases = %v", cases)
	}
	if discarded != 1 || len(notes) != 1 || notes[0] != "field 'f0.7' is not on this page" {
		t.Fatalf("discarded=%d notes=%v", discarded, notes)
	}
}

type brokenProvider struct{}

func (brokenProvider) CompleteJSON(_, _ string, _ map[string]any) (llm.Result, error) {
	return llm.Result{}, errors.New("upstream is down")
}

func TestPageIntelProviderFailureCostsBehavioursNeverTheCrawl(t *testing.T) {
	cases, discarded, notes := pageintel.Propose(loginScreen(), brokenProvider{})
	if len(cases) != 0 || discarded != 0 || len(notes) != 1 {
		t.Fatalf("cases=%d discarded=%d notes=%v", len(cases), discarded, notes)
	}
	if !strings.HasPrefix(notes[0], "the model could not be consulted") {
		t.Fatalf("note = %q", notes[0])
	}
}

type mustNotBeCalled struct{ t *testing.T }

func (m mustNotBeCalled) CompleteJSON(_, _ string, _ map[string]any) (llm.Result, error) {
	m.t.Fatal("the model was consulted about a page with no controls")
	return llm.Result{}, nil
}

func TestPageIntelSkipsAPageWithNothingToActOn(t *testing.T) {
	bare := pageintel.Page{URL: "https://demo.example/about", Title: "About"}
	cases, discarded, notes := pageintel.Propose(bare, mustNotBeCalled{t})
	if len(cases) != 0 || discarded != 0 || len(notes) != 1 {
		t.Fatalf("cases=%d discarded=%d notes=%v", len(cases), discarded, notes)
	}
	if notes[0] != "the page has no form or named control to write behaviour about" {
		t.Fatalf("note = %q", notes[0])
	}
}

func containsStr(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
