"""Unattended operation — FR-060 schedules, FR-061 CI gate, FR-062 regression watch.

The gate is the contract a pipeline depends on: it must fail loudly, exit non-zero,
and name the requirement that broke — not merely report a number.
"""
from datetime import datetime, timedelta, timezone

from conftest import add_requirement, confirm_requirement, import_spec, items_of

from app.db import SessionLocal
from app.models import Requirement, RequirementTestCase, Run, TestCase, TestResult
from app.modules.automation import next_fire_after, parse_cron, run_due_schedules


# ---------------------------------------------------------------- helpers

def _environment(client, headers, pid, name="staging"):
    r = client.post(f"/v1/projects/{pid}/environments",
                    json={"name": name, "base_url": "http://127.0.0.1:9/", "auth_type": "none"},
                    headers=headers)
    assert r.status_code in (200, 201), r.text
    return r.json()["id"]


def _seed_run(pid, org_id, env_id, outcomes, *, branch="", state="completed",
              created_at=None):
    """Write a completed run with the given {case_id: outcome} directly — the gate
    reads history, and building it through the executor would need a live SUT."""
    db = SessionLocal()
    try:
        run = Run(organisation_id=org_id, project_id=pid, environment_id=env_id,
                  state=state, initiated_by="seed", branch=branch, source="manual",
                  counts={"total": len(outcomes),
                          "passed": sum(1 for o in outcomes.values() if o == "passed"),
                          "failed": sum(1 for o in outcomes.values() if o == "failed"),
                          "errored": 0},
                  started_at=created_at or datetime.now(timezone.utc),
                  finished_at=created_at or datetime.now(timezone.utc))
        if created_at:
            run.created_at = created_at
        db.add(run)
        db.flush()
        for case_id, outcome in outcomes.items():
            db.add(TestResult(run_id=run.id, test_case_id=case_id, test_case_version=1,
                              outcome=outcome, duration_ms=5,
                              failure_reason={"assertion": {"type": "json_field",
                                                            "expected": "approved"},
                                              "actual": "rejected"}
                              if outcome != "passed" else None,
                              evidence=[]))
        db.commit()
        return run.id
    finally:
        db.close()


def _org_of(client, headers):
    return client.get("/v1/me", headers=headers).json()["organisation_id"]


def _covered_project(client, headers, create_project, priority="high"):
    """A project with one confirmed requirement covered by one approved case."""
    pid = create_project(headers, name="Gate Project", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(client, headers, pid, "REQ-001",
                          "Orders must be created for valid customers",
                          criteria=["A valid customer creates an order"],
                          priority=priority)
    confirm_requirement(client, headers, rid)
    r = client.post(f"/v1/projects/{pid}/test-cases", json={
        "title": "Create customer succeeds", "type": "positive", "priority": priority,
        "steps": [{"method": "POST", "path": "/customers",
                   "request": {"body": {"name": "A", "phone": "0512345678", "age": 30}},
                   "assertions": [{"type": "status_code", "expected": 201}]}],
        "requirement_ids": [rid],
    }, headers=headers)
    assert r.status_code in (200, 201), r.text
    case_id = r.json()["id"]
    client.post(f"/v1/test-cases/{case_id}/approve", headers=headers)
    return pid, rid, case_id


# ---------------------------------------------------------------- cron

def test_cron_parsing_accepts_the_usual_forms_and_rejects_nonsense():
    assert 0 in parse_cron("0 2 * * *")[0]
    assert parse_cron("*/15 * * * *")[0] == {0, 15, 30, 45}
    assert parse_cron("0 9-17 * * 1-5")[1] == set(range(9, 18))
    for bad in ("0 2 * *", "60 2 * * *", "0 2 * * 9", "x 2 * * *", "*/0 * * * *"):
        try:
            parse_cron(bad)
        except ValueError:
            continue
        raise AssertionError(f"expected '{bad}' to be rejected")


def test_next_fire_is_computed_in_the_schedules_own_timezone():
    # 02:00 Asia/Riyadh is 23:00 UTC the previous day (AST = UTC+3, no DST).
    after = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
    fire = next_fire_after("0 2 * * *", after, "Asia/Riyadh")
    assert fire.hour == 23 and fire.tzinfo == timezone.utc
    assert fire > after


# ---------------------------------------------------------------- gate policy

def test_gate_policy_round_trips_and_validates(client, register_org, create_project):
    headers = register_org("Gate Org")
    pid = create_project(headers, name="P", language="en")

    default = client.get(f"/v1/projects/{pid}/gate", headers=headers).json()
    assert default["min_coverage_pct"] == 80.0 and default["block_on"] == "high_priority"

    r = client.put(f"/v1/projects/{pid}/gate", json={
        "enabled": True, "min_coverage_pct": 90, "max_new_failures": 2,
        "block_on": "any"}, headers=headers)
    assert r.status_code == 200 and r.json()["max_new_failures"] == 2
    assert client.get(f"/v1/projects/{pid}/gate", headers=headers).json()["block_on"] == "any"

    bad = client.put(f"/v1/projects/{pid}/gate",
                     json={"block_on": "sometimes"}, headers=headers)
    assert bad.status_code == 422


def test_gate_passes_when_the_policy_is_met(client, register_org, create_project):
    headers = register_org("Gate Pass Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    client.put(f"/v1/projects/{pid}/gate",
               json={"min_coverage_pct": 100, "max_new_failures": 0,
                     "block_on": "high_priority"}, headers=headers)

    run_id = _seed_run(pid, _org_of(client, headers), env_id, {case_id: "passed"})
    verdict = client.get(f"/v1/runs/{run_id}/gate", headers=headers).json()

    assert verdict["passed"] is True
    assert verdict["exit_code"] == 0          # AC2
    assert verdict["coverage_pct"] == 100.0
    assert verdict["breaches"] == []
    assert verdict["report_url"].endswith("/report.html")  # AC4


def test_gate_fails_and_names_the_breaching_requirement(client, register_org,
                                                        create_project):
    headers = register_org("Gate Fail Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    org_id = _org_of(client, headers)
    client.put(f"/v1/projects/{pid}/gate",
               json={"min_coverage_pct": 50, "max_new_failures": 0,
                     "block_on": "high_priority"}, headers=headers)

    earlier = datetime.now(timezone.utc) - timedelta(hours=2)
    _seed_run(pid, org_id, env_id, {case_id: "passed"}, created_at=earlier)
    run_id = _seed_run(pid, org_id, env_id, {case_id: "failed"})

    verdict = client.get(f"/v1/runs/{run_id}/gate", headers=headers).json()
    assert verdict["passed"] is False
    assert verdict["exit_code"] == 1
    assert verdict["new_failures"] == 1
    codes = {b["code"] for b in verdict["breaches"]}
    assert "new_failures_exceeded" in codes
    assert "high_priority_requirement_failing" in codes
    named = [r["external_id"] for b in verdict["breaches"] for r in b["requirements"]]
    assert "REQ-001" in named, f"the gate must name the requirement: {verdict['breaches']}"


def test_gate_reports_coverage_breach_with_the_shortfall(client, register_org,
                                                         create_project):
    headers = register_org("Coverage Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    # A second confirmed requirement with no case at all drops coverage to 50%.
    rid2 = add_requirement(client, headers, pid, "REQ-002", "Refunds are auditable")
    confirm_requirement(client, headers, rid2)
    client.put(f"/v1/projects/{pid}/gate",
               json={"min_coverage_pct": 80, "block_on": "none"}, headers=headers)

    run_id = _seed_run(pid, _org_of(client, headers), env_id, {case_id: "passed"})
    verdict = client.get(f"/v1/runs/{run_id}/gate", headers=headers).json()
    assert verdict["coverage_pct"] == 50.0
    assert verdict["passed"] is False
    breach = next(b for b in verdict["breaches"] if b["code"] == "coverage_below_minimum")
    assert "50.0%" in breach["message"] and "80" in breach["message"]


def test_a_disabled_gate_never_blocks(client, register_org, create_project):
    headers = register_org("Disabled Gate Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    client.put(f"/v1/projects/{pid}/gate",
               json={"enabled": False, "min_coverage_pct": 100, "block_on": "any"},
               headers=headers)
    run_id = _seed_run(pid, _org_of(client, headers), env_id, {case_id: "failed"})
    verdict = client.get(f"/v1/runs/{run_id}/gate", headers=headers).json()
    assert verdict["passed"] is True and verdict["exit_code"] == 0


def test_gate_compares_within_a_branch(client, register_org, create_project):
    """A failure that also failed on this branch's previous run is not a regression."""
    headers = register_org("Branch Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    org_id = _org_of(client, headers)
    client.put(f"/v1/projects/{pid}/gate",
               json={"min_coverage_pct": 0, "max_new_failures": 0, "block_on": "none"},
               headers=headers)

    now = datetime.now(timezone.utc)
    _seed_run(pid, org_id, env_id, {case_id: "passed"}, branch="main",
              created_at=now - timedelta(hours=3))
    _seed_run(pid, org_id, env_id, {case_id: "failed"}, branch="feature/x",
              created_at=now - timedelta(hours=2))
    run_id = _seed_run(pid, org_id, env_id, {case_id: "failed"}, branch="feature/x",
                       created_at=now - timedelta(hours=1))

    verdict = client.get(f"/v1/runs/{run_id}/gate", headers=headers).json()
    assert verdict["new_failures"] == 0, \
        "comparing against main would have called this a regression"
    assert verdict["passed"] is True


# ---------------------------------------------------------------- CI tokens

def test_ci_token_authenticates_and_is_scoped_to_its_project(client, register_org,
                                                             create_project):
    headers = register_org("Token Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    other_pid = create_project(headers, name="Other", language="en")
    env_id = _environment(client, headers, pid)

    r = client.post("/v1/tokens", json={"name": "github-actions", "project_id": pid,
                                        "role": "qa_engineer"}, headers=headers)
    assert r.status_code == 201, r.text
    clear = r.json()["token"]
    assert clear.startswith("trc_")
    ci = {"Authorization": f"Bearer {clear}"}

    # the token can start a run on its own project…
    r = client.post(f"/v1/projects/{pid}/ci/runs",
                    json={"environment_id": env_id, "branch": "main"}, headers=ci)
    assert r.status_code == 202, r.text
    assert r.json()["gate_url"].endswith("/gate")

    # …and is refused on any other project
    r = client.get(f"/v1/projects/{other_pid}/gate", headers=ci)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "token_scope"

    # listing never exposes the secret, and revocation takes effect immediately
    listed = client.get("/v1/tokens", headers=headers).json()["tokens"]
    assert all("token" not in t for t in listed)
    assert listed[0]["prefix"] == clear[:12]
    client.delete(f"/v1/tokens/{listed[0]['id']}", headers=headers)
    assert client.get(f"/v1/projects/{pid}/gate", headers=ci).status_code == 401


def test_ci_token_role_is_enforced(client, register_org, create_project):
    headers = register_org("Viewer Token Org")
    pid, _rid, _case = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    clear = client.post("/v1/tokens", json={"name": "readonly", "project_id": pid,
                                            "role": "viewer"},
                        headers=headers).json()["token"]
    ci = {"Authorization": f"Bearer {clear}"}
    assert client.get(f"/v1/projects/{pid}/gate", headers=ci).status_code == 200
    r = client.post(f"/v1/projects/{pid}/ci/runs", json={"environment_id": env_id},
                    headers=ci)
    assert r.status_code == 403, "a viewer token must not be able to start runs"


def test_ci_run_is_refused_while_the_environment_is_busy(client, register_org,
                                                         create_project):
    headers = register_org("Busy Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    _seed_run(pid, _org_of(client, headers), env_id, {case_id: "passed"}, state="running")

    r = client.post(f"/v1/projects/{pid}/ci/runs", json={"environment_id": env_id},
                    headers=headers)
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "environment_busy"


# ---------------------------------------------------------------- schedules

def test_schedule_crud_and_cron_validation(client, register_org, create_project):
    headers = register_org("Schedule Org")
    pid, _rid, _case = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)

    r = client.post(f"/v1/projects/{pid}/schedules",
                    json={"environment_id": env_id, "cron": "0 2 * * *"}, headers=headers)
    assert r.status_code == 201, r.text
    sched = r.json()
    assert sched["timezone"] == "Asia/Riyadh"   # AC1 default
    assert sched["next_due_at"]

    bad = client.post(f"/v1/projects/{pid}/schedules",
                      json={"environment_id": env_id, "cron": "every tuesday"},
                      headers=headers)
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "invalid_cron"

    r = client.patch(f"/v1/schedules/{sched['id']}", json={"enabled": False},
                     headers=headers)
    assert r.json()["enabled"] is False
    assert client.delete(f"/v1/schedules/{sched['id']}", headers=headers).status_code == 204
    assert client.get(f"/v1/projects/{pid}/schedules",
                      headers=headers).json()["schedules"] == []


def test_due_schedule_fires_a_run_tagged_scheduler(client, register_org, create_project):
    headers = register_org("Fire Org")
    pid, _rid, _case = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    client.post(f"/v1/projects/{pid}/schedules",
                json={"environment_id": env_id, "cron": "*/5 * * * *", "branch": "nightly"},
                headers=headers)

    # Tick at a moment past the schedule's next_due_at.
    db = SessionLocal()
    try:
        fired = run_due_schedules(db, datetime.now(timezone.utc) + timedelta(hours=1))
    finally:
        db.close()
    assert len(fired) == 1 and fired[0]["status"] == "started", fired

    runs = items_of(client.get(f"/v1/projects/{pid}/runs", headers=headers).json())
    assert runs[0]["source"] == "scheduler"   # AC2
    assert runs[0]["branch"] == "nightly"


def test_overlapping_schedule_is_deferred_not_run_concurrently(client, register_org,
                                                               create_project):
    headers = register_org("Overlap Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    _seed_run(pid, _org_of(client, headers), env_id, {case_id: "passed"}, state="running")
    client.post(f"/v1/projects/{pid}/schedules",
                json={"environment_id": env_id, "cron": "*/5 * * * *"}, headers=headers)

    db = SessionLocal()
    try:
        fired = run_due_schedules(db, datetime.now(timezone.utc) + timedelta(hours=1))
    finally:
        db.close()
    assert fired and fired[0]["status"] == "deferred"   # AC3

    states = [r["state"] for r in items_of(
        client.get(f"/v1/projects/{pid}/runs", headers=headers).json())]
    assert states.count("running") == 1, "a second run must not start against the environment"


# ---------------------------------------------------------------- regression watch

def test_dashboard_regression_watch_and_trend_filters(client, register_org, create_project):
    headers = register_org("Watch Org")
    pid, _rid, case_id = _covered_project(client, headers, create_project)
    env_id = _environment(client, headers, pid)
    org_id = _org_of(client, headers)
    now = datetime.now(timezone.utc)
    _seed_run(pid, org_id, env_id, {case_id: "passed"}, branch="main",
              created_at=now - timedelta(hours=2))
    _seed_run(pid, org_id, env_id, {case_id: "failed"}, branch="main",
              created_at=now - timedelta(hours=1))

    dash = client.get(f"/v1/projects/{pid}/dashboard", headers=headers).json()
    watch = dash["regression_watch"]
    assert len(watch) == 1                                   # FR-062 AC1
    assert "REQ-001" in watch[0]["requirement_external_ids"]  # AC2
    assert watch[0]["severity"] in ("critical", "major", "minor")

    assert dash["branches"] == ["main"]
    trend = dash["trend"]
    assert len(trend) == 2 and trend[-1]["dropped"] is True   # FR-054 AC3
    assert trend[-1]["delta"] == -100.0

    filtered = client.get(f"/v1/projects/{pid}/dashboard",
                          params={"branch": "does-not-exist"}, headers=headers).json()
    assert filtered["trend"] == []                            # FR-054 AC2
