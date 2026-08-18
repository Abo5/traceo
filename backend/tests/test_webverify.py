"""Browser verification runs + fix prompts.

The claims under test:
  * a scan's DOM cases are EXECUTED, not skipped — the defect this feature
    exists to remove is the HTTP engine reporting them green unchecked;
  * a check the runner cannot evaluate is recorded as `skipped`, never `passed`;
  * the run is refused before a successful scan, and when the target has no
    browser cases at all — both with a stated reason;
  * the environment a scanned run points at is derived from the target's own
    origin, and reused rather than duplicated;
  * every failed case carries a fix prompt naming the requirement it violated,
    what was expected, what happened, and what to change — and the prompt tells
    the reader to change the APPLICATION, never the assertion;
  * passing cases carry no prompt.

No browser starts here: `run_check_sidecar` is replaced by a recorded document,
exactly as test_webtarget.py does for the discovery sidecar.
"""
import pytest

from app.db import SessionLocal
from app.models import (Environment, Requirement, RequirementTestCase, Run,
                        TestCase, TestResult, TestStep, WebTarget)
from app.modules import webverify
from app.modules.fixprompt import build_fix_prompt, fix_prompts_for

from conftest import poll_job

TARGET_URL = "http://app.example.com/login"


@pytest.fixture()
def project(client, register_org, create_project):
    headers = register_org("Verify Org")
    return headers, create_project(headers, "Verify Project")


def _org_of(client, headers) -> str:
    """The caller's org, read from the JWT the fixture just minted."""
    import base64, json as _json
    payload = headers["Authorization"].split(" ", 1)[1].split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return _json.loads(base64.urlsafe_b64decode(payload))["org"]


def _seed_target(org_id: str, project_id: str, *, status: str = "discovered",
                 with_cases: bool = True) -> tuple[str, list[str]]:
    """A discovered target plus the browser cases a scan would have written."""
    db = SessionLocal()
    try:
        target = WebTarget(organisation_id=org_id, project_id=project_id,
                           url=TARGET_URL, viewport="1280x800", status=status,
                           title="Login", final_url=TARGET_URL, inventory={})
        db.add(target)
        db.flush()

        case_ids: list[str] = []
        if with_cases:
            req = Requirement(organisation_id=org_id, project_id=project_id,
                              external_id="WEB-F1", description="The login form enforces its fields.",
                              type="functional", priority="high", state="extracted", version=1)
            db.add(req)
            db.flush()

            specs = [
                ("Form: 'login' renders every discovered field", "elements_present",
                 {"check": "elements_present", "url": TARGET_URL,
                  "selectors": ["#username", "#password"]}),
                ("Form: 'login' rejects submission with Email empty", "required_field_enforced",
                 {"check": "required_field_enforced", "url": TARGET_URL,
                  "form": "form#login", "empty": "#email", "filled": ["#username"]}),
                ("Form: Notes accepts at most 5 characters", "maxlength_enforced",
                 {"check": "maxlength_enforced", "url": TARGET_URL,
                  "selector": "#notes", "maxlength": 5}),
            ]
            for title, check, request in specs:
                tc = TestCase(organisation_id=org_id, project_id=project_id, title=title,
                              description="", preconditions="", type="negative",
                              priority="high", state="draft", generated=True,
                              technique="ep")
                db.add(tc)
                db.flush()
                db.add(TestStep(test_case_id=tc.id, order=0, method="GET", path="/login",
                                request=request,
                                assertions=[{"type": check, "expected": 5}], extractions=[]))
                db.add(RequirementTestCase(requirement_id=req.id, test_case_id=tc.id,
                                           link_source="generated",
                                           requirement_version_at_link=1))
                case_ids.append(tc.id)

            # An HTTP case in the same project: it must NOT be swept into a
            # browser run just because it lives next door.
            http_case = TestCase(organisation_id=org_id, project_id=project_id,
                                 title="API: POST /session returns 201", description="",
                                 preconditions="", type="positive", priority="medium",
                                 state="approved", generated=True, technique="ep")
            db.add(http_case)
            db.flush()
            db.add(TestStep(test_case_id=http_case.id, order=0, method="POST",
                            path="/session", request={"body": {}},
                            assertions=[{"type": "status", "expected": 201}], extractions=[]))

        db.commit()
        return target.id, case_ids
    finally:
        db.close()


def _recorded(case_ids: list[str]) -> dict:
    """What the sidecar returns: one pass, one failure, one unevaluated check."""
    return {
        "ok": True, "schema_version": 1, "url": TARGET_URL, "final_url": TARGET_URL,
        "load_ms": 91, "elapsed_ms": 2400,
        "results": [
            {"case_id": case_ids[0], "outcome": "passed", "duration_ms": 120,
             "assertions": [{"type": "elements_present", "outcome": "passed",
                             "expected": ["#username", "#password"],
                             "actual": "all 2 present and visible", "message": None}],
             "failure": None},
            {"case_id": case_ids[1], "outcome": "failed", "duration_ms": 310,
             "assertions": [{"type": "validation_error", "outcome": "failed",
                             "expected": "the form refuses submission while this required field is empty",
                             "actual": "submitted anyway and navigated to /done",
                             "message": "The form accepted an empty #email and submitted. "
                                        "A required field is not enforced.",
                             "selector": "#email"}],
             "failure": {"message": "The form accepted an empty #email and submitted. "
                                    "A required field is not enforced.",
                         "expected": "the form refuses submission while this required field is empty",
                         "actual": "submitted anyway and navigated to /done",
                         "selector": "#email", "assertion": "validation_error"}},
            {"case_id": case_ids[2], "outcome": "skipped", "duration_ms": 5,
             "assertions": [{"type": "contrast", "outcome": "skipped", "expected": None,
                             "actual": None,
                             "message": "design facts are measured from the discovery screenshot"}],
             "failure": None},
        ],
    }


# ---------------------------------------------------------------------------
# refusals
# ---------------------------------------------------------------------------

def test_verify_refused_before_a_successful_scan(client, project):
    headers, pid = project
    target_id, _ = _seed_target(_org_of(client, headers), pid, status="pending")
    r = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "target_not_ready"


def test_verify_refused_when_the_target_has_no_browser_cases(client, project):
    headers, pid = project
    target_id, _ = _seed_target(_org_of(client, headers), pid, with_cases=False)
    r = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "no_browser_cases"
    # The refusal must say how to get out of it, not merely that it happened.
    assert "re-scan" in detail["message"].lower()


def test_verify_is_org_scoped(client, project, register_org):
    headers, pid = project
    target_id, _ = _seed_target(_org_of(client, headers), pid)
    other = register_org("Somebody Else")
    r = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=other)
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# the run
# ---------------------------------------------------------------------------

def test_browser_cases_are_executed_and_skips_are_not_passes(client, project, monkeypatch):
    headers, pid = project
    org_id = _org_of(client, headers)
    target_id, case_ids = _seed_target(org_id, pid)

    monkeypatch.setattr(webverify, "run_check_sidecar",
                        lambda plan, timeout_s=None: _recorded(case_ids))

    r = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers)
    assert r.status_code == 202, r.text
    body = r.json()
    # The HTTP case in the same project is not part of a browser run.
    assert body["cases"] == 3
    poll_job(client, headers, body["job_id"])

    report = client.get(f"/v1/runs/{body['run_id']}/report", headers=headers)
    assert report.status_code == 200, report.text
    payload = report.json()

    assert payload["counts"]["total"] == 3
    assert payload["counts"]["passed"] == 1
    assert payload["counts"]["failed"] == 1
    # The whole point: an unevaluated check is its own outcome, never a pass.
    assert payload["counts"]["skipped"] == 1
    assert payload["counts"]["passed"] != 2

    outcomes = {c["test_case"]["title"]: c["outcome"] for c in payload["cases"]}
    assert outcomes["Form: 'login' renders every discovered field"] == "passed"
    assert outcomes["Form: 'login' rejects submission with Email empty"] == "failed"
    assert outcomes["Form: Notes accepts at most 5 characters"] == "skipped"


def test_a_verification_run_does_not_approve_anything(client, project, monkeypatch):
    """Human review is the gate; running a draft must not promote it."""
    headers, pid = project
    org_id = _org_of(client, headers)
    target_id, case_ids = _seed_target(org_id, pid)
    monkeypatch.setattr(webverify, "run_check_sidecar",
                        lambda plan, timeout_s=None: _recorded(case_ids))

    body = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers).json()
    poll_job(client, headers, body["job_id"])

    db = SessionLocal()
    try:
        states = {c.state for c in db.query(TestCase).filter(TestCase.id.in_(case_ids)).all()}
        assert states == {"draft"}
    finally:
        db.close()


def test_environment_is_derived_from_the_target_and_reused(client, project, monkeypatch):
    headers, pid = project
    org_id = _org_of(client, headers)
    target_id, case_ids = _seed_target(org_id, pid)
    monkeypatch.setattr(webverify, "run_check_sidecar",
                        lambda plan, timeout_s=None: _recorded(case_ids))

    first = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers).json()
    poll_job(client, headers, first["job_id"])
    second = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers).json()
    poll_job(client, headers, second["job_id"])

    assert first["environment_id"] == second["environment_id"]
    db = SessionLocal()
    try:
        envs = db.query(Environment).filter(Environment.project_id == pid).all()
        assert len(envs) == 1
        assert envs[0].base_url == "http://app.example.com"
    finally:
        db.close()


def test_a_case_the_browser_never_answered_is_errored_not_dropped(client, project, monkeypatch):
    """A short result list must not silently shrink the run's total."""
    headers, pid = project
    org_id = _org_of(client, headers)
    target_id, case_ids = _seed_target(org_id, pid)

    partial = _recorded(case_ids)
    partial["results"] = partial["results"][:1]
    monkeypatch.setattr(webverify, "run_check_sidecar",
                        lambda plan, timeout_s=None: partial)

    body = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers).json()
    poll_job(client, headers, body["job_id"])

    payload = client.get(f"/v1/runs/{body['run_id']}/report", headers=headers).json()
    assert payload["counts"]["total"] == 3
    assert payload["counts"]["errored"] == 2


# ---------------------------------------------------------------------------
# fix prompts
# ---------------------------------------------------------------------------

def _failed_entry() -> dict:
    return {
        "test_case": {"id": "abcdef0123456789", "title": "Form: 'login' rejects submission with Email empty"},
        "outcome": "failed",
        "severity": "critical",
        "failure_reason": {
            "message": "The form accepted an empty #email and submitted. A required field is not enforced.",
            "expected": "the form refuses submission while this required field is empty",
            "actual": "submitted anyway and navigated to /done",
            "selector": "#email", "assertion": "validation_error",
        },
        "evidence": [{"request": {"method": "BROWSER", "url": TARGET_URL}}],
        "requirements": [{"external_id": "WEB-F1",
                          "description": "The login form enforces its fields."}],
    }


def test_fix_prompt_states_the_defect_the_rule_and_the_repair():
    prompt = build_fix_prompt(_failed_entry(), run_label="RUN-42")
    assert "RUN-42" in prompt
    assert "A required field is not enforced." in prompt
    assert "#email" in prompt and TARGET_URL in prompt
    assert 'WEB-F1 — "The login form enforces its fields."' in prompt
    # The instruction is keyed to the assertion that actually failed.
    assert "reject the submission while this field is empty" in prompt
    assert "re-run" in prompt


def test_fix_prompt_never_invites_changing_the_test():
    prompt = build_fix_prompt(_failed_entry()).lower()
    assert "change the application, not the test" in prompt
    for weasel in ("relax the assertion", "update the expected value", "skip this test"):
        assert weasel not in prompt


def test_fix_prompt_is_deterministic():
    entry = _failed_entry()
    assert build_fix_prompt(entry, run_label="RUN-1") == build_fix_prompt(entry, run_label="RUN-1")


def test_fix_prompt_omits_what_the_evidence_does_not_say():
    bare = {"test_case": {"id": "x1", "title": "Some case"}, "outcome": "failed",
            "failure_reason": {"message": "It broke."}, "evidence": [], "requirements": []}
    prompt = build_fix_prompt(bare)
    assert "Requirement" not in prompt      # nothing was linked — say nothing
    assert "Where" not in prompt            # no url/selector recorded
    assert "It broke." in prompt


def test_errored_case_gets_a_reachability_instruction_not_a_rule_one():
    entry = {"test_case": {"id": "x2", "title": "Charging a card"}, "outcome": "errored",
             "failure_reason": {"error": "Read timeout after 2000ms"},
             "evidence": [], "requirements": []}
    prompt = build_fix_prompt(entry)
    assert "make the target reachable" in prompt
    assert "the rule was never evaluated" in prompt


def test_only_failures_carry_prompts():
    entries = [_failed_entry(),
               {"test_case": {"id": "ok"}, "outcome": "passed", "failure_reason": None,
                "evidence": [], "requirements": []}]
    prompts = fix_prompts_for(entries, run_label="RUN-9")
    assert len(prompts) == 1
    assert prompts[0]["test_case_id"] == "abcdef0123456789"


def test_report_attaches_prompts_to_failures_only(client, project, monkeypatch):
    headers, pid = project
    org_id = _org_of(client, headers)
    target_id, case_ids = _seed_target(org_id, pid)
    monkeypatch.setattr(webverify, "run_check_sidecar",
                        lambda plan, timeout_s=None: _recorded(case_ids))

    body = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers).json()
    poll_job(client, headers, body["job_id"])

    payload = client.get(f"/v1/runs/{body['run_id']}/report", headers=headers).json()
    by_outcome = {c["outcome"]: c for c in payload["cases"]}
    assert by_outcome["failed"]["fix_prompt"]
    assert by_outcome["passed"]["fix_prompt"] is None

    prompts = client.get(f"/v1/runs/{body['run_id']}/fix-prompts", headers=headers)
    assert prompts.status_code == 200, prompts.text
    data = prompts.json()
    assert data["total"] == 1
    assert "A required field is not enforced." in data["prompts"][0]["prompt"]


# ---------------------------------------------------------------------------
# regression: project deletion must cascade every table that points at it
# ---------------------------------------------------------------------------

def test_deleting_a_scanned_project_does_not_500(client, project, monkeypatch):
    """A project that has been scanned (and verified) must still be deletable.

    `delete_project` names each child table explicitly, and `web_targets`,
    `schedules`, `webhooks` and `components` were absent from that list — so any
    project the Target page had touched failed to delete with a FOREIGN KEY
    error behind a 500. Adding a table without adding it there is the failure
    mode this test pins.
    """
    headers, pid = project
    org_id = _org_of(client, headers)
    target_id, case_ids = _seed_target(org_id, pid)
    monkeypatch.setattr(webverify, "run_check_sidecar",
                        lambda plan, timeout_s=None: _recorded(case_ids))

    body = client.post(f"/v1/web-targets/{target_id}/verify", json={}, headers=headers).json()
    poll_job(client, headers, body["job_id"])

    r = client.delete(f"/v1/projects/{pid}", headers=headers)
    assert r.status_code in (200, 204), r.text

    db = SessionLocal()
    try:
        assert db.query(WebTarget).filter(WebTarget.project_id == pid).count() == 0
        assert db.query(Run).filter(Run.project_id == pid).count() == 0
        assert db.query(Environment).filter(Environment.project_id == pid).count() == 0
        assert db.query(TestResult).filter(TestResult.run_id == body["run_id"]).count() == 0
    finally:
        db.close()
