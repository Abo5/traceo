"""Shared FastAPI dependencies: auth, org scoping (FR-USR-04), permissions, audit."""
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import ApiToken, AuditEntry, Organisation, Project, User
from .security import API_TOKEN_PREFIX, decode_token, has_permission, hash_api_token


def _principal_from_api_token(clear: str, db: Session) -> User:
    """CI runners authenticate with a `trc_` token (FR-061). The token carries its own
    role and resolves to a detached, non-persistent User so every downstream
    permission and org-scoping check works unchanged."""
    row = db.query(ApiToken).filter(ApiToken.token_hash == hash_api_token(clear)).first()
    if not row or row.revoked:
        raise HTTPException(401, detail={"code": "invalid_token",
                                         "message": "Unknown or revoked API token"})
    row.last_used_at = datetime.now(timezone.utc)
    db.commit()
    # Constructed, never added to the session — so it can never be flushed into the
    # users table, while still satisfying every `User`-typed dependency downstream.
    principal = User(id=f"token:{row.id}", organisation_id=row.organisation_id,
                     email=f"{row.name}@token.traceo", name=row.name,
                     password_hash="", role=row.role, locale="en")
    principal.api_token_project_id = row.project_id  # consumed by assert_token_scope
    return principal


def get_current_user(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> User:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, detail={"code": "unauthenticated", "message": "Missing bearer token"})
    raw = authorization.removeprefix("Bearer ").strip()
    if raw.startswith(API_TOKEN_PREFIX):
        return _principal_from_api_token(raw, db)
    payload = decode_token(raw)
    if not payload:
        raise HTTPException(401, detail={"code": "invalid_token", "message": "Invalid or expired token"})
    user = db.get(User, payload["sub"])
    if not user:
        raise HTTPException(401, detail={"code": "unknown_user", "message": "User not found"})
    return user


def require(capability: str):
    def _dep(user: User = Depends(get_current_user)) -> User:
        if not has_permission(user.role, capability):
            raise HTTPException(403, detail={"code": "forbidden", "message": f"Role '{user.role}' lacks '{capability}'"})
        return user
    return _dep


def assert_token_scope(user: User, project_id: str) -> None:
    """A project-scoped CI token may only act on its own project (FR-061)."""
    scope = getattr(user, "api_token_project_id", None)
    if scope and scope != project_id:
        raise HTTPException(403, detail={"code": "token_scope",
                                         "message": "This API token is scoped to another project"})


def get_project_scoped(project_id: str, user: User, db: Session) -> Project:
    """Every project access path goes through this — org isolation (FR-USR-04, NFR-SEC-04)."""
    project = db.get(Project, project_id)
    if not project or project.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Project not found"})
    return project


def audit(db: Session, org_id: str, actor_id: str | None, action: str,
          object_type: str = "", object_id: str = "", detail: dict | None = None):
    """Append-only entry stamped with its retention date (FR-082 AC2/AC3): nothing may
    be purged before `retain_until`, and no update/delete path is exposed at all."""
    from datetime import timedelta
    org = db.get(Organisation, org_id)
    days = int(((org.settings or {}).get("audit_retention_days")
                if org else None) or settings.AUDIT_RETENTION_DAYS)
    db.add(AuditEntry(organisation_id=org_id, actor_id=actor_id, action=action,
                      object_type=object_type, object_id=object_id, detail=detail or {},
                      retain_until=datetime.now(timezone.utc) + timedelta(days=days)))
