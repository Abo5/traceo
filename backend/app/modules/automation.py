"""Automation module — the unattended half of the product.

FR-060 Scheduled runs   cron-style, per project + environment, AST by default,
                        overlapping runs queued rather than run concurrently.
FR-061 CI/CD gate       a policy (minimum coverage, maximum new failures, block-on
                        class) evaluated against a finished run; the verdict carries
                        an exit code and NAMES the breaching requirement, so a
                        pipeline step can fail loudly without parsing prose.
FR-062 Regression watch is served by the dashboard (projects module) — the gate here
                        reuses the same run-over-run comparison.

CI runners authenticate with a `trc_` API token (see deps._principal_from_api_token)
which carries its own role and may be scoped to a single project.
"""
from datetime import datetime, timedelta, timezone, tzinfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import assert_token_scope, audit, get_project_scoped, require
from ..models import (ApiToken, Environment, GatePolicy, Requirement,
                      RequirementTestCase, Run, Schedule, TestCase, TestResult, User)
from ..security import generate_api_token
from .execution import (NoApprovedCases, RunQueued, get_environment_scoped,
                        start_run)
from .traceability import is_high_priority, run_display_id

router = APIRouter()

BLOCK_ON = ("any", "high_priority", "none")


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Gate policy
# ---------------------------------------------------------------------------

class GatePolicyBody(BaseModel):
    enabled: bool = True
    min_coverage_pct: float = Field(default=80.0, ge=0, le=100)
    max_new_failures: int = Field(default=0, ge=0)
    block_on: str = "high_priority"


def _policy_payload(p: GatePolicy) -> dict:
    return {"project_id": p.project_id, "enabled": p.enabled,
            "min_coverage_pct": p.min_coverage_pct,
            "max_new_failures": p.max_new_failures, "block_on": p.block_on,
            "updated_at": _iso(p.updated_at)}


def _get_or_default_policy(db: Session, org_id: str, project_id: str) -> GatePolicy:
    policy = db.query(GatePolicy).filter(GatePolicy.project_id == project_id).first()
    if policy:
        return policy
    # A project that has never configured a gate still has one. Column defaults only
    # materialise on INSERT, so the transient default carries its values explicitly.
    defaults = GatePolicyBody()
    return GatePolicy(organisation_id=org_id, project_id=project_id, enabled=defaults.enabled,
                      min_coverage_pct=defaults.min_coverage_pct,
                      max_new_failures=defaults.max_new_failures,
                      block_on=defaults.block_on)


@router.get("/projects/{project_id}/gate")
def get_gate_policy(project_id: str, user: User = Depends(require("view")),
                    db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    assert_token_scope(user, project_id)
    return _policy_payload(_get_or_default_policy(db, user.organisation_id, project_id))


@router.put("/projects/{project_id}/gate")
def set_gate_policy(project_id: str, body: GatePolicyBody,
                    user: User = Depends(require("manage_projects")),
                    db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    if body.block_on not in BLOCK_ON:
        raise HTTPException(422, detail={"code": "invalid_block_on",
                                         "message": f"block_on must be one of: {', '.join(BLOCK_ON)}"})
    policy = db.query(GatePolicy).filter(GatePolicy.project_id == project_id).first()
    if not policy:
        policy = GatePolicy(organisation_id=user.organisation_id, project_id=project_id)
        db.add(policy)
    policy.enabled = body.enabled
    policy.min_coverage_pct = body.min_coverage_pct
    policy.max_new_failures = body.max_new_failures
    policy.block_on = body.block_on
    audit(db, user.organisation_id, user.id, "gate.updated", "project", project_id,
          _policy_payload(policy))
    db.commit()
    return _policy_payload(policy)


# ---------------------------------------------------------------------------
# Gate evaluation
# ---------------------------------------------------------------------------

def _outcomes_of(db: Session, run_id: str) -> dict[str, TestResult]:
    latest: dict[str, TestResult] = {}
    for res in (db.query(TestResult).filter(TestResult.run_id == run_id)
                .order_by(TestResult.created_at.asc(), TestResult.id.asc()).all()):
        latest[res.test_case_id] = res
    return latest


def _requirements_of_cases(db: Session, case_ids: list[str]) -> dict[str, list[Requirement]]:
    out: dict[str, list[Requirement]] = {cid: [] for cid in case_ids}
    if not case_ids:
        return out
    rows = (db.query(RequirementTestCase, Requirement)
            .join(Requirement, Requirement.id == RequirementTestCase.requirement_id)
            .filter(RequirementTestCase.test_case_id.in_(case_ids)).all())
    for link, req in rows:
        out.setdefault(link.test_case_id, []).append(req)
    return out


def _requirement_coverage(db: Session, project_id: str, org_id: str) -> tuple[float, int, int]:
    """Confirmed requirements carrying at least one approved case — the same
    definition the dashboard and the matrix use, so the gate cannot disagree
    with the screen a QA lead is looking at."""
    confirmed = (db.query(Requirement.id)
                 .filter(Requirement.project_id == project_id,
                         Requirement.organisation_id == org_id,
                         Requirement.state == "confirmed").all())
    total = len(confirmed)
    if not total:
        return 0.0, 0, 0
    ids = {rid for (rid,) in confirmed}
    covered_rows = (db.query(RequirementTestCase.requirement_id)
                    .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
                    .filter(TestCase.project_id == project_id,
                            TestCase.organisation_id == org_id,
                            TestCase.state == "approved").all())
    covered = len({rid for (rid,) in covered_rows if rid in ids})
    return round(covered / total * 100, 1), covered, total


def _previous_completed_run(db: Session, run: Run) -> Run | None:
    """The most recent completed run before this one, on the same branch when the
    run declares one — comparing a feature branch against main would report
    failures that are not regressions."""
    q = (db.query(Run)
         .filter(Run.project_id == run.project_id,
                 Run.organisation_id == run.organisation_id,
                 Run.state == "completed",
                 Run.id != run.id,
                 Run.created_at <= run.created_at))
    if run.branch:
        q = q.filter(Run.branch == run.branch)
    return q.order_by(Run.created_at.desc(), Run.id.desc()).first()


def evaluate_gate(db: Session, run: Run) -> dict:
    """FR-061 AC1/AC2/AC4. Returns the verdict payload including the exit code a
    CI step should exit with and the requirements that caused the breach."""
    policy = _get_or_default_policy(db, run.organisation_id, run.project_id)
    coverage_pct, covered, total_reqs = _requirement_coverage(
        db, run.project_id, run.organisation_id)

    current = _outcomes_of(db, run.id)
    previous_run = _previous_completed_run(db, run)
    previous = _outcomes_of(db, previous_run.id) if previous_run else {}

    failing_ids = [cid for cid, res in current.items()
                   if res.outcome in ("failed", "errored")]
    new_failure_ids = [cid for cid in failing_ids
                       if previous.get(cid) is not None and previous[cid].outcome == "passed"]

    reqs_by_case = _requirements_of_cases(db, failing_ids)
    titles = {}
    if failing_ids:
        titles = {tc.id: tc.title for tc in db.query(TestCase)
                  .filter(TestCase.id.in_(failing_ids)).all()}

    def _req_labels(case_ids: list[str]) -> list[dict]:
        seen: dict[str, dict] = {}
        for cid in case_ids:
            for req in reqs_by_case.get(cid, []):
                seen.setdefault(req.id, {
                    "requirement_id": req.id,
                    "external_id": req.external_id,
                    "priority": req.priority,
                    "test_case_id": cid,
                    "test_case_title": titles.get(cid, ""),
                })
        return sorted(seen.values(), key=lambda r: (r["external_id"] or "", r["requirement_id"]))

    high_priority_failures = [cid for cid in failing_ids
                              if any(is_high_priority(r.priority)
                                     for r in reqs_by_case.get(cid, []))]

    breaches: list[dict] = []
    if policy.enabled:
        if coverage_pct < policy.min_coverage_pct:
            breaches.append({
                "code": "coverage_below_minimum",
                "message": (f"Requirement coverage {coverage_pct}% is below the "
                            f"required {policy.min_coverage_pct}% "
                            f"({covered}/{total_reqs} requirements covered)"),
                "requirements": [],
            })
        if len(new_failure_ids) > policy.max_new_failures:
            breaches.append({
                "code": "new_failures_exceeded",
                "message": (f"{len(new_failure_ids)} newly failing case(s) exceed the "
                            f"allowed {policy.max_new_failures}"),
                "requirements": _req_labels(new_failure_ids),
            })
        if policy.block_on == "any" and failing_ids:
            breaches.append({
                "code": "failures_present",
                "message": f"{len(failing_ids)} failing case(s) and block_on=any",
                "requirements": _req_labels(failing_ids),
            })
        elif policy.block_on == "high_priority" and high_priority_failures:
            breaches.append({
                "code": "high_priority_requirement_failing",
                "message": (f"{len(high_priority_failures)} failing case(s) belong to a "
                            f"high-priority requirement"),
                "requirements": _req_labels(high_priority_failures),
            })

    passed = not breaches
    display = run_display_id(db, run)
    return {
        "run_id": run.id,
        "display_id": display,
        "run_state": run.state,
        "branch": run.branch or "",
        "source": run.source or "manual",
        "policy": _policy_payload(policy),
        "coverage_pct": coverage_pct,
        "covered_requirements": covered,
        "total_requirements": total_reqs,
        "counts": run.counts or {},
        "new_failures": len(new_failure_ids),
        "compared_with": previous_run.id if previous_run else None,
        "breaches": breaches,
        "passed": passed,
        "exit_code": 0 if passed else 1,  # FR-061 AC2
        "report_url": f"/v1/runs/{run.id}/report.html",  # FR-061 AC4
    }


@router.get("/runs/{run_id}/gate")
def run_gate(run_id: str, user: User = Depends(require("view")),
             db: Session = Depends(get_db)):
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    assert_token_scope(user, run.project_id)
    if run.state in ("queued", "running"):
        raise HTTPException(409, detail={"code": "run_in_flight",
                                         "message": f"Run is still {run.state}"})
    return evaluate_gate(db, run)


# ---------------------------------------------------------------------------
# CI trigger — one call a pipeline step can make with an API token
# ---------------------------------------------------------------------------

class CiRunBody(BaseModel):
    environment_id: str
    branch: str = ""
    concurrency: int | None = None


@router.post("/projects/{project_id}/ci/runs", status_code=202)
def ci_run(project_id: str, body: CiRunBody,
           user: User = Depends(require("trigger_run")),
           db: Session = Depends(get_db)):
    """Start a run tagged source=ci. Identical to a manual run in every other
    respect (FR-061); poll /runs/{id}/gate for the verdict."""
    get_project_scoped(project_id, user, db)
    assert_token_scope(user, project_id)
    env = get_environment_scoped(project_id, body.environment_id, user.organisation_id, db)
    try:
        job_id, run_id = start_run(db, user.organisation_id, project_id, env, user.id,
                                   source="ci", branch=body.branch,
                                   concurrency=body.concurrency,
                                   serialise_per_environment=True)
    except NoApprovedCases:
        raise HTTPException(409, detail={"code": "no_approved_cases",
                                         "message": "No approved test cases to execute"})
    except RunQueued as e:
        raise HTTPException(409, detail={
            "code": "environment_busy",
            "message": "A run is already in flight against this environment",
            "run_id": e.run_id})
    return {"job_id": job_id, "run_id": run_id,
            "gate_url": f"/v1/runs/{run_id}/gate"}


# ---------------------------------------------------------------------------
# API tokens
# ---------------------------------------------------------------------------

class TokenBody(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    project_id: str | None = None
    role: str = "qa_engineer"


def _token_payload(t: ApiToken) -> dict:
    return {"id": t.id, "name": t.name, "project_id": t.project_id, "role": t.role,
            "prefix": t.prefix, "revoked": t.revoked,
            "last_used_at": _iso(t.last_used_at), "created_at": _iso(t.created_at)}


@router.get("/tokens")
def list_tokens(user: User = Depends(require("manage_tokens")),
                db: Session = Depends(get_db)):
    rows = (db.query(ApiToken)
            .filter(ApiToken.organisation_id == user.organisation_id)
            .order_by(ApiToken.created_at.desc()).all())
    return {"tokens": [_token_payload(t) for t in rows]}


@router.post("/tokens", status_code=201)
def create_ci_token(body: TokenBody, user: User = Depends(require("manage_tokens")),
                    db: Session = Depends(get_db)):
    if body.role not in ("qa_engineer", "qa_lead", "viewer"):
        raise HTTPException(422, detail={
            "code": "invalid_role",
            "message": "An API token may only carry qa_engineer, qa_lead or viewer"})
    if body.project_id:
        get_project_scoped(body.project_id, user, db)
    clear, hashed, prefix = generate_api_token()
    token = ApiToken(organisation_id=user.organisation_id, project_id=body.project_id,
                     name=body.name, token_hash=hashed, prefix=prefix, role=body.role,
                     created_by=user.id)
    db.add(token)
    db.flush()
    audit(db, user.organisation_id, user.id, "token.created", "api_token", token.id,
          {"name": body.name, "role": body.role, "project_id": body.project_id})
    db.commit()
    payload = _token_payload(token)
    payload["token"] = clear  # shown exactly once
    return payload


@router.delete("/tokens/{token_id}", status_code=204)
def revoke_token(token_id: str, user: User = Depends(require("manage_tokens")),
                 db: Session = Depends(get_db)):
    token = db.get(ApiToken, token_id)
    if not token or token.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Token not found"})
    token.revoked = True
    audit(db, user.organisation_id, user.id, "token.revoked", "api_token", token.id)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Schedules (FR-060)
# ---------------------------------------------------------------------------

class ScheduleBody(BaseModel):
    environment_id: str
    cron: str = Field(min_length=1, max_length=100)
    timezone: str = "Asia/Riyadh"
    branch: str = ""
    enabled: bool = True


def _schedule_payload(s: Schedule) -> dict:
    return {"id": s.id, "project_id": s.project_id, "environment_id": s.environment_id,
            "cron": s.cron, "timezone": s.timezone, "branch": s.branch,
            "enabled": s.enabled, "last_fired_at": _iso(s.last_fired_at),
            "next_due_at": _iso(s.next_due_at), "created_at": _iso(s.created_at)}


# --- cron parsing (five fields, ranges/steps/lists — no external dependency) ---

_CRON_BOUNDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))


def parse_cron(expr: str) -> list[set[int]]:
    """Parse `m h dom mon dow`. Supports *, a, a-b, a-b/n, */n and comma lists.
    Raises ValueError with a human reason."""
    fields = (expr or "").split()
    if len(fields) != 5:
        raise ValueError("a cron expression has five fields: minute hour day month weekday")
    parsed: list[set[int]] = []
    for value, (low, high) in zip(fields, _CRON_BOUNDS):
        allowed: set[int] = set()
        for part in value.split(","):
            step = 1
            if "/" in part:
                part, _, raw_step = part.partition("/")
                if not raw_step.isdigit() or int(raw_step) < 1:
                    raise ValueError(f"invalid step in '{value}'")
                step = int(raw_step)
            if part in ("*", ""):
                start, end = low, high
            elif "-" in part:
                a, _, b = part.partition("-")
                if not (a.isdigit() and b.isdigit()):
                    raise ValueError(f"invalid range in '{value}'")
                start, end = int(a), int(b)
            elif part.isdigit():
                start = end = int(part)
            else:
                raise ValueError(f"invalid field '{value}'")
            if start < low or end > high or start > end:
                raise ValueError(f"'{value}' is outside {low}-{high}")
            allowed.update(range(start, end + 1, step))
        parsed.append(allowed)
    return parsed


def _tzinfo(name: str) -> tzinfo:
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001 — air-gapped hosts may lack tzdata
        return timezone(timedelta(hours=3))  # AST fallback


def next_fire_after(expr: str, after: datetime, tz_name: str = "Asia/Riyadh") -> datetime:
    """First matching minute strictly after `after`, evaluated in the schedule's own
    timezone (AST by default — FR-060 AC1) and returned as UTC."""
    minute, hour, dom, month, dow = parse_cron(expr)
    tz = _tzinfo(tz_name)
    local = after.astimezone(tz).replace(second=0, microsecond=0) + timedelta(minutes=1)
    for _ in range(367 * 24 * 60):  # one year of minutes is the practical ceiling
        if (local.minute in minute and local.hour in hour and local.day in dom
                and local.month in month and (local.weekday() + 1) % 7 in dow):
            return local.astimezone(timezone.utc)
        local += timedelta(minutes=1)
    raise ValueError("this cron expression never fires")


@router.get("/projects/{project_id}/schedules")
def list_schedules(project_id: str, user: User = Depends(require("view")),
                   db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    rows = (db.query(Schedule)
            .filter(Schedule.project_id == project_id,
                    Schedule.organisation_id == user.organisation_id)
            .order_by(Schedule.created_at.asc()).all())
    return {"schedules": [_schedule_payload(s) for s in rows]}


@router.post("/projects/{project_id}/schedules", status_code=201)
def create_schedule(project_id: str, body: ScheduleBody,
                    user: User = Depends(require("manage_schedules")),
                    db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    env = get_environment_scoped(project_id, body.environment_id, user.organisation_id, db)
    try:
        next_due = next_fire_after(body.cron, _utcnow(), body.timezone)
    except ValueError as e:
        raise HTTPException(422, detail={"code": "invalid_cron", "message": str(e)})
    sched = Schedule(organisation_id=user.organisation_id, project_id=project_id,
                     environment_id=env.id, cron=body.cron, timezone=body.timezone,
                     branch=body.branch, enabled=body.enabled, next_due_at=next_due,
                     created_by=user.id)
    db.add(sched)
    db.flush()
    audit(db, user.organisation_id, user.id, "schedule.created", "schedule", sched.id,
          {"cron": body.cron, "timezone": body.timezone, "environment_id": env.id})
    db.commit()
    return _schedule_payload(sched)


@router.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: str, body: dict,
                    user: User = Depends(require("manage_schedules")),
                    db: Session = Depends(get_db)):
    sched = db.get(Schedule, schedule_id)
    if not sched or sched.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Schedule not found"})
    if "cron" in body or "timezone" in body:
        cron = str(body.get("cron", sched.cron))
        tz = str(body.get("timezone", sched.timezone))
        try:
            sched.next_due_at = next_fire_after(cron, _utcnow(), tz)
        except ValueError as e:
            raise HTTPException(422, detail={"code": "invalid_cron", "message": str(e)})
        sched.cron, sched.timezone = cron, tz
    for field in ("branch", "enabled"):
        if field in body:
            setattr(sched, field, body[field])
    audit(db, user.organisation_id, user.id, "schedule.updated", "schedule", sched.id,
          {k: v for k, v in body.items() if k in ("cron", "timezone", "branch", "enabled")})
    db.commit()
    return _schedule_payload(sched)


@router.delete("/schedules/{schedule_id}", status_code=204)
def delete_schedule(schedule_id: str, user: User = Depends(require("manage_schedules")),
                    db: Session = Depends(get_db)):
    sched = db.get(Schedule, schedule_id)
    if not sched or sched.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Schedule not found"})
    db.delete(sched)
    audit(db, user.organisation_id, user.id, "schedule.deleted", "schedule", schedule_id)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Scheduler tick — called by the background thread in main.py, and by tests
# ---------------------------------------------------------------------------

def run_due_schedules(db: Session, now: datetime | None = None) -> list[dict]:
    """Fire every schedule whose next_due_at has passed. A schedule whose
    environment is already busy is left due (queued, never concurrent — AC3)."""
    now = now or _utcnow()
    fired: list[dict] = []
    due = (db.query(Schedule)
           .filter(Schedule.enabled == True,  # noqa: E712
                   Schedule.next_due_at != None,  # noqa: E711
                   Schedule.next_due_at <= now)
           .order_by(Schedule.next_due_at.asc()).all())
    for sched in due:
        env = db.get(Environment, sched.environment_id)
        if env is None:
            sched.enabled = False
            db.commit()
            continue
        try:
            job_id, run_id = start_run(db, sched.organisation_id, sched.project_id, env,
                                       sched.created_by or "scheduler",
                                       source="scheduler", branch=sched.branch,
                                       serialise_per_environment=True)
            outcome = {"schedule_id": sched.id, "run_id": run_id, "job_id": job_id,
                       "status": "started"}
        except RunQueued as e:
            # Leave next_due_at untouched: the tick retries once the environment frees.
            fired.append({"schedule_id": sched.id, "status": "deferred",
                          "blocking_run_id": e.run_id})
            continue
        except NoApprovedCases:
            outcome = {"schedule_id": sched.id, "status": "skipped",
                       "reason": "no approved test cases"}
        sched.last_fired_at = now
        try:
            sched.next_due_at = next_fire_after(sched.cron, now, sched.timezone)
        except ValueError:
            sched.enabled = False
        db.commit()
        fired.append(outcome)
    return fired
