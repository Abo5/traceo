"""Where results land — FR-070 Jira/Xray, FR-011 Confluence, FR-072 Slack.

Every outbound call is made through `integrations._request`; these tests replace that
one seam with a recorder, so the request Traceo *would* send is asserted exactly
without touching the network.
"""
from datetime import datetime, timezone

import pytest
from conftest import add_requirement, confirm_requirement, import_spec, items_of, poll_job

from app.db import SessionLocal
from app.models import Run, TestResult
from app.modules import integrations


class FakeResponse:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text or str(self._payload)

    def json(self):
        return self._payload


@pytest.fixture()
def outbound(monkeypatch):
    """Records every outbound integration call and returns canned responses."""
    calls = []
    responses = []

    def _request(method, url, *, secrets, **kwargs):
        calls.append({"method": method, "url": url, **kwargs})
        return responses.pop(0) if responses else FakeResponse(200, {"key": "PAY-1"})

    monkeypatch.setattr(integrations, "_request", _request)
    return type("Outbound", (), {"calls": calls, "responses": responses})()


# ---------------------------------------------------------------- fixtures

def _failed_run(client, headers, create_project):
    """A project with one failed result, ready to export as a defect."""
    pid = create_project(headers, name="Payments", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(client, headers, pid, "PAY-014",
                          "A refund above 1000 SAR requires approval",
                          criteria=["Refund over 1000 is held for approval"],
                          priority="high")
    confirm_requirement(client, headers, rid)
    case = client.post(f"/v1/projects/{pid}/test-cases", json={
        "title": "Refund over 1000 requires approval", "type": "negative", "priority": "high",
        "steps": [{"method": "POST", "path": "/customers",
                   "request": {"body": {"name": "A", "phone": "0512345678", "age": 30}},
                   "assertions": [{"type": "json_field", "path": "status",
                                   "op": "eq", "expected": "held"}]}],
        "requirement_ids": [rid],
    }, headers=headers).json()
    client.post(f"/v1/test-cases/{case['id']}/approve", headers=headers)

    env = client.post(f"/v1/projects/{pid}/environments",
                      json={"name": "stg", "base_url": "http://127.0.0.1:9/"},
                      headers=headers).json()
    org_id = client.get("/v1/me", headers=headers).json()["organisation_id"]

    db = SessionLocal()
    try:
        run = Run(organisation_id=org_id, project_id=pid, environment_id=env["id"],
                  state="completed", initiated_by="seed", branch="main",
                  counts={"total": 1, "passed": 0, "failed": 1, "errored": 0},
                  started_at=datetime.now(timezone.utc),
                  finished_at=datetime.now(timezone.utc))
        db.add(run)
        db.flush()
        result = TestResult(
            run_id=run.id, test_case_id=case["id"], test_case_version=1,
            outcome="failed", duration_ms=42,
            failure_reason={"assertion": {"type": "json_field", "path": "status",
                                          "expected": "held"},
                            "actual": "settled", "step_index": 0},
            evidence=[{"request": {"method": "POST", "url": "/refunds",
                                   "headers": {"Authorization": "••••••••"},
                                   "body": '{"amount": 1500}'},
                       "response": {"status": 200, "body": '{"status": "settled"}'},
                       "elapsed_ms": 42}])
        db.add(result)
        db.commit()
        return pid, run.id, result.id, case["id"]
    finally:
        db.close()


def _jira(client, headers, pid):
    return client.post("/v1/integrations", json={
        "type": "jira", "name": "Jira Cloud", "project_id": pid,
        "config": {"base_url": "https://acme.atlassian.net", "project_key": "PAY",
                   "email": "qa@acme.sa"},
        "secret": {"api_token": "atl-super-secret-token"},
    }, headers=headers).json()


# ---------------------------------------------------------------- CRUD + secrets

def test_integration_never_returns_its_credential(client, register_org, create_project):
    headers = register_org("Secret Org")
    pid = create_project(headers, name="P", language="en")
    created = _jira(client, headers, pid)

    assert created["secret_set"] is True
    assert created["secret_rotated_at"]          # FR-083 AC3: name + rotation date only
    body = client.get("/v1/integrations", headers=headers).text
    assert "atl-super-secret-token" not in body
    assert "api_token" not in body

    rotated = client.patch(f"/v1/integrations/{created['id']}",
                           json={"secret": {"api_token": "rotated-token"}},
                           headers=headers)
    assert rotated.status_code == 200 and "rotated-token" not in rotated.text


def test_integration_config_is_validated(client, register_org, create_project):
    headers = register_org("Validate Org")
    pid = create_project(headers, name="P", language="en")
    r = client.post("/v1/integrations",
                    json={"type": "jira", "config": {"base_url": "https://x"}},
                    headers=headers)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "missing_config"
    r = client.post("/v1/integrations", json={"type": "carrier-pigeon", "config": {}},
                    headers=headers)
    assert r.status_code == 422 and r.json()["detail"]["code"] == "invalid_type"


# ---------------------------------------------------------------- Jira export

def test_defect_export_creates_then_updates_the_same_issue(client, register_org,
                                                           create_project, outbound):
    headers = register_org("Export Org")
    pid, run_id, result_id, _case = _failed_run(client, headers, create_project)
    jira = _jira(client, headers, pid)

    outbound.responses.append(FakeResponse(201, {"key": "PAY-231"}))
    r = client.post(f"/v1/runs/{run_id}/results/{result_id}/export",
                    json={"integration_id": jira["id"]}, headers=headers)
    assert r.status_code == 200, r.text
    first = r.json()
    assert first["action"] == "created" and first["external_key"] == "PAY-231"
    assert first["external_url"].endswith("/browse/PAY-231")   # AC4
    assert first["severity"] == "critical"                     # AC1: severity carried

    created_call = outbound.calls[-1]
    assert created_call["method"] == "POST"
    fields = created_call["json"]["fields"]
    assert fields["project"]["key"] == "PAY"
    assert fields["priority"]["name"] == "Highest"
    description = fields["description"]
    assert "PAY-014" in description                # the requirement
    assert "Reproduction steps" in description     # AC1: steps
    assert "POST /customers" in description
    assert "Expected: held" in description and "Actual: settled" in description
    assert "atl-super-secret-token" not in description

    # AC2 — re-exporting the same failure updates, never duplicates
    outbound.responses.append(FakeResponse(204, {}))
    again = client.post(f"/v1/runs/{run_id}/results/{result_id}/export",
                        json={"integration_id": jira["id"]}, headers=headers)
    assert again.json()["action"] == "updated"
    assert again.json()["external_key"] == "PAY-231"
    assert outbound.calls[-1]["method"] == "PUT"
    assert "PAY-231" in outbound.calls[-1]["url"]

    exports = client.get(f"/v1/runs/{run_id}/exports", headers=headers).json()["exports"]
    assert len(exports) == 1, "one issue per failure, however many times it is exported"


def test_a_passing_result_is_not_exportable(client, register_org, create_project, outbound):
    headers = register_org("Pass Export Org")
    pid, run_id, result_id, _case = _failed_run(client, headers, create_project)
    jira = _jira(client, headers, pid)
    db = SessionLocal()
    try:
        db.get(TestResult, result_id).outcome = "passed"
        db.commit()
    finally:
        db.close()
    r = client.post(f"/v1/runs/{run_id}/results/{result_id}/export",
                    json={"integration_id": jira["id"]}, headers=headers)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_a_defect"


def test_jira_failure_surfaces_as_a_readable_error(client, register_org,
                                                   create_project, outbound):
    headers = register_org("Jira Error Org")
    pid, run_id, result_id, _case = _failed_run(client, headers, create_project)
    jira = _jira(client, headers, pid)
    outbound.responses.append(FakeResponse(403, {}, text="insufficient permissions"))
    r = client.post(f"/v1/runs/{run_id}/results/{result_id}/export",
                    json={"integration_id": jira["id"]}, headers=headers)
    assert r.status_code == 502
    assert "403" in r.json()["detail"]["message"]
    state = client.get("/v1/integrations", headers=headers).json()["integrations"][0]
    assert state["state"] == "error" and state["last_error"]


def test_xray_sync_posts_one_execution_with_every_verdict(client, register_org,
                                                          create_project, outbound):
    headers = register_org("Xray Org")
    pid, run_id, _result, _case = _failed_run(client, headers, create_project)
    xray = client.post("/v1/integrations", json={
        "type": "xray", "project_id": pid,
        "config": {"base_url": "https://xray.cloud.getxray.app"},
        "secret": {"api_token": "xray-token"}}, headers=headers).json()

    outbound.responses.append(FakeResponse(200, {"key": "PAY-500"}))
    r = client.post(f"/v1/runs/{run_id}/xray/sync",
                    json={"integration_id": xray["id"]}, headers=headers)
    assert r.status_code == 200 and r.json()["execution_key"] == "PAY-500"   # AC3
    payload = outbound.calls[-1]["json"]
    assert payload["tests"][0]["status"] == "FAILED"
    assert payload["info"]["testEnvironments"] == ["main"]


# ---------------------------------------------------------------- Slack

def test_slack_alert_level_decides_delivery(client, register_org, create_project, outbound):
    headers = register_org("Slack Org")
    pid, run_id, _result, _case = _failed_run(client, headers, create_project)
    slack = client.post("/v1/integrations", json={
        "type": "slack", "project_id": pid, "alert_level": "failures",
        "config": {"webhook_url": "https://hooks.slack.com/services/T/B/x"},
        "secret": {"webhook_url": "https://hooks.slack.com/services/T/B/secret"},
    }, headers=headers).json()

    r = client.post(f"/v1/runs/{run_id}/notify", headers=headers)
    assert r.json()["deliveries"][0]["delivered"] is True
    text = outbound.calls[-1]["json"]["text"]
    assert "1 failed" in text and "branch `main`" in text
    assert outbound.calls[-1]["url"].endswith("/secret"), \
        "the encrypted webhook must win over the plaintext config copy"

    # regressions-only stays quiet on a run with no regression
    client.patch(f"/v1/integrations/{slack['id']}",
                 json={"alert_level": "regressions"}, headers=headers)
    before = len(outbound.calls)
    client.post(f"/v1/runs/{run_id}/notify", headers=headers)
    assert len(outbound.calls) == before, "regressions-only must not post a plain failure"


# ---------------------------------------------------------------- Confluence

def test_confluence_import_parses_pages_and_reimport_marks_stale(
        client, register_org, create_project, outbound):
    headers = register_org("Confluence Org")
    pid = create_project(headers, name="Wiki", language="en")
    conf = client.post("/v1/integrations", json={
        "type": "confluence", "project_id": pid,
        "config": {"base_url": "https://acme.atlassian.net", "space_key": "QA",
                   "email": "qa@acme.sa"},
        "secret": {"api_token": "conf-token"}}, headers=headers).json()

    outbound.responses.append(FakeResponse(200, {"results": [
        {"id": "77", "title": "Order rules", "version": {"number": 3}}]}))
    pages = client.get(f"/v1/integrations/{conf['id']}/confluence/pages",
                       headers=headers).json()
    assert pages["pages"][0]["id"] == "77"     # AC1

    def page(rule):
        return FakeResponse(200, {
            "title": "Order rules", "version": {"number": 3},
            "body": {"storage": {"value":
                     f"<h1>Order rules</h1><p>REQ-500: {rule}</p>"}}})

    outbound.responses.append(page("An order must contain at least one item."))
    r = client.post(f"/v1/projects/{pid}/confluence/import",
                    json={"integration_id": conf["id"], "page_ids": ["77"]},
                    headers=headers)
    assert r.status_code == 202, r.text
    poll_job(client, headers, r.json()["imported"][0]["job_id"])

    reqs = items_of(client.get(f"/v1/projects/{pid}/requirements", headers=headers).json())
    assert any(q["external_id"] == "REQ-500" for q in reqs)     # AC2
    original = next(q for q in reqs if q["external_id"] == "REQ-500")
    assert original["version"] == 1

    # AC3 — the page changed, so the requirement is re-versioned and flagged
    outbound.responses.append(page("An order must contain at least three items."))
    r = client.post(f"/v1/projects/{pid}/confluence/import",
                    json={"integration_id": conf["id"], "page_ids": ["77"]},
                    headers=headers)
    poll_job(client, headers, r.json()["imported"][0]["job_id"])

    reqs = items_of(client.get(f"/v1/projects/{pid}/requirements", headers=headers).json())
    updated = next(q for q in reqs if q["external_id"] == "REQ-500")
    assert updated["version"] == 2
    assert updated["state"] == "changed"
    assert "three items" in updated["description"]


# ---------------------------------------------------------------- on-premise

def test_on_premise_mode_blocks_unlisted_egress(monkeypatch):
    """FR-081 AC2 — nothing leaves the network unless the operator named the host."""
    from app.config import settings

    monkeypatch.setattr(settings, "ON_PREMISE", True)
    monkeypatch.setattr(settings, "EGRESS_ALLOWLIST", ["jira.internal.sa"])

    with pytest.raises(integrations.IntegrationError) as blocked:
        integrations._assert_egress_allowed("https://acme.atlassian.net/rest/api/3/issue")
    assert "on-premise" in str(blocked.value)
    assert "TRACEO_EGRESS_ALLOWLIST" in str(blocked.value)

    # an allow-listed host, and its subdomains, are permitted
    integrations._assert_egress_allowed("https://jira.internal.sa/rest/api/3/issue")
    integrations._assert_egress_allowed("https://eu.jira.internal.sa/rest/api/3/issue")
