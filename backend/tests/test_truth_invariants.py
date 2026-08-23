"""RELEASE GATE — the honesty invariants (H1–H6), one test each.

These are not style rules. Each one guards a measured incident in
docs/REMEDIATION_PLAN_AR.md: a number the product showed a user that was not
true. A failure here means the platform has started manufacturing confidence
again, which is worse than shipping no result at all.
"""
import httpx
import pytest

from app.modules import execution


class _Resp:
    """The slice of an httpx response the evaluator reads."""

    def __init__(self, status=200, headers=None, text=""):
        self.status_code = status
        self.headers = headers or {}
        self.text = text


# --- H1: nothing evaluated is never a pass ----------------------------------

def test_h1_case_with_no_evaluated_assertion_is_inconclusive():
    """125 cases in one measured run reported `passed` having checked nothing."""
    evidence = [{"assertions": [
        {"assertion": {"type": "no_5xx"}, "outcome": "skipped",
         "reason": "no evaluator implements assertion type 'no_5xx'"},
        {"assertion": {"type": "body_not_matches"}, "outcome": "skipped",
         "reason": "no evaluator implements assertion type 'body_not_matches'"},
    ]}]
    outcome, reason = execution.decide_outcome("passed", None, 0, 2, evidence)
    assert outcome == "inconclusive"
    assert reason["code"] == "not_evaluated"
    assert reason["skipped"] == 2
    assert reason["reasons"], "the result must say WHY nothing ran"


def test_h1_a_real_assertion_still_passes():
    """The guard must not turn working checks into inconclusive ones."""
    evidence = [{"assertions": [
        {"assertion": {"type": "status_code"}, "outcome": "passed"},
    ]}]
    assert execution.decide_outcome("passed", None, 1, 0, evidence)[0] == "passed"


def test_h1_a_partly_skipped_case_that_checked_something_passes():
    evidence = [{"assertions": [
        {"assertion": {"type": "status_code"}, "outcome": "passed"},
        {"assertion": {"type": "rate_limited_within"}, "outcome": "skipped",
         "reason": "active probe not authorised"},
    ]}]
    assert execution.decide_outcome("passed", None, 1, 1, evidence)[0] == "passed"


def test_h1_failure_and_error_are_left_alone():
    for terminal in ("failed", "errored"):
        got, _ = execution.decide_outcome(terminal, {"x": 1}, 0, 3, [])
        assert got == terminal


def test_h1_a_case_with_no_assertions_at_all_is_inconclusive():
    outcome, reason = execution.decide_outcome("passed", None, 0, 0, [])
    assert outcome == "inconclusive"
    assert "no assertion" in reason["message"]


def test_h1_unsupported_reasons_reach_the_result():
    """A declared limit must be readable on the result, not just in a doc."""
    evidence = [{"assertions": [
        {"assertion": {"type": "surface_share"}, "outcome": "unsupported",
         "reason": "share is measured by counting screenshot pixels"},
    ]}]
    _, reason = execution.decide_outcome("passed", None, 0, 1, evidence)
    assert any("screenshot pixels" in r for r in reason["reasons"])


# --- H3: an unresolved variable is never sent -------------------------------

def test_h3_unresolved_variable_is_detected_before_anything_is_sent():
    """`Authorization: Bearer {{token}}` used to go out literally, and the 401 it
    provoked was then reported as a security finding about the target."""
    seen = set()
    execution._assert_resolved("headers", {"Authorization": "Bearer {{token}}"}, seen)
    execution._assert_resolved("body", {"customer": "{{name}}"}, seen)
    assert any("token" in s for s in seen)
    assert any("name" in s for s in seen)


def test_h3_a_resolved_value_raises_nothing():
    seen = set()
    execution._assert_resolved("headers", {"Authorization": "Bearer abc123"}, seen)
    execution._assert_resolved("params", {"limit": 10}, seen)
    assert not seen


def test_h3_the_malformed_marker_is_not_a_missing_variable():
    """{{malformed}} is a deliberate broken-JSON negative, not a forgotten var."""
    body = "not-json{{{"
    seen = set()
    execution._assert_resolved("body", body, seen)
    assert not seen, "a deliberately broken body must not be read as a variable"


# --- H4: a requirement in the document is never lost in silence -------------

def test_h4_reconciliation_names_every_missing_identifier():
    """22 written requirements became 7 extracted, and the job said `completed`."""
    from app.modules.ingestion import _reconcile_ids

    document = ("**REQ-AUTH-01** The first rule.\n"
                "**REQ-AUTH-02** The second rule.\n"
                "**REQ-ORD-01** The third rule.\n")
    got = _reconcile_ids(document, [{"data": {"external_id": "REQ-AUTH-01"}}])
    assert got["ids_in_document"] == 3
    assert got["ids_extracted"] == 1
    assert got["ids_missing"] == ["REQ-AUTH-02", "REQ-ORD-01"]


# --- H6: coverage counts only what was actually verified --------------------

def test_h6_inconclusive_is_not_coverage():
    from app.modules.traceability import _requirement_status

    approved_but_unchecked = [{"state": "approved", "latest_outcome": "inconclusive"}]
    assert _requirement_status(approved_but_unchecked) == "not_verified"

    genuinely_passing = [{"state": "approved", "latest_outcome": "passed"}]
    assert _requirement_status(genuinely_passing) == "passing"


# --- the login flow, which is what makes a secured API testable at all ------

def test_login_flow_extracts_and_injects_a_token(monkeypatch):
    calls = {}

    def fake_request(method, url, **kwargs):
        calls["method"], calls["url"], calls["json"] = method, url, kwargs.get("json")
        return httpx.Response(200, json={"token": "t-123", "user": {"id": 1}})

    monkeypatch.setattr(execution.httpx, "request", fake_request)
    headers, variables = execution._login_flow(
        {"method": "POST", "path": "/api/auth/login",
         "body": {"email": "a@b.test", "password": "secret"},
         "extract": {"token": "$.token"}},
        "http://sut.test", True)
    assert calls["url"] == "http://sut.test/api/auth/login"
    assert variables == {"token": "t-123"}
    assert headers == {"Authorization": "Bearer t-123"}


def test_login_flow_aborts_loudly_when_sign_in_fails(monkeypatch):
    """Better one diagnostic than 300 cases failing against 401."""
    monkeypatch.setattr(execution.httpx, "request",
                        lambda *a, **k: httpx.Response(401, json={"error": "no"}))
    with pytest.raises(execution._AuthSetupError) as excinfo:
        execution._login_flow({"path": "/api/auth/login"}, "http://sut.test", True)
    assert "401" in str(excinfo.value)


def test_login_flow_says_which_field_it_could_not_read(monkeypatch):
    monkeypatch.setattr(execution.httpx, "request",
                        lambda *a, **k: httpx.Response(200, json={"access": "x"}))
    with pytest.raises(execution._AuthSetupError) as excinfo:
        execution._login_flow(
            {"path": "/login", "extract": {"token": "$.token"}}, "http://sut.test", True)
    assert "token" in str(excinfo.value)
