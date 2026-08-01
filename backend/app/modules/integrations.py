"""Integrations module — results land where the team already works (BR-09).

FR-070 Jira / Xray   export a failure as an issue carrying reproduction steps,
                     evidence and severity; a re-export UPDATES the issue it created
                     the first time instead of opening a duplicate; where Xray is
                     configured, a test execution is created and verdicts synced.
FR-011 Confluence    list the pages of a space, parse selected pages through the same
                     ingestion pipeline as an uploaded document, and flag requirements
                     whose source page changed since the last import.
FR-072 Slack         run summaries and failure alerts to a channel, at a configurable
                     alert level.

Credentials live in the encrypted `secret_encrypted` column and are never returned by
any read path (FR-083). Every outbound call goes through `_request`, which honours
on-premise egress rules (FR-081) and is the single seam tests replace.
"""
import json
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, get_project_scoped, require
from ..models import (DefectExport, Integration, Requirement, RequirementTestCase,
                      Run, TestCase, TestResult, User)
from ..security import decrypt_secret, encrypt_secret, redact
from .ingestion import numbered_criteria
from .traceability import derive_severity, is_high_priority, run_display_id

router = APIRouter()

INTEGRATION_TYPES = ("jira", "xray", "confluence", "slack")
ALERT_LEVELS = ("all", "failures", "regressions")

# Non-secret config keys per type — everything else in `secret` is encrypted.
_REQUIRED_CONFIG = {
    "jira": ("base_url", "project_key", "email"),
    "xray": ("base_url",),
    "confluence": ("base_url", "space_key", "email"),
    "slack": ("webhook_url",),
}


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class IntegrationError(Exception):
    """Carries a message already safe to show the user (secrets redacted)."""


# ---------------------------------------------------------------------------
# Outbound HTTP — the single egress seam
# ---------------------------------------------------------------------------

def _assert_egress_allowed(url: str) -> None:
    """FR-081 AC2: in on-premise mode nothing leaves the network unless the operator
    named the host explicitly."""
    if not settings.ON_PREMISE:
        return
    host = httpx.URL(url).host or ""
    allowed = any(host == entry or host.endswith("." + entry)
                  for entry in settings.EGRESS_ALLOWLIST)
    if not allowed:
        raise IntegrationError(
            f"on-premise mode blocks outbound calls to '{host}'; add it to "
            f"TRACEO_EGRESS_ALLOWLIST to permit this integration")


def _request(method: str, url: str, *, secrets: list[str], **kwargs) -> httpx.Response:
    """Every outbound integration call funnels through here."""
    _assert_egress_allowed(url)
    kwargs.setdefault("timeout", settings.INTEGRATION_TIMEOUT_S)
    try:
        with httpx.Client() as client:
            return client.request(method, url, **kwargs)
    except Exception as e:  # noqa: BLE001
        raise IntegrationError(redact(f"{type(e).__name__}: {e}", secrets))


def _check_status(resp: httpx.Response, secrets: list[str], action: str) -> dict:
    if resp.status_code >= 400:
        body = redact((resp.text or "")[:400], secrets)
        raise IntegrationError(f"{action} failed with HTTP {resp.status_code}: {body}")
    try:
        return resp.json()
    except Exception:  # noqa: BLE001
        return {}


# ---------------------------------------------------------------------------
# Integration CRUD
# ---------------------------------------------------------------------------

class IntegrationBody(BaseModel):
    type: str
    name: str = Field(default="", max_length=200)
    project_id: str | None = None
    config: dict = Field(default_factory=dict)
    secret: dict | None = None       # write-only — {"api_token": "..."} / {"url": "..."}
    alert_level: str = "failures"    # slack only


class IntegrationUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    config: dict | None = None
    secret: dict | None = None       # {} clears the stored credential
    alert_level: str | None = None


def _integration_payload(i: Integration) -> dict:
    # NEVER return the credential (FR-083 AC3) — only that one is held, and when.
    return {"id": i.id, "type": i.type, "name": i.name, "project_id": i.project_id,
            "config": i.config or {}, "secret_set": i.secret_encrypted is not None,
            "state": i.state, "last_error": i.last_error,
            "last_checked_at": _iso(i.last_checked_at),
            "secret_rotated_at": _iso(i.updated_at) if i.secret_encrypted else None,
            "alert_level": i.alert_level,
            "created_at": _iso(i.created_at)}


def _get_integration(integration_id: str, user: User, db: Session) -> Integration:
    row = db.get(Integration, integration_id)
    if not row or row.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found",
                                         "message": "Integration not found"})
    return row


def _secrets_of(row: Integration) -> tuple[dict, list[str]]:
    cfg = decrypt_secret(row.secret_encrypted)
    return cfg, [v for v in cfg.values() if isinstance(v, str) and len(v) > 3]


@router.get("/integrations")
def list_integrations(project_id: str | None = None,
                      user: User = Depends(require("view")),
                      db: Session = Depends(get_db)):
    q = db.query(Integration).filter(Integration.organisation_id == user.organisation_id)
    if project_id:
        get_project_scoped(project_id, user, db)
        q = q.filter(Integration.project_id.in_((project_id, None)))
    rows = q.order_by(Integration.created_at.asc()).all()
    return {"integrations": [_integration_payload(r) for r in rows]}


@router.post("/integrations", status_code=201)
def create_integration(body: IntegrationBody,
                       user: User = Depends(require("manage_integrations")),
                       db: Session = Depends(get_db)):
    if body.type not in INTEGRATION_TYPES:
        raise HTTPException(422, detail={
            "code": "invalid_type",
            "message": f"type must be one of: {', '.join(INTEGRATION_TYPES)}"})
    if body.alert_level not in ALERT_LEVELS:
        raise HTTPException(422, detail={
            "code": "invalid_alert_level",
            "message": f"alert_level must be one of: {', '.join(ALERT_LEVELS)}"})
    missing = [k for k in _REQUIRED_CONFIG.get(body.type, ()) if not (body.config or {}).get(k)]
    if missing:
        raise HTTPException(422, detail={
            "code": "missing_config",
            "message": f"{body.type} requires: {', '.join(missing)}"})
    if body.project_id:
        get_project_scoped(body.project_id, user, db)

    row = Integration(organisation_id=user.organisation_id, project_id=body.project_id,
                      type=body.type, name=body.name or body.type.title(),
                      config=body.config or {}, alert_level=body.alert_level,
                      secret_encrypted=encrypt_secret(body.secret) if body.secret else None)
    db.add(row)
    db.flush()
    audit(db, user.organisation_id, user.id, "integration.created", "integration", row.id,
          {"type": row.type, "project_id": row.project_id})
    db.commit()
    return _integration_payload(row)


@router.patch("/integrations/{integration_id}")
def update_integration(integration_id: str, body: IntegrationUpdate,
                       user: User = Depends(require("manage_integrations")),
                       db: Session = Depends(get_db)):
    row = _get_integration(integration_id, user, db)
    if body.name is not None:
        row.name = body.name
    if body.config is not None:
        row.config = {**(row.config or {}), **body.config}
    if body.alert_level is not None:
        if body.alert_level not in ALERT_LEVELS:
            raise HTTPException(422, detail={
                "code": "invalid_alert_level",
                "message": f"alert_level must be one of: {', '.join(ALERT_LEVELS)}"})
        row.alert_level = body.alert_level
    if body.secret is not None:
        # FR-083 AC4: rotation takes effect on the next call, nothing else changes.
        row.secret_encrypted = encrypt_secret(body.secret) if body.secret else None
    audit(db, user.organisation_id, user.id, "integration.updated", "integration", row.id,
          {"secret_rotated": body.secret is not None})
    db.commit()
    return _integration_payload(row)


@router.delete("/integrations/{integration_id}", status_code=204)
def delete_integration(integration_id: str,
                       user: User = Depends(require("manage_integrations")),
                       db: Session = Depends(get_db)):
    row = _get_integration(integration_id, user, db)
    db.query(DefectExport).filter(DefectExport.integration_id == row.id).delete()
    db.delete(row)
    audit(db, user.organisation_id, user.id, "integration.deleted", "integration", integration_id)
    db.commit()
    return None


@router.post("/integrations/{integration_id}/check")
def check_integration(integration_id: str,
                      user: User = Depends(require("manage_integrations")),
                      db: Session = Depends(get_db)):
    """Reachability + credential probe. Records state so the screen can show it."""
    row = _get_integration(integration_id, user, db)
    cfg, secrets = _secrets_of(row)
    try:
        if row.type in ("jira", "xray"):
            base = str(row.config.get("base_url", "")).rstrip("/")
            resp = _request("GET", f"{base}/rest/api/3/myself",
                            secrets=secrets, headers=_jira_headers(row, cfg))
            _check_status(resp, secrets, "Jira authentication")
        elif row.type == "confluence":
            base = str(row.config.get("base_url", "")).rstrip("/")
            resp = _request("GET", f"{base}/wiki/rest/api/space/{row.config.get('space_key')}",
                            secrets=secrets, headers=_jira_headers(row, cfg))
            _check_status(resp, secrets, "Confluence space lookup")
        elif row.type == "slack":
            url = cfg.get("webhook_url") or row.config.get("webhook_url", "")
            resp = _request("POST", url, secrets=secrets,
                            json={"text": "Traceo connectivity check"})
            _check_status(resp, secrets, "Slack webhook")
        row.state, row.last_error = "connected", None
    except IntegrationError as e:
        row.state, row.last_error = "error", str(e)
    row.last_checked_at = _utcnow()
    db.commit()
    return _integration_payload(row)


# ---------------------------------------------------------------------------
# Jira / Xray (FR-070)
# ---------------------------------------------------------------------------

def _jira_headers(row: Integration, cfg: dict) -> dict:
    import base64
    email = str(row.config.get("email", ""))
    token = str(cfg.get("api_token", ""))
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if token and email:
        basic = base64.b64encode(f"{email}:{token}".encode()).decode()
        headers["Authorization"] = f"Basic {basic}"
    elif token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


_JIRA_SEVERITY_PRIORITY = {"critical": "Highest", "major": "High", "minor": "Medium"}


def build_defect_document(db: Session, run: Run, result: TestResult,
                          case: TestCase) -> dict:
    """The reproducible bug report (FR-052) rendered as a portable document — the
    same content the Jira description, the Xray comment and the Slack alert carry."""
    rows = (db.query(Requirement, RequirementTestCase)
            .join(RequirementTestCase, RequirementTestCase.requirement_id == Requirement.id)
            .filter(RequirementTestCase.test_case_id == case.id).all())
    reqs = [r for r, _link in rows]
    high = any(is_high_priority(r.priority) for r in reqs)
    # FR-042 AC2 — the exported issue quotes the criterion, so a developer who has
    # never seen Traceo can judge the failure from the ticket alone.
    criteria_cited: list[dict] = []
    for req, link in rows:
        statements = {c["index"]: c["statement"] for c in numbered_criteria(req)}
        for index in (link.criterion_indexes or []):
            criteria_cited.append({
                "requirement": req.external_id or req.id[:8],
                "index": index, "statement": statements.get(index, "")})
    severity = derive_severity(result.outcome, result.failure_reason, high)
    display = run_display_id(db, run)

    steps: list[str] = []
    for i, step in enumerate(sorted(case.steps, key=lambda s: s.order), start=1):
        steps.append(f"{i}. {step.method.upper()} {step.path}")
    fr = result.failure_reason or {}
    assertion = fr.get("assertion") if isinstance(fr.get("assertion"), dict) else {}

    return {
        "summary": f"[Traceo #{display}] {case.title}"[:250],
        "severity": severity,
        "outcome": result.outcome,
        "run_display_id": display,
        "run_id": run.id,
        "test_case_id": case.id,
        "requirements": [{"external_id": r.external_id, "id": r.id,
                          "priority": r.priority, "description": r.description}
                         for r in reqs],
        "criteria": criteria_cited,
        "steps": steps,
        "expected": assertion.get("expected", assertion.get("value")),
        "actual": fr.get("actual", fr.get("error")),
        "assertion_type": assertion.get("type"),
        "evidence": result.evidence or [],
    }


def _defect_description(doc: dict) -> str:
    """Plain-text rendering — readable in Jira, Slack and a terminal alike."""
    lines = [f"Traceo run #{doc['run_display_id']} — {doc['outcome']} ({doc['severity']})", ""]
    if doc["requirements"]:
        lines.append("Requirements: " + ", ".join(
            r["external_id"] or r["id"][:8] for r in doc["requirements"]))
    for criterion in doc.get("criteria") or []:
        lines.append(f"Violated criterion {criterion['requirement']} / "
                     f"{criterion['index']}: {criterion['statement']}")
    lines += ["", "Reproduction steps:"] + (doc["steps"] or ["1. (single request)"])
    lines += ["", f"Expected: {doc.get('expected')}", f"Actual: {doc.get('actual')}"]
    evidence = doc.get("evidence") or []
    if evidence:
        first = evidence[0] if isinstance(evidence[0], dict) else {}
        req, resp = first.get("request") or {}, first.get("response") or {}
        lines += ["", "Request:", json.dumps(req, ensure_ascii=False, indent=2)[:1500],
                  "", "Response:", json.dumps(resp, ensure_ascii=False, indent=2)[:1500]]
    lines += ["", f"Traceo report: /v1/runs/{doc['run_id']}/report.html"]
    return "\n".join(lines)


class ExportBody(BaseModel):
    integration_id: str


@router.post("/runs/{run_id}/results/{result_id}/export")
def export_defect(run_id: str, result_id: str, body: ExportBody,
                  user: User = Depends(require("export_defects")),
                  db: Session = Depends(get_db)):
    """FR-070 AC1/AC2/AC4 — create the issue, or update the one we created before."""
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    result = db.get(TestResult, result_id)
    if not result or result.run_id != run.id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Result not found"})
    if result.outcome not in ("failed", "errored"):
        raise HTTPException(409, detail={"code": "not_a_defect",
                                         "message": "Only failed or errored results export as defects"})
    case = db.get(TestCase, result.test_case_id)
    row = _get_integration(body.integration_id, user, db)
    if row.type != "jira":
        raise HTTPException(422, detail={"code": "wrong_integration_type",
                                         "message": "Defect export requires a Jira integration"})

    cfg, secrets = _secrets_of(row)
    doc = build_defect_document(db, run, result, case)
    base = str(row.config.get("base_url", "")).rstrip("/")
    headers = _jira_headers(row, cfg)

    existing = (db.query(DefectExport)
                .filter(DefectExport.integration_id == row.id,
                        DefectExport.run_id == run.id,
                        DefectExport.test_case_id == case.id).first())
    description = _defect_description(doc)

    try:
        if existing and existing.external_key:
            resp = _request("PUT", f"{base}/rest/api/3/issue/{existing.external_key}",
                            secrets=secrets, headers=headers,
                            json={"fields": {"summary": doc["summary"],
                                             "description": description}})
            _check_status(resp, secrets, "Jira issue update")
            key, action = existing.external_key, "updated"
        else:
            fields = {
                "project": {"key": row.config.get("project_key")},
                "issuetype": {"name": row.config.get("issue_type", "Bug")},
                "summary": doc["summary"],
                "description": description,
            }
            priority_name = _JIRA_SEVERITY_PRIORITY.get(doc["severity"])
            if priority_name and row.config.get("map_priority", True):
                fields["priority"] = {"name": priority_name}
            resp = _request("POST", f"{base}/rest/api/3/issue", secrets=secrets,
                            headers=headers, json={"fields": fields})
            created = _check_status(resp, secrets, "Jira issue creation")
            key, action = created.get("key", ""), "created"
    except IntegrationError as e:
        row.state, row.last_error = "error", str(e)
        db.commit()
        raise HTTPException(502, detail={"code": "integration_failed", "message": str(e)})

    record = existing or DefectExport(organisation_id=user.organisation_id,
                                      integration_id=row.id, run_id=run.id,
                                      test_case_id=case.id)
    record.external_key = key
    record.external_url = f"{base}/browse/{key}" if key else ""
    record.severity = doc["severity"]
    record.action = action
    record.synced_at = _utcnow()
    db.add(record)
    row.state, row.last_error = "connected", None
    audit(db, user.organisation_id, user.id, f"defect.{action}", "test_result", result.id,
          {"integration_id": row.id, "external_key": key, "severity": doc["severity"]})
    db.commit()
    return {"external_key": key, "external_url": record.external_url,
            "action": action, "severity": doc["severity"]}


@router.get("/runs/{run_id}/exports")
def list_run_exports(run_id: str, user: User = Depends(require("view")),
                     db: Session = Depends(get_db)):
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    rows = db.query(DefectExport).filter(DefectExport.run_id == run.id).all()
    return {"exports": [{"test_case_id": r.test_case_id, "external_key": r.external_key,
                         "external_url": r.external_url, "action": r.action,
                         "severity": r.severity, "synced_at": _iso(r.synced_at)}
                        for r in rows]}


@router.post("/runs/{run_id}/xray/sync")
def sync_xray(run_id: str, body: ExportBody,
              user: User = Depends(require("export_defects")),
              db: Session = Depends(get_db)):
    """FR-070 AC3 — create a test execution and sync each case verdict into it."""
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    row = _get_integration(body.integration_id, user, db)
    if row.type != "xray":
        raise HTTPException(422, detail={"code": "wrong_integration_type",
                                         "message": "This endpoint requires an Xray integration"})
    cfg, secrets = _secrets_of(row)
    base = str(row.config.get("base_url", "")).rstrip("/")

    rows = (db.query(TestResult, TestCase)
            .join(TestCase, TestCase.id == TestResult.test_case_id)
            .filter(TestResult.run_id == run.id).all())
    status_of = {"passed": "PASSED", "failed": "FAILED", "errored": "FAILED"}
    tests = [{"testKey": (tc.description or "").strip() or tc.id,
              "status": status_of.get(res.outcome, "TODO"),
              "comment": (res.failure_reason or {}).get("error", "")}
             for res, tc in rows]

    payload = {
        "info": {
            "summary": f"Traceo run #{run_display_id(db, run)}",
            "description": f"Automated execution from Traceo (run {run.id})",
            "startDate": _iso(run.started_at), "finishDate": _iso(run.finished_at),
            "testEnvironments": [run.branch] if run.branch else [],
        },
        "tests": tests,
    }
    headers = {"Content-Type": "application/json"}
    if cfg.get("api_token"):
        headers["Authorization"] = f"Bearer {cfg['api_token']}"
    try:
        resp = _request("POST", f"{base}/api/v2/import/execution", secrets=secrets,
                        headers=headers, json=payload)
        data = _check_status(resp, secrets, "Xray execution import")
    except IntegrationError as e:
        row.state, row.last_error = "error", str(e)
        db.commit()
        raise HTTPException(502, detail={"code": "integration_failed", "message": str(e)})
    row.state, row.last_error = "connected", None
    audit(db, user.organisation_id, user.id, "xray.synced", "run", run.id,
          {"integration_id": row.id, "tests": len(tests)})
    db.commit()
    return {"execution_key": data.get("key", ""), "synced": len(tests)}


# ---------------------------------------------------------------------------
# Slack (FR-072)
# ---------------------------------------------------------------------------

def _slack_summary(db: Session, run: Run, regressions: int = 0) -> str:
    counts = run.counts or {}
    display = run_display_id(db, run)
    icon = "✅" if not counts.get("failed") and not counts.get("errored") else "❌"
    line = (f"{icon} Traceo run #{display} {run.state} — "
            f"{counts.get('passed', 0)} passed · {counts.get('failed', 0)} failed · "
            f"{counts.get('errored', 0)} errored")
    if run.branch:
        line += f" · branch `{run.branch}`"
    if regressions:
        line += f" · {regressions} regression(s)"
    return line + f"\n/v1/runs/{run.id}/report.html"


def notify_run(db: Session, run: Run, regressions: int = 0) -> list[dict]:
    """Post the run summary to every Slack integration whose alert level matches.
    Returns a per-integration delivery report; never raises."""
    counts = run.counts or {}
    has_failures = bool(counts.get("failed", 0) or counts.get("errored", 0))
    rows = (db.query(Integration)
            .filter(Integration.organisation_id == run.organisation_id,
                    Integration.type == "slack",
                    Integration.project_id.in_((run.project_id, None))).all())
    sent: list[dict] = []
    for row in rows:
        level = row.alert_level or "failures"
        if level == "failures" and not has_failures:
            continue
        if level == "regressions" and not regressions:
            continue
        cfg, secrets = _secrets_of(row)
        url = cfg.get("webhook_url") or row.config.get("webhook_url", "")
        try:
            resp = _request("POST", url, secrets=secrets,
                            json={"text": _slack_summary(db, run, regressions)})
            _check_status(resp, secrets, "Slack post")
            row.state, row.last_error = "connected", None
            sent.append({"integration_id": row.id, "delivered": True})
        except IntegrationError as e:
            row.state, row.last_error = "error", str(e)
            sent.append({"integration_id": row.id, "delivered": False, "error": str(e)})
    db.commit()
    return sent


@router.post("/runs/{run_id}/notify")
def notify_run_endpoint(run_id: str, user: User = Depends(require("view")),
                        db: Session = Depends(get_db)):
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    return {"deliveries": notify_run(db, run)}


# ---------------------------------------------------------------------------
# Confluence (FR-011)
# ---------------------------------------------------------------------------

@router.get("/integrations/{integration_id}/confluence/pages")
def list_confluence_pages(integration_id: str,
                          user: User = Depends(require("view")),
                          db: Session = Depends(get_db)):
    """FR-011 AC1 — the pages of the connected space, for selection."""
    row = _get_integration(integration_id, user, db)
    if row.type != "confluence":
        raise HTTPException(422, detail={"code": "wrong_integration_type",
                                         "message": "This endpoint requires a Confluence integration"})
    cfg, secrets = _secrets_of(row)
    base = str(row.config.get("base_url", "")).rstrip("/")
    space = row.config.get("space_key")
    try:
        resp = _request("GET", f"{base}/wiki/rest/api/content",
                        secrets=secrets, headers=_jira_headers(row, cfg),
                        params={"spaceKey": space, "expand": "version", "limit": 100})
        data = _check_status(resp, secrets, "Confluence page listing")
    except IntegrationError as e:
        raise HTTPException(502, detail={"code": "integration_failed", "message": str(e)})
    pages = [{"id": p.get("id"), "title": p.get("title"),
              "version": (p.get("version") or {}).get("number", 1)}
             for p in data.get("results", [])]
    return {"space_key": space, "pages": pages}


def fetch_confluence_page(row: Integration, page_id: str) -> dict:
    """Returns {title, version, text} with storage-format markup flattened."""
    cfg, secrets = _secrets_of(row)
    base = str(row.config.get("base_url", "")).rstrip("/")
    resp = _request("GET", f"{base}/wiki/rest/api/content/{page_id}",
                    secrets=secrets, headers=_jira_headers(row, cfg),
                    params={"expand": "body.storage,version"})
    data = _check_status(resp, secrets, "Confluence page fetch")
    storage = ((data.get("body") or {}).get("storage") or {}).get("value", "")
    return {"title": data.get("title", ""),
            "version": (data.get("version") or {}).get("number", 1),
            "text": _strip_markup(storage)}


class ConfluenceImportBody(BaseModel):
    integration_id: str
    page_ids: list[str] = Field(min_length=1)


@router.post("/projects/{project_id}/confluence/import", status_code=202)
def import_confluence_pages(project_id: str, body: ConfluenceImportBody,
                            user: User = Depends(require("upload_documents")),
                            db: Session = Depends(get_db)):
    """FR-011 AC2/AC3 — selected pages are parsed by the same pipeline as an uploaded
    document. The document filename is stable per page, so a re-import of a changed
    page bumps the version and flags the affected requirements stale."""
    from .ingestion import ingest_text

    project = get_project_scoped(project_id, user, db)
    row = _get_integration(body.integration_id, user, db)
    if row.type != "confluence":
        raise HTTPException(422, detail={"code": "wrong_integration_type",
                                         "message": "This endpoint requires a Confluence integration"})
    imported = []
    for page_id in body.page_ids:
        try:
            page = fetch_confluence_page(row, page_id)
        except IntegrationError as e:
            row.state, row.last_error = "error", str(e)
            db.commit()
            raise HTTPException(502, detail={"code": "integration_failed", "message": str(e)})
        filename = f"confluence-{page_id}.md"
        header = f"# {page['title']}\n\n"
        job_id, doc_id = ingest_text(db, project, filename, header + page["text"],
                                     user.id, "text/confluence")
        imported.append({"page_id": page_id, "title": page["title"],
                         "version": page["version"], "job_id": job_id,
                         "document_id": doc_id})
    row.state, row.last_error = "connected", None
    audit(db, user.organisation_id, user.id, "confluence.imported", "project", project_id,
          {"integration_id": row.id, "pages": len(imported)})
    db.commit()
    return {"imported": imported}


def _strip_markup(markup: str) -> str:
    """Confluence storage format → plain text, preserving block boundaries so the
    requirement segmenter still sees paragraphs and list items."""
    import re
    text = re.sub(r"<br\s*/?>", "\n", markup or "")
    text = re.sub(r"</(p|li|h[1-6]|tr|div)>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = (text.replace("&nbsp;", " ").replace("&amp;", "&")
            .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"'))
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())
