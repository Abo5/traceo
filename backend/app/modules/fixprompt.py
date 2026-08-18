"""Fix prompts — a paste-ready repair brief for one failed case.

The product loop this closes: a run tells you *that* something is broken; a fix
prompt tells the tool you are building with *what* to change, in the words of the
requirement it violated. You paste it into Claude/Cursor/Lovable, apply the fix,
re-run, and the case that produced the prompt is the case that closes it.

Two rules shape everything here.

**It is deterministic and offline.** No model is called. Every line is assembled
from rows that already exist: the case, the requirement it traces to, and the
failure evidence the executor recorded. The same failure yields the same prompt
on every machine, which is what makes it quotable in a bug report — and it keeps
the "no outbound connection" property the mock provider gives the rest of the
stack (NFR-D1).

**It never invents.** The instruction lines are selected from a table keyed by
the assertion that actually failed; there is no free text describing a cause
nobody observed. When the recorded evidence does not say something, the prompt
omits it rather than guessing — the same discipline the grounding gate applies to
generation (BO-07).

Secrets: the text is built only from `TestResult.failure_reason` and
`TestResult.evidence`, both of which the execution engine wrote through
`redact()`. Nothing here reads an environment's auth config, so a prompt cannot
carry a credential the evidence did not already contain.
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# What to do about each kind of failed assertion.
#
# Keyed by the assertion `type` the runner recorded. Every entry is an
# instruction about the SYSTEM UNDER TEST, never about the test: a case that
# fails because the app is wrong must not invite someone to "relax the
# assertion", which is how a suite quietly stops meaning anything.
# ---------------------------------------------------------------------------

_ACTIONS: dict[str, list[str]] = {
    # --- browser / DOM checks (web-target scans) ---
    "validation_error": [
        "reject the submission while this field is empty, in the handler AND on the server",
        "show the user an error next to the field (aria-invalid + a message element)",
    ],
    "no_navigation": [
        "do not navigate away when the submission is rejected",
    ],
    "value_length_at_most": [
        "enforce the field's own maxlength — truncate or reject longer input",
        "apply the same limit on the server, so a direct request cannot exceed it",
    ],
    "pattern_enforced": [
        "reject values that do not match the field's declared pattern",
        "validate the same pattern on the server",
    ],
    "elements_present": [
        "render the missing element, or correct the selector if it was renamed",
    ],
    "value_rejected": [
        "refuse this value — the field already declares the rule, so enforce it "
        "in the handler AND on the server",
        "tell the user what is wrong, next to the field (aria-invalid + a message)",
    ],
    "whitespace_rejected": [
        "treat a whitespace-only value as empty: trim before the required check",
        "refuse the submission and show the error next to the field",
    ],
    "value_accepted": [
        "stop refusing a value the field's own declaration allows — the rule and "
        "the check disagree, and the declaration is what the user can see",
    ],
    # --- functionality ---
    "happy_path": [
        "make the form submit when every field holds a value it declares valid — "
        "wire the submit handler, and stop swallowing the event",
    ],
    "error_recovery": [
        "keep the other fields' values when a submission is refused; re-render "
        "from the submitted values rather than resetting the form",
        "let the submission through once the field is corrected",
    ],
    "submit_gated": [
        "block submission while the required checkbox is unticked, in the "
        "handler AND on the server",
    ],
    "conditional_fields": [
        "make the fields shown for an option depend only on that option, so the "
        "same choice always shows the same form",
    ],
    "initial_state": [
        "restore the control's documented initial value, or update the "
        "requirement if the new default is intended",
    ],
    "links_resolve": [
        "fix or remove the links that do not resolve",
    ],
    "page_load_ms": [
        "bring the page load inside the stated budget "
        "(defer non-critical scripts, compress the largest assets)",
    ],
    # --- HTTP checks (spec/traffic-derived cases) ---
    "status": [
        "return the expected status code for this request",
    ],
    "json_path": [
        "return the expected value at this JSON path",
    ],
    "header": [
        "send the expected response header",
    ],
    "response_time_ms": [
        "bring this endpoint's response time inside the stated budget",
    ],
    "json_schema": [
        "make the response body match the schema this endpoint declares",
    ],
}

_FALLBACK_ACTIONS = [
    "make the observed behaviour match the expected behaviour recorded below",
]

# An errored case never reached its assertion — the instruction is about
# reachability, not about the rule.
_ERROR_ACTIONS = [
    "make the target reachable and responsive for this step "
    "(the check could not complete, so the rule was never evaluated)",
]

_LABEL_WIDTH = 16


def _line(label: str, value: str) -> str:
    return f"{label.ljust(_LABEL_WIDTH)}{value}"


def _clip(value: object, limit: int = 400) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        import json
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:  # noqa: BLE001
            text = str(value)
    else:
        text = str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _failure_bits(failure_reason) -> dict:
    """Normalise the two shapes `failure_reason` is written in.

    The HTTP executor writes `{assertion, expected, actual, step_index}` (or
    `{error, step_index}` when the request itself failed); the browser runner
    writes `{message, expected, actual, selector, assertion}`. Readers should not
    have to know which engine produced the row.
    """
    if not isinstance(failure_reason, dict):
        return {"message": _clip(failure_reason)} if failure_reason else {}
    out: dict = {}
    if failure_reason.get("message"):
        out["message"] = _clip(failure_reason["message"])
    if failure_reason.get("error"):
        out["error"] = _clip(failure_reason["error"])
    if failure_reason.get("selector"):
        out["selector"] = _clip(failure_reason["selector"], 200)
    assertion = failure_reason.get("assertion")
    if isinstance(assertion, dict):
        out["assertion_type"] = str(assertion.get("type") or "")
        if "expected" in assertion:
            out.setdefault("expected", _clip(assertion.get("expected")))
    elif isinstance(assertion, str):
        out["assertion_type"] = assertion
    if failure_reason.get("expected") is not None:
        out["expected"] = _clip(failure_reason.get("expected"))
    if failure_reason.get("actual") is not None:
        out["actual"] = _clip(failure_reason.get("actual"))
    return out


def _where(evidence, bits: dict) -> str:
    """The place the failure happened, from evidence — selector, or method+URL."""
    selector = bits.get("selector")
    url = ""
    if isinstance(evidence, list) and evidence:
        first = evidence[0] if isinstance(evidence[0], dict) else {}
        req = first.get("request") if isinstance(first.get("request"), dict) else {}
        url = str(req.get("url") or "")
        method = str(req.get("method") or "").upper()
        if selector and url:
            return f"{selector} on {url}"
        if url:
            return f"{method} {url}".strip()
    return selector or url or ""


def _requirement_line(requirements) -> str:
    if not requirements:
        return ""
    req = requirements[0] or {}
    ext = str(req.get("external_id") or req.get("id") or "").strip()
    text = _clip(req.get("description") or req.get("text") or "", 300)
    if ext and text:
        return f'{ext} — "{text}"'
    return ext or text


def build_fix_prompt(entry: dict, *, run_label: str = "") -> str:
    """One paste-ready prompt for a failed/errored report entry.

    `entry` is the shape `reporting._report_entries` produces: test_case,
    outcome, failure_reason, evidence, requirements, severity.
    """
    case = entry.get("test_case") or {}
    title = _clip(case.get("title") or "", 300)
    case_id = str(case.get("id") or "")
    outcome = entry.get("outcome") or "failed"
    bits = _failure_bits(entry.get("failure_reason"))

    ref = " · ".join(x for x in (run_label, case_id[:8]) if x)
    lines = [f"# Fix request — generated by Traceo{(' · ' + ref) if ref else ''}", ""]

    broken = bits.get("message") or bits.get("error") or f"{title} — {outcome}"
    lines.append(_line("What is broken", broken))

    where = _where(entry.get("evidence"), bits)
    if where:
        lines.append(_line("Where", where))

    requirement = _requirement_line(entry.get("requirements"))
    if requirement:
        lines.append(_line("Requirement", requirement))

    severity = entry.get("severity")
    if severity:
        lines.append(_line("Severity", str(severity)))

    if bits.get("expected"):
        lines.append(_line("Expected", bits["expected"]))
    if bits.get("actual"):
        lines.append(_line("Observed", bits["actual"]))

    if outcome == "errored" and not bits.get("assertion_type"):
        actions = _ERROR_ACTIONS
    else:
        actions = _ACTIONS.get(bits.get("assertion_type", ""), _FALLBACK_ACTIONS)
    for i, action in enumerate(actions):
        lines.append(_line("Do" if i == 0 else "", f"{i + 1}) {action}"))

    verify = f're-run "{title}"' if title else "re-run this case"
    lines.append(_line("Verify", f"{verify} — when it passes, this closes"))

    lines.append("")
    lines.append("Change the application, not the test: this case states a rule the "
                 "product agreed to, so a passing test must mean the rule now holds.")
    return "\n".join(lines)


def fix_prompts_for(entries: list[dict], *, run_label: str = "") -> list[dict]:
    """A prompt per failed/errored entry, in report order."""
    out = []
    for entry in entries:
        if entry.get("outcome") not in ("failed", "errored"):
            continue
        case = entry.get("test_case") or {}
        out.append({
            "test_case_id": case.get("id"),
            "title": case.get("title"),
            "outcome": entry.get("outcome"),
            "severity": entry.get("severity"),
            "requirements": entry.get("requirements") or [],
            "prompt": build_fix_prompt(entry, run_label=run_label),
        })
    return out
