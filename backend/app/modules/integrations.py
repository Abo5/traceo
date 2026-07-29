"""Integrations module (v2 addendum) — public API keys, CI/CD gate, webhooks,
Xray/Jira exports, scheduled runs and the PDPL organisation data export.

- API keys (FR-061 token surface): `X-API-Key: trc_...` accepted as an alternative
  to Bearer JWT on the gate, traceability, run-read and run-launch endpoints. The
  alt-auth wrappers live HERE (this router is mounted before the v1 modules so the
  wrapped paths gain X-API-Key support without touching other modules' auth).
- CI gate (FR-061): always HTTP 200 (CI checks `.pass`); `?exit=1` returns 412 on
  failure so `curl -f` breaks the pipeline.
- Webhooks (FR-070/072 transport): SSRF-guarded URLs, HMAC-SHA256 signatures,
  Slack incoming-webhook special case ({"text": ...} Arabic summary).
- Schedules (FR-060): daemon thread scans every 60s and launches the standard
  run path. Started once from main.py startup.
- Data export (FR-082, PDPL): full organisation JSON, evidence excluded.
"""
import csv
import hashlib
import hmac
import json
import secrets as pysecrets
import threading
import time
from datetime import datetime, timedelta, timezone
from io import BytesIO, StringIO
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..db import SessionLocal, get_db
from ..deps import audit, get_current_user, get_project_scoped, require
from ..models import (ApiKey, AuditEntry, Environment, Organisation, Project,
                      Requirement, RequirementTestCase, Run, Schedule, TestCase,
                      TestResult, User, Webhook)
from ..security import has_permission
from .discovery import _assert_public_host  # SSRF guard (same rules as spec fetch)
from .traceability import derive_severity, is_high_priority, run_display_id

router = APIRouter()

KEY_PREFIX = "trc_"
KEY_HEX_CHARS = 40
WEBHOOK_TIMEOUT_S = 5.0
SCHEDULER_INTERVAL_S = 60
MIN_SCHEDULE_INTERVAL_MIN = 15

SUPPORTED_EVENTS = ("run.completed",)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ---------------------------------------------------------------------------
# API keys (FR-061 token surface)
# ---------------------------------------------------------------------------

class ApiKeyCreate(BaseModel):
    name: str


def _key_dict(k: ApiKey) -> dict:
    return {"id": k.id, "name": k.name, "prefix": k.prefix,
            "created_at": _iso(k.created_at), "last_used_at": _iso(k.last_used_at),
            "revoked": k.revoked}


@router.post("/api-keys", status_code=201)
def create_api_key(payload: ApiKeyCreate,
                   user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, detail={"code": "invalid_name",
                                         "message": "API key name is required"})
    full_key = KEY_PREFIX + pysecrets.token_hex(KEY_HEX_CHARS // 2)  # trc_ + 40 hex
    k = ApiKey(organisation_id=user.organisation_id, name=name,
               prefix=full_key[:8], key_hash=hashlib.sha256(full_key.encode()).hexdigest(),
               created_by=user.id)
    db.add(k)
    db.flush()
    audit(db, user.organisation_id, user.id, "api_key.created", "api_key", k.id,
          {"name": name, "prefix": k.prefix})
    db.commit()
    # The full key is returned ONCE — only the sha256 hash is stored.
    return {"id": k.id, "name": k.name, "prefix": k.prefix, "key": full_key}


@router.get("/api-keys")
def list_api_keys(user: User = Depends(require("view")), db: Session = Depends(get_db)):
    keys = (db.query(ApiKey)
            .filter(ApiKey.organisation_id == user.organisation_id)
            .order_by(ApiKey.created_at.desc()).all())
    return [_key_dict(k) for k in keys]


@router.post("/api-keys/{key_id}/revoke")
def revoke_api_key(key_id: str, user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    k = db.get(ApiKey, key_id)
    if not k or k.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "API key not found"})
    k.revoked = True
    audit(db, user.organisation_id, user.id, "api_key.revoked", "api_key", k.id,
          {"name": k.name, "prefix": k.prefix})
    db.commit()
    return _key_dict(k)


# ---------------------------------------------------------------------------
# Alt auth: X-API-Key OR Bearer JWT (public API surface only)
# ---------------------------------------------------------------------------

def user_or_api_key(x_api_key: str = Header(default="", alias="X-API-Key"),
                    authorization: str = Header(default=""),
                    db: Session = Depends(get_db)) -> User:
    """Resolve either an `X-API-Key: trc_...` header (public API) or the standard
    Bearer JWT. API keys map to a synthetic org-scoped qa_engineer actor."""
    if x_api_key:
        k = (db.query(ApiKey)
             .filter(ApiKey.key_hash == hashlib.sha256(x_api_key.encode()).hexdigest())
             .first())
        if not k or k.revoked:
            raise HTTPException(401, detail={"code": "invalid_api_key",
                                             "message": "Unknown or revoked API key"})
        k.last_used_at = _utcnow()
        db.commit()
        # Transient (never persisted) actor — org-scoped, qa_engineer capabilities.
        return User(id=k.id, organisation_id=k.organisation_id, email="",
                    name=f"API key: {k.name}", password_hash="", role="qa_engineer",
                    locale="en")
    return get_current_user(authorization, db)


def _check_capability(actor: User, capability: str) -> None:
    if not has_permission(actor.role, capability):
        raise HTTPException(403, detail={
            "code": "forbidden",
            "message": f"Role '{actor.role}' lacks '{capability}'"})


# --- Thin X-API-Key wrappers over existing read/launch endpoints.
# This router is mounted BEFORE the v1 modules, so these definitions take over
# the paths and delegate to the original handlers with the resolved actor.

@router.get("/projects/{project_id}/traceability")
def traceability_with_api_key(project_id: str, actor: User = Depends(user_or_api_key),
                              db: Session = Depends(get_db)):
    _check_capability(actor, "view")
    from .traceability import traceability_matrix
    return traceability_matrix(project_id, actor, db)


@router.get("/runs/{run_id}")
def run_with_api_key(run_id: str, actor: User = Depends(user_or_api_key),
                     db: Session = Depends(get_db)):
    _check_capability(actor, "view")
    from .execution import get_run
    return get_run(run_id, actor, db)


@router.post("/projects/{project_id}/runs", status_code=202)
def launch_run_with_api_key(project_id: str, payload: dict,
                            actor: User = Depends(user_or_api_key),
                            db: Session = Depends(get_db)):
    _check_capability(actor, "trigger_run")
    from .execution import RunCreate, create_run
    try:
        body = RunCreate(**payload)
    except Exception:
        raise HTTPException(422, detail={"code": "invalid_body",
                                         "message": "environment_id is required"})
    return create_run(project_id, body, actor, db)


# ---------------------------------------------------------------------------
# CI/CD gate (FR-061)
# ---------------------------------------------------------------------------

def _project_coverage_pct(db: Session, project_id: str, org_id: str) -> float:
    """Confirmed requirements with >=1 approved linked case / all confirmed."""
    from sqlalchemy import func
    confirmed = db.query(func.count(Requirement.id)).filter(
        Requirement.project_id == project_id,
        Requirement.organisation_id == org_id,
        Requirement.state == "confirmed").scalar() or 0
    if not confirmed:
        return 0.0
    covered = (db.query(func.count(func.distinct(RequirementTestCase.requirement_id)))
               .select_from(RequirementTestCase)
               .join(Requirement, Requirement.id == RequirementTestCase.requirement_id)
               .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
               .filter(Requirement.project_id == project_id,
                       Requirement.organisation_id == org_id,
                       Requirement.state == "confirmed",
                       TestCase.state == "approved")
               .scalar() or 0)
    return round(100.0 * covered / confirmed, 1)


def _latest_completed_run(db: Session, project_id: str, org_id: str) -> Run | None:
    return (db.query(Run)
            .filter(Run.project_id == project_id, Run.organisation_id == org_id,
                    Run.state == "completed")
            .order_by(Run.created_at.desc(), Run.id.desc()).first())


def _failing_results(db: Session, run_id: str) -> dict[str, TestResult]:
    """test_case_id -> latest failing/errored result within the run."""
    latest: dict[str, TestResult] = {}
    rows = (db.query(TestResult).filter(TestResult.run_id == run_id)
            .order_by(TestResult.created_at.asc(), TestResult.id.asc()).all())
    for res in rows:
        latest[res.test_case_id] = res
    return {cid: r for cid, r in latest.items() if r.outcome in ("failed", "errored")}


def _requirements_of_cases(db: Session, case_ids: list[str]) -> dict[str, dict]:
    """case_id -> {external_ids: [...], high_priority: bool}."""
    info = {cid: {"external_ids": [], "high_priority": False} for cid in case_ids}
    if not case_ids:
        return info
    rows = (db.query(RequirementTestCase.test_case_id,
                     Requirement.external_id, Requirement.priority)
            .join(Requirement, Requirement.id == RequirementTestCase.requirement_id)
            .filter(RequirementTestCase.test_case_id.in_(case_ids)).all())
    for cid, external_id, priority in rows:
        if external_id:
            info[cid]["external_ids"].append(external_id)
        if is_high_priority(priority):
            info[cid]["high_priority"] = True
    return info


@router.get("/projects/{project_id}/gate")
def ci_gate(project_id: str, min_coverage: float = 80, max_critical: int = 0,
            max_failed: int | None = None, exit: int = 0,
            actor: User = Depends(user_or_api_key), db: Session = Depends(get_db)):
    _check_capability(actor, "view")
    get_project_scoped(project_id, actor, db)
    org_id = actor.organisation_id

    coverage_pct = _project_coverage_pct(db, project_id, org_id)

    latest = _latest_completed_run(db, project_id, org_id)
    latest_payload = None
    failing: dict[str, TestResult] = {}
    req_info: dict[str, dict] = {}
    open_defects = {"total": 0, "critical": 0}
    if latest:
        latest_payload = {"id": latest.id, "display_id": run_display_id(db, latest),
                          "counts": latest.counts or {}}
        failing = _failing_results(db, latest.id)
        req_info = _requirements_of_cases(db, list(failing))
        open_defects["total"] = len(failing)
        open_defects["critical"] = sum(
            1 for cid, res in failing.items()
            if derive_severity(res.outcome, res.failure_reason,
                               req_info[cid]["high_priority"]) == "critical")

    def _breach_reqs(case_ids) -> list[str]:
        seen: list[str] = []
        for cid in case_ids:
            for ext in req_info.get(cid, {}).get("external_ids", []):
                if ext not in seen:
                    seen.append(ext)
        return sorted(seen)

    breaches: list[dict] = []
    if coverage_pct < min_coverage:
        breaches.append({"check": "min_coverage", "limit": min_coverage,
                         "actual": coverage_pct})
    if open_defects["critical"] > max_critical:
        critical_ids = [cid for cid, res in failing.items()
                        if derive_severity(res.outcome, res.failure_reason,
                                           req_info[cid]["high_priority"]) == "critical"]
        breaches.append({"check": "max_critical", "limit": max_critical,
                         "actual": open_defects["critical"],
                         "requirement_external_ids": _breach_reqs(critical_ids)})
    if max_failed is not None and open_defects["total"] > max_failed:
        breaches.append({"check": "max_failed", "limit": max_failed,
                         "actual": open_defects["total"],
                         "requirement_external_ids": _breach_reqs(list(failing))})

    gate = {"pass": not breaches, "coverage_pct": coverage_pct,
            "open_defects": open_defects, "latest_run": latest_payload,
            "breaches": breaches}
    if exit and breaches:
        # `?exit=1`: non-2xx so `curl -f` fails the CI job (FR-061)
        raise HTTPException(412, detail={"code": "gate_failed",
                                         "message": "Quality gate failed",
                                         "gate": gate})
    return gate


# ---------------------------------------------------------------------------
# Webhooks (FR-070/072 transport)
# ---------------------------------------------------------------------------

class WebhookCreate(BaseModel):
    name: str
    url: str
    secret: str | None = None
    events: list[str] | None = None
    enabled: bool = True


class WebhookPatch(BaseModel):
    name: str | None = None
    url: str | None = None
    secret: str | None = None
    events: list[str] | None = None
    enabled: bool | None = None


def _validate_webhook_url(url: str) -> None:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise HTTPException(422, detail={"code": "invalid_url",
                                         "message": "Only http/https URLs are allowed."})
    _assert_public_host(parts.hostname)


def _validate_events(events: list[str]) -> list[str]:
    for e in events:
        if e not in SUPPORTED_EVENTS:
            raise HTTPException(422, detail={
                "code": "unsupported_event",
                "message": f"Unsupported event '{e}'. Supported: {', '.join(SUPPORTED_EVENTS)}"})
    return events


def _webhook_dict(w: Webhook) -> dict:
    return {"id": w.id, "project_id": w.project_id, "name": w.name, "url": w.url,
            "secret_set": bool(w.secret), "events": w.events or [],
            "enabled": w.enabled, "last_status": w.last_status,
            "last_fired_at": _iso(w.last_fired_at), "created_at": _iso(w.created_at)}


def _get_webhook(webhook_id: str, user: User, db: Session) -> Webhook:
    w = db.get(Webhook, webhook_id)
    if not w or w.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Webhook not found"})
    return w


@router.get("/projects/{project_id}/webhooks")
def list_webhooks(project_id: str, user: User = Depends(require("view")),
                  db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    hooks = (db.query(Webhook)
             .filter(Webhook.project_id == project_id,
                     Webhook.organisation_id == user.organisation_id)
             .order_by(Webhook.created_at.asc()).all())
    return [_webhook_dict(w) for w in hooks]


@router.post("/projects/{project_id}/webhooks", status_code=201)
def create_webhook(project_id: str, payload: WebhookCreate,
                   user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    _validate_webhook_url(payload.url)
    events = _validate_events(payload.events or ["run.completed"])
    w = Webhook(organisation_id=user.organisation_id, project_id=project_id,
                name=payload.name.strip(), url=payload.url.strip(),
                secret=payload.secret or None, events=events, enabled=payload.enabled)
    db.add(w)
    db.flush()
    audit(db, user.organisation_id, user.id, "webhook.created", "webhook", w.id,
          {"name": w.name, "url": w.url})
    db.commit()
    return _webhook_dict(w)


@router.patch("/webhooks/{webhook_id}")
def update_webhook(webhook_id: str, payload: WebhookPatch,
                   user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    w = _get_webhook(webhook_id, user, db)
    if payload.url is not None:
        _validate_webhook_url(payload.url)
        w.url = payload.url.strip()
    if payload.name is not None:
        w.name = payload.name.strip()
    if payload.secret is not None:
        w.secret = payload.secret or None
    if payload.events is not None:
        w.events = _validate_events(payload.events)
    if payload.enabled is not None:
        w.enabled = payload.enabled
    audit(db, user.organisation_id, user.id, "webhook.updated", "webhook", w.id,
          {"name": w.name})
    db.commit()
    return _webhook_dict(w)


@router.delete("/webhooks/{webhook_id}")
def delete_webhook(webhook_id: str, user: User = Depends(require("manage_projects")),
                   db: Session = Depends(get_db)):
    w = _get_webhook(webhook_id, user, db)
    db.delete(w)
    audit(db, user.organisation_id, user.id, "webhook.deleted", "webhook", webhook_id,
          {"name": w.name})
    db.commit()
    return {"deleted": True}


def _deliver(w: Webhook, event: str, payload: dict, summary_ar: str) -> int | None:
    """One delivery attempt, 5s timeout. Returns the HTTP status or None on
    transport failure. Slack incoming webhooks get a {"text": ...} payload."""
    if "hooks.slack.com" in w.url:
        body = json.dumps({"text": summary_ar}, ensure_ascii=False, default=str).encode()
    else:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode()
    headers = {"Content-Type": "application/json", "X-Traceo-Event": event}
    if w.secret:
        headers["X-Traceo-Signature"] = "sha256=" + hmac.new(
            w.secret.encode(), body, hashlib.sha256).hexdigest()
    try:
        resp = httpx.post(w.url, content=body, headers=headers,
                          timeout=WEBHOOK_TIMEOUT_S)
        return resp.status_code
    except Exception:  # noqa: BLE001 — delivery failure must never propagate
        return None


def _slack_summary(payload: dict) -> str:
    run = payload.get("run") or {}
    project = payload.get("project") or {}
    counts = run.get("counts") or {}
    return ("اكتمل التشغيل #{did} في مشروع {name}: "
            "{passed} ناجح، {failed} فاشل، {errored} خطأ من أصل {total}").format(
        did=run.get("display_id", "?"), name=project.get("name", "?"),
        passed=counts.get("passed", 0), failed=counts.get("failed", 0),
        errored=counts.get("errored", 0), total=counts.get("total", 0))


def fire_webhooks(db: Session, project_id: str, event: str, payload: dict) -> None:
    """Fire all enabled project webhooks subscribed to `event`. One attempt each,
    status recorded, never raises (imported lazily by the execution module)."""
    try:
        hooks = (db.query(Webhook)
                 .filter(Webhook.project_id == project_id, Webhook.enabled.is_(True))
                 .all())
        summary = _slack_summary(payload)
        for w in hooks:
            if event not in (w.events or []):
                continue
            w.last_status = _deliver(w, event, payload, summary)
            w.last_fired_at = _utcnow()
        db.commit()
    except Exception:  # noqa: BLE001 — a webhook must never break a run
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


@router.post("/webhooks/{webhook_id}/test")
def test_webhook(webhook_id: str, user: User = Depends(require("manage_projects")),
                 db: Session = Depends(get_db)):
    w = _get_webhook(webhook_id, user, db)
    project = db.get(Project, w.project_id)
    payload = {
        "event": "run.completed", "test": True,
        "project": {"id": w.project_id, "name": project.name if project else ""},
        "run": {"id": "00000000-0000-0000-0000-000000000000", "display_id": 1001,
                "state": "completed",
                "counts": {"total": 4, "passed": 3, "failed": 1, "errored": 0},
                "coverage_pct": 75.0},
        "timestamp": _iso(_utcnow()),
    }
    status = _deliver(w, "run.completed", payload, _slack_summary(payload))
    w.last_status = status
    w.last_fired_at = _utcnow()
    audit(db, user.organisation_id, user.id, "webhook.tested", "webhook", w.id,
          {"status": status})
    db.commit()
    return {"webhook_id": w.id, "delivered": status is not None and status < 400,
            "status": status}


# ---------------------------------------------------------------------------
# Xray / Jira exports (FR-070 — file export, no tenant needed)
# ---------------------------------------------------------------------------

def _get_run_scoped(run_id: str, user: User, db: Session) -> Run:
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    return run


def _run_rows(db: Session, run: Run):
    return (db.query(TestResult, TestCase)
            .join(TestCase, TestCase.id == TestResult.test_case_id)
            .filter(TestResult.run_id == run.id)
            .order_by(TestResult.created_at.asc()).all())


_JIRA_PRIORITY = {"critical": "Highest", "major": "High", "minor": "Medium"}


@router.get("/runs/{run_id}/exports/xray.json")
def export_xray(run_id: str, user: User = Depends(require("export")),
                db: Session = Depends(get_db)):
    run = _get_run_scoped(run_id, user, db)
    project = db.get(Project, run.project_id)
    rows = _run_rows(db, run)
    req_info = _requirements_of_cases(db, [tc.id for _res, tc in rows])
    display_id = run_display_id(db, run)

    tests = []
    for res, tc in rows:
        finish = res.created_at
        start = finish - timedelta(milliseconds=res.duration_ms or 0) if finish else None
        ext_ids = req_info.get(tc.id, {}).get("external_ids", [])
        steps = sorted(tc.steps, key=lambda s: s.order)
        definition = " ; ".join(f"{s.method.upper()} {s.path}" for s in steps) or tc.title
        comment = ""
        if res.outcome != "passed" and res.failure_reason:
            comment = json.dumps(res.failure_reason, ensure_ascii=False, default=str)
        entry = {
            "testInfo": {"summary": tc.title, "type": "Generic", "definition": definition},
            "start": _iso(start), "finish": _iso(finish),
            "status": "PASSED" if res.outcome == "passed" else "FAILED",
            "comment": comment,
        }
        if ext_ids:
            entry["testKey"] = ext_ids[0]
        tests.append(entry)

    doc = {
        "info": {
            "summary": f"Traceo run #{display_id} — {project.name if project else run.project_id}",
            "description": (f"State: {run.state} · counts: "
                            f"{json.dumps(run.counts or {}, ensure_ascii=False)} · "
                            f"finished: {_iso(run.finished_at) or '—'}"),
        },
        "tests": tests,
    }
    body = json.dumps(doc, ensure_ascii=False, indent=2, default=str).encode("utf-8")
    return StreamingResponse(
        BytesIO(body), media_type="application/json",
        headers={"Content-Disposition":
                 f'attachment; filename="traceo-run-{display_id}-xray.json"'})


@router.get("/runs/{run_id}/exports/defects.csv")
def export_defects_csv(run_id: str, user: User = Depends(require("export")),
                       db: Session = Depends(get_db)):
    run = _get_run_scoped(run_id, user, db)
    rows = _run_rows(db, run)
    req_info = _requirements_of_cases(db, [tc.id for _res, tc in rows])
    display_id = run_display_id(db, run)

    buf = StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Summary", "Description", "Priority", "Labels"])
    for res, tc in rows:
        if res.outcome not in ("failed", "errored"):
            continue  # failures only
        info = req_info.get(tc.id, {"external_ids": [], "high_priority": False})
        severity = derive_severity(res.outcome, res.failure_reason, info["high_priority"])
        fr = res.failure_reason or {}
        steps = sorted(tc.steps, key=lambda s: s.order)
        lines = [f"[Traceo run #{display_id}] {tc.title}", "", "Steps:"]
        lines += [f"{i + 1}. {s.method.upper()} {s.path}" for i, s in enumerate(steps)]
        if fr.get("assertion") is not None:
            lines += ["", f"Expected: {json.dumps(fr.get('expected'), ensure_ascii=False, default=str)}",
                      f"Actual: {json.dumps(fr.get('actual'), ensure_ascii=False, default=str)}"]
        elif fr.get("error"):
            lines += ["", f"Error: {fr['error']}"]
        writer.writerow([
            f"[{res.outcome.upper()}] {tc.title}",
            "\n".join(lines),
            _JIRA_PRIORITY.get(severity, "Medium"),
            " ".join(info["external_ids"]),
        ])

    # UTF-8 BOM so Excel opens Arabic content correctly
    body = ("\ufeff" + buf.getvalue()).encode("utf-8")  # BOM
    return StreamingResponse(
        BytesIO(body), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition":
                 f'attachment; filename="traceo-run-{display_id}-defects.csv"'})


# ---------------------------------------------------------------------------
# Schedules (FR-060)
# ---------------------------------------------------------------------------

class ScheduleCreate(BaseModel):
    name: str
    environment_id: str
    interval_minutes: int
    enabled: bool = True


class SchedulePatch(BaseModel):
    name: str | None = None
    environment_id: str | None = None
    interval_minutes: int | None = None
    enabled: bool | None = None


def _schedule_dict(s: Schedule) -> dict:
    return {"id": s.id, "project_id": s.project_id, "environment_id": s.environment_id,
            "name": s.name, "interval_minutes": s.interval_minutes, "enabled": s.enabled,
            "last_run_at": _iso(s.last_run_at), "next_run_at": _iso(s.next_run_at),
            "created_at": _iso(s.created_at)}


def _check_interval(minutes: int) -> None:
    if minutes < MIN_SCHEDULE_INTERVAL_MIN:
        raise HTTPException(422, detail={
            "code": "interval_too_short",
            "message": f"interval_minutes must be at least {MIN_SCHEDULE_INTERVAL_MIN}"})


def _env_in_project(env_id: str, project_id: str, user: User, db: Session) -> Environment:
    env = db.get(Environment, env_id)
    if (not env or env.project_id != project_id
            or env.organisation_id != user.organisation_id):
        raise HTTPException(404, detail={"code": "not_found",
                                         "message": "Environment not found in this project"})
    return env


@router.get("/projects/{project_id}/schedules")
def list_schedules(project_id: str, user: User = Depends(require("view")),
                   db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    schedules = (db.query(Schedule)
                 .filter(Schedule.project_id == project_id,
                         Schedule.organisation_id == user.organisation_id)
                 .order_by(Schedule.created_at.asc()).all())
    return [_schedule_dict(s) for s in schedules]


@router.post("/projects/{project_id}/schedules", status_code=201)
def create_schedule(project_id: str, payload: ScheduleCreate,
                    user: User = Depends(require("manage_projects")),
                    db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    _check_interval(payload.interval_minutes)
    _env_in_project(payload.environment_id, project_id, user, db)
    s = Schedule(organisation_id=user.organisation_id, project_id=project_id,
                 environment_id=payload.environment_id, name=payload.name.strip(),
                 interval_minutes=payload.interval_minutes, enabled=payload.enabled,
                 next_run_at=_utcnow() + timedelta(minutes=payload.interval_minutes),
                 created_by=user.id)
    db.add(s)
    db.flush()
    audit(db, user.organisation_id, user.id, "schedule.created", "schedule", s.id,
          {"name": s.name, "interval_minutes": s.interval_minutes})
    db.commit()
    return _schedule_dict(s)


def _get_schedule(schedule_id: str, user: User, db: Session) -> Schedule:
    s = db.get(Schedule, schedule_id)
    if not s or s.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Schedule not found"})
    return s


@router.patch("/schedules/{schedule_id}")
def update_schedule(schedule_id: str, payload: SchedulePatch,
                    user: User = Depends(require("manage_projects")),
                    db: Session = Depends(get_db)):
    s = _get_schedule(schedule_id, user, db)
    if payload.interval_minutes is not None:
        _check_interval(payload.interval_minutes)
        s.interval_minutes = payload.interval_minutes
        s.next_run_at = _utcnow() + timedelta(minutes=payload.interval_minutes)
    if payload.environment_id is not None:
        _env_in_project(payload.environment_id, s.project_id, user, db)
        s.environment_id = payload.environment_id
    if payload.name is not None:
        s.name = payload.name.strip()
    if payload.enabled is not None:
        s.enabled = payload.enabled
    audit(db, user.organisation_id, user.id, "schedule.updated", "schedule", s.id,
          {"name": s.name})
    db.commit()
    return _schedule_dict(s)


@router.delete("/schedules/{schedule_id}")
def delete_schedule(schedule_id: str, user: User = Depends(require("manage_projects")),
                    db: Session = Depends(get_db)):
    s = _get_schedule(schedule_id, user, db)
    db.delete(s)
    audit(db, user.organisation_id, user.id, "schedule.deleted", "schedule", schedule_id,
          {"name": s.name})
    db.commit()
    return {"deleted": True}


# --- Scheduler daemon (started once from main.py startup) --------------------

_scheduler_started = False


def _launch_scheduled_run(db: Session, sched: Schedule) -> str | None:
    """Trigger the same run-launch path as POST /projects/{id}/runs for a due
    schedule (all approved cases, the schedule's environment). Returns run_id
    or None when skipped (no approved cases / missing environment)."""
    sched.last_run_at = _utcnow()
    sched.next_run_at = _utcnow() + timedelta(minutes=max(1, sched.interval_minutes))

    env = db.get(Environment, sched.environment_id)
    if not env or env.project_id != sched.project_id:
        db.commit()
        return None
    cases = (db.query(TestCase)
             .filter(TestCase.project_id == sched.project_id,
                     TestCase.organisation_id == sched.organisation_id,
                     TestCase.state == "approved").all())
    if not cases:  # skip silently — nothing approved to execute
        db.commit()
        return None

    run = Run(organisation_id=sched.organisation_id, project_id=sched.project_id,
              environment_id=env.id, state="queued", initiated_by=sched.created_by,
              counts={})
    db.add(run)
    db.flush()
    audit(db, sched.organisation_id, sched.created_by, "run.scheduled", "run", run.id,
          {"schedule_id": sched.id, "environment_id": env.id, "case_count": len(cases)})
    db.commit()

    run_id, case_ids = run.id, [c.id for c in cases]
    from .execution import _execute_run  # lazy import — avoids module cycles
    jobstore.submit("execute", lambda j: _execute_run(j, run_id, case_ids))
    return run_id


def scheduler_tick() -> int:
    """Scan enabled schedules that are due and launch them. Returns launches."""
    launched = 0
    db = SessionLocal()
    try:
        due = (db.query(Schedule)
               .filter(Schedule.enabled.is_(True),
                       Schedule.next_run_at <= _utcnow())
               .all())
        for sched in due:
            try:
                if _launch_scheduled_run(db, sched):
                    launched += 1
            except Exception:  # noqa: BLE001 — one bad schedule must not stop the rest
                db.rollback()
    finally:
        db.close()
    return launched


def _scheduler_loop():
    while True:
        time.sleep(SCHEDULER_INTERVAL_S)
        try:
            scheduler_tick()
        except Exception:  # noqa: BLE001 — the daemon must survive anything
            pass


def start_scheduler() -> None:
    """Start the schedule daemon thread exactly once (guarded — main.py startup)."""
    global _scheduler_started
    if _scheduler_started:
        return
    _scheduler_started = True
    threading.Thread(target=_scheduler_loop, name="traceo-scheduler", daemon=True).start()


# ---------------------------------------------------------------------------
# Organisation data export (FR-082, PDPL)
# ---------------------------------------------------------------------------

@router.get("/export/organisation")
def export_organisation(user: User = Depends(require("manage_members")),
                        db: Session = Depends(get_db)):
    org_id = user.organisation_id
    org = db.get(Organisation, org_id)

    projects = (db.query(Project).filter(Project.organisation_id == org_id)
                .order_by(Project.created_at.asc()).all())
    reqs = (db.query(Requirement).filter(Requirement.organisation_id == org_id)
            .order_by(Requirement.created_at.asc()).all())
    cases = (db.query(TestCase).filter(TestCase.organisation_id == org_id)
             .order_by(TestCase.created_at.asc()).all())
    runs = (db.query(Run).filter(Run.organisation_id == org_id)
            .order_by(Run.created_at.asc()).all())
    from sqlalchemy import func
    audit_count = db.query(func.count(AuditEntry.id)).filter(
        AuditEntry.organisation_id == org_id).scalar() or 0

    result_summaries: dict[str, list[dict]] = {}
    run_ids = [r.id for r in runs]
    if run_ids:
        for res in (db.query(TestResult).filter(TestResult.run_id.in_(run_ids))
                    .order_by(TestResult.created_at.asc()).all()):
            # Evidence EXCLUDED by design (PDPL data-minimisation)
            result_summaries.setdefault(res.run_id, []).append({
                "test_case_id": res.test_case_id,
                "test_case_version": res.test_case_version,
                "outcome": res.outcome, "duration_ms": res.duration_ms,
                "executed_at": _iso(res.created_at)})

    doc = {
        "exported_at": _iso(_utcnow()),
        "organisation": {"id": org.id, "name": org.name, "plan": org.plan,
                         "created_at": _iso(org.created_at)} if org else None,
        "projects": [{"id": p.id, "name": p.name, "language": p.language,
                      "status": p.status, "created_at": _iso(p.created_at)}
                     for p in projects],
        "requirements": [{"id": r.id, "project_id": r.project_id,
                          "external_id": r.external_id, "description": r.description,
                          "acceptance_criteria": r.acceptance_criteria or [],
                          "type": r.type, "priority": r.priority, "state": r.state,
                          "version": r.version, "source_text": r.source_text}
                         for r in reqs],
        "test_cases": [{"id": c.id, "project_id": c.project_id, "title": c.title,
                        "description": c.description, "preconditions": c.preconditions,
                        "type": c.type, "priority": c.priority, "state": c.state,
                        "technique": c.technique, "generated": c.generated,
                        "version": c.version,
                        "steps": [{"order": s.order, "method": s.method,
                                   "path": s.path, "request": s.request or {},
                                   "assertions": s.assertions or [],
                                   "extractions": s.extractions or []}
                                  for s in sorted(c.steps, key=lambda s: s.order)]}
                       for c in cases],
        "runs": [{"id": r.id, "project_id": r.project_id,
                  "environment_id": r.environment_id, "state": r.state,
                  "started_at": _iso(r.started_at), "finished_at": _iso(r.finished_at),
                  "counts": r.counts or {}, "initiated_by": r.initiated_by,
                  "results": result_summaries.get(r.id, [])}
                 for r in runs],
        "audit_entry_count": audit_count,
    }
    audit(db, org_id, user.id, "organisation.exported", "organisation", org_id,
          {"projects": len(projects), "runs": len(runs)})
    db.commit()
    body = json.dumps(doc, ensure_ascii=False, indent=2, default=str).encode("utf-8")
    return StreamingResponse(
        BytesIO(body), media_type="application/json",
        headers={"Content-Disposition": 'attachment; filename="traceo_export.json"'})
