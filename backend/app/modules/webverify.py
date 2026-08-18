"""Browser verification runs — execute the cases a web-target scan generated.

`webtarget.py` scans a URL and writes grounded draft cases from what the render
actually contained. Until now nothing could *run* them: those cases assert DOM
facts (`elements_present`, `validation_error`, `pattern_enforced`, …) and the
execution engine speaks HTTP, whose assertion evaluator ends in

    return True, None, True  # unknown assertion types are skipped, never failed

so a run of scanned cases reported every one of them green while checking none of
them. A green badge over an unverified page is worse than no badge, so this
module gives those cases the runner they were always written for: the same real
browser that discovered them, driven by `tools/web-discovery/check.mjs`.

Two decisions worth stating.

**Drafts run; nothing is auto-approved.** A scan produces drafts, and human
review is the gate this product is built around (BO-07's sibling: the model
proposes, a person accepts). A verification run therefore executes the target's
cases *whatever state they are in* and never changes that state — it answers
"what would these find?", which is the question you have before you approve, not
after.

**A skipped check is never a pass.** The sidecar reports `skipped` with a reason
for anything it cannot evaluate, and those land in the result as skipped. The
failure mode this whole module exists to remove must not reappear one level up.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import audit, require
from ..jobs import JobError
from ..models import (Environment, Run, TestCase, TestResult, TestStep, User,
                      WebTarget)
from .webtarget import (BROWSER_UNAVAILABLE, _UNAVAILABLE_CODES,
                        _UNAVAILABLE_MARKERS, _first_json_object, _install_hint,
                        _payload_error, _target_scoped)

router = APIRouter()

# Checks this runner understands. A case whose steps carry none of these is not a
# browser case and belongs to the HTTP engine instead.
BROWSER_CHECKS = frozenset({
    "elements_present", "required_field_enforced", "maxlength_enforced",
    "pattern_enforced", "page_load_ms",
    # input validation: a concrete value typed into the field, and whether the
    # page stands by the rule it declared about it
    "value_rejected", "value_accepted", "whitespace_rejected",
    # functionality: what the form DOES once it is filled in correctly
    "happy_path", "error_recovery", "submit_gated", "conditional_fields",
    "initial_state", "links_resolve",
})


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# sidecar
# ---------------------------------------------------------------------------

def check_command(plan_path: str, timeout_ms: int) -> list[str]:
    return [settings.NODE_BIN, str(settings.WEB_CHECK_SCRIPT),
            "--plan", plan_path, "--timeout", str(timeout_ms)]


def run_check_sidecar(plan: dict, timeout_s: float | None = None) -> dict:
    """Drive the browser over `plan` and return the sidecar's JSON document.

    Mirrors `webtarget.run_sidecar`, including its one non-negotiable: a missing
    sidecar raises rather than returning an empty result, because "no findings"
    and "nothing ran" must never look the same to a caller.
    """
    script = Path(settings.WEB_CHECK_SCRIPT)
    if not script.is_file():
        raise JobError(BROWSER_UNAVAILABLE,
                       _install_hint(f"The browser-check sidecar is missing at {script}."))
    timeout_s = float(timeout_s if timeout_s is not None else settings.WEB_CHECK_TIMEOUT_S)
    env = dict(os.environ)
    if settings.ALLOW_PRIVATE_TARGETS:
        env["TRACEO_ALLOW_PRIVATE_TARGETS"] = "1"

    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(plan, tmp)
        tmp.close()
        cmd = check_command(tmp.name, int(min(timeout_s, 120) * 1000))
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True,
                                  timeout=timeout_s + 30.0, env=env, cwd=str(script.parent))
        except FileNotFoundError:
            raise JobError(BROWSER_UNAVAILABLE, _install_hint(
                f"Node.js was not found (tried '{settings.NODE_BIN}')."))
        except subprocess.TimeoutExpired:
            raise JobError("check_timeout",
                           f"The browser did not finish the checks within {timeout_s + 30:.0f}s — "
                           "raise TRACEO_WEB_CHECK_TIMEOUT_S or narrow the run.")
        except OSError as exc:
            raise JobError(BROWSER_UNAVAILABLE, _install_hint(
                f"The browser-check sidecar could not be started ({exc.__class__.__name__})."))
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass

    stderr = (proc.stderr or "").strip()
    if any(marker in stderr.lower() for marker in _UNAVAILABLE_MARKERS):
        raise JobError(BROWSER_UNAVAILABLE,
                       _install_hint("The browser-check sidecar could not start Playwright."))
    doc = _first_json_object(proc.stdout or "")
    if doc is None:
        if proc.returncode != 0:
            raise JobError("check_failed",
                           f"The browser-check sidecar exited with code {proc.returncode}: "
                           f"{stderr[:500] or 'no output'}")
        raise JobError("check_failed", "The browser-check sidecar produced no JSON document.")
    reported = _payload_error(doc)
    if reported is not None:
        code, message = reported
        if code in _UNAVAILABLE_CODES:
            raise JobError(BROWSER_UNAVAILABLE, _install_hint(message))
        raise JobError(code, message)
    return doc


# ---------------------------------------------------------------------------
# selection
# ---------------------------------------------------------------------------

def _step_url(step: TestStep) -> str:
    req = step.request if isinstance(step.request, dict) else {}
    return str(req.get("url") or "")


def _step_check(step: TestStep) -> str:
    req = step.request if isinstance(step.request, dict) else {}
    return str(req.get("check") or "")


def collect_browser_cases(db: Session, org_id: str, project_id: str,
                          target: WebTarget) -> list[tuple[TestCase, list[TestStep]]]:
    """This target's browser cases, newest requirement links included.

    A case belongs to the target when its steps carry one of BROWSER_CHECKS and
    name the URL this target rendered. Matching on the recorded URL (rather than
    on "everything in the project") is what keeps two targets in one project from
    verifying each other's pages.
    """
    urls = {u for u in (target.url, target.final_url) if u}
    cases = db.scalars(select(TestCase).where(
        TestCase.project_id == project_id,
        TestCase.organisation_id == org_id,
        TestCase.state != "archived",
    ).order_by(TestCase.created_at.asc())).all()
    if not cases:
        return []

    steps_by_case: dict[str, list[TestStep]] = {}
    rows = db.scalars(select(TestStep).where(
        TestStep.test_case_id.in_([c.id for c in cases])).order_by(TestStep.order.asc())).all()
    for step in rows:
        steps_by_case.setdefault(step.test_case_id, []).append(step)

    out: list[tuple[TestCase, list[TestStep]]] = []
    for case in cases:
        steps = steps_by_case.get(case.id) or []
        browser_steps = [s for s in steps if _step_check(s) in BROWSER_CHECKS]
        if not browser_steps:
            continue
        if urls and not any(_step_url(s) in urls for s in browser_steps):
            continue
        out.append((case, browser_steps))
    return out


def ensure_environment(db: Session, org_id: str, project_id: str,
                       target: WebTarget) -> Environment:
    """The environment a scanned run points at, derived from the target itself.

    A Run requires an environment; a scanned page already states its own origin,
    so asking the user to type one in would be asking for something we know. The
    row is reused on later verifications of the same origin.
    """
    origin_src = target.final_url or target.url
    parts = urlsplit(origin_src)
    base_url = f"{parts.scheme}://{parts.netloc}" if parts.scheme and parts.netloc else origin_src
    existing = db.scalars(select(Environment).where(
        Environment.project_id == project_id,
        Environment.organisation_id == org_id,
        Environment.base_url == base_url)).first()
    if existing is not None:
        return existing
    env = Environment(organisation_id=org_id, project_id=project_id,
                      name=f"{parts.netloc or 'target'} (scanned)"[:100],
                      base_url=base_url[:500], auth_type="none", variables={},
                      tls_strict=parts.scheme != "http")
    db.add(env)
    db.flush()
    return env


# ---------------------------------------------------------------------------
# the job
# ---------------------------------------------------------------------------

def _plan_case(case: TestCase, steps: list[TestStep]) -> dict:
    return {
        "id": case.id,
        "title": case.title,
        "checks": [{
            "request": step.request if isinstance(step.request, dict) else {},
            "assertions": step.assertions if isinstance(step.assertions, list) else [],
        } for step in steps],
    }


def _evidence_for(result: dict, url: str) -> list[dict]:
    """One evidence block per case, in the shape the report already renders."""
    return [{
        "request": {"method": "BROWSER", "url": url,
                    "headers": {}, "body": None},
        "response": {"status": None, "headers": {},
                     "body": f"{len(result.get('assertions') or [])} browser assertion(s)"},
        "elapsed_ms": int(result.get("duration_ms") or 0),
        "assertions": [{
            "assertion": {"type": a.get("type"), "expected": a.get("expected"),
                          **({"selector": a["selector"]} if a.get("selector") else {})},
            "outcome": a.get("outcome"),
            "actual": a.get("actual"),
            **({"message": a["message"]} if a.get("message") else {}),
        } for a in (result.get("assertions") or [])],
    }]


def run_verify_job(job, org_id: str, user_id: str, project_id: str,
                   target_id: str, run_id: str, allow_submit: bool = False) -> dict:
    db: Session = SessionLocal()
    try:
        target = db.get(WebTarget, target_id)
        run = db.get(Run, run_id)
        if target is None or run is None:
            raise JobError("not_found", "The target or run disappeared before the check started.")

        selected = collect_browser_cases(db, org_id, project_id, target)
        run.state = "running"
        run.started_at = _now()
        db.commit()

        if not selected:
            run.state = "completed"
            run.finished_at = _now()
            run.counts = {"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0}
            db.commit()
            return {"run_id": run.id, "counts": run.counts,
                    "note": "This target has no browser cases — scan it with the "
                            "functional or performance test type first."}

        url = target.final_url or target.url
        plan = {
            "url": url,
            "viewport": target.viewport or "1280x800",
            # OFF by default: a real submission creates data on the target. The
            # runner intercepts and aborts the outbound request instead, which
            # still proves the form wired its submit up.
            "allow_submit": bool(allow_submit),
            "cases": [_plan_case(c, s) for c, s in selected],
        }

        try:
            doc = run_check_sidecar(plan)
        except JobError:
            run.state = "aborted"
            run.finished_at = _now()
            db.commit()
            raise

        by_id = {str(r.get("case_id")): r for r in (doc.get("results") or [])}
        counts = {"total": 0, "passed": 0, "failed": 0, "errored": 0, "skipped": 0}

        for case, _steps in selected:
            result = by_id.get(case.id)
            if result is None:
                # The sidecar returns one entry per planned case; a gap means the
                # browser died mid-plan. Recording it as errored keeps the run's
                # arithmetic honest instead of quietly shrinking the total.
                outcome, duration, failure, assertions = "errored", 0, {
                    "message": "The browser produced no result for this case.",
                    "expected": None, "actual": None, "selector": None, "assertion": None,
                }, []
            else:
                outcome = str(result.get("outcome") or "errored")
                duration = int(result.get("duration_ms") or 0)
                failure = result.get("failure")
                assertions = result.get("assertions") or []

            counts["total"] += 1
            counts[outcome] = counts.get(outcome, 0) + 1
            db.add(TestResult(
                run_id=run.id, test_case_id=case.id, test_case_version=1,
                # A skipped case is not a passed case: the DB stores what happened.
                outcome=outcome, duration_ms=duration,
                failure_reason=failure if outcome in ("failed", "errored") else None,
                evidence=_evidence_for({"assertions": assertions, "duration_ms": duration}, url),
            ))

        run.state = "completed"
        run.finished_at = _now()
        run.counts = counts
        audit(db, org_id, user_id, "web_target.verified", "run", run.id,
              {"target_id": target_id, "url": url, **counts})
        db.commit()
        return {"run_id": run.id, "counts": counts, "url": url,
                "load_ms": doc.get("load_ms")}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# route
# ---------------------------------------------------------------------------

class VerifyRequest(BaseModel):
    pass


@router.post("/web-targets/{target_id}/verify", status_code=202)
def verify_web_target(target_id: str,
                      user: User = Depends(require("trigger_run")),
                      db: Session = Depends(get_db)):
    """Run this target's browser cases against the page they were written from."""
    target = _target_scoped(target_id, user, db)
    if target.status != "discovered":
        raise HTTPException(409, detail={
            "code": "target_not_ready",
            "message": "Scan this target successfully before verifying it."})

    selected = collect_browser_cases(db, user.organisation_id, target.project_id, target)
    if not selected:
        raise HTTPException(422, detail={
            "code": "no_browser_cases",
            "message": "This target has no browser-checkable cases. Re-scan it with "
                       "the functional or performance test type enabled."})

    env = ensure_environment(db, user.organisation_id, target.project_id, target)
    run = Run(organisation_id=user.organisation_id, project_id=target.project_id,
              environment_id=env.id, kind="functional", state="queued",
              counts={"total": len(selected), "passed": 0, "failed": 0, "errored": 0},
              initiated_by=user.id)
    db.add(run)
    audit(db, user.organisation_id, user.id, "web_target.verify_requested", "web_target",
          target.id, {"cases": len(selected), "url": target.final_url or target.url})
    db.commit()

    org_id, user_id, project_id, run_id = (
        user.organisation_id, user.id, target.project_id, run.id)
    job = jobstore.submit(
        "web_verify",
        lambda job: run_verify_job(job, org_id, user_id, project_id, target_id, run_id),
        project_id=project_id)
    return {"job_id": job.id, "run_id": run_id, "cases": len(selected),
            "environment_id": env.id}
