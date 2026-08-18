"""The model reads a crawled screen and proposes behaviours — under the same gate.

What these tests hold onto is the division of labour that makes the track safe:
the model may decide what is worth testing and what the product should do; it may
NOT decide what exists. A proposal citing an element the crawl never found is
discarded and counted, exactly as a fabricated endpoint is.

The gate is proved capable of FAILING before it is trusted to pass anything — an
oracle that accepts everything would let this whole track through silently.
"""
import json

import pytest

from app.llm.mock import MockProvider
from app.modules import pageintel


LOGIN_PAGE = {
    "final_url": "https://demo.example/web/index.php/auth/login",
    "title": "Login",
    "forms": [{
        "selector": "form.oxd-form",
        "name": "Login",
        "method": "POST",
        "action": "/web/index.php/auth/validate",
        "fields": [
            {"selector": "input[name=username]", "name": "username", "label": "Username",
             "type": "text", "required": True},
            {"selector": "input[name=password]", "name": "password", "label": "Password",
             "type": "password", "required": True, "maxlength": 64},
            {"selector": "input[name=_token]", "name": "_token", "label": "",
             "type": "hidden", "required": False},
        ],
    }],
    "controls": [{"selector": "button[type=submit]", "name": "Login", "role": "button"},
                 {"selector": "a.forgot", "name": "Forgot your password?", "role": "link"}],
    "requests": [{"method": "GET", "url": "https://demo.example/api/v2/session?x=1",
                  "resource_type": "xhr"}],
}


@pytest.fixture()
def payload():
    return pageintel.page_payload(LOGIN_PAGE)


# --- the closed list ---------------------------------------------------------

def test_the_payload_describes_the_page_and_nothing_else(payload):
    assert payload["url"] == LOGIN_PAGE["final_url"]
    assert [f["id"] for f in payload["forms"][0]["fields"]] == ["f0.0", "f0.1", "f0.2"]
    assert payload["forms"][0]["fields"][0]["label"] == "Username"
    assert payload["forms"][0]["fields"][1]["maxlength"] == 64
    # an unnamed control cannot be described, so it is not offered to be cited
    assert [c["name"] for c in payload["controls"]] == ["Login", "Forgot your password?"]
    # the model is given the calls the page made, without their query strings —
    # a captured value is not part of what the screen IS
    assert payload["requests_the_page_made"] == [
        {"method": "GET", "url": "https://demo.example/api/v2/session"}]


def test_no_credential_can_reach_the_model(payload):
    """The payload is built from the inventory, and the inventory never carried
    a credential — this pins that a change upstream cannot quietly leak one."""
    # The password FIELD is described — that is the point of the payload — but no
    # VALUE of any field is, and no key that could carry one exists.
    serialised = json.dumps(payload)
    assert "Password" in serialised
    assert "admin123" not in serialised
    for form in payload["forms"]:
        for field in form["fields"]:
            assert set(field) <= {"id", "label", "type", "required", "placeholder",
                                  "pattern", "maxlength"}, field


# --- the gate, shown fallible first ------------------------------------------

def test_the_gate_rejects_a_fabricated_proposal(payload):
    fields, controls = pageintel.artefact_index(payload)

    invented_field = {"title": "t", "expected": "e", "type": "negative",
                      "field_ids": ["f9.9"]}
    assert pageintel.violations(invented_field, fields, controls) == \
        ["field 'f9.9' is not on this page"]

    invented_control = {"title": "t", "expected": "e", "type": "positive",
                        "field_ids": [], "control_ids": ["c42"]}
    assert pageintel.violations(invented_control, fields, controls) == \
        ["control 'c42' is not on this page"]

    grounded_in_nothing = {"title": "t", "expected": "e", "type": "positive",
                           "field_ids": [], "control_ids": []}
    assert pageintel.violations(grounded_in_nothing, fields, controls) == \
        ["case cites no field or control from this page"]

    assert pageintel.violations({"title": "", "expected": "e", "type": "positive",
                                 "field_ids": ["f0.0"]}, fields, controls) == \
        ["case has no title"]
    assert pageintel.violations({"title": "t", "expected": "  ", "type": "positive",
                                 "field_ids": ["f0.0"]}, fields, controls) == \
        ["case states no expected outcome"]


def test_the_gate_accepts_a_proposal_that_names_real_elements(payload):
    fields, controls = pageintel.artefact_index(payload)
    real = {"title": "Submitting without a username is rejected",
            "expected": "The form refuses and reports Username as required.",
            "type": "negative", "field_ids": ["f0.0"], "control_ids": ["c0"]}
    assert pageintel.violations(real, fields, controls) == []


# --- end to end over the provider seam ---------------------------------------

def test_proposals_become_cases_bound_to_the_pages_own_selectors():
    cases, discarded, notes = pageintel.propose(LOGIN_PAGE, "/web/index.php/auth/login",
                                                MockProvider())
    assert cases and discarded == 0 and notes == []
    for case in cases:
        assert case["technique"] == "scenario"
        assert case["steps"][0]["assertions"][0]["type"] == "expected_outcome"
        assert case["steps"][0]["assertions"][0]["statement"]
        # the ids the model cited are resolved HERE into the page's own selectors
        cited = case["steps"][0]["request"]["fields"] + case["steps"][0]["request"]["controls"]
        assert cited
        assert all(s in {"input[name=username]", "input[name=password]",
                         "input[name=_token]", "button[type=submit]", "a.forgot"}
                   for s in cited)
        assert f"page:{LOGIN_PAGE['final_url']}" in case["grounds"]

    titles = [c["title"] for c in cases]
    assert any("without Username" in t for t in titles)
    assert any("64 characters" in t for t in titles)


def test_a_fabricated_proposal_is_discarded_and_counted():
    class Fabricator:
        model = "fabricator"

        def complete_json(self, prompt_id, prompt, schema):
            from app.llm.base import LLMResult
            return LLMResult(data={"cases": [
                {"title": "Two-factor code is required", "expected": "It asks for a code.",
                 "type": "negative", "field_ids": ["f0.7"]},          # invented
                {"title": "Submitting without a username is rejected",
                 "expected": "The form refuses.", "type": "negative",
                 "field_ids": ["f0.0"]},                              # real
            ]}, model="fabricator", prompt_version="v1")

    cases, discarded, notes = pageintel.propose(LOGIN_PAGE, "/login", Fabricator())
    assert [c["title"] for c in cases] == ["Submitting without a username is rejected"]
    assert discarded == 1
    assert notes == ["field 'f0.7' is not on this page"]


def test_a_provider_failure_costs_behaviours_never_the_crawl():
    class Broken:
        def complete_json(self, *_args, **_kwargs):
            raise RuntimeError("upstream is down")

    cases, discarded, notes = pageintel.propose(LOGIN_PAGE, "/login", Broken())
    assert cases == [] and discarded == 0
    assert notes == ["the model could not be consulted: RuntimeError"]


def test_a_page_with_nothing_to_act_on_is_reported_not_asked_about():
    bare = {"final_url": "https://demo.example/about", "title": "About",
            "forms": [], "controls": [], "requests": []}

    class MustNotBeCalled:
        def complete_json(self, *_args, **_kwargs):
            raise AssertionError("the model was consulted about a page with no controls")

    cases, discarded, notes = pageintel.propose(bare, "/about", MustNotBeCalled())
    assert cases == [] and discarded == 0
    assert notes == ["the page has no form or named control to write behaviour about"]
