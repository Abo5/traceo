"""The whole testing process as one job.

The claims under test:
  * the document is genuinely optional, and skipping it is RECORDED with a
    reason rather than silently omitted;
  * a document already parsed on upload is reused, not parsed a second time
    (a re-parse diffs the same file to zeros and reads like an empty document);
  * only the cases THIS run produced are executed — pointing the pipeline at a
    page must not re-run a project's existing 500 cases;
  * a browser case never goes to the HTTP engine, and vice versa;
  * stage progress is scaled into the parent job instead of resetting the bar;
  * the combined result carries counts across every run plus one fix prompt per
    failure.

No browser and no LLM: the scan and browser-check stages are monkeypatched, the
same way test_webtarget.py and test_webverify.py replace their sidecars.
"""
import pytest

from app.config import settings
from app.db import SessionLocal
from app.models import (Endpoint, Requirement, SourceDocument, TestCase,
                        TestStep, WebTarget)
from app.modules import pipeline, webtarget, webverify
from app.modules.pipeline import _Stage, http_runnable

from conftest import poll_job

URL = "http://localhost:8017/login"


@pytest.fixture(autouse=True)
def _allow_local_target(monkeypatch):
    """The suite aims at a loopback URL, so lift the SSRF guard the way a local
    development stack does (TRACEO_ALLOW_PRIVATE_TARGETS=1). test_webtarget.py
    does the same; the guard itself is tested there."""
    monkeypatch.setattr(settings, "ALLOW_PRIVATE_TARGETS", True)


@pytest.fixture()
def project(client, register_org, create_project):
    headers = register_org("Pipeline Org")
    return headers, create_project(headers, "Pipeline Project")


def _org_of(headers) -> str:
    import base64, json
    payload = headers["Authorization"].split(" ", 1)[1].split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))["org"]


class _FakeJob:
    """Enough of a Job for the pipeline body to write progress into."""
    def __init__(self):
        self.id = "job-fake"
        self.kind = "pipeline"
        self.project_id = None
        self.progress = 0.0
        self.message = ""


def _fake_scan(org_id, project_id, target_id, *, forms=1, endpoints=0):
    """Stand in for run_discovery_job: write what a scan would have written."""
    def _run(job, _org, _user, _project, _target, url, viewport, test_types):
        job.progress = 0.5
        job.message = "Rendering"
        db = SessionLocal()
        try:
            target = db.get(WebTarget, target_id)
            target.status = "discovered"
            target.final_url = url
            req = Requirement(organisation_id=org_id, project_id=project_id,
                              external_id="WEB-F1", description="The form enforces its fields.",
                              type="functional", priority="high", state="extracted", version=1)
            db.add(req)
            db.flush()
            tc = TestCase(organisation_id=org_id, project_id=project_id,
                          title="Form: 'login' rejects submission with Email empty",
                          description="", preconditions="", type="negative",
                          priority="high", state="draft", generated=True, technique="ep")
            db.add(tc)
            db.flush()
            db.add(TestStep(test_case_id=tc.id, order=0, method="GET", path="/login",
                            request={"check": "required_field_enforced", "url": url,
                                     "form": "form#login", "empty": "#email",
                                     "filled": ["#username"]},
                            assertions=[{"type": "validation_error"}], extractions=[]))
            if endpoints:
                db.add(Endpoint(organisation_id=org_id, project_id=project_id,
                                method="GET", path="/api/session", source="dom"))
            db.commit()
        finally:
            db.close()
        return {"target_id": target_id, "forms": forms, "requests": 1,
                "endpoints": endpoints, "requirements": 1,
                "cases_by_type": {"functional": 1}, "skipped": [], "discarded": 0}
    return _run


def _fake_check(outcome="failed"):
    def _run(plan, timeout_s=None):
        return {
            "ok": True, "url": URL, "final_url": URL, "load_ms": 12, "elapsed_ms": 300,
            "results": [{
                "case_id": c["id"], "outcome": outcome, "duration_ms": 40,
                "assertions": [{"type": "validation_error", "outcome": outcome,
                                "expected": "refused", "actual": "submitted",
                                "message": "A required field is not enforced.",
                                "selector": "#email"}],
                "failure": ({"message": "A required field is not enforced.",
                             "expected": "refused", "actual": "submitted",
                             "selector": "#email", "assertion": "validation_error"}
                            if outcome == "failed" else None),
            } for c in plan["cases"]],
        }
    return _run


# ---------------------------------------------------------------------------
# unit: selection and progress
# ---------------------------------------------------------------------------

def test_http_runnable_excludes_browser_cases_and_foreign_ids(client, project):
    headers, pid = project
    org_id = _org_of(headers)
    db = SessionLocal()
    try:
        made = {}
        for key, request in (("dom", {"check": "elements_present", "url": URL}),
                             ("http", {"body": {}}),
                             ("other", {"body": {}})):
            tc = TestCase(organisation_id=org_id, project_id=pid, title=key,
                          description="", preconditions="", type="positive",
                          priority="medium", state="draft", generated=True, technique="ep")
            db.add(tc)
            db.flush()
            db.add(TestStep(test_case_id=tc.id, order=0, method="GET",
                            path="/x", request=request, assertions=[], extractions=[]))
            made[key] = tc.id
        db.commit()

        # "other" exists but is not part of this run's id set.
        picked = http_runnable(db, org_id, pid, {made["dom"], made["http"]})
        assert picked == [made["http"]]
        assert http_runnable(db, org_id, pid, set()) == []
    finally:
        db.close()


def test_stage_progress_is_scaled_into_the_parent_not_reset():
    parent = _FakeJob()
    stage = _Stage(parent, 0.20, 0.60, "Scan")
    stage.progress = 0.0
    assert parent.progress == pytest.approx(0.20)
    stage.progress = 0.5
    assert parent.progress == pytest.approx(0.40)
    stage.progress = 1.0
    assert parent.progress == pytest.approx(0.60)
    stage.message = "Rendering"
    assert parent.message == "Scan: Rendering"


# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------

def test_without_a_document_the_stage_is_skipped_with_a_reason(client, project, monkeypatch):
    headers, pid = project
    org_id = _org_of(headers)

    monkeypatch.setattr(webverify, "run_check_sidecar", _fake_check("passed"))
    monkeypatch.setattr(webtarget, "run_discovery_job", _lazy_scan(org_id, pid))

    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": URL, "test_types": ["functional"]}, headers=headers)
    assert r.status_code == 202, r.text
    job = poll_job(client, headers, r.json()["job_id"], timeout=60)
    stages = {s["stage"]: s for s in job["result"]["stages"]}

    assert stages["requirements"]["status"] == "skipped"
    assert "No document" in stages["requirements"]["reason"]
    assert stages["scan"]["status"] == "completed"
    assert stages["browser_run"]["status"] == "completed"


def test_an_already_parsed_document_is_reused_not_reparsed(client, project, monkeypatch):
    headers, pid = project
    org_id = _org_of(headers)
    monkeypatch.setattr(webverify, "run_check_sidecar", _fake_check("passed"))
    monkeypatch.setattr(webtarget, "run_discovery_job", _lazy_scan(org_id, pid))

    db = SessionLocal()
    try:
        doc = SourceDocument(organisation_id=org_id, project_id=pid,
                             filename="brd.md", mime_type="text/markdown", size=10,
                             storage_key="k", language="en", version=1,
                             parse_status="parsed")
        db.add(doc)
        db.commit()
        doc_id = doc.id
    finally:
        db.close()

    called = {"ingest": 0}

    def _boom(*a, **k):
        called["ingest"] += 1
        raise AssertionError("the pipeline re-parsed a document already parsed on upload")

    monkeypatch.setattr(pipeline, "_run_ingest", _boom)

    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": URL, "test_types": ["functional"], "document_id": doc_id},
                    headers=headers)
    job = poll_job(client, headers, r.json()["job_id"], timeout=60)
    stages = {s["stage"]: s for s in job["result"]["stages"]}
    assert stages["requirements"]["status"] == "reused"
    assert called["ingest"] == 0


def test_only_cases_this_run_produced_are_executed(client, project, monkeypatch):
    """A project full of existing cases must not be re-run by a page scan."""
    headers, pid = project
    org_id = _org_of(headers)

    db = SessionLocal()
    try:
        for i in range(3):
            tc = TestCase(organisation_id=org_id, project_id=pid, title=f"pre-existing {i}",
                          description="", preconditions="", type="positive",
                          priority="medium", state="approved", generated=True, technique="ep")
            db.add(tc)
            db.flush()
            db.add(TestStep(test_case_id=tc.id, order=0, method="GET", path="/old",
                            request={"body": {}}, assertions=[], extractions=[]))
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(webverify, "run_check_sidecar", _fake_check("passed"))
    monkeypatch.setattr(webtarget, "run_discovery_job", _lazy_scan(org_id, pid))

    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": URL, "test_types": ["functional"]}, headers=headers)
    job = poll_job(client, headers, r.json()["job_id"], timeout=60)
    result = job["result"]

    # One browser case was created by the scan; the three old HTTP cases are
    # outside this run and must not have been executed.
    assert result["counts"]["total"] == 1
    stages = {s["stage"]: s for s in result["stages"]}
    assert stages["http_run"]["status"] == "skipped"


def test_failures_come_back_with_one_fix_prompt_each(client, project, monkeypatch):
    headers, pid = project
    org_id = _org_of(headers)
    monkeypatch.setattr(webverify, "run_check_sidecar", _fake_check("failed"))
    monkeypatch.setattr(webtarget, "run_discovery_job", _lazy_scan(org_id, pid))

    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": URL, "test_types": ["functional"]}, headers=headers)
    job = poll_job(client, headers, r.json()["job_id"], timeout=60)
    result = job["result"]

    assert result["counts"]["failed"] == 1
    assert len(result["fix_prompts"]) == 1
    prompt = result["fix_prompts"][0]["prompt"]
    assert "A required field is not enforced." in prompt
    assert "#email" in prompt
    assert "Change the application, not the test" in prompt


def test_unknown_document_is_refused(client, project):
    headers, pid = project
    # Validation order is url -> viewport -> test types -> document, so the
    # document refusal is only reachable with the earlier fields valid.
    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": URL, "test_types": ["functional"],
                          "document_id": "does-not-exist"}, headers=headers)
    assert r.status_code == 404, r.text
    assert r.json()["detail"]["code"] == "not_found"


def test_a_bad_url_is_refused_before_anything_runs(client, project):
    headers, pid = project
    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": "ftp://nope"}, headers=headers)
    assert r.status_code == 422, r.text


def test_viewer_cannot_start_a_run(client, project, register_org, create_project):
    headers, pid = project
    other = register_org("Other Org")
    r = client.post(f"/v1/projects/{pid}/pipeline",
                    json={"url": URL, "test_types": ["functional"]}, headers=other)
    assert r.status_code == 404, r.text


# `_lazy_scan` is defined after the tests that use it only for readability: the
# fixture needs the org and project ids, which the tests own.
def _lazy_scan(org_id, project_id):
    holder = {}

    def _run(job, _org, _user, _project, target_id, url, viewport, test_types):
        if "fn" not in holder:
            holder["fn"] = _fake_scan(org_id, project_id, target_id)
        return holder["fn"](job, _org, _user, _project, target_id, url, viewport, test_types)
    return _run


# ---------------------------------------------------------------------------
# regression: a re-run must check the same things
# ---------------------------------------------------------------------------

def test_a_second_run_over_the_same_page_checks_the_same_cases(client, project, monkeypatch):
    """The fix loop depends on this.

    Selecting HTTP cases on "created during this job" meant a re-run silently
    stopped executing the cases the FIRST run had created — the scan recognises
    them as duplicates and does not write them again, so they fell out of the
    new-id set. Observed: a security case that failed on run 1 was not run at
    all on run 2, which then reported all-green. A green re-run that quietly
    checked less is the exact failure this feature exists to prevent.
    """
    headers, pid = project
    org_id = _org_of(headers)
    monkeypatch.setattr(webverify, "run_check_sidecar", _fake_check("passed"))

    db = SessionLocal()
    try:
        ep = Endpoint(organisation_id=org_id, project_id=pid,
                      method="GET", path="/api/session", source="dom")
        db.add(ep)
        db.flush()
        # An HTTP case grounded to that discovered endpoint, as the security
        # track would have written on a previous run.
        tc = TestCase(organisation_id=org_id, project_id=pid,
                      title="Security: response carries the security headers",
                      description="", preconditions="", type="negative",
                      priority="high", state="draft", generated=True, technique="security")
        db.add(tc)
        db.flush()
        db.add(TestStep(test_case_id=tc.id, order=0, endpoint_id=ep.id, method="GET",
                        path="/api/session", request={}, assertions=[], extractions=[]))
        db.commit()
        existing_case = tc.id
        endpoint_ids = {ep.id}
    finally:
        db.close()

    db = SessionLocal()
    try:
        # Nothing is "new" on a re-run — the case already existed.
        picked = pipeline.http_runnable(db, org_id, pid, set(), endpoint_ids)
        assert existing_case in picked, (
            "a case calling an endpoint discovered from this page must be re-run")
    finally:
        db.close()
