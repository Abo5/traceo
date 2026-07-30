"""Review module (FR-REV) — the human gate between generation and execution.

Every generated case lands here as a draft. Reviewers see the requirement text
alongside the case (FR-REV-02), edit freely (edits flag user_modified and knock an
approved/stale case back to draft with a version bump, FR-REV-03), and approve or
reject individually or in bulk (FR-REV-04/05/06). Manual authoring (FR-REV-07,
FR-GEN-02) requires at least one requirement link — an unlinked case cannot exist,
which is also why removing the LAST link is refused (FR-TRC-05).
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, get_project_scoped, require
from ..models import (Endpoint, Requirement, RequirementTestCase, TestCase,
                      TestStep, User)

router = APIRouter()

CASE_TYPES = ("positive", "negative", "boundary")
REJECT_REASON_CODES = ("incorrect", "shallow", "duplicate", "other")
BULK_ACTIONS = ("approve", "reject")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ---------------------------------------------------------------------------
# Scoped fetch + serializers
# ---------------------------------------------------------------------------

def _get_case(case_id: str, user: User, db: Session) -> TestCase:
    """Org isolation (FR-USR-04): a foreign tenant sees 404, never 403."""
    tc = db.get(TestCase, case_id)
    if not tc or tc.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Test case not found"})
    return tc


def _links_for(db: Session, case_ids: list[str]) -> dict[str, list[dict]]:
    """case_id -> [{id, external_id, description}] in one query (list endpoints)."""
    out: dict[str, list[dict]] = {cid: [] for cid in case_ids}
    if not case_ids:
        return out
    rows = (db.query(RequirementTestCase, Requirement)
            .join(Requirement, Requirement.id == RequirementTestCase.requirement_id)
            .filter(RequirementTestCase.test_case_id.in_(case_ids))
            .all())
    for link, req in rows:
        out[link.test_case_id].append({
            "id": req.id, "external_id": req.external_id, "description": req.description,
        })
    return out


def _step_dict(s: TestStep) -> dict:
    return {
        "id": s.id, "order": s.order, "endpoint_id": s.endpoint_id,
        "method": s.method, "path": s.path, "request": s.request or {},
        "assertions": s.assertions or [], "extractions": s.extractions or [],
    }


def _case_dict(tc: TestCase, links: list[dict], step_count: int | None = None) -> dict:
    d = {
        "id": tc.id, "project_id": tc.project_id, "title": tc.title,
        "description": tc.description, "preconditions": tc.preconditions,
        "type": tc.type, "priority": tc.priority, "state": tc.state,
        "generated": tc.generated, "user_modified": tc.user_modified,
        "model": tc.model, "prompt_version": tc.prompt_version,
        "technique": tc.technique, "version": tc.version,
        "approved_by": tc.approved_by, "approved_at": _iso(tc.approved_at),
        "rejection_reason": tc.rejection_reason,
        "links": links,
        "created_at": _iso(tc.created_at), "updated_at": _iso(tc.updated_at),
    }
    d["step_count"] = len(tc.steps) if step_count is None else step_count
    return d


def _case_detail(tc: TestCase, links: list[dict]) -> dict:
    d = _case_dict(tc, links)
    d["steps"] = [_step_dict(s) for s in sorted(tc.steps, key=lambda s: s.order)]
    # alias: the review queue renders requirement text alongside the case (FR-REV-02)
    d["requirements"] = links
    return d


# ---------------------------------------------------------------------------
# Step validation (shared by PATCH and manual authoring)
# ---------------------------------------------------------------------------

def _clean_steps(raw_steps: list) -> list[dict]:
    if not isinstance(raw_steps, list) or not raw_steps:
        raise HTTPException(422, detail={
            "code": "invalid_steps", "message": "steps must be a non-empty list"})
    cleaned = []
    for i, s in enumerate(raw_steps):
        if not isinstance(s, dict):
            raise HTTPException(422, detail={
                "code": "invalid_steps", "message": f"step {i} must be an object"})
        method = str(s.get("method") or "GET").upper()
        path = str(s.get("path") or "")
        if not path:
            raise HTTPException(422, detail={
                "code": "invalid_steps", "message": f"step {i} is missing 'path'"})
        request = s.get("request") if isinstance(s.get("request"), dict) else {}
        assertions = s.get("assertions") if isinstance(s.get("assertions"), list) else []
        extractions = s.get("extractions") if isinstance(s.get("extractions"), list) else []
        cleaned.append({"order": i, "endpoint_id": s.get("endpoint_id"),
                        "method": method, "path": path, "request": request,
                        "assertions": assertions, "extractions": extractions})
    return cleaned


def _resolve_endpoint_ids(db: Session, project_id: str, org_id: str,
                          cleaned: list[dict]) -> list[dict]:
    """Bind each hand-authored step to the endpoint it targets.

    A person writing a case types a method and a path, not an internal endpoint id —
    so without this the case would never appear in the endpoint coverage map, and
    FR-036 AC4 ("a case added by hand participates like a generated one") would be
    false in the one place it is measurable. A step whose path is not in the
    inventory keeps `endpoint_id = None`: manual authoring is deliberately allowed
    to go beyond the discovered surface, it just does not count as coverage of it."""
    needs = [s for s in cleaned if not s.get("endpoint_id")]
    if not needs:
        return cleaned
    inventory = {(e.method.upper(), e.path): e.id for e in db.query(Endpoint).filter(
        Endpoint.project_id == project_id, Endpoint.organisation_id == org_id).all()}
    if not inventory:
        return cleaned
    for step in needs:
        step["endpoint_id"] = inventory.get((step["method"].upper(), step["path"]))
    return cleaned


def _replace_steps(tc: TestCase, cleaned: list[dict]) -> None:
    """Atomic replacement: delete-orphan cascade drops the old rows at commit."""
    tc.steps = [TestStep(order=s["order"], endpoint_id=s["endpoint_id"],
                         method=s["method"], path=s["path"], request=s["request"],
                         assertions=s["assertions"], extractions=s["extractions"])
                for s in cleaned]


# ---------------------------------------------------------------------------
# Approve / reject primitives (shared by single + bulk endpoints)
# ---------------------------------------------------------------------------

def _approve(db: Session, tc: TestCase, user: User) -> None:
    if tc.state == "archived":
        raise HTTPException(409, detail={
            "code": "invalid_state", "message": "An archived test case cannot be approved"})
    tc.state = "approved"
    tc.approved_by = user.id
    tc.approved_at = _utcnow()
    tc.rejection_reason = None
    audit(db, user.organisation_id, user.id, "test_case.approved",
          "test_case", tc.id, {"version": tc.version})


def _reject(db: Session, tc: TestCase, user: User, reason_code: str, reason_text: str) -> None:
    if tc.state == "archived":
        raise HTTPException(409, detail={
            "code": "invalid_state", "message": "An archived test case cannot be rejected"})
    tc.state = "rejected"
    tc.approved_by = None
    tc.approved_at = None
    tc.rejection_reason = f"{reason_code}: {reason_text}" if reason_text else reason_code
    audit(db, user.organisation_id, user.id, "test_case.rejected",
          "test_case", tc.id, {"reason_code": reason_code, "reason_text": reason_text})


def _check_reason_code(reason_code: str) -> str:
    if reason_code not in REJECT_REASON_CODES:
        raise HTTPException(422, detail={
            "code": "invalid_reason_code",
            "message": f"reason_code must be one of {', '.join(REJECT_REASON_CODES)}"})
    return reason_code


# ---------------------------------------------------------------------------
# Routes — listing & detail
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/test-cases")
def list_test_cases(project_id: str, state: str = "", requirement_id: str = "",
                    type: str = "", q: str = "",
                    user: User = Depends(require("view")),
                    db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    query = db.query(TestCase).filter(
        TestCase.project_id == project_id,
        TestCase.organisation_id == user.organisation_id)
    if state:
        query = query.filter(TestCase.state == state)
    if type:
        query = query.filter(TestCase.type == type)
    if requirement_id:
        query = query.join(RequirementTestCase,
                           RequirementTestCase.test_case_id == TestCase.id) \
                     .filter(RequirementTestCase.requirement_id == requirement_id)
    if q:
        needle = f"%{q}%"
        query = query.filter(or_(TestCase.title.ilike(needle),
                                 TestCase.description.ilike(needle)))
    cases = query.order_by(TestCase.created_at.asc()).all()
    links = _links_for(db, [c.id for c in cases])
    return {"test_cases": [_case_dict(c, links.get(c.id, [])) for c in cases]}


@router.get("/test-cases/{case_id}")
def get_test_case(case_id: str, user: User = Depends(require("view")),
                  db: Session = Depends(get_db)):
    tc = _get_case(case_id, user, db)
    return _case_detail(tc, _links_for(db, [tc.id]).get(tc.id, []))


# ---------------------------------------------------------------------------
# Routes — editing (FR-REV-03)
# ---------------------------------------------------------------------------

class CasePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    preconditions: str | None = None
    type: str | None = None
    priority: str | None = None
    steps: list | None = None


@router.patch("/test-cases/{case_id}")
def update_test_case(case_id: str, body: CasePatch,
                     user: User = Depends(require("edit_test_case")),
                     db: Session = Depends(get_db)):
    tc = _get_case(case_id, user, db)
    if tc.state == "archived":
        raise HTTPException(409, detail={
            "code": "invalid_state", "message": "An archived test case cannot be edited"})
    if body.type is not None and body.type not in CASE_TYPES:
        raise HTTPException(422, detail={
            "code": "invalid_type", "message": f"type must be one of {', '.join(CASE_TYPES)}"})

    changed: list[str] = []
    if body.title is not None and body.title.strip() and body.title != tc.title:
        tc.title = body.title.strip()[:500]
        changed.append("title")
    if body.description is not None and body.description != tc.description:
        tc.description = body.description
        changed.append("description")
    if body.preconditions is not None and body.preconditions != tc.preconditions:
        tc.preconditions = body.preconditions
        changed.append("preconditions")
    if body.type is not None and body.type != tc.type:
        tc.type = body.type
        changed.append("type")
    if body.priority is not None and body.priority != tc.priority:
        tc.priority = str(body.priority)
        changed.append("priority")
    if body.steps is not None:
        _replace_steps(tc, _resolve_endpoint_ids(
            db, tc.project_id, tc.organisation_id, _clean_steps(body.steps)))
        changed.append("steps")

    if changed:
        tc.user_modified = True  # FR-REV-03: human edits are marked
        if tc.state in ("approved", "stale"):
            # any edit invalidates the previous approval — back to the review queue
            tc.state = "draft"
            tc.version += 1
            tc.approved_by = None
            tc.approved_at = None
        audit(db, user.organisation_id, user.id, "test_case.updated",
              "test_case", tc.id, {"changes": changed, "version": tc.version})
    db.commit()
    return _case_detail(tc, _links_for(db, [tc.id]).get(tc.id, []))


# ---------------------------------------------------------------------------
# Routes — approve / reject (FR-REV-05/06), single + bulk (FR-REV-04)
# ---------------------------------------------------------------------------

@router.post("/test-cases/{case_id}/approve")
def approve_test_case(case_id: str, user: User = Depends(require("approve_reject")),
                      db: Session = Depends(get_db)):
    tc = _get_case(case_id, user, db)
    _approve(db, tc, user)
    db.commit()
    return _case_dict(tc, _links_for(db, [tc.id]).get(tc.id, []))


class RejectBody(BaseModel):
    reason_code: str
    reason_text: str = ""


@router.post("/test-cases/{case_id}/reject")
def reject_test_case(case_id: str, body: RejectBody,
                     user: User = Depends(require("approve_reject")),
                     db: Session = Depends(get_db)):
    tc = _get_case(case_id, user, db)
    _reject(db, tc, user, _check_reason_code(body.reason_code), body.reason_text)
    db.commit()
    return _case_dict(tc, _links_for(db, [tc.id]).get(tc.id, []))


class BulkBody(BaseModel):
    ids: list[str]
    action: str
    reason_code: str | None = None
    reason_text: str = ""


@router.post("/test-cases/bulk")
def bulk_review(body: BulkBody, user: User = Depends(require("approve_reject")),
                db: Session = Depends(get_db)):
    if body.action not in BULK_ACTIONS:
        raise HTTPException(422, detail={
            "code": "invalid_action", "message": f"action must be one of {', '.join(BULK_ACTIONS)}"})
    if not body.ids:
        raise HTTPException(422, detail={"code": "empty_ids", "message": "ids must be non-empty"})
    reason_code = _check_reason_code(body.reason_code or "other") \
        if body.action == "reject" else None

    processed, errors = 0, []
    for cid in body.ids:
        tc = db.get(TestCase, cid)
        if not tc or tc.organisation_id != user.organisation_id:
            errors.append({"id": cid, "code": "not_found", "message": "Test case not found"})
            continue
        try:
            if body.action == "approve":
                _approve(db, tc, user)
            else:
                _reject(db, tc, user, reason_code, body.reason_text)
            processed += 1
        except HTTPException as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {"message": str(exc.detail)}
            errors.append({"id": cid, **detail})
    db.commit()
    return {"action": body.action, "processed": processed, "errors": errors}


# ---------------------------------------------------------------------------
# Routes — manual authoring (FR-REV-07, FR-GEN-02: link at creation is mandatory)
# ---------------------------------------------------------------------------

class CaseCreate(BaseModel):
    title: str
    requirement_ids: list[str]
    description: str = ""
    preconditions: str = ""
    type: str = "positive"
    priority: str = "medium"
    steps: list | None = None


@router.post("/projects/{project_id}/test-cases", status_code=201)
def create_test_case(project_id: str, body: CaseCreate,
                     user: User = Depends(require("edit_test_case")),
                     db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    if not body.title.strip():
        raise HTTPException(422, detail={"code": "missing_title", "message": "title is required"})
    if not body.requirement_ids:
        raise HTTPException(422, detail={
            "code": "missing_requirements",
            "message": "requirement_ids is required — every test case must trace to a requirement"})
    if body.type not in CASE_TYPES:
        raise HTTPException(422, detail={
            "code": "invalid_type", "message": f"type must be one of {', '.join(CASE_TYPES)}"})

    wanted = list(dict.fromkeys(body.requirement_ids))  # de-dup, keep order
    reqs = db.query(Requirement).filter(
        Requirement.id.in_(wanted),
        Requirement.project_id == project_id,
        Requirement.organisation_id == user.organisation_id).all()
    found = {r.id: r for r in reqs}
    missing = [rid for rid in wanted if rid not in found]
    if missing:
        raise HTTPException(422, detail={
            "code": "unknown_requirements",
            "message": f"Requirements not found in this project: {', '.join(missing)}"})

    tc = TestCase(
        organisation_id=user.organisation_id, project_id=project_id,
        title=body.title.strip()[:500], description=body.description,
        preconditions=body.preconditions, type=body.type, priority=str(body.priority),
        state="draft", generated=False, user_modified=False,
        model="", prompt_version="", technique="manual",
    )
    if body.steps is not None:
        _replace_steps(tc, _resolve_endpoint_ids(
            db, project_id, user.organisation_id, _clean_steps(body.steps)))
    db.add(tc)
    db.flush()
    for rid in wanted:
        db.add(RequirementTestCase(
            requirement_id=rid, test_case_id=tc.id, link_source="manual",
            requirement_version_at_link=found[rid].version))
    audit(db, user.organisation_id, user.id, "test_case.created",
          "test_case", tc.id, {"manual": True, "requirement_ids": wanted})
    db.commit()
    return _case_detail(tc, _links_for(db, [tc.id]).get(tc.id, []))


# ---------------------------------------------------------------------------
# Routes — link management (FR-TRC-05)
# ---------------------------------------------------------------------------

class LinkBody(BaseModel):
    requirement_id: str


@router.post("/test-cases/{case_id}/links", status_code=201)
def add_link(case_id: str, body: LinkBody,
             user: User = Depends(require("edit_test_case")),
             db: Session = Depends(get_db)):
    tc = _get_case(case_id, user, db)
    req = db.get(Requirement, body.requirement_id)
    if (not req or req.organisation_id != user.organisation_id
            or req.project_id != tc.project_id):
        raise HTTPException(404, detail={
            "code": "not_found", "message": "Requirement not found in this project"})
    existing = db.get(RequirementTestCase, (req.id, tc.id))
    if existing:
        raise HTTPException(409, detail={
            "code": "link_exists", "message": "This requirement is already linked"})
    db.add(RequirementTestCase(requirement_id=req.id, test_case_id=tc.id,
                               link_source="manual",
                               requirement_version_at_link=req.version))
    audit(db, user.organisation_id, user.id, "test_case.link_added",
          "test_case", tc.id, {"requirement_id": req.id})
    db.commit()
    return {"test_case_id": tc.id, "links": _links_for(db, [tc.id]).get(tc.id, [])}


@router.delete("/test-cases/{case_id}/links/{requirement_id}")
def remove_link(case_id: str, requirement_id: str,
                user: User = Depends(require("edit_test_case")),
                db: Session = Depends(get_db)):
    tc = _get_case(case_id, user, db)
    link = db.get(RequirementTestCase, (requirement_id, case_id))
    if not link:
        raise HTTPException(404, detail={"code": "not_found", "message": "Link not found"})
    link_count = db.query(RequirementTestCase).filter(
        RequirementTestCase.test_case_id == tc.id).count()
    if link_count <= 1:
        # a case may never become untraceable (FR-GEN-02 / FR-TRC-05)
        raise HTTPException(409, detail={
            "code": "last_link",
            "message": "Cannot remove the last requirement link — every test case must trace to a requirement"})
    db.delete(link)
    audit(db, user.organisation_id, user.id, "test_case.link_removed",
          "test_case", tc.id, {"requirement_id": requirement_id})
    db.commit()
    return {"test_case_id": tc.id, "links": _links_for(db, [tc.id]).get(tc.id, [])}
