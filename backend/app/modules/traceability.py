"""Traceability module (TRD §4.7) — the live requirement -> case -> latest-result view.

The RequirementTestCase join table "is the product": this module renders it as the
coverage matrix (FR-TRC-01/02), computes the coverage KPI (FR-TRC-03), surfaces gaps
(FR-TRC-06), keeps the staleness contract (FR-TRC-04 — `mark_stale` is imported by the
ingestion module) and exposes per-requirement run history (FR-TRC-07).
"""
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_project_scoped, require
from ..models import (Requirement, RequirementTestCase, Run, TestCase,
                      TestResult, User)

router = APIRouter()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ---------------------------------------------------------------------------
# Staleness helper — imported by ingestion (FR-TRC-04). Caller owns the commit.
# ---------------------------------------------------------------------------

def mark_stale(db: Session, requirement_id: str) -> None:
    """A changed requirement invalidates every APPROVED case linked to it."""
    case_ids = [link.test_case_id for link in db.scalars(
        select(RequirementTestCase).where(
            RequirementTestCase.requirement_id == requirement_id)).all()]
    if not case_ids:
        return
    for tc in db.scalars(select(TestCase).where(
            TestCase.id.in_(case_ids), TestCase.state == "approved")).all():
        tc.state = "stale"


# ---------------------------------------------------------------------------
# Latest-outcome computation
# ---------------------------------------------------------------------------

def _latest_outcomes(db: Session, case_ids: list[str]) -> dict[str, str]:
    """test_case_id -> outcome of its most recent TestResult (created_at desc)."""
    if not case_ids:
        return {}
    latest: dict[str, str] = {}
    rows = (db.query(TestResult.test_case_id, TestResult.outcome)
            .filter(TestResult.test_case_id.in_(case_ids))
            .order_by(TestResult.created_at.asc(), TestResult.id.asc())
            .all())
    for case_id, outcome in rows:  # ascending order: the last write wins = newest
        latest[case_id] = outcome
    return latest


def _requirement_status(cases: list[dict]) -> str:
    """FR-TRC-02 status ladder. Only APPROVED cases count as coverage."""
    approved = [c for c in cases if c["state"] == "approved"]
    if not approved:
        return "not_covered"
    outcomes = [c["latest_outcome"] for c in approved if c["latest_outcome"]]
    if not outcomes:
        return "covered_not_run"
    if any(o == "failed" for o in outcomes):
        return "failing"
    if any(o == "errored" for o in outcomes):
        return "errored"
    return "passing"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/projects/{project_id}/traceability")
def traceability_matrix(project_id: str, user: User = Depends(require("view")),
                        db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)

    reqs = (db.query(Requirement)
            .filter(Requirement.project_id == project_id,
                    Requirement.organisation_id == user.organisation_id,
                    Requirement.state != "removed")
            .order_by(Requirement.external_id.asc(), Requirement.created_at.asc())
            .all())

    links = (db.query(RequirementTestCase, TestCase)
             .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
             .filter(TestCase.project_id == project_id,
                     TestCase.organisation_id == user.organisation_id)
             .all())
    cases_by_req: dict[str, list[TestCase]] = {}
    for link, tc in links:
        cases_by_req.setdefault(link.requirement_id, []).append(tc)

    all_case_ids = list({tc.id for _link, tc in links})
    latest = _latest_outcomes(db, all_case_ids)

    rows, gaps = [], []
    confirmed_total = confirmed_covered = 0
    for req in reqs:
        linked = sorted(cases_by_req.get(req.id, []), key=lambda c: (c.created_at or 0, c.id))
        cases = [{"id": tc.id, "title": tc.title, "state": tc.state,
                  "latest_outcome": latest.get(tc.id)} for tc in linked]
        status = _requirement_status(cases)
        has_approved = any(c["state"] == "approved" for c in cases)

        if req.state == "confirmed":
            confirmed_total += 1
            if has_approved:
                confirmed_covered += 1
            elif not cases:
                # never linked at all — generation could not (or did not) map it
                gaps.append({"requirement_id": req.id, "external_id": req.external_id,
                             "reason": "unmappable"})
            else:
                gaps.append({"requirement_id": req.id, "external_id": req.external_id,
                             "reason": "no_approved_cases"})

        rows.append({
            "requirement": {
                "id": req.id, "external_id": req.external_id,
                "description": req.description, "type": req.type,
                "priority": req.priority, "state": req.state, "version": req.version,
            },
            "cases": cases,
            "status": status,
        })

    # FR-TRC-03: stale/draft/rejected cases are excluded — approved only.
    coverage_pct = round(confirmed_covered / confirmed_total * 100, 1) if confirmed_total else 0.0
    return {"rows": rows, "coverage_pct": coverage_pct, "gaps": gaps}


@router.get("/requirements/{requirement_id}/history")
def requirement_history(requirement_id: str, user: User = Depends(require("view")),
                        db: Session = Depends(get_db)):
    req = db.get(Requirement, requirement_id)
    if not req or req.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Requirement not found"})

    case_ids = [link.test_case_id for link in db.scalars(
        select(RequirementTestCase).where(
            RequirementTestCase.requirement_id == req.id)).all()]
    if not case_ids:
        return {"requirement_id": req.id, "external_id": req.external_id, "runs": []}

    titles = {tc.id: tc.title for tc in db.scalars(
        select(TestCase).where(TestCase.id.in_(case_ids))).all()}

    rows = (db.query(TestResult, Run)
            .join(Run, Run.id == TestResult.run_id)
            .filter(TestResult.test_case_id.in_(case_ids),
                    Run.organisation_id == user.organisation_id)
            .order_by(Run.created_at.desc(), TestResult.created_at.asc())
            .all())

    runs: list[dict] = []
    by_run: dict[str, dict] = {}
    for res, run in rows:
        entry = by_run.get(run.id)
        if entry is None:
            entry = {
                "run": {"id": run.id, "project_id": run.project_id,
                        "environment_id": run.environment_id, "state": run.state,
                        "started_at": _iso(run.started_at),
                        "finished_at": _iso(run.finished_at),
                        "counts": run.counts or {}},
                "results": [],
            }
            by_run[run.id] = entry
            runs.append(entry)
        entry["results"].append({
            "test_case_id": res.test_case_id,
            "title": titles.get(res.test_case_id, ""),
            "test_case_version": res.test_case_version,
            "outcome": res.outcome,
            "duration_ms": res.duration_ms,
            "executed_at": _iso(res.created_at),
        })

    for entry in runs:  # requirement-level verdict per run (FR-TRC-07)
        outcomes = [r["outcome"] for r in entry["results"]]
        if any(o == "failed" for o in outcomes):
            entry["outcome"] = "failed"
        elif any(o == "errored" for o in outcomes):
            entry["outcome"] = "errored"
        else:
            entry["outcome"] = "passed"

    return {"requirement_id": req.id, "external_id": req.external_id, "runs": runs}
