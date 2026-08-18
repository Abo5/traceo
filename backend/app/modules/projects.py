"""Projects module — project CRUD, dashboard, environments + connectivity check.

Endpoints (mounted under /v1 by main.py):
- POST   /projects                                   (manage_projects)
- GET    /projects / GET /projects/{id}              (view)
- PATCH  /projects/{id}  rename / archive            (manage_projects)
- DELETE /projects/{id}  cascades child data, keeps audit entries (FR data handling)
- GET    /projects/{id}/dashboard                    (view, FR-PRJ-07)
- CRUD   /projects/{id}/environments                 (manage_environments / view, FR-PRJ-04/05)
- POST   /projects/{id}/environments/{eid}/check     (trigger_run, FR-PRJ-06)

Environment secrets: `auth_config` is write-only — stored via encrypt_secret, never
returned; reads expose only `auth_config_masked: bool` + auth_type.
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, get_project_scoped, require
from ..models import (ApiSpec, Endpoint, Environment, Project, Requirement,
                      RequirementTestCase, Run, SourceDocument, TestCase,
                      TestResult, TestStep, User)
from ..security import decrypt_secret, encrypt_secret, redact
from ..testtypes import (DEFAULT_PROJECT_TEST_TYPES, TEST_TYPES, project_test_types,
                         validate_test_types)
from .traceability import (GAP_NEXT_ACTIONS, derive_severity, gap_reason,
                           is_high_priority, project_coverage, run_display_ids)

router = APIRouter()

_AUTH_TYPES = ("none", "api_key", "basic", "bearer", "oauth2_cc")
_AUTOMATIONS = ("auto", "manual")
_TC_STATES = ("draft", "approved", "rejected", "stale", "archived")


# --- helpers -----------------------------------------------------------------

def _iso(dt):
    return dt.isoformat() if dt else None


def _project_payload(p: Project) -> dict:
    return {"id": p.id, "name": p.name,
            "automation": p.automation, "status": p.status,
            "test_types": project_test_types(p),
            "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at)}


def _env_payload(e: Environment) -> dict:
    # NEVER return decrypted auth values (FR-PRJ-04).
    return {"id": e.id, "project_id": e.project_id, "name": e.name, "base_url": e.base_url,
            "auth_type": e.auth_type, "variables": e.variables or {},
            "tls_strict": e.tls_strict, "fixtures": e.fixtures or [],
            "auth_config_masked": e.auth_config_encrypted is not None,
            # FR-083 AC3: name and rotation date only — never the value.
            "secret_rotated_at": _iso(e.updated_at) if e.auth_config_encrypted else None,
            "created_at": _iso(e.created_at), "updated_at": _iso(e.updated_at)}


def _run_payload(r: Run) -> dict:
    return {"id": r.id, "state": r.state, "environment_id": r.environment_id,
            "started_at": _iso(r.started_at), "finished_at": _iso(r.finished_at),
            "counts": r.counts or {}, "initiated_by": r.initiated_by,
            "created_at": _iso(r.created_at)}


def _get_env_scoped(project_id: str, env_id: str, user: User, db: Session) -> Environment:
    """Org + project isolated environment lookup."""
    get_project_scoped(project_id, user, db)
    env = db.get(Environment, env_id)
    if not env or env.project_id != project_id or env.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Environment not found"})
    return env


def _validate_auth_type(auth_type: str) -> str:
    if auth_type not in _AUTH_TYPES:
        raise HTTPException(422, detail={
            "code": "invalid_auth_type",
            "message": f"auth_type must be one of: {', '.join(_AUTH_TYPES)}"})
    return auth_type


# --- request models ----------------------------------------------------------

class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    automation: str = "auto"  # auto|manual
    # Omitted means all five (app/testtypes.py): a project narrows its scope by
    # saying so, never by staying silent.
    test_types: list[str] | None = None


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    automation: str | None = None  # auto|manual
    test_types: list[str] | None = None
    status: str | None = None  # active|archived


class EnvironmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=1, max_length=500)
    auth_type: str = "none"
    auth_config: dict | None = None  # write-only; e.g. {"key","header"} | {"username","password"} | {"token"} | {"client_id","client_secret","token_url"}
    variables: dict = Field(default_factory=dict)
    tls_strict: bool = True
    fixtures: list = Field(default_factory=list)  # FR-043 test-data lifecycle


class EnvironmentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    auth_type: str | None = None
    auth_config: dict | None = None  # write-only; {} clears the stored secret
    variables: dict | None = None
    tls_strict: bool | None = None
    fixtures: list | None = None


# --- projects ----------------------------------------------------------------

@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate, user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    if body.automation not in _AUTOMATIONS:
        raise HTTPException(422, detail={"code": "invalid_automation",
                                         "message": "Automation must be 'auto' or 'manual'"})
    test_types = (validate_test_types(body.test_types) if body.test_types is not None
                  else list(DEFAULT_PROJECT_TEST_TYPES))
    project = Project(organisation_id=user.organisation_id, name=body.name.strip(),
                      automation=body.automation, test_types=test_types)
    db.add(project)
    db.flush()
    audit(db, user.organisation_id, user.id, "project.create", "project", project.id,
          {"name": project.name, "automation": project.automation,
           "test_types": test_types})
    db.commit()
    return _project_payload(project)


@router.get("/projects")
def list_projects(status: str | None = None, user: User = Depends(require("view")),
                  db: Session = Depends(get_db)):
    q = db.query(Project).filter(Project.organisation_id == user.organisation_id)
    if status:
        q = q.filter(Project.status == status)
    return [_project_payload(p) for p in q.order_by(Project.created_at.desc()).all()]


@router.get("/projects/{project_id}")
def get_project(project_id: str, user: User = Depends(require("view")),
                db: Session = Depends(get_db)):
    return _project_payload(get_project_scoped(project_id, user, db))


@router.patch("/projects/{project_id}")
def update_project(project_id: str, body: ProjectUpdate,
                   user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    project = get_project_scoped(project_id, user, db)
    changes = {}
    if body.name is not None:
        changes["name"] = {"from": project.name, "to": body.name.strip()}
        project.name = body.name.strip()
    if body.automation is not None:
        if body.automation not in _AUTOMATIONS:
            raise HTTPException(422, detail={"code": "invalid_automation",
                                             "message": "Automation must be 'auto' or 'manual'"})
        changes["automation"] = {"from": project.automation, "to": body.automation}
        project.automation = body.automation
    if body.test_types is not None:
        chosen = validate_test_types(body.test_types)
        changes["test_types"] = {"from": project_test_types(project), "to": chosen}
        project.test_types = chosen
    if body.status is not None:
        if body.status not in ("active", "archived"):
            raise HTTPException(422, detail={"code": "invalid_status",
                                             "message": "Status must be 'active' or 'archived'"})
        changes["status"] = {"from": project.status, "to": body.status}
        project.status = body.status  # archive = status change, data retained
    if changes:
        action = "project.archive" if changes.get("status", {}).get("to") == "archived" \
            else "project.update"
        audit(db, user.organisation_id, user.id, action, "project", project.id, changes)
    db.commit()
    return _project_payload(project)


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    """Cascade-delete all project data. Audit entries are KEPT (FR data handling)."""
    project = get_project_scoped(project_id, user, db)
    org_id = user.organisation_id

    run_ids = [r for (r,) in db.query(Run.id).filter(
        Run.project_id == project_id, Run.organisation_id == org_id)]
    case_ids = [c for (c,) in db.query(TestCase.id).filter(
        TestCase.project_id == project_id, TestCase.organisation_id == org_id)]
    req_ids = [r for (r,) in db.query(Requirement.id).filter(
        Requirement.project_id == project_id, Requirement.organisation_id == org_id)]

    if run_ids:
        db.query(TestResult).filter(TestResult.run_id.in_(run_ids)).delete(synchronize_session=False)
    db.query(Run).filter(Run.project_id == project_id,
                         Run.organisation_id == org_id).delete(synchronize_session=False)
    if case_ids or req_ids:
        db.query(RequirementTestCase).filter(
            (RequirementTestCase.test_case_id.in_(case_ids)) |
            (RequirementTestCase.requirement_id.in_(req_ids))).delete(synchronize_session=False)
    if case_ids:
        db.query(TestStep).filter(TestStep.test_case_id.in_(case_ids)).delete(synchronize_session=False)
    db.query(TestCase).filter(TestCase.project_id == project_id,
                              TestCase.organisation_id == org_id).delete(synchronize_session=False)
    db.query(Endpoint).filter(Endpoint.project_id == project_id,
                              Endpoint.organisation_id == org_id).delete(synchronize_session=False)
    db.query(ApiSpec).filter(ApiSpec.project_id == project_id,
                             ApiSpec.organisation_id == org_id).delete(synchronize_session=False)
    db.query(Requirement).filter(Requirement.project_id == project_id,
                                 Requirement.organisation_id == org_id).delete(synchronize_session=False)
    db.query(SourceDocument).filter(SourceDocument.project_id == project_id,
                                    SourceDocument.organisation_id == org_id).delete(synchronize_session=False)
    db.query(Environment).filter(Environment.project_id == project_id,
                                 Environment.organisation_id == org_id).delete(synchronize_session=False)
    db.delete(project)
    audit(db, org_id, user.id, "project.delete", "project", project_id, {"name": project.name})
    db.commit()
    return {"deleted": True}


# --- dashboard (FR-PRJ-07 + v2 FR-054/FR-062/FR-051/FR-052) --------------------

def _median_int(values: list[float]) -> int | None:
    if not values:
        return None
    values = sorted(values)
    n = len(values)
    mid = n // 2
    return int(values[mid]) if n % 2 else int((values[mid - 1] + values[mid]) / 2)


def _run_coverage_pct(run: Run) -> float:
    c = run.counts or {}
    total = c.get("total", 0)
    return round(c.get("passed", 0) / total * 100, 1) if total else 0.0


def _case_requirement_info(db: Session, case_ids: list[str]) -> dict[str, dict]:
    """case_id -> {external_ids: [...], high_priority: bool} over linked requirements."""
    info = {cid: {"external_ids": [], "high_priority": False, "priority": None}
            for cid in case_ids}
    order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    if not case_ids:
        return info
    rows = (db.query(RequirementTestCase.test_case_id,
                     Requirement.external_id, Requirement.priority)
            .join(Requirement, Requirement.id == RequirementTestCase.requirement_id)
            .filter(RequirementTestCase.test_case_id.in_(case_ids))
            .all())
    for cid, external_id, priority in rows:
        entry = info[cid]
        if external_id:
            entry["external_ids"].append(external_id)
        if is_high_priority(priority):
            entry["high_priority"] = True
        level = str(priority or "medium").lower()
        if entry["priority"] is None or order.get(level, 2) < order.get(entry["priority"], 2):
            entry["priority"] = level  # the most severe linked requirement governs
    return info


def _run_outcome_map(db: Session, run_id: str) -> dict[str, TestResult]:
    """test_case_id -> latest TestResult within one run (ascending scan, last wins)."""
    out: dict[str, TestResult] = {}
    rows = (db.query(TestResult).filter(TestResult.run_id == run_id)
            .order_by(TestResult.created_at.asc(), TestResult.id.asc()).all())
    for res in rows:
        out[res.test_case_id] = res
    return out


@router.get("/projects/{project_id}/dashboard")
def project_dashboard(project_id: str, branch: str | None = None,
                      environment_id: str | None = None,
                      drop_threshold: float = 5.0,
                      user: User = Depends(require("view")),
                      db: Session = Depends(get_db)):
    """FR-054: the trend series can be filtered by branch and environment, and a
    coverage drop larger than `drop_threshold` points is marked on the point where
    it happened."""
    get_project_scoped(project_id, user, db)
    org_id = user.organisation_id

    requirement_count = db.query(func.count(Requirement.id)).filter(
        Requirement.project_id == project_id,
        Requirement.organisation_id == org_id).scalar() or 0
    confirmed_count = db.query(func.count(Requirement.id)).filter(
        Requirement.project_id == project_id,
        Requirement.organisation_id == org_id,
        Requirement.state == "confirmed").scalar() or 0

    tc_counts = {state: 0 for state in _TC_STATES}
    rows = (db.query(TestCase.state, func.count(TestCase.id))
            .filter(TestCase.project_id == project_id, TestCase.organisation_id == org_id)
            .group_by(TestCase.state).all())
    for state, count in rows:
        if state in tc_counts:
            tc_counts[state] = count

    # One coverage computation for the whole product (SRS §4.5) — the dashboard, the
    # matrix and the CI gate must never show three different numbers.
    project_cov = project_coverage(db, project_id, org_id)
    coverage_pct = project_cov["coverage_pct"]

    latest = (db.query(Run)
              .filter(Run.project_id == project_id, Run.organisation_id == org_id)
              .order_by(Run.created_at.desc())
              .first())

    display_ids = run_display_ids(db, project_id)

    # -- trend (FR-054): last 14 completed runs, oldest -> newest
    trend_q = (db.query(Run)
               .filter(Run.project_id == project_id, Run.organisation_id == org_id,
                       Run.state == "completed"))
    if branch:
        trend_q = trend_q.filter(Run.branch == branch)
    if environment_id:
        trend_q = trend_q.filter(Run.environment_id == environment_id)
    completed = (trend_q.order_by(Run.created_at.desc(), Run.id.desc()).limit(14).all())
    completed.reverse()
    trend = []
    previous_coverage = None
    for r in completed:
        c = r.counts or {}
        coverage = _run_coverage_pct(r)
        # AC3: a drop beyond the threshold is marked, not merely plotted.
        dropped = (previous_coverage is not None
                   and previous_coverage - coverage > drop_threshold)
        trend.append({"run_id": r.id, "display_id": display_ids.get(r.id),
                      "coverage_pct": coverage,
                      "passed": c.get("passed", 0), "failed": c.get("failed", 0),
                      "errored": c.get("errored", 0),
                      "branch": r.branch or "", "source": r.source or "manual",
                      "environment_id": r.environment_id,
                      "dropped": dropped,
                      "delta": round(coverage - previous_coverage, 1)
                      if previous_coverage is not None else None})
        previous_coverage = coverage

    branches = sorted({r.branch for r in db.query(Run)
                       .filter(Run.project_id == project_id,
                               Run.organisation_id == org_id).all() if r.branch})

    # -- median run duration over the same window
    durations = [(r.finished_at - r.started_at).total_seconds() * 1000
                 for r in completed if r.started_at and r.finished_at]
    median_duration_ms = _median_int(durations)

    # -- open defects (FR-052) + regression watch (FR-062) on the completed runs
    open_defects = {"total": 0, "critical": 0}
    regression_watch: list[dict] = []
    if completed:
        latest_completed = completed[-1]
        latest_results = _run_outcome_map(db, latest_completed.id)
        failing = {cid: res for cid, res in latest_results.items()
                   if res.outcome in ("failed", "errored")}
        req_info = _case_requirement_info(db, list(failing))
        open_defects["total"] = len(failing)
        open_defects["critical"] = sum(
            1 for cid, res in failing.items()
            if derive_severity(res.outcome, res.failure_reason,
                               req_info[cid]["high_priority"],
                               req_info[cid]["priority"]) == "critical")

        if len(completed) >= 2:
            previous_results = _run_outcome_map(db, completed[-2].id)
            regressed = {cid: res for cid, res in failing.items()
                         if previous_results.get(cid) is not None
                         and previous_results[cid].outcome == "passed"}
            if regressed:
                titles = {tc.id: tc.title for tc in db.query(TestCase)
                          .filter(TestCase.id.in_(list(regressed))).all()}
                for cid in sorted(regressed, key=lambda c: titles.get(c, "")):
                    res = regressed[cid]
                    regression_watch.append({
                        "test_case_id": cid,
                        "title": titles.get(cid, ""),
                        "requirement_external_ids": req_info[cid]["external_ids"],
                        "run_id": latest_completed.id,
                        "outcome": res.outcome,
                        "severity": derive_severity(res.outcome, res.failure_reason,
                                                    req_info[cid]["high_priority"],
                                                    req_info[cid]["priority"]),
                    })

    # -- gap detail (FR-051): uncovered confirmed requirements + next action
    confirmed_reqs = (db.query(Requirement)
                      .filter(Requirement.project_id == project_id,
                              Requirement.organisation_id == org_id,
                              Requirement.state == "confirmed")
                      .order_by(Requirement.external_id.asc(),
                                Requirement.created_at.asc()).all())
    states_by_req: dict[str, list[str]] = {}
    link_rows = (db.query(RequirementTestCase.requirement_id, TestCase.state)
                 .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
                 .filter(TestCase.project_id == project_id,
                         TestCase.organisation_id == org_id).all())
    for rid, state in link_rows:
        states_by_req.setdefault(rid, []).append(state)
    gaps_detail = []
    for req in confirmed_reqs:
        states = states_by_req.get(req.id, [])
        if any(s == "approved" for s in states):
            continue
        reason = gap_reason(states)
        gaps_detail.append({"requirement_id": req.id, "external_id": req.external_id,
                            "reason": reason, "next_action": GAP_NEXT_ACTIONS[reason]})

    latest_payload = None
    if latest:
        latest_payload = _run_payload(latest)
        latest_payload["display_id"] = display_ids.get(latest.id)

    return {
        "requirement_count": requirement_count,
        "confirmed_count": confirmed_count,
        "test_case_counts": tc_counts,
        "coverage_pct": coverage_pct,
        "requirement_coverage_pct": project_cov["requirement_coverage_pct"],
        "criteria_covered": project_cov["criteria_covered"],
        "criteria_total": project_cov["criteria_total"],
        "latest_run": latest_payload,
        "trend": trend,
        "branches": branches,
        "drop_threshold": drop_threshold,
        "regression_watch": regression_watch,
        "gaps_detail": gaps_detail,
        "open_defects": open_defects,
        "median_duration_ms": median_duration_ms,
    }


# --- environments (FR-PRJ-04/05) -----------------------------------------------

@router.get("/projects/{project_id}/environments")
def list_environments(project_id: str, user: User = Depends(require("view")),
                      db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    envs = (db.query(Environment)
            .filter(Environment.project_id == project_id,
                    Environment.organisation_id == user.organisation_id)
            .order_by(Environment.created_at.asc()).all())
    return [_env_payload(e) for e in envs]


def create_environment_record(db: Session, *, org_id: str, user_id: str, project_id: str,
                              body: EnvironmentCreate, action: str = "environment.create",
                              extra_audit: dict | None = None) -> Environment:
    """THE write path for a new environment — validation, secret encryption and
    the audit entry in one place.

    The route below and the import-time auto-creation (discovery.py) both go
    through here, so a derived environment is validated exactly like a typed one
    and can never drift from it. Callers commit; the row is flushed so `env.id`
    is available for the audit entry and the response.
    """
    _validate_auth_type(body.auth_type)
    env = Environment(organisation_id=org_id, project_id=project_id,
                      name=body.name.strip(), base_url=body.base_url.strip(),
                      auth_type=body.auth_type, variables=body.variables or {},
                      tls_strict=body.tls_strict, fixtures=body.fixtures or [])
    if body.auth_config:
        env.auth_config_encrypted = encrypt_secret(body.auth_config)
    db.add(env)
    db.flush()
    meta = {"name": env.name, "auth_type": env.auth_type,
            "auth_config_set": env.auth_config_encrypted is not None}
    meta.update(extra_audit or {})
    audit(db, org_id, user_id, action, "environment", env.id, meta)
    return env


@router.post("/projects/{project_id}/environments", status_code=201)
def create_environment(project_id: str, body: EnvironmentCreate,
                       user: User = Depends(require("manage_environments")),
                       db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    env = create_environment_record(db, org_id=user.organisation_id, user_id=user.id,
                                   project_id=project_id, body=body)
    db.commit()
    return _env_payload(env)


@router.get("/projects/{project_id}/environments/{env_id}")
def get_environment(project_id: str, env_id: str, user: User = Depends(require("view")),
                    db: Session = Depends(get_db)):
    return _env_payload(_get_env_scoped(project_id, env_id, user, db))


@router.patch("/projects/{project_id}/environments/{env_id}")
def update_environment(project_id: str, env_id: str, body: EnvironmentUpdate,
                       user: User = Depends(require("manage_environments")),
                       db: Session = Depends(get_db)):
    env = _get_env_scoped(project_id, env_id, user, db)
    changed = []
    if body.name is not None:
        env.name = body.name.strip()
        changed.append("name")
    if body.base_url is not None:
        env.base_url = body.base_url.strip()
        changed.append("base_url")
    if body.auth_type is not None:
        env.auth_type = _validate_auth_type(body.auth_type)
        changed.append("auth_type")
    if "auth_config" in body.model_fields_set:
        # write-only: a dict replaces the secret, {} or null clears it; values never echoed
        env.auth_config_encrypted = encrypt_secret(body.auth_config) if body.auth_config else None
        changed.append("auth_config")
    if body.variables is not None:
        env.variables = body.variables
        changed.append("variables")
    if body.tls_strict is not None:
        env.tls_strict = body.tls_strict
        changed.append("tls_strict")
    if body.fixtures is not None:
        env.fixtures = body.fixtures
        changed.append("fixtures")
    if changed:
        audit(db, user.organisation_id, user.id, "environment.update", "environment", env.id,
              {"fields": changed})
    db.commit()
    return _env_payload(env)


@router.delete("/projects/{project_id}/environments/{env_id}")
def delete_environment(project_id: str, env_id: str,
                       user: User = Depends(require("manage_environments")),
                       db: Session = Depends(get_db)):
    env = _get_env_scoped(project_id, env_id, user, db)
    in_use = db.query(func.count(Run.id)).filter(Run.environment_id == env.id).scalar() or 0
    if in_use:
        raise HTTPException(409, detail={"code": "environment_in_use",
                                         "message": "Environment has runs recorded against it"})
    audit(db, user.organisation_id, user.id, "environment.delete", "environment", env.id,
          {"name": env.name})
    db.delete(env)
    db.commit()
    return {"deleted": True}


# --- connectivity check (FR-PRJ-06) --------------------------------------------

@router.post("/projects/{project_id}/environments/{env_id}/check")
def check_environment(project_id: str, env_id: str,
                      user: User = Depends(require("trigger_run")),
                      db: Session = Depends(get_db)):
    env = _get_env_scoped(project_id, env_id, user, db)
    cfg = decrypt_secret(env.auth_config_encrypted)
    secrets = [v for v in cfg.values() if isinstance(v, str)]

    headers: dict[str, str] = {}
    basic_auth: tuple[str, str] | None = None
    auth_applied = False

    if env.auth_type == "api_key" and cfg.get("key"):
        headers[cfg.get("header") or "X-API-Key"] = cfg["key"]
        auth_applied = True
    elif env.auth_type == "basic" and (cfg.get("username") or cfg.get("password")):
        basic_auth = (cfg.get("username", ""), cfg.get("password", ""))
        auth_applied = True
    elif env.auth_type == "bearer" and cfg.get("token"):
        headers["Authorization"] = f"Bearer {cfg['token']}"
        auth_applied = True
    elif env.auth_type == "oauth2_cc":
        token = cfg.get("token")
        if not token and cfg.get("token_url") and cfg.get("client_id"):
            try:
                resp = httpx.post(
                    cfg["token_url"],
                    data={"grant_type": "client_credentials",
                          "client_id": cfg["client_id"],
                          "client_secret": cfg.get("client_secret", "")},
                    timeout=5.0, verify=env.tls_strict)
                if resp.status_code < 400:
                    token = resp.json().get("access_token")
            except Exception:
                token = None
        if token:
            headers["Authorization"] = f"Bearer {token}"
            secrets.append(token)
            auth_applied = True

    if not env.base_url:
        return {"reachable": False, "auth_applied": auth_applied, "error": "base_url is not set"}

    try:
        resp = httpx.get(env.base_url, headers=headers, auth=basic_auth,
                         timeout=5.0, verify=env.tls_strict, follow_redirects=True)
        return {"reachable": True, "status_code": resp.status_code, "auth_applied": auth_applied}
    except Exception as exc:  # noqa: BLE001 — connectivity probe: report, never leak
        return {"reachable": False, "auth_applied": auth_applied,
                "error": redact(str(exc), secrets)}
