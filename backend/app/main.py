import logging
import threading
import time

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import jobs as jobstore
from .config import settings
from .db import SessionLocal, sync_schema
from .deps import get_current_user
from .models import Organisation, User
from .security import hash_password

from .modules.identity import router as identity_router
from .modules.projects import router as projects_router
from .modules.ingestion import router as ingestion_router
from .modules.discovery import router as discovery_router
from .modules.capture import router as capture_router
from .modules.generation import router as generation_router
from .modules.review import router as review_router
from .modules.execution import router as execution_router
from .modules.traceability import router as traceability_router
from .modules.reporting import router as reporting_router
from .modules.automation import router as automation_router
from .modules.integrations import router as integrations_router

log = logging.getLogger("traceo")

app = FastAPI(title=settings.APP_NAME, version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

P = settings.API_V1_PREFIX
for r in (identity_router, projects_router, ingestion_router, discovery_router,
          capture_router, generation_router, review_router, execution_router,
          traceability_router, reporting_router, automation_router,
          integrations_router):
    app.include_router(r, prefix=P)


@app.get(P + "/jobs/{job_id}")
def get_job(job_id: str, user=Depends(get_current_user)):
    job = jobstore.get(job_id)
    if not job:
        raise HTTPException(404, detail={"code": "not_found", "message": "Job not found"})
    return job.to_dict()


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME,
            "on_premise": settings.ON_PREMISE,
            "telemetry": settings.TELEMETRY_ENABLED,
            "scheduler": settings.SCHEDULER_ENABLED}


# --- scheduler (FR-060) ------------------------------------------------------
# One in-process thread, ticking on a fixed interval. A tick opens its own session,
# fires whatever is due and goes back to sleep; overlapping runs are handled inside
# run_due_schedules, which defers rather than executing two runs against the same
# environment at once.

_scheduler_stop = threading.Event()


def _scheduler_loop():
    from .modules.automation import run_due_schedules
    while not _scheduler_stop.wait(settings.SCHEDULER_TICK_S):
        db = SessionLocal()
        try:
            for outcome in run_due_schedules(db):
                log.info("scheduler: %s", outcome)
        except Exception:  # noqa: BLE001 — a bad tick must never kill the thread
            log.exception("scheduler tick failed")
        finally:
            db.close()


@app.on_event("shutdown")
def shutdown():
    _scheduler_stop.set()


@app.on_event("startup")
def startup():
    added = sync_schema()
    if added:
        log.info("schema sync added columns: %s", ", ".join(added))
    if settings.ON_PREMISE:
        # FR-081 AC3/AC4: no model calls leave the network, telemetry stays off.
        settings.LLM_PROVIDER = "mock"
        log.info("on-premise mode: offline provider, egress allow-list=%s",
                 settings.EGRESS_ALLOWLIST or "(empty)")
    if settings.SCHEDULER_ENABLED:
        threading.Thread(target=_scheduler_loop, name="traceo-scheduler",
                         daemon=True).start()
    if settings.SEED_DEMO:
        db = SessionLocal()
        try:
            if not db.query(User).filter_by(email="demo@traceo.sa").first():
                org = Organisation(name="Traceo Demo Org", plan="team")
                db.add(org)
                db.flush()
                db.add(User(organisation_id=org.id, email="demo@traceo.sa", name="Nawaf Al-Qahtani",
                            password_hash=hash_password("Demo1234!"), role="qa_lead", locale="ar"))
                db.add(User(organisation_id=org.id, email="admin@traceo.sa", name="Reem Al-Otaibi",
                            password_hash=hash_password("Demo1234!"), role="admin", locale="ar"))
                db.commit()
        finally:
            db.close()
