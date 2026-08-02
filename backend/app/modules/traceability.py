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
from .ingestion import numbered_criteria

router = APIRouter()

# v2 gap vocabulary (FR-051): reason -> Arabic next action.
GAP_NEXT_ACTIONS = {
    "no_reachable_endpoint": "استورد مواصفة تغطي هذا المتطلب أو اربطه يدوياً",
    "all_cases_disabled": "اعتمد إحدى الحالات المرتبطة في المراجعة",
    "no_approved_cases": "ولّد حالات لهذا المتطلب",
    # FR-013 AC3 / FR-051 AC2 — a requirement with nothing testable stated
    "no_criteria": "اكتب معيار قبول واحداً على الأقل — لا يمكن توليد حالة لا تعرف ما تتحقق منه",
    "criteria_uncovered": "بعض معايير القبول لا تغطيها أي حالة معتمدة — ولّد لها أو اربطها يدوياً",
}

RUN_DISPLAY_BASE = 1000  # first run of a project renders as #1001

_HIGH_PRIORITIES = ("high", "critical")


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ---------------------------------------------------------------------------
# Shared read-time helpers (no schema changes — everything computed on read)
# ---------------------------------------------------------------------------

def run_display_ids(db: Session, project_id: str) -> dict[str, int]:
    """run_id -> chronological #1001-style display id within the project."""
    rows = (db.query(Run.id).filter(Run.project_id == project_id)
            .order_by(Run.created_at.asc(), Run.id.asc()).all())
    return {rid: RUN_DISPLAY_BASE + i + 1 for i, (rid,) in enumerate(rows)}


def run_display_id(db: Session, run: Run) -> int:
    return run_display_ids(db, run.project_id).get(run.id, RUN_DISPLAY_BASE + 1)


def is_high_priority(priority: str | None) -> bool:
    return (priority or "").lower() in _HIGH_PRIORITIES


def derive_severity(outcome: str, failure_reason: dict | None,
                    high_priority: bool, priority: str | None = None) -> str:
    """FR-052 severity = requirement priority × failure class, per the SRS §4.5 table:

    | priority     | failure class     | severity |
    |--------------|-------------------|----------|
    | high         | rule violation    | critical |
    | high         | schema violation  | major    |
    | medium       | rule violation    | major    |
    | medium / low | schema violation  | minor    |
    | any          | transport error   | major    |

    `priority` is the requirement's own priority where the caller knows it; the older
    `high_priority` flag remains the fallback so every existing call site keeps working.
    A medium-priority BUSINESS RULE breaking is a bigger deal than a low-priority
    schema drift, which the previous "high or nothing" rule flattened into minor."""
    fr = failure_reason or {}
    assertion = fr.get("assertion") if isinstance(fr.get("assertion"), dict) else {}
    if outcome == "errored" or (fr.get("error") and not assertion):
        return "major"  # transport / execution error — SRS: any priority

    level = (priority or ("high" if high_priority else "medium")).lower()
    if level in _HIGH_PRIORITIES:
        level = "high"
    atype = assertion.get("type")

    if atype == "json_field":  # business-rule class
        if level == "high":
            return "critical"
        return "major" if level == "medium" else "minor"
    if atype == "json_schema":  # schema class
        return "major" if level == "high" else "minor"
    return "major" if level == "high" else "minor"


def gap_reason(case_states: list[str], has_criteria: bool = True) -> str:
    """v2 gap-reason vocabulary for an uncovered confirmed requirement.

    Ordered by what the reader should fix FIRST: a requirement with no acceptance
    criteria cannot be generated for at all, so saying "no reachable endpoint" would
    send them to the wrong screen."""
    if not has_criteria:
        return "no_criteria"
    if not case_states:
        return "no_reachable_endpoint"  # never mapped / unmappable
    if not any(s == "approved" for s in case_states):
        return "all_cases_disabled"  # linked, but nothing approved counts
    return "no_approved_cases"  # fallback


# SRS §4.5: project coverage is a mean of requirement coverage weighted by priority,
# so leaving a P0 requirement half-covered costs three times what a P2 does.
PRIORITY_WEIGHTS = {"critical": 3, "high": 3, "medium": 2, "low": 1}


def priority_weight(priority: str | None) -> int:
    return PRIORITY_WEIGHTS.get(str(priority or "medium").lower(), 2)


def weighted_coverage(entries: list[dict]) -> float:
    """entries: [{coverage: 0..1, priority}] -> project coverage %, per SRS §4.5.

    Measuring at criterion level is the whole point: a requirement with three criteria
    and one covered is 33% covered, not "covered". The old requirement-level count
    reported it as 100% and that is precisely the number a client would later dispute."""
    if not entries:
        return 0.0
    total_weight = sum(priority_weight(e.get("priority")) for e in entries)
    if not total_weight:
        return 0.0
    weighted = sum(e["coverage"] * priority_weight(e.get("priority")) for e in entries)
    return round(weighted / total_weight * 100, 1)


def project_coverage(db: Session, project_id: str, org_id: str) -> dict:
    """The single coverage computation. The matrix, the dashboard and the CI gate all
    call this, so the number that fails a pipeline is the number on the screen the QA
    lead is looking at — a gate that disagrees with the matrix is worse than no gate."""
    reqs = (db.query(Requirement)
            .filter(Requirement.project_id == project_id,
                    Requirement.organisation_id == org_id,
                    Requirement.state == "confirmed").all())
    if not reqs:
        return {"coverage_pct": 0.0, "requirement_coverage_pct": 0.0,
                "confirmed_total": 0, "confirmed_covered": 0,
                "criteria_total": 0, "criteria_covered": 0}

    links = (db.query(RequirementTestCase, TestCase)
             .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
             .filter(TestCase.project_id == project_id,
                     TestCase.organisation_id == org_id).all())
    links_by_req: dict[str, list] = {}
    for link, tc in links:
        links_by_req.setdefault(link.requirement_id, []).append((link, tc))

    entries, criteria_total, criteria_covered, covered_reqs = [], 0, 0, 0
    for req in reqs:
        req_links = links_by_req.get(req.id, [])
        coverage = criterion_coverage(numbered_criteria(req), req_links)
        hit = sum(1 for c in coverage if c["covered"])
        criteria_total += len(coverage)
        criteria_covered += hit
        approved = [tc for _l, tc in req_links if tc.state == "approved"]
        if approved:
            covered_reqs += 1
        entries.append({"coverage": requirement_fraction(coverage, req_links),
                        "priority": req.priority})

    return {"coverage_pct": weighted_coverage(entries),
            "requirement_coverage_pct": round(covered_reqs / len(reqs) * 100, 1),
            "confirmed_total": len(reqs), "confirmed_covered": covered_reqs,
            "criteria_total": criteria_total, "criteria_covered": criteria_covered}


def requirement_fraction(coverage: list[dict], links: list) -> float:
    """How covered one requirement is, 0..1 — progressive rigour.

    Measured per criterion as soon as ANY linked case cites one. Until then the
    requirement is measured the old way, on whether an approved case exists at all:
    a QA lead who writes a case by hand, links it and approves it should not be told
    they have 0% coverage because they never used a labelling feature they may not
    know exists. The moment criterion citations appear, the stricter measure takes
    over and stays."""
    if not coverage:
        # Nothing stated to measure against; an approved case is all the evidence there is.
        return 1.0 if any(tc.state == "approved" for _l, tc in links) else 0.0
    cites_any = any(link.criterion_indexes for link, _tc in links)
    if not cites_any:
        return 1.0 if any(tc.state == "approved" for _l, tc in links) else 0.0
    return sum(1 for c in coverage if c["covered"]) / len(coverage)


def criterion_coverage(criteria: list[dict], links: list) -> list[dict]:
    """Per-criterion coverage — the unit FR-013 AC4 says the matrix reports against.

    A requirement showing 'covered' while one of its three criteria has no case is
    exactly the false comfort the traceability matrix exists to prevent."""
    approved_by_index: dict[str, list[str]] = {}
    for link, tc in links:
        for index in (link.criterion_indexes or []):
            approved_by_index.setdefault(index, []).append(tc.state)
    out = []
    for criterion in criteria:
        states = approved_by_index.get(criterion["index"], [])
        out.append({
            "index": criterion["index"],
            "statement": criterion["statement"],
            "case_count": len(states),
            "covered": any(s == "approved" for s in states),
        })
    return out


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
    links_by_req: dict[str, list] = {}
    for link, tc in links:
        cases_by_req.setdefault(link.requirement_id, []).append(tc)
        links_by_req.setdefault(link.requirement_id, []).append((link, tc))

    all_case_ids = list({tc.id for _link, tc in links})
    latest = _latest_outcomes(db, all_case_ids)

    rows, gaps = [], []
    confirmed_total = confirmed_covered = 0
    weighted_entries: list[dict] = []
    for req in reqs:
        linked = sorted(cases_by_req.get(req.id, []), key=lambda c: (c.created_at or 0, c.id))
        cases = [{"id": tc.id, "title": tc.title, "state": tc.state,
                  "latest_outcome": latest.get(tc.id)} for tc in linked]
        status = _requirement_status(cases)
        has_approved = any(c["state"] == "approved" for c in cases)

        criteria = numbered_criteria(req)
        coverage = criterion_coverage(criteria, links_by_req.get(req.id, []))
        uncovered = [c["index"] for c in coverage if not c["covered"]]

        if req.state == "confirmed":
            confirmed_total += 1
            # SRS §4.5: a requirement's coverage is the fraction of its CRITERIA that
            # an approved case verifies. With no criteria stated there is nothing to
            # measure, so it contributes zero rather than a free pass.
            weighted_entries.append({
                "coverage": requirement_fraction(coverage, links_by_req.get(req.id, [])),
                "priority": req.priority})
            if has_approved:
                confirmed_covered += 1
            else:
                reason = gap_reason([c["state"] for c in cases], bool(criteria))
                gaps.append({"requirement_id": req.id, "external_id": req.external_id,
                             "reason": reason,
                             "next_action": GAP_NEXT_ACTIONS[reason]})
            # FR-013 AC4 — a covered requirement whose criteria are not all covered
            # is still a gap; reporting it as green is the failure mode the matrix exists to prevent.
            if has_approved and uncovered:
                gaps.append({"requirement_id": req.id, "external_id": req.external_id,
                             "reason": "criteria_uncovered",
                             "criteria": uncovered,
                             "next_action": GAP_NEXT_ACTIONS["criteria_uncovered"]})

        rows.append({
            "requirement": {
                "id": req.id, "external_id": req.external_id,
                "description": req.description, "type": req.type,
                "priority": req.priority, "state": req.state, "version": req.version,
                "needs_criteria": bool(req.needs_criteria),
            },
            "cases": cases,
            "criteria": coverage,          # FR-013 AC4
            "criteria_covered": sum(1 for c in coverage if c["covered"]),
            "criteria_total": len(coverage),
            "status": status,
        })

    # FR-TRC-03: stale/draft/rejected cases are excluded — approved only.
    coverage_pct = weighted_coverage(weighted_entries)
    requirement_coverage_pct = (round(confirmed_covered / confirmed_total * 100, 1)
                                if confirmed_total else 0.0)
    return {"rows": rows,
            # The headline number is criterion-level and priority-weighted (SRS §4.5).
            "coverage_pct": coverage_pct,
            # The coarser "has at least one approved case" count, kept because the
            # review queue and the gap list both reason in requirements.
            "requirement_coverage_pct": requirement_coverage_pct,
            "confirmed_total": confirmed_total,
            "confirmed_covered": confirmed_covered,
            "gaps": gaps}


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
