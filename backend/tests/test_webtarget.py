"""Web targets — point Traceo at a URL and pick what to test.

The claims under test:
  * the routes exist, are capability-gated, and org-scoped;
  * an unknown test type is REFUSED with the legal list, never ignored;
  * a missing sidecar fails the job with browser_discovery_unavailable and a
    message naming what to install — never a silent empty result;
  * a RECORDED sidecar payload produces the per-type persistence the contract
    states, without a browser ever being started here;
  * every generated case references an artefact the discovery actually found;
  * the api track writes Endpoint rows with source="dom", templated ids and all.
"""
import json
import time
from pathlib import Path

import pytest

from app.config import settings
from app.db import SessionLocal
from app import models
from app.models import Endpoint, Requirement, RequirementTestCase, WebTarget
from app.modules import webtarget
from app.modules.webtarget import (TEST_TYPES, artefact_ids, endpoints_from_requests,
                                   form_cases, form_label, grounding_violations,
                                   normalise_payload, validate_test_types)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
TARGET_URL = "http://localhost:8017/web/index.php/auth/login"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def recorded_payload():
    """The sidecar document recorded from the real SPA target. Nothing in this
    suite starts a browser: a unit test that shells out to Chromium is a network
    test wearing a costume."""
    doc = json.loads((FIXTURES / "webtarget_orangehrm.json").read_text())
    doc["screenshot"] = str(FIXTURES / "webtarget_screen.png")
    return doc


@pytest.fixture()
def project(client, register_org, create_project):
    """automation="manual" on purpose: these tests are about the tracks, and the
    autopilot chain would confirm their requirements out from under them. The
    handover itself is tested separately, in auto mode."""
    headers = register_org("Web Target Org")
    return headers, create_project(headers, "Web Target Project", automation="manual")


@pytest.fixture(autouse=True)
def _allow_local_targets(monkeypatch):
    """The SSRF guard is exercised in its own test; everywhere else the target is
    a loopback URL, which is exactly what the escape hatch exists for."""
    monkeypatch.setattr(settings, "ALLOW_PRIVATE_TARGETS", True)


@pytest.fixture()
def sidecar(monkeypatch, recorded_payload):
    """Replace the browser invocation with the recorded document."""
    calls = []

    def _fake(url, viewport, out_dir, timeout_s=None):
        calls.append({"url": url, "viewport": viewport})
        return recorded_payload

    monkeypatch.setattr(webtarget, "run_sidecar", _fake)
    return calls


def poll(client, headers, job_id, timeout=60.0):
    """Poll until the job reaches a terminal state — failure included."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert r.status_code == 200, r.text
        job = r.json()
        if job["status"] in ("completed", "failed"):
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} never finished")


def start(client, headers, project_id, types, url=TARGET_URL, viewport=None):
    body = {"url": url, "test_types": types}
    if viewport:
        body["viewport"] = viewport
    return client.post(f"/v1/projects/{project_id}/web-targets", json=body, headers=headers)


def run(client, headers, project_id, types, **kwargs):
    r = start(client, headers, project_id, types, **kwargs)
    assert r.status_code == 202, r.text
    return poll(client, headers, r.json()["job_id"]), r.json()


# ---------------------------------------------------------------------------
# 1. Request validation
# ---------------------------------------------------------------------------

def test_an_unknown_test_type_is_refused_with_the_legal_list(client, project):
    headers, pid = project
    r = start(client, headers, pid, ["functional", "perfomance"])
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_test_type"
    assert detail["errors"] == list(TEST_TYPES)
    assert "perfomance" in detail["message"]
    # and nothing was created for a request that was refused
    assert client.get(f"/v1/projects/{pid}/web-targets",
                      headers=headers).json()["web_targets"] == []


def test_no_test_type_at_all_is_refused(client, project):
    headers, pid = project
    r = start(client, headers, pid, [])
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_test_type"
    assert r.json()["detail"]["errors"] == list(TEST_TYPES)


def test_test_types_are_deduplicated_into_canonical_order():
    assert validate_test_types(["ui", "api", "ui"]) == ["api", "ui"]
    assert validate_test_types(["SECURITY", " functional "]) == ["functional", "security"]


def test_a_non_http_scheme_is_refused(client, project):
    headers, pid = project
    r = start(client, headers, pid, ["ui"], url="file:///etc/passwd")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_url"


def test_a_private_host_is_refused_unless_the_escape_hatch_is_set(client, project, monkeypatch):
    headers, pid = project
    monkeypatch.setattr(settings, "ALLOW_PRIVATE_TARGETS", False)
    r = start(client, headers, pid, ["ui"], url="http://127.0.0.1:8017/login")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "ssrf_blocked"


def test_an_impossible_viewport_is_refused(client, project):
    headers, pid = project
    r = start(client, headers, pid, ["ui"], viewport="banana")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_viewport"
    r = start(client, headers, pid, ["ui"], viewport="10x10")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# 2. Capability guards and org scoping
# ---------------------------------------------------------------------------

@pytest.fixture()
def viewer_headers(client, project):
    headers, _pid = project
    email = "viewer.webtarget@example.sa"
    r = client.post("/v1/members/invite", json={
        "email": email, "name": "Viewer", "role": "viewer", "password": "Passw0rd!"},
        headers=headers)
    assert r.status_code == 201, r.text
    r = client.post("/v1/auth/login", json={"email": email, "password": "Passw0rd!"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_a_viewer_may_read_targets_but_never_start_one(client, project, viewer_headers, sidecar):
    headers, pid = project
    run(client, headers, pid, ["functional"])

    r = client.get(f"/v1/projects/{pid}/web-targets", headers=viewer_headers)
    assert r.status_code == 200
    listed = r.json()["web_targets"]
    assert len(listed) == 1

    assert client.get(f"/v1/web-targets/{listed[0]['id']}",
                      headers=viewer_headers).status_code == 200
    assert client.get(f"/v1/web-targets/{listed[0]['id']}/screenshot",
                      headers=viewer_headers).status_code in (200, 404)

    r = start(client, viewer_headers, pid, ["functional"])
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"


def test_unauthenticated_access_is_rejected(client, project):
    _headers, pid = project
    assert client.get(f"/v1/projects/{pid}/web-targets").status_code == 401
    assert client.post(f"/v1/projects/{pid}/web-targets",
                       json={"url": TARGET_URL, "test_types": ["ui"]}).status_code == 401


def test_another_organisation_never_sees_the_target(client, project, register_org, sidecar):
    headers, pid = project
    _job, accepted = run(client, headers, pid, ["functional"])
    other = register_org("Other Org")
    r = client.get(f"/v1/web-targets/{accepted['target_id']}", headers=other)
    assert r.status_code == 404
    assert client.get(f"/v1/projects/{pid}/web-targets", headers=other).status_code == 404


# ---------------------------------------------------------------------------
# 3. The sidecar is missing — the failure that must never be silent
# ---------------------------------------------------------------------------

def test_a_missing_sidecar_script_fails_the_job_with_a_named_code(client, project, monkeypatch):
    headers, pid = project
    monkeypatch.setattr(settings, "WEB_DISCOVERY_SCRIPT", "/nonexistent/discover.mjs")
    r = start(client, headers, pid, ["functional", "ui"])
    assert r.status_code == 202
    job = poll(client, headers, r.json()["job_id"])

    assert job["status"] == "failed"
    assert job["error_code"] == "browser_discovery_unavailable"
    # the message must say what to install, not just that something went wrong
    assert "playwright" in job["error"].lower()
    assert "node" in job["error"].lower()

    target = client.get(f"/v1/web-targets/{r.json()['target_id']}", headers=headers).json()
    assert target["status"] == "failed"
    assert "browser_discovery_unavailable" in target["error"]


def test_a_missing_node_binary_fails_the_same_way(client, project, monkeypatch):
    headers, pid = project
    # a script that exists, and a node that does not — the other half of "unavailable"
    monkeypatch.setattr(settings, "WEB_DISCOVERY_SCRIPT",
                        str(FIXTURES / "webtarget_orangehrm.json"))
    monkeypatch.setattr(settings, "NODE_BIN", "/nonexistent/node-binary")
    r = start(client, headers, pid, ["api"])
    job = poll(client, headers, r.json()["job_id"])
    assert job["status"] == "failed"
    assert job["error_code"] == "browser_discovery_unavailable"


def test_a_sidecar_that_reports_playwright_missing_is_reported_as_unavailable(monkeypatch):
    """The sidecar's own error object is honoured, not second-guessed."""
    monkeypatch.setattr(settings, "WEB_DISCOVERY_SCRIPT",
                        str(FIXTURES / "webtarget_orangehrm.json"))

    class _Proc:
        returncode = 1
        stdout = json.dumps({"error": {"code": "playwright_missing",
                                       "message": "Playwright is not installed."}})
        stderr = ""

    monkeypatch.setattr(webtarget.subprocess, "run", lambda *a, **k: _Proc())
    with pytest.raises(webtarget.JobError) as exc:
        webtarget.run_sidecar(TARGET_URL, "1280x800", "/tmp")
    assert exc.value.code == "browser_discovery_unavailable"


def test_a_page_level_sidecar_failure_keeps_its_own_code(monkeypatch):
    monkeypatch.setattr(settings, "WEB_DISCOVERY_SCRIPT",
                        str(FIXTURES / "webtarget_orangehrm.json"))

    class _Proc:
        returncode = 1
        stdout = json.dumps({"error": {"code": "navigation_failed",
                                       "message": "net::ERR_NAME_NOT_RESOLVED"}})
        stderr = ""

    monkeypatch.setattr(webtarget.subprocess, "run", lambda *a, **k: _Proc())
    with pytest.raises(webtarget.JobError) as exc:
        webtarget.run_sidecar(TARGET_URL, "1280x800", "/tmp")
    assert exc.value.code == "navigation_failed"


# ---------------------------------------------------------------------------
# 4. The recorded payload — per-type persistence
# ---------------------------------------------------------------------------

def test_the_recorded_payload_drives_every_selected_track(client, project, sidecar):
    headers, pid = project
    job, accepted = run(client, headers, pid, list(TEST_TYPES))
    assert job["status"] == "completed", job.get("error")
    result = job["result"]

    assert result["target_id"] == accepted["target_id"]
    assert result["title"] == "OrangeHRM"
    assert result["forms"] == 2
    assert result["controls"] == 3
    assert result["requests"] == 8            # every request, not only the API ones
    assert result["endpoints"] == 4           # the xhr/fetch ones, ids templated
    assert result["requirements"] >= 5        # 2 forms + perf + ui + api surface
    for kind in ("functional", "ui", "performance", "security", "api"):
        assert result["cases_by_type"][kind] > 0, (kind, result)

    db = SessionLocal()
    try:
        target = db.get(WebTarget, accepted["target_id"])
        assert target.status == "discovered"
        assert target.title == "OrangeHRM"
        assert target.final_url.endswith("/auth/login")
        assert target.last_discovered_at is not None
        assert target.screenshot_key.endswith(".png")
    finally:
        db.close()


def test_the_api_track_writes_dom_endpoints_with_templated_ids(client, project, sidecar):
    headers, pid = project
    run(client, headers, pid, ["api"])

    rows = client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json()
    by_key = {(e["method"], e["path"]): e for e in rows}
    assert set(by_key) == {
        ("GET", "/web/index.php/api/v2/admin/validation/user-name"),
        ("GET", "/web/index.php/api/v2/pim/employees/{id}"),
        ("POST", "/web/index.php/api/v2/auth/session"),
        ("GET", "/web/index.php/api/v2/core/i18n/messages"),
    }
    assert all(e["source"] == "dom" for e in rows)
    # the two concrete employee ids collapsed onto ONE templated endpoint, and the
    # count says it was seen twice
    employees = by_key[("GET", "/web/index.php/api/v2/pim/employees/{id}")]
    assert employees["observed_count"] == 2
    assert [p["name"] for p in employees["parameters"]] == ["id"]
    assert employees["parameters"][0]["location"] == "path"
    assert employees["parameters"][0]["required"] is True
    # a query string becomes a query parameter carrying the observed example
    username = by_key[("GET", "/web/index.php/api/v2/admin/validation/user-name")]
    query = [p for p in username["parameters"] if p["location"] == "query"]
    assert [p["name"] for p in query] == ["userName"]
    assert query[0]["constraints"]["example"] == "Admin"
    # document/script/image requests are NOT endpoints
    assert not any("logo.png" in e["path"] for e in rows)


def test_a_spec_endpoint_is_never_downgraded_by_a_crawl(client, project, sidecar):
    """Fidelity precedence (SRS §L2): dom outranks postman and nothing else."""
    headers, pid = project
    spec = {
        "openapi": "3.0.3", "info": {"title": "PIM", "version": "1"},
        "paths": {"/web/index.php/api/v2/pim/employees/{id}": {"get": {
            "operationId": "getEmployee", "summary": "Declared by the spec",
            "parameters": [{"name": "id", "in": "path", "required": True,
                            "schema": {"type": "integer"}}],
            "responses": {"200": {"description": "OK"}}}}},
    }
    r = client.post(f"/v1/projects/{pid}/api-specs",
                    files={"file": ("spec.json", json.dumps(spec).encode(), "application/json")},
                    headers=headers)
    assert r.status_code in (200, 201), r.text

    run(client, headers, pid, ["api"])
    rows = {(e["method"], e["path"]): e
            for e in client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json()}
    declared = rows[("GET", "/web/index.php/api/v2/pim/employees/{id}")]
    assert declared["source"] == "spec"
    assert declared["summary"] == "Declared by the spec"   # the crawl did not overwrite it
    # the endpoints the spec never mentioned still arrived from the DOM
    assert rows[("POST", "/web/index.php/api/v2/auth/session")]["source"] == "dom"


def test_the_functional_track_makes_a_requirement_per_form(client, project, sidecar):
    headers, pid = project
    run(client, headers, pid, ["functional"])

    reqs = client.get(f"/v1/projects/{pid}/requirements", headers=headers).json()
    reqs = reqs["requirements"] if isinstance(reqs, dict) else reqs
    login = [r for r in reqs if "form.oxd-form" in (r["description"] or "")]
    assert len(login) == 1
    assert login[0]["state"] == "extracted"          # awaiting confirmation
    assert "form.oxd-form" in login[0]["description"]
    assert "input[name=username]" in login[0]["description"]
    assert "Required: Username, Password" in login[0]["description"]
    assert len(reqs) == 2                            # one per discovered form


def test_functional_cases_carry_the_form_selectors_verbatim(client, project, sidecar):
    headers, pid = project
    run(client, headers, pid, ["functional"])

    db = SessionLocal()
    try:
        steps = (db.query(models.TestStep)
                 .join(models.TestCase, models.TestCase.id == models.TestStep.test_case_id)
                 .filter(models.TestCase.project_id == pid).all())
        assert steps
        for step in steps:
            assert step.request.get("form", "").startswith(("form.", "form#"))
        payloads = json.dumps([s.request for s in steps])
        assert "input[name=username]" in payloads
        assert "input[name=password]" in payloads
        # the required-field negative for each required field of the login form
        titles = [c.title for c in db.query(models.TestCase).filter(models.TestCase.project_id == pid).all()]
        assert any("rejects submission with Username empty" in t for t in titles)
        assert any("rejects submission with Password empty" in t for t in titles)
        # the search field declares maxlength and a pattern — both become cases
        assert any("at most 120 characters" in t for t in titles)
        assert any("enforces its declared pattern" in t for t in titles)
    finally:
        db.close()


def test_the_ui_track_extracts_design_facts_and_a_palette_with_shares(client, project, sidecar):
    headers, pid = project
    _job, accepted = run(client, headers, pid, ["ui"])

    detail = client.get(f"/v1/web-targets/{accepted['target_id']}", headers=headers).json()
    design = detail["design"]
    assert design["fact_count"] >= 8
    palette = {p["hex"]: p["share"] for p in design["palette"]}
    assert "#FFFFFF" in palette and "#F0903F" in palette
    assert 0 < palette["#F0903F"] < 1

    failing = [c for c in design["contrast"] if c["passes_aa"] is False]
    assert failing, design["contrast"]
    # the remediation is the point: a failure without the passing colour leaves
    # the designer guessing
    assert failing[0]["suggested"] != failing[0]["ink"]
    assert failing[0]["ratio_after"] >= 4.5
    assert failing[0]["achievable"] is True


def test_ui_cases_only_ever_cite_a_fact_the_design_states(client, project, sidecar):
    headers, pid = project
    _job, accepted = run(client, headers, pid, ["ui"])
    detail = client.get(f"/v1/web-targets/{accepted['target_id']}", headers=headers).json()
    stated = {f["id"] for f in detail["design"]["facts"]}

    db = SessionLocal()
    try:
        cases = db.query(models.TestCase).filter(models.TestCase.project_id == pid,
                                          models.TestCase.technique.in_(("design", "a11y"))).all()
        assert cases
        for case in cases:
            fact = case.steps[0].request.get("fact")
            assert fact in stated, f"{case.title} cites {fact!r}"
    finally:
        db.close()


def test_the_performance_track_states_a_budget_against_the_observed_baseline(
        client, project, sidecar):
    headers, pid = project
    run(client, headers, pid, ["performance"])

    db = SessionLocal()
    try:
        req = db.query(Requirement).filter(Requirement.project_id == pid,
                                           Requirement.type == "non_functional").one()
        assert "2410ms" in req.description
        case = db.query(models.TestCase).filter(models.TestCase.project_id == pid,
                                         models.TestCase.technique == "performance").one()
        assertion = case.steps[0].assertions[0]
        assert assertion["type"] == "page_load_ms"
        assert assertion["expected_max"] == settings.PAGE_LOAD_BUDGET_MS
        assert assertion["observed_baseline_ms"] == 2410
    finally:
        db.close()


def test_the_security_track_builds_the_s0_classes_on_the_discovered_endpoints(
        client, project, sidecar):
    headers, pid = project
    job, _accepted = run(client, headers, pid, ["security"])
    assert job["result"]["cases_by_type"]["security"] > 0

    db = SessionLocal()
    try:
        cases = db.query(models.TestCase).filter(models.TestCase.project_id == pid,
                                          models.TestCase.technique == "security").all()
        assert cases
        assert all(c.weakness_id for c in cases)
        endpoint_ids = {e.id for e in db.query(Endpoint).filter(
            Endpoint.project_id == pid, Endpoint.source == "dom").all()}
        assert endpoint_ids
        for case in cases:
            # every security step is bound to an endpoint the crawl discovered
            assert case.steps[0].endpoint_id in endpoint_ids
    finally:
        db.close()


def test_the_api_track_generates_cases_bound_to_the_captured_requests(
        client, project, sidecar):
    """Selecting `api` must produce cases, not merely an endpoint inventory.

    Every step has to address an endpoint the crawl actually observed: a case
    against a path the browser never called would be exactly the fabrication
    BO-07 exists to stop."""
    headers, pid = project
    job, _accepted = run(client, headers, pid, ["api"])
    assert job["result"]["cases_by_type"]["api"] > 0, job["result"]

    db = SessionLocal()
    try:
        dom = {e.id: (e.method.upper(), e.path) for e in db.query(Endpoint).filter(
            Endpoint.project_id == pid, Endpoint.source == "dom").all()}
        assert dom
        cases = db.query(models.TestCase).filter(
            models.TestCase.project_id == pid,
            models.TestCase.technique != "security").all()
        assert cases
        for case in cases:
            step = case.steps[0]
            assert step.endpoint_id in dom, (case.title, step.path)
            assert (step.method.upper(), step.path) == dom[step.endpoint_id]
            assert step.assertions
    finally:
        db.close()


def test_every_generated_case_is_linked_to_a_requirement(client, project, sidecar):
    headers, pid = project
    run(client, headers, pid, list(TEST_TYPES))
    db = SessionLocal()
    try:
        cases = db.query(models.TestCase).filter(models.TestCase.project_id == pid).all()
        linked = {r.test_case_id for r in db.query(RequirementTestCase).all()}
        assert cases
        assert all(c.id in linked for c in cases)
    finally:
        db.close()


def test_rerunning_the_same_target_refreshes_it_instead_of_duplicating(client, project, sidecar):
    headers, pid = project
    _job, first = run(client, headers, pid, list(TEST_TYPES))
    db = SessionLocal()
    try:
        cases_before = db.query(models.TestCase).filter(models.TestCase.project_id == pid).count()
        reqs_before = db.query(Requirement).filter(Requirement.project_id == pid).count()
    finally:
        db.close()

    job, second = run(client, headers, pid, list(TEST_TYPES))
    assert second["target_id"] == first["target_id"]
    assert job["result"]["duplicates"] > 0          # the re-run recognised its own cases

    db = SessionLocal()
    try:
        assert db.query(WebTarget).filter(WebTarget.project_id == pid).count() == 1
        assert db.query(models.TestCase).filter(models.TestCase.project_id == pid).count() == cases_before
        assert db.query(Requirement).filter(Requirement.project_id == pid).count() == reqs_before
    finally:
        db.close()


def test_the_screenshot_route_serves_the_png(client, project, sidecar):
    headers, pid = project
    _job, accepted = run(client, headers, pid, ["ui"])
    r = client.get(f"/v1/web-targets/{accepted['target_id']}/screenshot", headers=headers)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_a_target_without_a_screenshot_says_so(client, project, monkeypatch, recorded_payload):
    headers, pid = project
    recorded_payload["screenshot"] = ""
    monkeypatch.setattr(webtarget, "run_sidecar",
                        lambda *a, **k: recorded_payload)
    job, accepted = run(client, headers, pid, ["ui"])
    assert {"type": "ui", "reason": "the sidecar produced no screenshot"} in job["result"]["skipped"]
    r = client.get(f"/v1/web-targets/{accepted['target_id']}/screenshot", headers=headers)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "no_screenshot"


def test_a_page_with_no_api_calls_reports_the_reason(client, project, monkeypatch,
                                                     recorded_payload):
    headers, pid = project
    recorded_payload["requests"] = [r for r in recorded_payload["requests"]
                                    if r["resourceType"] not in ("xhr", "fetch")]
    monkeypatch.setattr(webtarget, "run_sidecar", lambda *a, **k: recorded_payload)
    job, _accepted = run(client, headers, pid, ["api", "security"])
    reasons = {s["type"]: s["reason"] for s in job["result"]["skipped"]}
    assert "api" in reasons and "security" in reasons
    assert "XHR/fetch" in reasons["api"]
    assert job["result"]["endpoints"] == 0


# ---------------------------------------------------------------------------
# 5. Grounding — the rule that does not bend
# ---------------------------------------------------------------------------

def test_the_artefact_set_is_exactly_what_the_render_found(recorded_payload):
    inv = normalise_payload(recorded_payload)
    ids = artefact_ids(inv)
    assert "selector:input[name=username]" in ids
    assert "selector:form.oxd-form" in ids
    assert ("request:GET https://opensource-demo.orangehrmlive.com/web/index.php/"
            "api/v2/pim/employees/7") in ids
    assert "selector:input[name=nonexistent]" not in ids


def test_a_case_citing_an_undiscovered_selector_is_a_violation(recorded_payload):
    inv = normalise_payload(recorded_payload)
    ids = artefact_ids(inv)
    invented = {"title": "x", "grounds": ["selector:#totally-made-up"]}
    assert grounding_violations(invented, ids)
    assert grounding_violations({"title": "x", "grounds": []}, ids) == \
        ["case references no discovered artefact"]
    real = {"title": "x", "grounds": ["selector:input[name=password]"]}
    assert grounding_violations(real, ids) == []


def test_every_form_case_is_grounded_in_the_form_it_came_from(recorded_payload):
    inv = normalise_payload(recorded_payload)
    ids = artefact_ids(inv)
    for form in inv["forms"]:
        cases = form_cases(form, inv)
        assert cases
        for case in cases:
            assert grounding_violations(case, ids) == []


def test_a_nameless_form_is_labelled_by_what_the_page_shows(recorded_payload):
    """A real SPA form usually carries neither name nor id. Falling straight
    through to the CSS selector produced titles that repeated a 200-character
    path twice, so the heading and the submit control — both of which the
    sidecar already reports — are read first."""
    doc = {"forms": [{
        "selector": "#app > div:nth-of-type(1) > div > form",
        "heading": "Login",
        "submits": [{"selector": "#app form button", "name": "Login",
                     "type": "submit"}],
        "fields": [{"selector": "input[name=username]", "name": "username"}],
    }]}
    form = normalise_payload(doc)["forms"][0]
    # a bare <button> is the form's submit control, and it is captured
    assert form["submit"] == "#app form button"
    assert form["submit_name"] == "Login"
    assert form["heading"] == "Login"
    assert form_label(form) == "Login"

    # the page's own naming still outranks both
    doc["forms"][0]["name"] = "signin"
    assert form_label(normalise_payload(doc)["forms"][0]) == "signin"

    # and a form the page says nothing about still gets an unambiguous label
    bare = normalise_payload({"forms": [{"selector": "form.x"}]})["forms"][0]
    assert form_label(bare) == "form.x"


def test_a_field_without_a_selector_is_dropped_rather_than_invented():
    doc = {"forms": [{"selector": "form#a", "fields": [
        {"name": "ghost", "required": True},               # no selector -> dropped
        {"selector": "#real", "name": "real", "required": True},
    ]}]}
    inv = normalise_payload(doc)
    assert [f["selector"] for f in inv["forms"][0]["fields"]] == ["#real"]


def test_unknown_sidecar_keys_are_tolerated(recorded_payload):
    recorded_payload["future_field"] = {"anything": [1, 2, 3]}
    recorded_payload["forms"][0]["shadow_root"] = True
    inv = normalise_payload(recorded_payload)
    assert len(inv["forms"]) == 2
    assert inv["elapsed_ms"] == 2410


def test_endpoints_from_requests_ignores_non_api_resources(recorded_payload):
    inv = normalise_payload(recorded_payload)
    ops = endpoints_from_requests(inv["requests"])
    assert {op["source"] for op in ops} == {"dom"}
    assert all(op["path"].startswith("/") for op in ops)
    assert not any("logo" in op["path"] for op in ops)


def test_discovery_hands_over_to_the_autopilot_in_auto_mode(client, register_org,
                                                            create_project, sidecar):
    """A crawl's requirements must not stop at "extracted".

    The whole point of pointing Traceo at a URL and walking away is that the
    chain continues: confirm what the crawl extracted, then run the generator
    over it. Without this the URL path silently ends at the deterministic
    builders and the model-assisted cases are never produced — a difference the
    counts alone would not reveal, since the deterministic ones are still there.
    It still stops at DRAFT cases: approval and runs stay manual (BO-07).
    """
    headers = register_org("Autopilot Org")
    pid = create_project(headers, "Auto Project", automation="auto")

    job, _accepted = run(client, headers, pid, list(TEST_TYPES))
    assert job["status"] == "completed", job.get("error")
    assert job["result"]["auto_confirmed"] >= 1

    states = {r["state"] for r in client.get(
        f"/v1/projects/{pid}/requirements", headers=headers).json()}
    assert states == {"confirmed"}, f"the crawl's requirements were left at {states}"

    entries = client.get("/v1/audit", headers=headers).json()["items"]
    actions = {e["action"]: e["detail"] for e in entries}
    assert "auto.requirements.confirm_all" in actions
    assert actions["auto.requirements.confirm_all"]["source"] == "web_target"

    cases = client.get(f"/v1/projects/{pid}/test-cases?limit=500",
                       headers=headers).json()["test_cases"]
    assert cases and all(c["state"] == "draft" for c in cases), \
        "the autopilot must stop at draft — approval stays manual"


def test_manual_mode_leaves_the_crawls_requirements_alone(client, register_org,
                                                          create_project, sidecar):
    """automation="manual" means manual: nothing is confirmed on the user's behalf."""
    headers = register_org("Manual Org")
    pid = create_project(headers, "Manual Project", automation="manual")

    job, _accepted = run(client, headers, pid, list(TEST_TYPES))
    assert job["status"] == "completed", job.get("error")
    assert "auto_confirmed" not in job["result"]

    states = {r["state"] for r in client.get(
        f"/v1/projects/{pid}/requirements", headers=headers).json()}
    assert states == {"extracted"}
