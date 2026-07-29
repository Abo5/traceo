from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from . import jobs as jobstore
from .config import settings
from .db import Base, SessionLocal, engine
from .deps import get_current_user
from .models import Organisation, User
from .security import hash_password

from .modules.identity import router as identity_router
from .modules.projects import router as projects_router
from .modules.ingestion import router as ingestion_router
from .modules.discovery import router as discovery_router
from .modules.generation import router as generation_router
from .modules.review import router as review_router
from .modules.execution import router as execution_router
from .modules.traceability import router as traceability_router
from .modules.reporting import router as reporting_router
from .modules.integrations import router as integrations_router, start_scheduler
from .modules.reference import router as reference_router

app = FastAPI(title=settings.APP_NAME, version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

P = settings.API_V1_PREFIX
# integrations mounts FIRST: its X-API-Key wrappers must take precedence on the
# public-API paths (gate/traceability/run read/run launch — v2 addendum).
for r in (integrations_router, reference_router,
          identity_router, projects_router, ingestion_router, discovery_router,
          generation_router, review_router, execution_router, traceability_router,
          reporting_router):
    app.include_router(r, prefix=P)


@app.get(P + "/jobs/{job_id}")
def get_job(job_id: str, user=Depends(get_current_user)):
    job = jobstore.get(job_id)
    if not job:
        raise HTTPException(404, detail={"code": "not_found", "message": "Job not found"})
    return job.to_dict()


@app.get("/health")
def health():
    return {"status": "ok", "app": settings.APP_NAME}


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    start_scheduler()  # FR-060 daemon thread — guarded internally, starts once
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
