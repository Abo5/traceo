"""The project assistant — answers about THIS project, from its own rows.

Two rules, and they are the same two the fix prompts follow.

**It is deterministic and offline.** No model is called. Every answer is
assembled from rows that already exist: the project's runs, its requirements,
its cases and the results those cases produced. The same question asked twice
gets the same answer, which is what makes an answer quotable in a handover — and
it keeps the "no outbound connection" property the mock provider gives the rest
of the stack (NFR-D1).

**It never invents.** An answer names the rows it was built from — case ids,
requirement external ids, run numbers — and when the project holds nothing that
bears on the question it says so and lists what it can answer instead. A
confident sentence about a defect that does not exist is worse than no
assistant, because the person reading it has no way to tell the difference.

Scope is the project, deliberately. It is reached at
`POST /projects/{id}/assistant`, every query it runs is filtered by that project
and the caller's organisation, and there is no path from here to another
project's data — a support tool that can be talked into reading the next tenant
over is a data leak with a chat interface.

It answers nothing until the project has completed a run. Before that there are
no results to explain, and an assistant whose every answer is "no data yet" only
teaches people not to open it.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require
from ..llm import get_provider
from ..llm.base import frame_untrusted
from ..models import (Project, Requirement, RequirementTestCase, Run, TestCase,
                      TestResult, User)

router = APIRouter(tags=["assistant"])

# What a model is allowed to see and how much of it. A bound, not a guess: a
# project with two thousand cases must not turn one question into a prompt that
# costs more than the run it is describing.
CONTEXT_FAILURES = 25
CONTEXT_REQUIREMENTS = 20
CONTEXT_RUNS = 5

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string", "maxLength": 2000},
        "cites": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
    },
    "required": ["answer"],
    "additionalProperties": False,
}

# The shapes a question can take. Matched in order, first hit wins — the list is
# ordered most specific first, so "why did X fail" is not swallowed by "fail".
Intent = str


@dataclass(frozen=True)
class Answer:
    text: str
    cites: list[dict]          # {kind, id, label} — every row the answer used
    intent: Intent
    suggestions: list[str]


class Ask(BaseModel):
    question: str = Field(min_length=1, max_length=500)


def _short(value: str | None, n: int = 8) -> str:
    return (value or "")[:n]


def _latest_run(db: Session, org_id: str, project_id: str) -> Run | None:
    return db.scalars(
        select(Run)
        .where(Run.project_id == project_id, Run.organisation_id == org_id)
        .order_by(Run.started_at.desc())
    ).first()


def _completed_runs(db: Session, org_id: str, project_id: str) -> list[Run]:
    return list(db.scalars(
        select(Run)
        .where(Run.project_id == project_id, Run.organisation_id == org_id,
               Run.state == "completed")
        .order_by(Run.started_at.desc())
    ))


def _failures(db: Session, org_id: str, run: Run) -> list[tuple[TestResult, TestCase]]:
    rows = db.execute(
        select(TestResult, TestCase)
        .join(TestCase, TestCase.id == TestResult.test_case_id)
        .where(TestResult.run_id == run.id,
               TestCase.organisation_id == org_id,
               TestResult.outcome.in_(("failed", "errored")))
    ).all()
    return [(r, c) for r, c in rows]


def _requirements_for(db: Session, org_id: str, case_id: str) -> list[Requirement]:
    return list(db.scalars(
        select(Requirement)
        .join(RequirementTestCase, RequirementTestCase.requirement_id == Requirement.id)
        .where(RequirementTestCase.test_case_id == case_id,
               Requirement.organisation_id == org_id)
    ))


def _reason_text(failure_reason) -> str:
    """The one sentence a failure_reason can be reduced to, whichever engine wrote it."""
    if not isinstance(failure_reason, dict):
        return str(failure_reason or "").strip()
    for key in ("message", "error"):
        if failure_reason.get(key):
            return str(failure_reason[key]).strip()
    assertion = failure_reason.get("assertion")
    kind = assertion.get("type") if isinstance(assertion, dict) else assertion
    expected, actual = failure_reason.get("expected"), failure_reason.get("actual")
    if kind:
        return f"{kind}: expected {expected!r}, observed {actual!r}"
    return ""


# ---------------------------------------------------------------------------
# Intents
# ---------------------------------------------------------------------------

_CASE_ID = re.compile(r"\b([0-9a-f]{8})[0-9a-f-]*\b", re.I)


def _pick_case(db: Session, org_id: str, project_id: str, question: str) -> TestCase | None:
    """A case named by id prefix, or by enough of its title to be unambiguous."""
    match = _CASE_ID.search(question)
    if match:
        prefix = match.group(1).lower()
        for case in db.scalars(select(TestCase).where(
                TestCase.project_id == project_id,
                TestCase.organisation_id == org_id)):
            if case.id.lower().startswith(prefix):
                return case
    quoted = re.findall(r"['\"]([^'\"]{4,})['\"]", question)
    for needle in quoted:
        hit = db.scalars(select(TestCase).where(
            TestCase.project_id == project_id,
            TestCase.organisation_id == org_id,
            TestCase.title.ilike(f"%{needle}%"))).first()
        if hit:
            return hit
    return None


def _answer_status(db: Session, org_id: str, project: Project, run: Run) -> Answer:
    c = run.counts or {}
    total = int(c.get("total") or 0)
    passed = int(c.get("passed") or 0)
    failed = int(c.get("failed") or 0) + int(c.get("errored") or 0)
    skipped = int(c.get("skipped") or 0)
    rate = f"{round(passed / total * 100)}%" if total else "—"
    lines = [
        f"The last completed run executed {total} case(s): {passed} passed, "
        f"{failed} need fixing"
        + (f", {skipped} skipped" if skipped else "")
        + f". Pass rate {rate}.",
    ]
    if skipped:
        lines.append(
            f"{skipped} case(s) were skipped — a skipped case is not a passing "
            "one; nothing was evaluated for it.")
    if failed:
        lines.append("Ask “what failed” for the list, or name a case to see why.")
    else:
        lines.append("Nothing is failing in that run.")
    return Answer("\n".join(lines), [{"kind": "run", "id": run.id, "label": "latest run"}],
                  "status", ["what failed?", "how many test cases are there?"])


def _answer_failures(db: Session, org_id: str, run: Run) -> Answer:
    rows = _failures(db, org_id, run)
    if not rows:
        return Answer("Nothing failed in the last completed run.",
                      [{"kind": "run", "id": run.id, "label": "latest run"}],
                      "failures", ["how did the last run go?"])
    lines = [f"{len(rows)} case(s) did not pass in the last run:"]
    cites = []
    for result, case in rows[:12]:
        reason = _reason_text(result.failure_reason)
        lines.append(f"  • {case.title} — {reason or result.outcome}  [{_short(case.id)}]")
        cites.append({"kind": "case", "id": case.id, "label": case.title})
    if len(rows) > 12:
        # Said out loud rather than silently truncated: a list that stops
        # without saying so reads as a complete list.
        lines.append(f"  … and {len(rows) - 12} more. Open the run report for the full list.")
    lines.append("Name any of them and I will tell you what it asserted and what it saw.")
    return Answer("\n".join(lines), cites, "failures",
                  ["why did " + _short(rows[0][1].id) + " fail?"])


def _answer_case(db: Session, org_id: str, project: Project, case: TestCase) -> Answer:
    reqs = _requirements_for(db, org_id, case.id)
    result = db.scalars(
        select(TestResult)
        .where(TestResult.test_case_id == case.id)
        .order_by(TestResult.created_at.desc())
    ).first()

    lines = [f"{case.title}  [{_short(case.id)}]"]
    if case.description:
        lines.append(case.description.strip())
    if case.test_type:
        lines.append(f"Discipline: {case.test_type}.")
    if reqs:
        for r in reqs:
            lines.append(f"Traces to {r.external_id} — “{(r.description or '').strip()[:160]}”")
    else:
        lines.append("It is not linked to a requirement.")

    if result is None:
        lines.append("It has not been executed yet.")
    else:
        lines.append(f"Last outcome: {result.outcome}"
                     + (f" in {result.duration_ms} ms." if result.duration_ms else "."))
        reason = _reason_text(result.failure_reason)
        if reason:
            lines.append(f"Why: {reason}")
        if result.outcome in ("failed", "errored"):
            lines.append("The run report carries a paste-ready fix prompt for it.")

    cites = [{"kind": "case", "id": case.id, "label": case.title}]
    cites += [{"kind": "requirement", "id": r.id, "label": r.external_id} for r in reqs]
    return Answer("\n".join(lines), cites, "case",
                  ["what failed?", "how did the last run go?"])


def _answer_counts(db: Session, org_id: str, project: Project) -> Answer:
    cases = db.scalars(select(TestCase).where(
        TestCase.project_id == project.id,
        TestCase.organisation_id == org_id)).all()
    reqs = db.scalars(select(Requirement).where(
        Requirement.project_id == project.id,
        Requirement.organisation_id == org_id)).all()
    by_type: dict[str, int] = {}
    for c in cases:
        by_type[c.test_type or "unclassified"] = by_type.get(c.test_type or "unclassified", 0) + 1
    spread = ", ".join(f"{n} {t}" for t, n in sorted(by_type.items(), key=lambda kv: -kv[1]))
    return Answer(
        f"This project holds {len(cases)} test case(s) across {len(reqs)} requirement(s)."
        + (f"\nBy discipline: {spread}." if spread else ""),
        [], "counts", ["what failed?", "how did the last run go?"])


def _answer_requirements(db: Session, org_id: str, project: Project) -> Answer:
    reqs = list(db.scalars(select(Requirement).where(
        Requirement.project_id == project.id,
        Requirement.organisation_id == org_id)))
    if not reqs:
        return Answer("This project has no requirements yet.", [], "requirements",
                      ["how many test cases are there?"])
    lines = [f"{len(reqs)} requirement(s):"]
    for r in reqs[:10]:
        lines.append(f"  • {r.external_id} — {(r.description or '').strip()[:120]}")
    if len(reqs) > 10:
        lines.append(f"  … and {len(reqs) - 10} more.")
    return Answer("\n".join(lines),
                  [{"kind": "requirement", "id": r.id, "label": r.external_id} for r in reqs[:10]],
                  "requirements", ["what failed?"])


def _answer_history(db: Session, org_id: str, project: Project) -> Answer:
    runs = _completed_runs(db, org_id, project.id)
    lines = [f"{len(runs)} completed run(s)."]
    for run in runs[:5]:
        c = run.counts or {}
        total = int(c.get("total") or 0)
        passed = int(c.get("passed") or 0)
        lines.append(f"  • {str(run.started_at)[:16]} — {passed}/{total} passed")
    return Answer("\n".join(lines),
                  [{"kind": "run", "id": r.id, "label": str(r.started_at)[:16]} for r in runs[:5]],
                  "history", ["how did the last run go?", "what failed?"])


# ---------------------------------------------------------------------------
# Routing a question to an intent
# ---------------------------------------------------------------------------

_PATTERNS: list[tuple[Intent, re.Pattern[str]]] = [
    ("case", re.compile(r"\b(why|explain|what (is|does)|tell me about)\b", re.I)),
    ("failures", re.compile(r"\b(fail(ed|ing|ures?)?|broke(n)?|red|defects?|bugs?|errors?)\b", re.I)),
    ("status", re.compile(r"\b(last run|latest run|how did|status|pass rate|result|summary|how many passed)\b", re.I)),
    ("history", re.compile(r"\b(history|previous runs?|over time|trend|runs? so far)\b", re.I)),
    ("requirements", re.compile(r"\b(requirements?|specs?|brd|trd|coverage)\b", re.I)),
    ("counts", re.compile(r"\b(how many|count|total|number of)\b", re.I)),
]

# Words that make a question about THIS project. "What is …" alone is not one:
# it opens a question about anything, and an assistant that answers "what is the
# capital of France" with a list of your defects is not being helpful, it is
# being confusing.
_IN_SCOPE = re.compile(
    r"\b(test\w*|case\w*|run\w*|fail\w*|bug\w*|defect\w*|error\w*|"
    r"requirement\w*|coverage|assert\w*|result\w*|report\w*|pass\w*|"
    r"skip\w*|project\w*|form\w*|field\w*|endpoint\w*|selector\w*|"
    r"page\w*|scan\w*|suite\w*|verdict\w*)\b", re.I)

_FALLBACK = (
    "I answer from this project's own rows — its runs, requirements, cases and "
    "results — so I can only tell you what Traceo actually recorded here.\n"
    "Try: “how did the last run go?”, “what failed?”, “why did <case id> fail?”, "
    "“how many test cases are there?”, or “what are the requirements?”"
)


def answer_question(db: Session, org_id: str, project: Project, question: str) -> Answer:
    """Route a question to the rows that bear on it.

    Order matters: a named case wins over every keyword, because "why did
    3ea494c5 fail" is a question about that case and not a request for the
    failure list. After that the patterns run most specific first.
    """
    named = _pick_case(db, org_id, project.id, question)
    if named is not None:
        return _answer_case(db, org_id, project, named)

    run = _latest_run(db, org_id, project.id)
    for intent, pattern in _PATTERNS:
        if not pattern.search(question):
            continue
        if intent == "case":
            # "explain"/"why" with no case named. If the question is about this
            # project at all, the failure list is the most useful thing to hand
            # back; if it is not, saying so is.
            if not _IN_SCOPE.search(question):
                break
            return _answer_failures(db, org_id, run) if run else _answer_counts(db, org_id, project)
        if intent == "failures" and run:
            return _answer_failures(db, org_id, run)
        if intent == "status" and run:
            return _answer_status(db, org_id, project, run)
        if intent == "history":
            return _answer_history(db, org_id, project)
        if intent == "requirements":
            return _answer_requirements(db, org_id, project)
        if intent == "counts":
            return _answer_counts(db, org_id, project)

    return Answer(_FALLBACK, [], "unknown",
                  ["how did the last run go?", "what failed?",
                   "how many test cases are there?"])


# ---------------------------------------------------------------------------
# The model path
#
# The retrieval above does not change when a model is configured: the same rows
# are gathered, and the model is given ONLY those rows. It phrases and reasons
# over the project's facts; it is never asked to recall anything about the
# project, because it knows nothing about the project.
#
# Two things are enforced rather than requested. The facts are wrapped in the
# untrusted-data frame, because case titles and failure messages come from a
# scanned third-party page and a page that says "ignore your instructions" must
# be quoted, not obeyed. And every id the model cites is checked against the
# ids actually in the context — an answer that cites a case that does not exist
# has its citation dropped, the same gate generation applies to its cases.
# ---------------------------------------------------------------------------

def _context(db: Session, org_id: str, project: Project) -> tuple[str, dict[str, str]]:
    """The project's facts as text, and the ids a citation is allowed to name."""
    allowed: dict[str, str] = {}
    lines: list[str] = [f"PROJECT: {project.name}"]

    runs = _completed_runs(db, org_id, project.id)
    lines.append(f"COMPLETED RUNS: {len(runs)}")
    for run in runs[:CONTEXT_RUNS]:
        c = run.counts or {}
        lines.append(
            f"  run {_short(run.id)} at {str(run.started_at)[:16]}: "
            f"total={c.get('total', 0)} passed={c.get('passed', 0)} "
            f"failed={c.get('failed', 0)} errored={c.get('errored', 0)} "
            f"skipped={c.get('skipped', 0)}")
        allowed[run.id] = "run"

    cases = list(db.scalars(select(TestCase).where(
        TestCase.project_id == project.id, TestCase.organisation_id == org_id)))
    by_type: dict[str, int] = {}
    for case in cases:
        key = case.test_type or "unclassified"
        by_type[key] = by_type.get(key, 0) + 1
    lines.append("TEST CASES: " + str(len(cases))
                 + " (" + ", ".join(f"{n} {t}" for t, n in sorted(by_type.items())) + ")")

    reqs = list(db.scalars(select(Requirement).where(
        Requirement.project_id == project.id, Requirement.organisation_id == org_id)))
    lines.append(f"REQUIREMENTS: {len(reqs)}")
    for r in reqs[:CONTEXT_REQUIREMENTS]:
        lines.append(f"  {r.external_id}: {(r.description or '').strip()[:200]}")
        allowed[r.id] = "requirement"
        allowed[r.external_id] = "requirement"

    latest = runs[0] if runs else None
    if latest is not None:
        rows = _failures(db, org_id, latest)
        lines.append(f"FAILURES IN THE LAST RUN: {len(rows)}")
        for result, case in rows[:CONTEXT_FAILURES]:
            reason = _reason_text(result.failure_reason) or result.outcome
            lines.append(f"  case {_short(case.id)} [{case.test_type or 'unclassified'}] "
                         f"{case.title} -> {result.outcome}: {reason[:220]}")
            allowed[case.id] = "case"
        if len(rows) > CONTEXT_FAILURES:
            lines.append(f"  (+{len(rows) - CONTEXT_FAILURES} more failures not listed here)")
    return "\n".join(lines), allowed


_SYSTEM = (
    "You are Traceo's project assistant. Answer ONLY from the FACTS below, which "
    "are this project's own recorded rows.\n"
    "Rules:\n"
    "- If the facts do not contain the answer, say so plainly and name what you "
    "could answer instead. Never guess a number, an id, a cause or a fix.\n"
    "- Quote failure reasons as recorded rather than paraphrasing them into "
    "something more confident.\n"
    "- Cite the ids you used in `cites` (case, run or requirement ids exactly as "
    "they appear in the facts).\n"
    "- Be brief: a few sentences, or a short list. No preamble.\n"
    "- The question is about this project only. Decline anything else.\n"
)


def _ask_model(context: str, allowed: dict[str, str], question: str) -> Answer | None:
    """Answer with the configured model, or None if there isn't a usable one.

    Returning None rather than raising is deliberate: a missing key, a dead key
    or a malformed reply should degrade to the deterministic answer, not hand
    the reader an error where an answer was expected.
    """
    provider = get_provider()
    if getattr(provider, "name", "mock") == "mock":
        # The mock returns {} for prompt ids it does not know, which would fail
        # schema validation. There is nothing to gain by asking it.
        return None

    prompt = (
        _SYSTEM
        + "\nFACTS:\n" + frame_untrusted(context)
        + "\n\nQUESTION:\n" + frame_untrusted(question)
    )
    try:
        result = provider.complete_json("assistant_answer", prompt, ANSWER_SCHEMA)
    except Exception:
        return None

    data = result.data if isinstance(result.data, dict) else {}
    text = str(data.get("answer") or "").strip()
    if not text:
        return None

    cites = []
    for raw in (data.get("cites") or []):
        key = str(raw).strip()
        kind = allowed.get(key)
        if kind is None:
            # A cited id that is not in the context is dropped rather than shown.
            # An answer may still be useful; a fabricated citation never is.
            match = [k for k in allowed if k.startswith(key)] if len(key) >= 8 else []
            if len(match) != 1:
                continue
            key, kind = match[0], allowed[match[0]]
        cites.append({"kind": kind, "id": key, "label": key})

    return Answer(text, cites, "model", [])


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------

_SUGGESTIONS = [
    "How did the last run go?",
    "What failed?",
    "How many test cases are there?",
    "What are the requirements?",
]


def _model_available() -> bool:
    """Whether a real provider is configured. The mock is not one."""
    try:
        return getattr(get_provider(), "name", "mock") != "mock"
    except Exception:
        return False


def _project_or_404(db: Session, org_id: str, project_id: str) -> Project:
    project = db.get(Project, project_id)
    if project is None or project.organisation_id != org_id:
        raise HTTPException(404, {"code": "not_found", "message": "No such project."})
    return project


@router.get("/projects/{project_id}/assistant")
def assistant_state(project_id: str, user: User = Depends(require("view")),
                    db: Session = Depends(get_db)) -> dict:
    """Whether the assistant has anything to work with, and what to ask it.

    The UI asks this before it offers the panel. There is nothing to explain
    until a run has completed, and an assistant whose every answer is "no data
    yet" only teaches people not to open it.
    """
    project = _project_or_404(db, user.organisation_id, project_id)
    runs = _completed_runs(db, user.organisation_id, project.id)
    return {
        "available": bool(runs),
        "reason": None if runs else "no_completed_run",
        "runs": len(runs),
        "suggestions": _SUGGESTIONS if runs else [],
        # The UI says which kind of thing is answering, so it has to be told.
        "engine": "model" if _model_available() else "deterministic",
        "model": getattr(get_provider(), "model", None) if _model_available() else None,
    }


@router.post("/projects/{project_id}/assistant")
def ask(project_id: str, body: Ask, user: User = Depends(require("view")),
        db: Session = Depends(get_db)) -> dict:
    project = _project_or_404(db, user.organisation_id, project_id)
    if not _completed_runs(db, user.organisation_id, project.id):
        raise HTTPException(409, {
            "code": "no_completed_run",
            "message": "The assistant answers from run results — start a run first.",
        })
    question = body.question.strip()

    # The model answers when one is configured; the deterministic path answers
    # when it is not, when the call fails, and when the reply comes back empty.
    # Both read the same rows — the model is given the facts, never the database.
    engine, model_name = "deterministic", None
    result = None
    context, allowed = _context(db, user.organisation_id, project)
    from_model = _ask_model(context, allowed, question)
    if from_model is not None:
        result, engine = from_model, "model"
        model_name = getattr(get_provider(), "model", None)
    else:
        result = answer_question(db, user.organisation_id, project, question)

    return {
        "answer": result.text,
        "cites": result.cites,
        "intent": result.intent,
        "suggestions": result.suggestions or _SUGGESTIONS,
        # Stated on every reply rather than buried in a tooltip. Whether a
        # sentence came from a model or from a table changes how much weight it
        # can carry, and the reader is the one who has to decide that.
        "engine": engine,
        "model": model_name,
    }
