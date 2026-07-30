"""Identity module — auth, profile, org members, audit log (FR-USR).

Endpoints (mounted under /v1 by main.py):
- POST  /auth/register   create Organisation + admin User, return token immediately
- POST  /auth/login      audited ('auth.login'); failures are generic 401s
- GET   /me / PATCH /me  own profile
- GET   /members         (view)
- POST  /members/invite  (manage_members)
- PATCH /members/{id}    (manage_members) — cannot demote the last admin
- DELETE /members/{id}   (manage_members) — cannot delete yourself
- GET   /audit           (view_audit_log) — newest first, cursor pagination
- GET   /audit/export.csv, GET/PUT /audit/retention, POST /audit/purge  (FR-082)
"""
import json
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import audit, get_current_user, require
from ..models import AuditEntry, Organisation, User
from ..security import ROLES, create_token, hash_password, verify_password

router = APIRouter()

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_LOCALES = ("en", "ar")


# --- helpers -----------------------------------------------------------------

def _iso(dt):
    return dt.isoformat() if dt else None


def _user_payload(user: User, org_name: str | None = None) -> dict:
    data = {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role,
        "locale": user.locale,
        "organisation_id": user.organisation_id,
        "created_at": _iso(user.created_at),
    }
    if org_name is not None:
        data["org_name"] = org_name
    return data


def _org_name(db: Session, org_id: str) -> str:
    org = db.get(Organisation, org_id)
    return org.name if org else ""


def _validate_email(email: str) -> str:
    email = email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(422, detail={"code": "invalid_email", "message": "Invalid email address"})
    return email


def _validate_role(role: str) -> str:
    if role not in ROLES:
        raise HTTPException(422, detail={
            "code": "invalid_role", "message": f"Role must be one of: {', '.join(ROLES)}"})
    return role


def _get_member(member_id: str, user: User, db: Session) -> User:
    """Org-isolated member lookup (FR-USR-04)."""
    member = db.get(User, member_id)
    if not member or member.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Member not found"})
    return member


def _admin_count(db: Session, org_id: str) -> int:
    return db.query(User).filter(
        User.organisation_id == org_id, User.role == "admin").count()


# --- request models ----------------------------------------------------------

class RegisterIn(BaseModel):
    org_name: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    email: str
    password: str = Field(min_length=8, max_length=200)
    locale: str = "en"


class LoginIn(BaseModel):
    email: str
    password: str


class MeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    locale: str | None = None


class InviteIn(BaseModel):
    email: str
    name: str = Field(min_length=1, max_length=200)
    role: str = "qa_engineer"
    password: str = Field(min_length=8, max_length=200)


class RoleUpdate(BaseModel):
    role: str


# --- auth --------------------------------------------------------------------

@router.post("/auth/register", status_code=201)
def register(body: RegisterIn, db: Session = Depends(get_db)):
    email = _validate_email(body.email)
    if body.locale not in _LOCALES:
        raise HTTPException(422, detail={"code": "invalid_locale", "message": "Locale must be 'en' or 'ar'"})
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(409, detail={"code": "email_taken", "message": "Email is already registered"})

    org = Organisation(name=body.org_name.strip())
    db.add(org)
    db.flush()
    user = User(organisation_id=org.id, email=email, name=body.name.strip(),
                password_hash=hash_password(body.password), role="admin", locale=body.locale)
    db.add(user)
    db.flush()
    audit(db, org.id, user.id, "auth.register", "user", user.id,
          {"email": email, "org_name": org.name})
    db.commit()
    return {"token": create_token(user.id, org.id, user.role),
            "user": _user_payload(user, org.name)}


@router.post("/auth/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if not user or not verify_password(body.password, user.password_hash):
        # Never reveal which field was wrong (NFR-SEC).
        if user:
            audit(db, user.organisation_id, user.id, "auth.login_failed", "user", user.id,
                  {"email": email})
            db.commit()
        raise HTTPException(401, detail={"code": "invalid_credentials",
                                         "message": "Invalid email or password"})
    audit(db, user.organisation_id, user.id, "auth.login", "user", user.id, {"email": email})
    db.commit()
    return {"token": create_token(user.id, user.organisation_id, user.role),
            "user": _user_payload(user, _org_name(db, user.organisation_id))}


# --- own profile -------------------------------------------------------------

@router.get("/me")
def get_me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _user_payload(user, _org_name(db, user.organisation_id))


@router.patch("/me")
def update_me(body: MeUpdate, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    if body.name is not None:
        user.name = body.name.strip()
    if body.locale is not None:
        if body.locale not in _LOCALES:
            raise HTTPException(422, detail={"code": "invalid_locale",
                                             "message": "Locale must be 'en' or 'ar'"})
        user.locale = body.locale
    db.commit()
    return _user_payload(user, _org_name(db, user.organisation_id))


# --- members -----------------------------------------------------------------

@router.get("/members")
def list_members(user: User = Depends(require("view")), db: Session = Depends(get_db)):
    members = (db.query(User)
               .filter(User.organisation_id == user.organisation_id)
               .order_by(User.created_at.asc())
               .all())
    return [_user_payload(m) for m in members]


@router.post("/members/invite", status_code=201)
def invite_member(body: InviteIn, user: User = Depends(require("manage_members")),
                  db: Session = Depends(get_db)):
    email = _validate_email(body.email)
    _validate_role(body.role)
    if db.query(User).filter(User.email == email).first():
        raise HTTPException(409, detail={"code": "email_taken", "message": "Email is already registered"})
    member = User(organisation_id=user.organisation_id, email=email, name=body.name.strip(),
                  password_hash=hash_password(body.password), role=body.role)
    db.add(member)
    db.flush()
    audit(db, user.organisation_id, user.id, "member.invite", "user", member.id,
          {"email": email, "role": body.role})
    db.commit()
    return _user_payload(member)


@router.patch("/members/{member_id}")
def update_member(member_id: str, body: RoleUpdate,
                  user: User = Depends(require("manage_members")),
                  db: Session = Depends(get_db)):
    _validate_role(body.role)
    member = _get_member(member_id, user, db)
    if member.role == "admin" and body.role != "admin" and \
            _admin_count(db, user.organisation_id) <= 1:
        raise HTTPException(400, detail={"code": "last_admin",
                                         "message": "Cannot demote the last admin of the organisation"})
    old_role = member.role
    member.role = body.role
    audit(db, user.organisation_id, user.id, "member.role_change", "user", member.id,
          {"from": old_role, "to": body.role})
    db.commit()
    return _user_payload(member)


@router.delete("/members/{member_id}")
def delete_member(member_id: str, user: User = Depends(require("manage_members")),
                  db: Session = Depends(get_db)):
    member = _get_member(member_id, user, db)
    if member.id == user.id:
        raise HTTPException(400, detail={"code": "cannot_delete_self",
                                         "message": "You cannot delete your own account"})
    if member.role == "admin" and _admin_count(db, user.organisation_id) <= 1:
        raise HTTPException(400, detail={"code": "last_admin",
                                         "message": "Cannot delete the last admin of the organisation"})
    audit(db, user.organisation_id, user.id, "member.delete", "user", member.id,
          {"email": member.email})
    db.delete(member)
    db.commit()
    return {"deleted": True}


# --- audit log ---------------------------------------------------------------

@router.get("/audit")
def audit_log(limit: int = 50, cursor: str | None = None,
              user: User = Depends(require("view_audit_log")),
              db: Session = Depends(get_db)):
    limit = max(1, min(limit, 200))
    q = db.query(AuditEntry).filter(AuditEntry.organisation_id == user.organisation_id)
    if cursor:
        anchor = db.get(AuditEntry, cursor)
        if not anchor or anchor.organisation_id != user.organisation_id:
            raise HTTPException(400, detail={"code": "invalid_cursor", "message": "Unknown cursor"})
        q = q.filter(or_(AuditEntry.occurred_at < anchor.occurred_at,
                         and_(AuditEntry.occurred_at == anchor.occurred_at,
                              AuditEntry.id < anchor.id)))
    entries = (q.order_by(AuditEntry.occurred_at.desc(), AuditEntry.id.desc())
               .limit(limit + 1).all())
    has_more = len(entries) > limit
    items = entries[:limit]
    return {
        "items": [{
            "id": e.id,
            "actor_id": e.actor_id,
            "action": e.action,
            "object_type": e.object_type,
            "object_id": e.object_id,
            "detail": e.detail or {},
            "occurred_at": _iso(e.occurred_at),
            "retain_until": _iso(e.retain_until),
        } for e in items],
        "next_cursor": items[-1].id if has_more and items else None,
    }


# --- audit retention + export (FR-082 AC2/AC3/AC4) ----------------------------

@router.get("/audit/retention")
def get_retention(user: User = Depends(require("view_audit_log")),
                  db: Session = Depends(get_db)):
    org = db.get(Organisation, user.organisation_id)
    days = int((org.settings or {}).get("audit_retention_days") or settings.AUDIT_RETENTION_DAYS)
    purgeable = (db.query(func.count(AuditEntry.id))
                 .filter(AuditEntry.organisation_id == user.organisation_id,
                         AuditEntry.retain_until != None,  # noqa: E711
                         AuditEntry.retain_until <= datetime.now(timezone.utc))
                 .scalar() or 0)
    total = (db.query(func.count(AuditEntry.id))
             .filter(AuditEntry.organisation_id == user.organisation_id).scalar() or 0)
    return {"retention_days": days, "default_days": settings.AUDIT_RETENTION_DAYS,
            "entries": total, "past_retention": purgeable}


@router.put("/audit/retention")
def set_retention(body: dict = Body(...),
                  user: User = Depends(require("manage_members")),
                  db: Session = Depends(get_db)):
    days = body.get("retention_days")
    if not isinstance(days, int) or not (1 <= days <= 3650):
        raise HTTPException(422, detail={
            "code": "invalid_retention",
            "message": "retention_days must be an integer between 1 and 3650"})
    org = db.get(Organisation, user.organisation_id)
    org.settings = {**(org.settings or {}), "audit_retention_days": days}
    audit(db, user.organisation_id, user.id, "audit.retention_changed", "organisation",
          org.id, {"retention_days": days})
    db.commit()
    return {"retention_days": days}


@router.post("/audit/purge")
def purge_expired(user: User = Depends(require("manage_members")),
                  db: Session = Depends(get_db)):
    """The ONLY deletion path, and it cannot touch an entry before its retention date
    (FR-082 AC2). Entries are never editable through any route."""
    now = datetime.now(timezone.utc)
    removed = (db.query(AuditEntry)
               .filter(AuditEntry.organisation_id == user.organisation_id,
                       AuditEntry.retain_until != None,  # noqa: E711
                       AuditEntry.retain_until <= now)
               .delete(synchronize_session=False))
    audit(db, user.organisation_id, user.id, "audit.purged", "organisation",
          user.organisation_id, {"removed": removed})
    db.commit()
    return {"removed": removed}


@router.get("/audit/export.csv")
def export_audit(user: User = Depends(require("view_audit_log")),
                 db: Session = Depends(get_db)):
    """FR-082 AC4 — the whole log, in the format an auditor asks for."""
    import csv
    import io

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "occurred_at", "actor_id", "action", "object_type",
                     "object_id", "retain_until", "detail"])
    rows = (db.query(AuditEntry)
            .filter(AuditEntry.organisation_id == user.organisation_id)
            .order_by(AuditEntry.occurred_at.asc(), AuditEntry.id.asc()).all())
    for e in rows:
        writer.writerow([e.id, _iso(e.occurred_at), e.actor_id or "", e.action,
                         e.object_type, e.object_id, _iso(e.retain_until) or "",
                         json.dumps(e.detail or {}, ensure_ascii=False)])
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="traceo-audit.csv"'})
