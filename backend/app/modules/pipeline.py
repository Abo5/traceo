"""The whole testing process as one job.

Traceo already had every stage as its own endpoint: parse a document, scan a
URL, generate cases, run them, read the report. That is the right decomposition
for an API and the wrong shape for the question a user actually arrives with —
*"here is my site, is it broken?"* — because answering it meant driving five
routes in the right order and knowing which ones to skip.

This module composes those stages without duplicating any of them. It calls the
same job bodies the individual endpoints call (`_run_ingest`,
`run_discovery_job`, `_run_generation`, `run_verify_job`, `_execute_run`), so
there is one implementation of each engine and this file only decides the order
and what to do when a stage produces nothing.

    document? ─▶ parse ─┐
                        ├─▶ scan URL ─▶ generate? ─┬─▶ browser run ─┐
    url + test types ───┘                          └─▶ HTTP run ────┴─▶ counts + fix prompts

Three properties worth stating.

**The document is optional, and its absence is not a degraded mode.** With a BRD
the scan's findings get checked against what you *said* should happen; without
one they are checked against what the page itself declares (a `required`
attribute is a claim, and a form that ignores it is a defect whether or not a
document mentions it). Skipping the stage is recorded in `stages`, never
silently.

**Scope is this target, not the project.** A project with 500 existing cases does
not re-run all of them because you pointed the pipeline at one page: the browser
side selects by the scanned URL, the HTTP side by cases that call an endpoint
discovered from it (plus anything this job created). Provenance, not recency —
selecting on "new since I started" made a SECOND run over the same page skip the
cases the first run had already created, including the one that failed.

**Nothing is approved.** Cases run in whatever state they are in and stay there;
approval remains a human act (see webverify.py for the same stance).
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..jobs import JobError
from ..models import (Endpoint, Requirement, RequirementTestCase, Run,
                      SourceDocument, TestCase, TestStep, User, WebTarget)
from . import webtarget, webverify
from .execution import _execute_run
from .fixprompt import fix_prompts_for
from .generation import _run_generation
from .ingestion import _run_ingest
from .reporting import _report_entries
from .traceability import run_display_id

router = APIRouter()


# ---------------------------------------------------------------------------
# progress plumbing
# ---------------------------------------------------------------------------

class _Stage:
    """A job-shaped proxy that maps a sub-job's 0..1 progress into a slice.

    The engine job bodies write `job.progress` and `job.message` directly. Handing
    them the pipeline's own job would make each stage reset the bar to zero, so
    each gets one of these instead — same duck type, scaled writes.
    """

    def __init__(self, parent, lo: float, hi: float, label: str):
        self._parent = parent
        self._lo = lo
        self._hi = hi
        self._label = label
        self.id = getattr(parent, "id", "")
        self.kind = getattr(parent, "kind", "pipeline")
        self.project_id = getattr(parent, "project_id", None)
        self.result = None
        self.status = "running"

    @property
    def progress(self) -> float:
        return self._parent.progress

    @progress.setter
    def progress(self, value: float) -> None:
        try:
            frac = max(0.0, min(1.0, float(value)))
        except (TypeError, ValueError):
            return
        self._parent.progress = self._lo + (self._hi - self._lo) * frac

    @property
    def message(self) -> str:
        return self._parent.message

    @message.setter
    def message(self, value: str) -> None:
        self._parent.message = f"{self._label}: {value}" if value else self._label


def _say(job, pct: float, message: str) -> None:
    job.progress = pct
    job.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# request
# ---------------------------------------------------------------------------

class PipelineRequest(BaseModel):
    url: str
    viewport: str | None = None
    test_types: list[str] | None = None
    # Optional: upload with POST /projects/{id}/documents first, pass the id here.
    document_id: str | None = None
    # Let a correctly-filled form actually submit. OFF by default because a real
    # submission creates data on the target; with it off the runner intercepts
    # and aborts the request instead, and any case that genuinely needs a real
    # submit is recorded `skipped` with that reason rather than passed.
    allow_submit: bool = False


# ---------------------------------------------------------------------------
# case selection
# ---------------------------------------------------------------------------

def _browser_check(step: TestStep) -> bool:
    req = step.request if isinstance(step.request, dict) else {}
    return bool(req.get("check"))


def discovered_endpoint_ids(db: Session, org_id: str, project_id: str) -> set[str]:
    """Endpoints this project learned from a rendered page (`source="dom"`)."""
    return {e for (e,) in db.query(Endpoint.id).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == org_id,
        Endpoint.source == "dom")}


def http_runnable(db: Session, org_id: str, project_id: str,
                  only_ids: set[str], endpoint_ids: set[str] | None = None) -> list[str]:
    """The HTTP-executable cases that belong to this target.

    A case qualifies when it has a step with a path and no DOM `check` — the same
    split webverify makes, read from the other side — AND it belongs to this run:
    either this job created it, or it calls an endpoint discovered from the page
    this job scanned.

    That second clause is load-bearing. Selecting purely on "created by this job"
    looked right and was wrong: on a SECOND run over the same page the scan
    recognises its cases as duplicates and does not recreate them, so they fall
    outside the new-id set and are never executed. The observed result was a
    re-run that quietly stopped checking the security case that had failed the
    first time and reported all-green — the exact failure this whole feature
    exists to prevent, one level up. Provenance is stable across re-runs; "new
    since I started" is not.
    """
    ids = set(only_ids or set())
    endpoint_ids = endpoint_ids or set()
    if not ids and not endpoint_ids:
        return []

    cases = db.scalars(select(TestCase).where(
        TestCase.project_id == project_id,
        TestCase.organisation_id == org_id,
        TestCase.state != "archived")).all()
    if not cases:
        return []
    steps: dict[str, list[TestStep]] = {}
    rows = db.scalars(select(TestStep).where(
        TestStep.test_case_id.in_([c.id for c in cases]))).all()
    for s in rows:
        steps.setdefault(s.test_case_id, []).append(s)

    out = []
    for case in cases:
        mine = steps.get(case.id) or []
        if not mine or any(_browser_check(s) for s in mine):
            continue
        if not any((s.path or "").strip() for s in mine):
            continue
        belongs = case.id in ids or any(
            s.endpoint_id and s.endpoint_id in endpoint_ids for s in mine)
        if belongs:
            out.append(case.id)
    return out


# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------

def run_pipeline_job(job, org_id: str, user_id: str, project_id: str,
                     url: str, viewport: str, test_types: list[str],
                     document_id: str | None, allow_submit: bool = False) -> dict:
    stages: list[dict] = []
    runs: list[dict] = []

    def note(name: str, status: str, **detail) -> None:
        stages.append({"stage": name, "status": status, **detail})

    db: Session = SessionLocal()
    try:
        # Everything that already existed is not this run's business.
        before: set[str] = {
            c for (c,) in db.query(TestCase.id).filter(
                TestCase.project_id == project_id,
                TestCase.organisation_id == org_id)}
    finally:
        db.close()

    # ---- 1. requirements (optional) ---------------------------------------
    already_parsed = False
    if document_id:
        db = SessionLocal()
        try:
            doc = db.get(SourceDocument, document_id)
            already_parsed = bool(doc and doc.parse_status == "parsed")
        finally:
            db.close()

    if document_id and already_parsed:
        # POST /projects/{id}/documents parses on upload, so a UI that shows you
        # "28 rules found" before you press Start has already done this stage.
        # Re-running it would re-diff the same file to a row of zeros and read
        # like the document had no content.
        note("requirements", "reused",
             reason="This document was already parsed on upload; its requirements are in use.")
    elif document_id:
        _say(job, 0.02, "Reading the requirements document…")
        try:
            # _run_ingest also runs the autopilot chain on an `auto` project:
            # it confirms the extracted requirements and tries the generation
            # trigger. That trigger no-ops here because no endpoint exists yet —
            # the scan has not run — so generation stays this job's step 3 and
            # the two cannot race.
            ingest = _run_ingest(_Stage(job, 0.02, 0.18, "Requirements"),
                                 document_id, project_id, org_id, user_id)
            note("requirements", "completed", counts=ingest or {})
        except Exception as exc:  # noqa: BLE001
            # A document we cannot read must not sink the run: the scan alone is
            # still a real answer. Say so rather than failing everything.
            note("requirements", "failed", reason=str(exc)[:300])
    else:
        note("requirements", "skipped",
             reason="No document was provided — the scan checks the page against "
                    "what it declares about itself.")

    # ---- 2. scan the target ------------------------------------------------
    _say(job, 0.20, "Opening the page in a browser…")
    db = SessionLocal()
    try:
        target = db.scalars(select(WebTarget).where(
            WebTarget.project_id == project_id,
            WebTarget.organisation_id == org_id,
            WebTarget.url == url, WebTarget.viewport == viewport)).first()
        if target is None:
            target = WebTarget(organisation_id=org_id, project_id=project_id,
                               url=url, viewport=viewport, status="pending")
            db.add(target)
        else:
            target.status = "pending"
            target.last_error = None
        db.commit()
        target_id = target.id
    finally:
        db.close()

    scan = webtarget.run_discovery_job(
        _Stage(job, 0.20, 0.55, "Scan"), org_id, user_id, project_id, target_id,
        url, viewport, test_types)
    note("scan", "completed",
         forms=scan.get("forms"), requests=scan.get("requests"),
         endpoints=scan.get("endpoints"), requirements=scan.get("requirements"),
         cases_by_type=scan.get("cases_by_type"), skipped=scan.get("skipped"))

    # ---- 3. generate from the requirements (only when something needs it) ----
    db = SessionLocal()
    try:
        endpoint_count = db.query(Endpoint).filter(
            Endpoint.project_id == project_id,
            Endpoint.organisation_id == org_id).count()
        # Confirmed requirements that no case covers yet. Without this gate a
        # re-run regenerates over requirements that already have cases, and the
        # project accumulates a fresh near-duplicate on every run — observed as
        # five copies of one "Positive: valid request" case after five runs.
        uncovered = db.query(Requirement.id).filter(
            Requirement.project_id == project_id,
            Requirement.organisation_id == org_id,
            Requirement.state == "confirmed",
            ~Requirement.id.in_(select(RequirementTestCase.requirement_id))).count()
    finally:
        db.close()

    # Generation is gated on a document because that is what supplies rules the
    # page does not state about itself; it needs an endpoint inventory to ground
    # against, and something left to cover.
    if document_id and endpoint_count and uncovered:
        _say(job, 0.58, "Writing test cases from your requirements…")
        try:
            gen = _run_generation(_Stage(job, 0.58, 0.68, "Generation"),
                                  org_id, user_id, project_id, None, "standard")
            note("generation", "completed", generated=(gen or {}).get("generated"),
                 discarded=(gen or {}).get("discarded"))
        except Exception as exc:  # noqa: BLE001
            note("generation", "failed", reason=str(exc)[:300])
    elif document_id and not endpoint_count:
        note("generation", "skipped",
             reason="No API endpoints were discovered, so requirement-derived API "
                    "cases would have nothing to call. Enable the 'api' test type "
                    "or import a spec.")
    elif document_id and not uncovered:
        note("generation", "skipped",
             reason="Every confirmed requirement already has cases — re-generating "
                    "would only add near-duplicates.")
    else:
        note("generation", "skipped", reason="No document, so no requirements to generate from.")

    # ---- 4. run the DOM cases in the browser -------------------------------
    _say(job, 0.70, "Running the page checks in a browser…")
    db = SessionLocal()
    try:
        target = db.get(WebTarget, target_id)
        browser_cases = webverify.collect_browser_cases(db, org_id, project_id, target)
        env = webverify.ensure_environment(db, org_id, project_id, target)
        env_id = env.id
        browser_run_id = None
        if browser_cases:
            run = Run(organisation_id=org_id, project_id=project_id,
                      environment_id=env_id, kind="functional", state="queued",
                      counts={"total": len(browser_cases), "passed": 0,
                              "failed": 0, "errored": 0},
                      initiated_by=user_id)
            db.add(run)
            db.commit()
            browser_run_id = run.id
    finally:
        db.close()

    if browser_run_id:
        try:
            webverify.run_verify_job(_Stage(job, 0.70, 0.88, "Browser checks"),
                                     org_id, user_id, project_id, target_id,
                                     browser_run_id, allow_submit=allow_submit)
            runs.append({"run_id": browser_run_id, "kind": "browser"})
            note("browser_run", "completed", cases=len(browser_cases))
        except JobError as exc:
            note("browser_run", "failed", code=exc.code, reason=exc.message)
    else:
        note("browser_run", "skipped",
             reason="The scan found no form or page check to run — enable the "
                    "'functional' or 'performance' test type.")

    # ---- 5. run the HTTP cases against the site ----------------------------
    _say(job, 0.90, "Calling the APIs the page uses…")
    db = SessionLocal()
    try:
        after: set[str] = {
            c for (c,) in db.query(TestCase.id).filter(
                TestCase.project_id == project_id,
                TestCase.organisation_id == org_id)}
        new_ids = after - before
        http_ids = http_runnable(db, org_id, project_id, new_ids,
                                 discovered_endpoint_ids(db, org_id, project_id))
        http_run_id = None
        if http_ids:
            run = Run(organisation_id=org_id, project_id=project_id,
                      environment_id=env_id, kind="functional", state="queued",
                      counts={}, initiated_by=user_id)
            db.add(run)
            db.commit()
            http_run_id = run.id
    finally:
        db.close()

    if http_run_id:
        try:
            _execute_run(_Stage(job, 0.90, 0.99, "API checks"), http_run_id, http_ids)
            runs.append({"run_id": http_run_id, "kind": "http"})
            note("http_run", "completed", cases=len(http_ids))
        except Exception as exc:  # noqa: BLE001
            note("http_run", "failed", reason=str(exc)[:300])
    else:
        note("http_run", "skipped",
             reason="This run produced no HTTP-callable case — the 'api' and "
                    "'security' types build those from captured requests.")

    # ---- 6. combined verdict ----------------------------------------------
    _say(job, 0.99, "Collecting results…")
    totals = {"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0}
    prompts: list[dict] = []
    db = SessionLocal()
    try:
        for entry in runs:
            run = db.get(Run, entry["run_id"])
            if run is None:
                continue
            counts = run.counts or {}
            for k in totals:
                totals[k] += int(counts.get(k) or 0)
            report_entries = _report_entries(db, run)
            label = f"RUN-{run_display_id(db, run)}"
            entry["counts"] = counts
            entry["display_id"] = run_display_id(db, run)
            prompts.extend(fix_prompts_for(report_entries, run_label=label))
        audit(db, org_id, user_id, "pipeline.completed", "web_target", target_id,
              {"url": url, "test_types": test_types, **totals})
        db.commit()
    finally:
        db.close()

    return {
        "target_id": target_id, "url": url, "environment_id": env_id,
        "test_types": test_types, "allow_submit": allow_submit,
        "stages": stages, "runs": runs,
        "counts": totals, "fix_prompts": prompts,
    }


# ---------------------------------------------------------------------------
# route
# ---------------------------------------------------------------------------

@router.post("/projects/{project_id}/pipeline", status_code=202)
def start_pipeline(project_id: str, body: PipelineRequest,
                   user: User = Depends(require("trigger_run")),
                   db: Session = Depends(get_db)):
    """Scan a URL, build tests from it (and any document), run them, report."""
    get_project_scoped(project_id, user, db)
    url = webtarget.validate_target_url(body.url)
    viewport = webtarget.validate_viewport(body.viewport)
    test_types = webtarget.validate_test_types(body.test_types)

    document_id = None
    if body.document_id:
        doc = db.get(SourceDocument, body.document_id)
        if (doc is None or doc.project_id != project_id
                or doc.organisation_id != user.organisation_id):
            raise HTTPException(404, detail={
                "code": "not_found", "message": "Document not found in this project"})
        document_id = doc.id

    # One pipeline per project at a time: two of them would scan the same URL
    # into the same target row and interleave their case sets.
    if jobstore.has_active("pipeline", project_id):
        raise HTTPException(409, detail={
            "code": "pipeline_in_progress",
            "message": "A test run is already in progress for this project."})

    audit(db, user.organisation_id, user.id, "pipeline.requested", "project", project_id,
          {"url": url, "viewport": viewport, "test_types": test_types,
           "document_id": document_id, "allow_submit": body.allow_submit})
    db.commit()

    org_id, user_id = user.organisation_id, user.id
    job = jobstore.submit(
        "pipeline",
        lambda j: run_pipeline_job(j, org_id, user_id, project_id, url, viewport,
                                   test_types, document_id, body.allow_submit),
        project_id=project_id)
    return {"job_id": job.id, "url": url, "test_types": test_types,
            "document_id": document_id, "allow_submit": body.allow_submit}
