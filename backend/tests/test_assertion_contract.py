"""RELEASE GATE — every assertion a builder emits must be executable (QG1/TR-030).

WHY THIS EXISTS
---------------
The suite used to be green while the product reported cases as `passed` that had
checked nothing. Three assertion types — `no_5xx`, `body_not_matches`,
`rate_limited_within` — were emitted by the security builders and understood by
no executor, so `_eval_assertion` skipped them and `_case_worker` left the
outcome at its default of "passed". A case titled "error response leaks no stack
trace" passed against a body whose literal text was a stack trace.

Every engine was unit-tested. The CONTRACT BETWEEN them was not, and that is the
gap this file closes: it compares what the producers emit with what the
consumers understand and fails when they diverge. A new assertion type is
therefore impossible to ship half-built.
"""
import inspect
import re

from app.modules import (design, execution, generation, insight, security,
                         visual, webtarget)


# ---------------------------------------------------------------------------
# What the executors understand
# ---------------------------------------------------------------------------

def http_assertion_types() -> set[str]:
    """Types `_eval_assertion` branches on, read from its own source.

    Read rather than listed: a hand-maintained list is another thing to forget,
    and forgetting it is precisely the bug.
    """
    src = inspect.getsource(execution._eval_assertion)
    found = set(re.findall(r'kind == "([a-z0-9_]+)"', src))
    # `kind in ("a", "b")` is the same dispatch written for two related types
    for group in re.findall(r'kind in \(([^)]*)\)', src):
        found |= set(re.findall(r'"([a-z0-9_]+)"', group))
    return found


def browser_assertion_types() -> set[str]:
    """What the browser sidecar can run: its check names AND the assertion types
    it records inside them.

    The two live in different languages, which is exactly why the contract
    between them needs a test: `required_field_enforced` is dispatched on in
    check.mjs, and the assertions it carries (`validation_error`,
    `no_navigation`) are recorded there too. Reading the sidecar source keeps
    this honest across the boundary.
    """
    from pathlib import Path

    from app.config import settings
    from app.modules import webverify

    types = set(webverify.BROWSER_CHECKS)
    sidecar = Path(settings.WEB_CHECK_SCRIPT)
    if sidecar.is_file():
        src = sidecar.read_text(encoding="utf-8")
        types |= set(re.findall(r"record\(\s*'([a-z0-9_]+)'", src))
        types |= set(re.findall(r"check === '([a-z0-9_]+)'", src))
    return types


def executable_assertion_types() -> set[str]:
    return http_assertion_types() | browser_assertion_types()


# ---------------------------------------------------------------------------
# What the builders emit
# ---------------------------------------------------------------------------

_ASSERTION_TYPE_RE = re.compile(r'"type":\s*"([a-z0-9_]+)"')
_CHECK_RE = re.compile(r'"check":\s*"([a-z0-9_]+)"')

BUILDER_MODULES = (security, generation, insight, visual, webtarget, design)


def emitted_assertion_types() -> set[str]:
    found: set[str] = set()
    for module in BUILDER_MODULES:
        src = inspect.getsource(module)
        found |= set(_ASSERTION_TYPE_RE.findall(src))
        found |= set(_CHECK_RE.findall(src))
    # design.py names its checks in a table rather than in JSON literals, so it
    # is read from the table itself — the authoritative list either way.
    found |= set(design._UI_CHECKS)
    return found


# Types that are deliberately not executable, each with the reason. Anything
# NOT on this list and not executable fails the gate.
KNOWN_NON_ASSERTIONS = {
    # JSON Schema shapes and auth-scheme names that happen to share the "type" key
    "object", "string", "integer", "number", "boolean", "array", "null",
    "http", "apikey", "oauth2",
    # the five test tracks (app/testtypes.py) and the case polarity — both are
    # written as "type" on a case, not on an assertion
    "functional", "api", "ui", "performance", "security",
    "positive", "negative", "boundary",
}


def declared_unsupported() -> set[str]:
    """Types the runner states it cannot answer, each with a reason on record.

    Declaring a limit is not the same as forgetting one. These are reported
    `unsupported` at run time and excluded from coverage, so they can never be
    mistaken for a pass (H1/H6/H9).
    """
    from app.modules import webverify
    return set(webverify.UNSUPPORTED_CHECKS)


def test_every_emitted_assertion_has_an_executor():
    """QG1. The gate that would have caught TR-002 before it shipped."""
    emitted = emitted_assertion_types() - KNOWN_NON_ASSERTIONS
    accounted = executable_assertion_types() | declared_unsupported()
    orphans = sorted(t for t in emitted if t not in accounted)
    assert not orphans, (
        "these assertion/check types are produced by a builder and understood by "
        f"no executor, so every case carrying them silently checks nothing: {orphans}. "
        "Implement them, declare them unsupported with a reason, or stop emitting "
        "them — do not skip them."
    )


def test_every_unsupported_check_carries_a_reason():
    """A declared limit without a reason is just a skip with better manners."""
    from app.modules import webverify
    for check, reason in webverify.UNSUPPORTED_CHECKS.items():
        assert reason and len(reason) > 20, f"{check} is declared unsupported without a reason"


def test_the_sidecar_and_the_backend_agree_on_what_is_unsupported():
    """Both sides keep their own copy; a divergence is a silent skip again."""
    from pathlib import Path

    from app.config import settings
    from app.modules import webverify

    sidecar = Path(settings.WEB_DISCOVERY_SCRIPT).parent / "check.mjs"
    src = sidecar.read_text(encoding="utf-8")
    block = re.search(r"const RASTER_ONLY = \{(.*?)\n\};", src, re.S)
    assert block, "check.mjs no longer declares RASTER_ONLY"
    in_sidecar = set(re.findall(r"^\s*([a-z0-9_]+):", block.group(1), re.M))
    assert in_sidecar == set(webverify.UNSUPPORTED_CHECKS), (
        f"backend says {sorted(webverify.UNSUPPORTED_CHECKS)}, "
        f"sidecar says {sorted(in_sidecar)}")


def test_the_design_checks_are_now_runnable():
    """TR-008 by name: 68% of the cases on a real target were of these types."""
    from app.modules import webverify
    for check in ("contrast_aa", "element_present", "element_box",
                  "surface_present", "palette_closed", "a11y_audit"):
        assert check in webverify.BROWSER_CHECKS, f"{check} still has no runner"


def test_the_three_security_assertions_are_implemented():
    """TR-002 by name: these three shipped unimplemented for a whole release."""
    http = http_assertion_types()
    for kind in ("no_5xx", "body_not_matches", "rate_limited_within"):
        assert kind in http, f"{kind} is emitted by the security builders and unimplemented"


def test_no_5xx_fails_on_a_server_error():
    class R:
        status_code = 500
    ok, actual, skipped, _ = execution._eval_assertion({"type": "no_5xx"}, R(), None, 1, None)
    assert not ok and not skipped and actual == 500


def test_body_not_matches_catches_a_stack_trace():
    """The exact regression: a leaked traceback used to pass."""
    class R:
        status_code = 500
    body = ('{"error": "TypeError: float() argument must be a string\\n'
            '  File \\"/srv/shopdesk/api.py\\", line 214, in create_order"}')
    assertion = {"type": "body_not_matches",
                 "patterns": ["Traceback (most recent call last)", "/srv/"]}
    ok, actual, skipped, _ = execution._eval_assertion(
        assertion, R(), None, 1, None, resp_text=body)
    assert not ok and not skipped
    assert "/srv/" in str(actual)


def test_body_not_matches_passes_on_a_clean_body():
    class R:
        status_code = 422
    ok, _, skipped, _ = execution._eval_assertion(
        {"type": "body_not_matches", "patterns": ["Traceback (most recent call last)"]},
        R(), None, 1, None, resp_text='{"error": "quantity must be at least 1"}')
    assert ok and not skipped


def test_rate_limit_without_authorisation_is_inconclusive_not_passed():
    """An unauthorised ACTIVE probe must say "not run", never "passed"."""
    class R:
        status_code = 200
    ok, _, skipped, why = execution._eval_assertion(
        {"type": "rate_limited_within", "requests": 20, "expected_status": 429},
        R(), None, 1, None, probe=None)
    assert skipped and why, "a skip must carry its reason (H1)"
    assert "not authorised" in why


def test_rate_limit_reads_the_probe_when_authorised():
    class R:
        status_code = 200
    ok, actual, skipped, _ = execution._eval_assertion(
        {"type": "rate_limited_within", "expected_status": 429},
        R(), None, 1, None, probe={"statuses": [200, 200, 429]})
    assert ok and not skipped and actual["expected"] == 429

    ok, _, skipped, _ = execution._eval_assertion(
        {"type": "rate_limited_within", "expected_status": 429},
        R(), None, 1, None, probe={"statuses": [200] * 20})
    assert not ok and not skipped, "20 unlimited requests is a finding, not a pass"


def test_every_skip_carries_a_reason():
    """H1. A skipped assertion that says nothing is indistinguishable from a pass."""
    class R:
        status_code = 200
    _, _, skipped, why = execution._eval_assertion(
        {"type": "totally_made_up"}, R(), None, 1, None)
    assert skipped and why and "totally_made_up" in why
