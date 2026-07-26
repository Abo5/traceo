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

router = APIRouter()

_AUTH_TYPES = ("none", "api_key", "basic", "bearer", "oauth2_cc")
_LANGUAGES = ("en", "ar")
_TC_STATES = ("draft", "approved", "rejected", "stale", "archived")


# --- helpers -----------------------------------------------------------------

def _iso(dt):
    return dt.isoformat() if dt else None


def _project_payload(p: Project) -> dict:
    return {"id": p.id, "name": p.name, "language": p.language, "status": p.status,
            "created_at": _iso(p.created_at), "updated_at": _iso(p.updated_at)}


def _env_payload(e: Environment) -> dict:
    # NEVER return decrypted auth values (FR-PRJ-04).
    return {"id": e.id, "project_id": e.project_id, "name": e.name, "base_url": e.base_url,
            "auth_type": e.auth_type, "variables": e.variables or {},
            "tls_strict": e.tls_strict,
            "auth_config_masked": e.auth_config_encrypted is not None,
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
    language: str = "en"


class ProjectUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    language: str | None = None
    status: str | None = None  # active|archived


class EnvironmentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=1, max_length=500)
    auth_type: str = "none"
    auth_config: dict | None = None  # write-only; e.g. {"key","header"} | {"username","password"} | {"token"} | {"client_id","client_secret","token_url"}
    variables: dict = Field(default_factory=dict)
    tls_strict: bool = True


class EnvironmentUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    base_url: str | None = Field(default=None, min_length=1, max_length=500)
    auth_type: str | None = None
    auth_config: dict | None = None  # write-only; {} clears the stored secret
    variables: dict | None = None
    tls_strict: bool | None = None


# --- projects ----------------------------------------------------------------

@router.post("/projects", status_code=201)
def create_project(body: ProjectCreate, user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    if body.language not in _LANGUAGES:
        raise HTTPException(422, detail={"code": "invalid_language",
                                         "message": "Language must be 'en' or 'ar'"})
    project = Project(organisation_id=user.organisation_id, name=body.name.strip(),
                      language=body.language)
    db.add(project)
    db.flush()
    audit(db, user.organisation_id, user.id, "project.create", "project", project.id,
          {"name": project.name})
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
    if body.language is not None:
        if body.language not in _LANGUAGES:
            raise HTTPException(422, detail={"code": "invalid_language",
                                             "message": "Language must be 'en' or 'ar'"})
        changes["language"] = {"from": project.language, "to": body.language}
        project.language = body.language
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


# --- dashboard (FR-PRJ-07) ----------------------------------------------------

@router.get("/projects/{project_id}/dashboard")
def project_dashboard(project_id: str, user: User = Depends(require("view")),
                      db: Session = Depends(get_db)):
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

    # coverage: confirmed requirements with >=1 approved linked case / confirmed (0 if none)
    covered = (db.query(func.count(func.distinct(RequirementTestCase.requirement_id)))
               .select_from(RequirementTestCase)
               .join(Requirement, Requirement.id == RequirementTestCase.requirement_id)
               .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
               .filter(Requirement.project_id == project_id,
                       Requirement.organisation_id == org_id,
                       Requirement.state == "confirmed",
                       TestCase.state == "approved")
               .scalar() or 0)
    coverage_pct = round(100.0 * covered / confirmed_count, 1) if confirmed_count else 0.0

    latest = (db.query(Run)
              .filter(Run.project_id == project_id, Run.organisation_id == org_id)
              .order_by(Run.created_at.desc())
              .first())

    return {
        "requirement_count": requirement_count,
        "confirmed_count": confirmed_count,
        "test_case_counts": tc_counts,
        "coverage_pct": coverage_pct,
        "latest_run": _run_payload(latest) if latest else None,
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


@router.post("/projects/{project_id}/environments", status_code=201)
def create_environment(project_id: str, body: EnvironmentCreate,
                       user: User = Depends(require("manage_environments")),
                       db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    _validate_auth_type(body.auth_type)
    env = Environment(organisation_id=user.organisation_id, project_id=project_id,
                      name=body.name.strip(), base_url=body.base_url.strip(),
                      auth_type=body.auth_type, variables=body.variables or {},
                      tls_strict=body.tls_strict)
    if body.auth_config:
        env.auth_config_encrypted = encrypt_secret(body.auth_config)
    db.add(env)
    db.flush()
    audit(db, user.organisation_id, user.id, "environment.create", "environment", env.id,
          {"name": env.name, "auth_type": env.auth_type,
           "auth_config_set": env.auth_config_encrypted is not None})
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
