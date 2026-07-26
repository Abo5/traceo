"""Shared FastAPI dependencies: auth, org scoping (FR-USR-04), permissions, audit."""
from fastapi import Depends, Header, HTTPException
from sqlalchemy.orm import Session

from .db import get_db
from .models import AuditEntry, Project, User
from .security import decode_token, has_permission


def get_current_user(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> User:
    if not authorization.startswith("Bearer "):
        raise HTTPException(401, detail={"code": "unauthenticated", "message": "Missing bearer token"})
    payload = decode_token(authorization.removeprefix("Bearer ").strip())
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


def get_project_scoped(project_id: str, user: User, db: Session) -> Project:
    """Every project access path goes through this — org isolation (FR-USR-04, NFR-SEC-04)."""
    project = db.get(Project, project_id)
    if not project or project.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Project not found"})
    return project


def audit(db: Session, org_id: str, actor_id: str | None, action: str,
          object_type: str = "", object_id: str = "", detail: dict | None = None):
    db.add(AuditEntry(organisation_id=org_id, actor_id=actor_id, action=action,
                      object_type=object_type, object_id=object_id, detail=detail or {}))
