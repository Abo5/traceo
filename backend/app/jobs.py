"""In-process async job manager. Mirrors the TRD's Celery queues (ingest/generate/execute/report)
without the Redis dependency — swap run_job's executor for Celery when scaling out (NFR-SCA-02)."""
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


class JobError(Exception):
    """A job failure the caller is expected to ACT on, carrying a stable code.

    A bare exception string tells the UI nothing it can branch on: "node: command
    not found" and "the page timed out" need different sentences in front of the
    user, and only the failing code knows which is which."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Job:
    id: str
    kind: str  # ingest|generate|execute|report|discover
    project_id: str | None = None  # lets has_active() guard per-project double-triggers
    status: str = "queued"  # queued|running|completed|failed
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: str | None = None
    # Machine-readable failure code, set only when the job raised a JobError.
    error_code: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "status": self.status, "progress": self.progress,
                "message": self.message, "result": self.result, "error": self.error,
                "error_code": self.error_code, "created_at": self.created_at}


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def submit(kind: str, fn: Callable[[Job], Any], project_id: str | None = None) -> Job:
    job = Job(id=str(uuid.uuid4()), kind=kind, project_id=project_id)
    with _lock:
        _jobs[job.id] = job

    def _run():
        job.status = "running"
        try:
            job.result = fn(job)
            job.status = "completed"
            job.progress = 1.0
        except JobError as e:
            job.status = "failed"
            job.error = e.message
            job.error_code = e.code
        except Exception as e:  # noqa: BLE001
            job.status = "failed"
            job.error = str(e)
            traceback.print_exc()

    threading.Thread(target=_run, daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)


def has_active(kind: str, project_id: str) -> bool:
    """True when a job of this kind for this project is queued or running —
    the autopilot generation trigger's double-fire guard (contract 4b)."""
    with _lock:
        jobs = list(_jobs.values())
    return any(j.kind == kind and j.project_id == project_id
               and j.status in ("queued", "running") for j in jobs)
