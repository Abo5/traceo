"""In-process async job manager. Mirrors the TRD's Celery queues (ingest/generate/execute/report)
without the Redis dependency — swap run_job's executor for Celery when scaling out (NFR-SCA-02)."""
import threading
import traceback
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


@dataclass
class Job:
    id: str
    kind: str  # ingest|generate|execute|report
    status: str = "queued"  # queued|running|completed|failed
    progress: float = 0.0
    message: str = ""
    result: Any = None
    error: str | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self):
        return {"id": self.id, "kind": self.kind, "status": self.status, "progress": self.progress,
                "message": self.message, "result": self.result, "error": self.error, "created_at": self.created_at}


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def submit(kind: str, fn: Callable[[Job], Any]) -> Job:
    job = Job(id=str(uuid.uuid4()), kind=kind)
    with _lock:
        _jobs[job.id] = job

    def _run():
        job.status = "running"
        try:
            job.result = fn(job)
            job.status = "completed"
            job.progress = 1.0
        except Exception as e:  # noqa: BLE001
            job.status = "failed"
            job.error = str(e)
            traceback.print_exc()

    threading.Thread(target=_run, daemon=True).start()
    return job


def get(job_id: str) -> Job | None:
    return _jobs.get(job_id)
