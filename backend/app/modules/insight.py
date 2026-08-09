"""Insight module — the SIXTH engine: QA Insight Agent (وكيل الرؤى).

Techniques adapted from an external QA-tool audit and re-implemented in Traceo's
style. Three properties are non-negotiable and are what the tests defend:

* 100% DETERMINISTIC — same inventory in, byte-identical cases out.
* ZERO LLM CALLS — nothing in this module touches ``app.llm``; it runs fully
  offline (NFR-D1). Requirement -> endpoint association reuses the generation
  module's *lexical* prefilter, which is a pure function, never the mapper.
* GROUNDED — every produced case goes through ``generation.grounding_validate``
  before persistence, exactly like the main generator: one fabricated path,
  method, parameter, body field or assertion target and the case is DISCARDED,
  never repaired, never shown (BO-07, BR-09).

The engine answers two questions:

  GET  /projects/{id}/insights           "which edge-case families does this
                                          project already cover, which are gaps,
                                          and which are simply not applicable?"
  POST /projects/{id}/insights/generate  "build the missing ones, as drafts."

Everything else in Traceo is untouched: this engine is opt-in through its own
two routes, it never changes an existing payload's meaning and it never runs
from autopilot.
"""
import copy
import re
import unicodedata

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..models import (Endpoint, Requirement, RequirementTestCase, TestCase,
                      TestStep, User)
# REUSE, never re-implement: the grounding gate, the deterministic request
# builder, the schema introspection helpers and the persistence helper all come
# from the generation engine. Duplicating any of them would let the two engines
# drift, and a weaker copy of the gate is exactly the failure BO-07 forbids.
from .generation import (_apply_input, _body_object_schema, _constrained_inputs,
                         _epget, _first_status, _free_text_body_fields,
                         _is_free_text, _param_schema, _persist_case,
                         _positive_assertions, _prefilter, _step,
                         _valid_request, grounding_validate)

router = APIRouter()


# ---------------------------------------------------------------------------
# A. TAXONOMY — the 9 canonical ids. These exact strings are the contract with
#    the Go backend and the UI; they are ids, not labels, and are never
#    translated on the wire.
# ---------------------------------------------------------------------------

BOUNDARY_SURPRISE = "boundary_surprise"      # off-by-one/limit edges beyond plain BVA
EXOTIC_INPUT = "exotic_input"                # Arabic/RTL, emoji, NFC-vs-NFD, zero-width
CONTROL_CHARS = "control_chars"              # null bytes + control characters in strings
IDEMPOTENCY = "idempotency"                  # duplicate/replayed mutating request
STATE_CORRUPTION = "state_corruption"        # out-of-order / illegal state transitions
PERMISSION_EDGE = "permission_edge"          # same request, lower-privileged actor
TIMING_DST = "timing_dst"                    # timezone/DST/date-rollover values
RESOURCE_EXHAUSTION = "resource_exhaustion"  # oversized payload / extreme pagination
DOWNSTREAM_FAILURE = "downstream_failure"    # dependency / error-propagation shapes

EDGE_CATEGORIES: tuple[str, ...] = (
    BOUNDARY_SURPRISE, EXOTIC_INPUT, CONTROL_CHARS, IDEMPOTENCY, STATE_CORRUPTION,
    PERMISSION_EDGE, TIMING_DST, RESOURCE_EXHAUSTION, DOWNSTREAM_FAILURE,
)
EDGE_CATEGORY_SET = frozenset(EDGE_CATEGORIES)

EDGE_TECHNIQUE = "edge_case"          # TestCase.technique value for every insight case
STATUS_COVERED, STATUS_GAP, STATUS_NA = "covered", "gap", "n_a"

MODEL_NAME = "deterministic-insight"  # provenance: no model was involved
MAX_STRING_PROBE_FIELDS = 1           # exotic/control probes target the first free-text field
OVERSIZED_EXTRA_CHARS = 5000          # beyond maxLength — "exhaustion", not "one too many"
EXTREME_PAGE_VALUE = 1_000_000_000

PAGINATION_PARAM_NAMES = frozenset({
    "limit", "page", "page_size", "pagesize", "per_page", "perpage", "offset",
    "size", "count", "top", "skip", "take", "max_results", "maxresults", "rows",
})

# --- exotic payloads (all derived from Unicode, never from an endpoint) ------
ARABIC_RTL_PAYLOAD = "اختبار‏ الحدود"          # Arabic + RIGHT-TO-LEFT MARK
EMOJI_PAYLOAD = "qa 🐫🇸🇦 test"
_NFC_PAYLOAD = unicodedata.normalize("NFC", "أحمد")   # composed hamza-on-alef
_NFD_PAYLOAD = unicodedata.normalize("NFD", "أحمد")   # decomposed — must normalise back
ZERO_WIDTH_PAYLOAD = "qa​test‍﻿"       # ZWSP + ZWJ + BOM
NULL_BYTE_PAYLOAD = "qa\x00test"
CONTROL_CHAR_PAYLOAD = "qa\x07\x1b[31mtest"

# --- timing payloads --------------------------------------------------------
DATETIME_PROBES = (
    ("spring-forward gap", "2026-03-29T02:30:00+02:00"),   # local time that never exists
    ("fall-back ambiguity", "2026-10-25T02:30:00+01:00"),  # local time that happens twice
    ("year rollover in UTC", "2026-12-31T23:59:59Z"),
)
DATE_PROBES = (
    ("leap day", "2028-02-29"),
    ("year rollover", "2026-12-31"),
)


# ---------------------------------------------------------------------------
# Pure classifier — which category does an EXISTING case already belong to?
#
# Insight-generated cases carry `edge_category` and need no guessing. Legacy
# cases (everything generated before this engine, plus manual authoring) are
# classified by this pure function so the report credits work that is already
# done instead of reporting a false gap.
#
# RULES, in strict priority order (first match wins — the order matters because
# a single case can carry several signals, e.g. a null byte inside an Arabic
# string):
#   0. an explicit, legal `edge_category` always wins.
#   1. REQUEST-VALUE signals (strongest: they describe what the case actually
#      sends, not what someone called it):
#      1a. a C0/C1 control character or NUL in any string value -> control_chars
#      1b. Arabic/RTL marks, emoji, zero-width or combining marks     -> exotic_input
#          NOTE: only *request values* are inspected, never the title — in an
#          Arabic project every title is Arabic and would false-positive.
#      1c. two or more steps repeating the SAME mutating (method, path)
#                                                                     -> idempotency
#      1d. a string value >= 1000 chars, or a pagination-named parameter with an
#          extreme value                                          -> resource_exhaustion
#      1e. an assertion that tolerates a 5xx                    -> downstream_failure
#      1f. an assertion expecting 401/403                          -> permission_edge
#      1g. a date/date-time-shaped value carrying a timezone offset,
#          a leap day or a 12-31/01-01 rollover                        -> timing_dst
#      1h. >= 2 steps whose mutating (method, path) pairs differ  -> state_corruption
#   2. TITLE keywords (English + Arabic), for hand-written cases that describe
#      the intent without a machine-readable signal.
#   3. otherwise None — the case belongs to no edge family.
#
# DELIBERATELY NOT A RULE: technique "bva" / type "boundary" do NOT imply
# boundary_surprise. Taxonomy item A defines that category as the off-by-one and
# limit edges *beyond plain BVA*; plain BVA walks min, min+1, max-1, max — all
# INSIDE the declared range — and never sends the min-1/max+1 values the
# boundary_surprise builder emits. Crediting every BVA case would report the
# category as "covered" on exactly the projects whose just-outside edges are
# untested, which is the blind spot this engine exists to expose. Only the
# explicit just-outside vocabulary in _TITLE_HINTS counts.
# ---------------------------------------------------------------------------

_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_ZERO_WIDTH_CHARS = "​‌‍‎‏‪‫‬‮﻿"
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_TZ_OFFSET_RE = re.compile(r"\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})")
_MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})

_TITLE_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (CONTROL_CHARS, ("null byte", "nul byte", "control char", "محارف تحكم", "بايت صفري")),
    (IDEMPOTENCY, ("idempot", "duplicate submit", "double submit", "replay", "تكرار الإرسال", "التكرار")),
    (PERMISSION_EDGE, ("unauthenticated", "unauthorised", "unauthorized", "forbidden",
                       "permission", "privilege", "lower-privileged", "صلاحية", "بدون مصادقة")),
    (RESOURCE_EXHAUSTION, ("oversized", "too large", "payload limit", "pagination",
                           "exhaustion", "حمولة كبيرة", "استنزاف")),
    (TIMING_DST, ("timezone", "time zone", "dst", "daylight", "rollover", "leap day",
                  "التوقيت", "المنطقة الزمنية")),
    (STATE_CORRUPTION, ("out of order", "out-of-order", "illegal transition", "after delete",
                        "before create", "انتقال غير صالح", "ترتيب غير صالح")),
    (DOWNSTREAM_FAILURE, ("downstream", "upstream", "dependency failure", "5xx",
                          "فشل التبعية", "الخدمة الخلفية")),
    (EXOTIC_INPUT, ("arabic", "emoji", "unicode", "rtl", "normalisation", "normalization",
                    "localisation", "localization", "zero-width", "زخرفة", "عربي")),
    # Just-outside vocabulary ONLY. A bare "boundary" is the plain-BVA word and
    # would credit min/max cases that never leave the declared range.
    (BOUNDARY_SURPRISE, ("off-by-one", "off by one", "just outside", "just-outside",
                         "beyond the limit", "past the declared", "minimum-1", "maximum+1",
                         "minlength-1", "maxlength+1", "خارج الحد", "تجاوز الحد")),
)


def _is_exotic_text(text: str) -> bool:
    for ch in text:
        code = ord(ch)
        if "؀" <= ch <= "ۿ":                 # Arabic block
            return True
        if ch in _ZERO_WIDTH_CHARS:
            return True
        if 0x0300 <= code <= 0x036F:                   # combining marks (NFD residue)
            return True
        if code >= 0x1F000 or 0x2600 <= code <= 0x27BF or 0x1F1E6 <= code <= 0x1F1FF:
            return True
    return False


def _iter_request_strings(request: dict):
    """Every string value a step sends (params, headers, body, raw_body), with the
    key it was sent under."""
    def walk(key, value):
        if isinstance(value, str):
            yield key, value
        elif isinstance(value, dict):
            for k, v in value.items():
                yield from walk(str(k), v)
        elif isinstance(value, list):
            for v in value:
                yield from walk(key, v)

    for section in ("params", "headers", "body"):
        yield from walk("", (request or {}).get(section))
    raw = (request or {}).get("raw_body")
    if isinstance(raw, str):
        yield "", raw


def _iter_request_values(request: dict):
    """(key, value) for every scalar the step sends — used for numeric probes."""
    for section in ("params", "body"):
        sub = (request or {}).get(section)
        if isinstance(sub, dict):
            for k, v in sub.items():
                yield str(k), v


def _assert_codes(assertions) -> set[int]:
    codes: set[int] = set()
    for a in assertions or []:
        if not isinstance(a, dict) or a.get("type") != "status_code":
            continue
        exp = a.get("expected")
        if isinstance(exp, int) and not isinstance(exp, bool):
            codes.add(exp)
        for x in a.get("expected_any") or []:
            if isinstance(x, int) and not isinstance(x, bool):
                codes.add(x)
    return codes


def classify_case(case: dict) -> str | None:
    """Pure function — no DB, no I/O. See the rule table above.

    `case` shape: {edge_category, technique, type, title,
                   steps: [{method, path, request, assertions}]}"""
    explicit = case.get("edge_category")
    if explicit in EDGE_CATEGORY_SET:
        return explicit

    steps = [s for s in (case.get("steps") or []) if isinstance(s, dict)]
    title = str(case.get("title") or "").lower()

    has_control = has_exotic = False
    has_long_string = has_extreme_page = False
    has_timing = False
    codes: set[int] = set()
    mutating_keys: list[tuple[str, str]] = []

    for step in steps:
        method = str(step.get("method") or "").upper()
        if method in _MUTATING:
            mutating_keys.append((method, str(step.get("path") or "")))
        request = step.get("request") or {}
        codes |= _assert_codes(step.get("assertions"))
        for _key, text in _iter_request_strings(request):
            if _CONTROL_RE.search(text):
                has_control = True
            if _is_exotic_text(text):
                has_exotic = True
            if len(text) >= 1000:
                has_long_string = True
            if _DATE_RE.search(text) and (_TZ_OFFSET_RE.search(text)
                                          or "-02-29" in text or "-12-31" in text
                                          or "-01-01" in text):
                has_timing = True
        for key, value in _iter_request_values(request):
            if (key.lower() in PAGINATION_PARAM_NAMES and isinstance(value, int)
                    and not isinstance(value, bool) and (value < 0 or value >= 100_000)):
                has_extreme_page = True

    # 1. request-value signals
    if has_control:
        return CONTROL_CHARS
    if has_exotic:
        return EXOTIC_INPUT
    if len(mutating_keys) >= 2 and len(set(mutating_keys)) == 1:
        return IDEMPOTENCY
    if has_long_string or has_extreme_page:
        return RESOURCE_EXHAUSTION
    if any(500 <= c < 600 for c in codes):
        return DOWNSTREAM_FAILURE
    if codes & {401, 403}:
        return PERMISSION_EDGE
    if has_timing:
        return TIMING_DST
    if len(mutating_keys) >= 2 and len(set(mutating_keys)) > 1:
        return STATE_CORRUPTION

    # 2. title keywords
    for category, needles in _TITLE_HINTS:
        if any(n in title for n in needles):
            return category

    # 3. no fallback on technique/type — see the rule table above: plain BVA is
    #    not boundary_surprise, so an unrecognised case is honestly uncategorised.
    return None


def case_view(tc: TestCase) -> dict:
    """ORM TestCase -> the plain dict `classify_case` consumes."""
    return {
        "edge_category": tc.edge_category,
        "technique": tc.technique,
        "type": tc.type,
        "title": tc.title,
        "steps": [{"method": s.method, "path": s.path, "request": s.request or {},
                   "assertions": s.assertions or []}
                  for s in sorted(tc.steps, key=lambda s: s.order)],
    }


# ---------------------------------------------------------------------------
# Inventory introspection (all of it reads the DISCOVERED inventory only)
# ---------------------------------------------------------------------------

def _free_text_params(ep) -> list[dict]:
    """Free-text string QUERY parameters — path params are part of the URL and are
    left alone so the probes stay about payloads, not routing."""
    out = []
    for p in _epget(ep, "parameters") or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        if p.get("location", "query") != "query":
            continue
        sch = _param_schema(p)
        if _is_free_text(sch):
            out.append({"name": p["name"], "where": "param", "schema": sch,
                        "required": bool(p.get("required")), "location": "query"})
    return out


def _string_probe_targets(ep) -> list[dict]:
    """Existing free-text string inputs, body first. Empty list => the exotic and
    control-char builders have nothing to ground themselves in and emit nothing."""
    return (_free_text_body_fields(ep) + _free_text_params(ep))[:MAX_STRING_PROBE_FIELDS]


def _datetime_inputs(ep) -> list[dict]:
    """Inputs whose SCHEMA declares format date/date-time — the only thing the
    timing_dst builder is allowed to touch."""
    out = []
    for p in _epget(ep, "parameters") or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        sch = _param_schema(p)
        if sch.get("format") in ("date", "date-time"):
            out.append({"name": p["name"], "where": "param", "schema": sch,
                        "required": bool(p.get("required")),
                        "location": p.get("location", "query")})
    rs = _body_object_schema(ep)
    if rs:
        required = rs.get("required") or []
        for name, sch in rs["properties"].items():
            if isinstance(sch, dict) and sch.get("format") in ("date", "date-time"):
                out.append({"name": name, "where": "body", "schema": sch,
                            "required": name in required, "location": "body"})
    return out


def _pagination_params(ep) -> list[dict]:
    out = []
    for p in _epget(ep, "parameters") or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        if str(p["name"]).lower() in PAGINATION_PARAM_NAMES:
            out.append({"name": p["name"], "where": "param", "schema": _param_schema(p),
                        "required": bool(p.get("required")),
                        "location": p.get("location", "query")})
    return out


def _bounded_string_inputs(ep) -> list[dict]:
    """String inputs the oversized-payload probe can grow (body fields + query params)."""
    out = []
    rs = _body_object_schema(ep)
    if rs:
        required = rs.get("required") or []
        for name, sch in rs["properties"].items():
            if isinstance(sch, dict) and sch.get("type", "string") == "string" and not sch.get("enum"):
                out.append({"name": name, "where": "body", "schema": sch,
                            "required": name in required, "location": "body"})
    out.extend(_free_text_params(ep))
    return out


def _response_props(ep, lo: int = 200, hi: int = 299) -> dict:
    """Properties of the first declared response schema in [lo, hi] — the closed set
    of json_field targets the grounding gate will accept."""
    rss = _epget(ep, "response_schemas") or {}
    for k in sorted(rss, key=str):
        if str(k).isdigit() and lo <= int(k) <= hi:
            cand = rss[k]
            if isinstance(cand, dict) and isinstance(cand.get("properties"), dict):
                return cand["properties"]
    return {}


def _fits(schema: dict, value: str) -> bool:
    mn, mx = schema.get("minLength"), schema.get("maxLength")
    if isinstance(mn, int) and len(value) < mn:
        return False
    if isinstance(mx, int) and len(value) > mx:
        return False
    return True


def _family(path: str) -> str:
    """First non-templated path segment — the resource family two endpoints share."""
    for seg in (path or "").strip("/").split("/"):
        if seg and not seg.startswith("{"):
            return seg
    return ""


# ---------------------------------------------------------------------------
# Assertion helpers (every code is drawn from the endpoint's own declarations)
# ---------------------------------------------------------------------------

def _ok_code(ep) -> int:
    return _first_status(ep, 200, 299) or 200


def _err_code(ep) -> int:
    return _first_status(ep, 400, 499) or 422


def _handled(ep, prefer: str = "ok") -> dict:
    """"The API handled this on purpose — it did not fall over."

    expected is the outcome we consider correct; expected_any is the closed set of
    acceptable codes, built from the endpoint's own declared 2xx/4xx responses plus
    the standard validation codes. A 5xx is never in the set, which is the point."""
    ok, err = _ok_code(ep), _err_code(ep)
    allowed = sorted({ok, err, 400, 422})
    return {"type": "status_code", "expected": ok if prefer == "ok" else err,
            "expected_any": allowed}


# ---------------------------------------------------------------------------
# D. DETERMINISTIC BUILDERS
#
# Every builder receives (endpoint, requirement, ctx) and returns a list of case
# dicts in the exact shape the generation engine persists. A builder that cannot
# ground itself in the inventory returns [] — it NEVER invents an endpoint, a
# parameter, a body field or a response property.
# ---------------------------------------------------------------------------

def _mk(req: Requirement, ep, category: str, title: str, ctype: str,
        steps: list[dict], rationale: str) -> dict:
    ref = req.external_id or req.id[:8]
    return {
        "title": f"Edge [{category}]: {title} — {ep.method.upper()} {ep.path}"[:500],
        "description": (f"{rationale} Covers requirement {ref}: "
                        f"{(req.description or '')[:300]}"),
        "preconditions": "Authenticated session" if (ep.security or []) else "",
        "type": ctype,
        "priority": req.priority or "medium",
        "technique": EDGE_TECHNIQUE,
        "edge_category": category,
        "steps": steps,
        "requirement_ids": [req.id],
    }


def _build_boundary_surprise(ep, req, ctx) -> list[dict]:
    """Off-by-one OUTSIDE the declared bounds — the edges plain BVA (which walks
    min/min+1/max-1/max, all inside the range) never visits."""
    params, headers, body = _valid_request(ep)
    cases: list[dict] = []
    for inp in _constrained_inputs(ep):
        sch = inp["schema"]
        if isinstance(sch.get("enum"), list) and sch["enum"]:
            continue
        probes: list[tuple[str, object]] = []
        if sch.get("type") in ("integer", "number"):
            mn, mx = sch.get("minimum"), sch.get("maximum")
            if mn is not None:
                probes.append(("one below minimum", mn - 1))
            if mx is not None:
                probes.append(("one above maximum", mx + 1))
        elif sch.get("type", "string") == "string" and not sch.get("pattern") and not sch.get("format"):
            mnl, mxl = sch.get("minLength"), sch.get("maxLength")
            if isinstance(mnl, int) and mnl > 0:
                probes.append(("one char below minLength", "x" * (mnl - 1)))
            if isinstance(mxl, int):
                probes.append(("one char above maxLength", "x" * (mxl + 1)))
        for label, value in probes:
            p2, b2 = _apply_input(inp, value, params, body)
            cases.append(_mk(
                req, ep, BOUNDARY_SURPRISE, f"{inp['name']} {label}", "boundary",
                [_step(ep, p2, headers, b2, [_handled(ep, "error")])],
                "The declared limit must be enforced exactly one step outside the range."))
    return cases


def _build_exotic_input(ep, req, ctx) -> list[dict]:
    """Arabic/RTL, emoji, NFC-vs-NFD and zero-width payloads in an EXISTING
    free-text field. These must round-trip, not explode."""
    targets = _string_probe_targets(ep)
    if not targets:
        return []
    inp = targets[0]
    sch, name = inp["schema"], inp["name"]
    echoed = name in _response_props(ep)
    params, headers, body = _valid_request(ep)
    probes = (
        ("Arabic with RTL mark", ARABIC_RTL_PAYLOAD, None),
        ("emoji and flag sequences", EMOJI_PAYLOAD, None),
        ("NFD-decomposed Arabic", _NFD_PAYLOAD, _NFC_PAYLOAD),
        ("zero-width characters", ZERO_WIDTH_PAYLOAD, None),
    )
    cases: list[dict] = []
    for label, payload, normalised in probes:
        if not _fits(sch, payload):
            continue  # the field's own length bounds win — no invented headroom
        p2, b2 = _apply_input(inp, payload, params, body)
        assertions: list[dict] = [_handled(ep, "ok")]
        if echoed:
            if normalised is not None:
                # the whole point of the NFD probe: the API must normalise back
                assertions.append({"type": "json_field", "path": name, "op": "eq",
                                   "expected": normalised})
            else:
                assertions.append({"type": "json_field", "path": name, "op": "exists"})
        cases.append(_mk(
            req, ep, EXOTIC_INPUT, f"{name} carries {label}", "positive",
            [_step(ep, p2, headers, b2, assertions)],
            "Unicode that is legal but rarely tested must survive the round trip."))
    return cases


def _build_control_chars(ep, req, ctx) -> list[dict]:
    """NUL and C0 control characters inside an EXISTING string field."""
    targets = _string_probe_targets(ep)
    if not targets:
        return []
    inp = targets[0]
    params, headers, body = _valid_request(ep)
    cases: list[dict] = []
    for label, payload in (("a NUL byte", NULL_BYTE_PAYLOAD),
                           ("C0 control characters", CONTROL_CHAR_PAYLOAD)):
        if not _fits(inp["schema"], payload):
            continue
        p2, b2 = _apply_input(inp, payload, params, body)
        cases.append(_mk(
            req, ep, CONTROL_CHARS, f"{inp['name']} contains {label}", "negative",
            [_step(ep, p2, headers, b2, [_handled(ep, "error")])],
            "Control characters must be rejected or sanitised, never stored raw."))
    return cases


def _build_idempotency(ep, req, ctx) -> list[dict]:
    """The SAME existing mutating request, sent twice, back to back."""
    method = ep.method.upper()
    if method not in ("POST", "PUT", "PATCH"):
        return []
    params, headers, body = _valid_request(ep)
    ok = _ok_code(ep)
    first = _step(ep, params, headers, body, _positive_assertions(ep))

    # "no duplicate side effect": when the success schema declares an identifier,
    # capture it and assert the replay returns the SAME one.
    props = _response_props(ep)
    id_prop = next((p for p in ("id", "uuid", "reference", "number", "code") if p in props), None)
    replay_assertions: list[dict] = [
        {"type": "status_code", "expected": ok,
         "expected_any": sorted({ok, 200, _err_code(ep), 409, 422})}]
    if id_prop:
        first["extractions"] = [{"name": "insight_first_id", "path": id_prop}]
        replay_assertions.append({"type": "json_field", "path": id_prop, "op": "eq",
                                  "expected": "{{insight_first_id}}"})
    second = _step(ep, dict(params), dict(headers), copy.deepcopy(body), replay_assertions)
    return [_mk(
        req, ep, IDEMPOTENCY, "identical request replayed twice", "positive",
        [first, second],
        "A replayed mutation must not 5xx and must not create a second resource.")]


def _build_state_corruption(ep, req, ctx) -> list[dict]:
    """Two EXISTING endpoints of the same resource family, exercised in an order
    the state machine forbids. Only built from the mutating side, so the mirrored
    pair is never emitted twice."""
    method = ep.method.upper()
    family = _family(ep.path)
    if not family or method not in ("DELETE", "PUT", "PATCH"):
        return []
    siblings = [e for e in ctx["endpoints"]
                if e.id != ep.id and _family(e.path) == family]
    if not siblings:
        return []

    def pick(methods: tuple[str, ...]):
        """Deterministic partner choice: the same path wins over a family sibling,
        then the caller's method preference, then alphabetical."""
        ranked = sorted(
            (e for e in siblings if e.method.upper() in methods),
            key=lambda e: (e.path != ep.path, methods.index(e.method.upper()),
                           e.path, e.method.upper()))
        return ranked[0] if ranked else None

    if method == "DELETE":
        partner = pick(("GET", "PUT", "PATCH"))
        if partner is None:
            return []
        first_ep, second_ep = ep, partner
        gone = _first_status(partner, 400, 499) or 404
        first_assertions = _positive_assertions(ep)
        second_assertions = [{"type": "status_code", "expected": gone,
                              "expected_any": sorted({gone, 404, 409, 410, 422})}]
        title = f"{partner.method.upper()} {partner.path} after DELETE"
        rationale = "A resource that was deleted must stay deleted for every sibling operation."
    else:
        partner = pick(("POST",))
        if partner is None:
            return []
        first_ep, second_ep = ep, partner
        missing = _first_status(ep, 400, 499) or 404
        first_assertions = [{"type": "status_code", "expected": missing,
                             "expected_any": sorted({missing, 400, 404, 409, 422})}]
        second_assertions = _positive_assertions(partner)
        title = f"{method} before POST {partner.path}"
        rationale = "Updating before creating is an illegal transition; the later create must still work."

    p1, h1, b1 = _valid_request(first_ep)
    p2, h2, b2 = _valid_request(second_ep)
    steps = [_step(first_ep, p1, h1, b1, first_assertions),
             _step(second_ep, p2, h2, b2, second_assertions)]
    return [_mk(req, ep, STATE_CORRUPTION, title, "negative", steps, rationale)]


def _build_permission_edge(ep, req, ctx) -> list[dict]:
    """The exact same existing request, carried out by a lower-privileged actor.
    Only endpoints that DECLARE a security requirement qualify."""
    if not (ep.security or []):
        return []
    params, headers, body = _valid_request(ep)
    headers = {k: v for k, v in headers.items() if k.lower() != "authorization"}
    headers["Authorization"] = "Bearer {{lower_privilege_token}}"
    case = _mk(
        req, ep, PERMISSION_EDGE, "same request as a lower-privileged actor", "negative",
        [_step(ep, params, headers, body,
               [{"type": "status_code", "expected": 403, "expected_any": [401, 403, 404]}])],
        "Authorisation must be checked per operation, not only at sign-in.")
    case["preconditions"] = "A session for a role below the one this operation expects"
    return [case]


def _build_timing_dst(ep, req, ctx) -> list[dict]:
    """Timezone / DST / rollover values — ONLY on fields whose schema says
    date or date-time. No such field anywhere => this category is n_a."""
    inputs = _datetime_inputs(ep)
    if not inputs:
        return []
    inp = inputs[0]
    params, headers, body = _valid_request(ep)
    probes = (DATETIME_PROBES if inp["schema"].get("format") == "date-time" else DATE_PROBES)
    cases: list[dict] = []
    for label, value in probes:
        p2, b2 = _apply_input(inp, value, params, body)
        cases.append(_mk(
            req, ep, TIMING_DST, f"{inp['name']} at {label}", "positive",
            [_step(ep, p2, headers, b2, [_handled(ep, "ok")])],
            "Clock arithmetic breaks at DST edges and date rollovers."))
    return cases


def _build_resource_exhaustion(ep, req, ctx) -> list[dict]:
    """Extreme values for EXISTING pagination parameters, and an oversized value
    for an EXISTING string field."""
    params, headers, body = _valid_request(ep)
    cases: list[dict] = []
    for inp in _pagination_params(ep):
        for label, value in (("an extreme page size", EXTREME_PAGE_VALUE),
                             ("a negative value", -1)):
            p2, b2 = _apply_input(inp, value, params, body)
            cases.append(_mk(
                req, ep, RESOURCE_EXHAUSTION, f"{inp['name']} set to {label}", "negative",
                [_step(ep, p2, headers, b2,
                       [{"type": "status_code", "expected": _err_code(ep),
                         "expected_any": sorted({_err_code(ep), 400, 413, 422})}])],
                "Pagination limits must be clamped, not handed straight to the database."))
    bounded = _bounded_string_inputs(ep)
    if bounded:
        inp = bounded[0]
        mx = inp["schema"].get("maxLength")
        size = (mx + OVERSIZED_EXTRA_CHARS) if isinstance(mx, int) else OVERSIZED_EXTRA_CHARS
        p2, b2 = _apply_input(inp, "x" * size, params, body)
        cases.append(_mk(
            req, ep, RESOURCE_EXHAUSTION, f"{inp['name']} carries an oversized payload", "negative",
            [_step(ep, p2, headers, b2,
                   [{"type": "status_code", "expected": 413,
                     "expected_any": sorted({_err_code(ep), 400, 413, 414, 422})}])],
            "An oversized field must be refused cheaply, before it reaches storage."))
    return cases


def _build_downstream_failure(ep, req, ctx) -> list[dict]:
    """Only for endpoints that DECLARE a 5xx response: the declared failure shape
    must be what callers actually see when a dependency is down."""
    declared = _first_status(ep, 500, 599)
    if declared is None:
        return []
    params, headers, body = _valid_request(ep)
    ok = _ok_code(ep)
    return [_mk(
        req, ep, DOWNSTREAM_FAILURE, "dependency failure propagates as the declared shape",
        "negative",
        [_step(ep, params, headers, body,
               [{"type": "status_code", "expected": ok,
                 "expected_any": sorted({ok, declared, 502, 503, 504})}])],
        f"When a dependency fails this operation must answer {declared}, "
        "not leak an undeclared error.")]


BUILDERS = {
    BOUNDARY_SURPRISE: _build_boundary_surprise,
    EXOTIC_INPUT: _build_exotic_input,
    CONTROL_CHARS: _build_control_chars,
    IDEMPOTENCY: _build_idempotency,
    STATE_CORRUPTION: _build_state_corruption,
    PERMISSION_EDGE: _build_permission_edge,
    TIMING_DST: _build_timing_dst,
    RESOURCE_EXHAUSTION: _build_resource_exhaustion,
    DOWNSTREAM_FAILURE: _build_downstream_failure,
}
assert set(BUILDERS) == EDGE_CATEGORY_SET  # taxonomy and builders never drift


# ---------------------------------------------------------------------------
# Deterministic requirement <-> endpoint association (NO LLM)
#
# Every case must link to at least one requirement — the generator's hard
# contract. The mapping is built from two deterministic sources:
#   1. the project's OWN traceability: requirements already linked to a case
#      whose steps hit this endpoint;
#   2. the generation engine's lexical prefilter, which is a pure token-overlap
#      function (the LLM mapper that normally consumes its output is NOT used).
# An endpoint with no requirement from either source is skipped entirely.
# ---------------------------------------------------------------------------

def _endpoint_requirements(db: Session, org_id: str, project_id: str,
                           endpoints: list[Endpoint],
                           requirement_ids: list[str] | None) -> dict[str, list[Requirement]]:
    query = select(Requirement).where(Requirement.project_id == project_id,
                                      Requirement.organisation_id == org_id,
                                      Requirement.state == "confirmed")
    if requirement_ids:
        query = query.where(Requirement.id.in_(requirement_ids))
    reqs = sorted(db.scalars(query).all(), key=lambda r: (r.external_id or "~", r.id))
    if not reqs or not endpoints:
        return {}
    by_id = {r.id: r for r in reqs}
    mapping: dict[str, list[Requirement]] = {ep.id: [] for ep in endpoints}
    seen: dict[str, set[str]] = {ep.id: set() for ep in endpoints}
    by_key = {(e.method.upper(), e.path): e for e in endpoints}

    # 1. existing traceability
    rows = (db.query(RequirementTestCase.requirement_id, TestStep.endpoint_id,
                     TestStep.method, TestStep.path)
            .join(TestCase, TestCase.id == RequirementTestCase.test_case_id)
            .join(TestStep, TestStep.test_case_id == TestCase.id)
            .filter(TestCase.project_id == project_id,
                    TestCase.organisation_id == org_id,
                    TestCase.state != "archived")
            .all())
    for rid, endpoint_id, method, path in rows:
        req = by_id.get(rid)
        if req is None:
            continue
        ep_id = endpoint_id
        if ep_id not in mapping:
            match = by_key.get((str(method or "").upper(), path))
            ep_id = match.id if match else None
        if ep_id and req.id not in seen[ep_id]:
            seen[ep_id].add(req.id)
            mapping[ep_id].append(req)

    # 2. deterministic lexical prefilter
    for req in reqs:
        text = " ".join([req.description or ""]
                        + [str(a) for a in (req.acceptance_criteria or [])]).strip()
        for ep in _prefilter(text, endpoints):
            if req.id not in seen[ep.id]:
                seen[ep.id].add(req.id)
                mapping[ep.id].append(req)

    for ep_id in mapping:
        mapping[ep_id].sort(key=lambda r: (r.external_id or "~", r.id))
    return mapping


# ---------------------------------------------------------------------------
# The plan — ONE code path shared by the dry-run count (C) and the job (D)
# ---------------------------------------------------------------------------

def _dup_key(case: dict) -> tuple:
    first = case["steps"][0]
    return (case["technique"], first["method"], first["path"], case["title"])


def build_plan(db: Session, org_id: str, project_id: str, categories,
               requirement_ids: list[str] | None = None) -> tuple[list[dict], dict]:
    """Deterministically build every case the requested categories can ground.

    Returns (cases, endpoints_by_key). NOTHING is written — this is the exact
    function the dry-run count and the generation job both call, which is why the
    report can promise "suggestable_count" without duplicating builder logic."""
    wanted = [c for c in EDGE_CATEGORIES if c in set(categories)]
    endpoints = db.scalars(select(Endpoint).where(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == org_id,
        Endpoint.excluded == False)).all()  # noqa: E712
    endpoints = sorted(endpoints, key=lambda e: (e.path, e.method.upper()))
    endpoints_by_key = {(e.method.upper(), e.path): e for e in endpoints}
    if not wanted or not endpoints:
        return [], endpoints_by_key

    ep_reqs = _endpoint_requirements(db, org_id, project_id, endpoints, requirement_ids)
    ctx = {"endpoints": endpoints}
    cases: list[dict] = []
    titles: set[str] = set()
    for ep in endpoints:
        reqs = ep_reqs.get(ep.id) or []
        if not reqs:
            continue  # no requirement to trace to => no case (never an orphan case)
        req = reqs[0]
        for category in wanted:
            for case in BUILDERS[category](ep, req, ctx):
                if case["title"] in titles:
                    continue
                titles.add(case["title"])
                cases.append(case)
    return cases, endpoints_by_key


# ---------------------------------------------------------------------------
# C. GET /projects/{id}/insights — deterministic, no job
# ---------------------------------------------------------------------------

def build_report(db: Session, org_id: str, project_id: str) -> dict:
    cases = db.scalars(select(TestCase).where(
        TestCase.project_id == project_id,
        TestCase.organisation_id == org_id,
        TestCase.state != "archived")).all()

    covered = {c: 0 for c in EDGE_CATEGORIES}
    existing_keys: set[tuple] = set()
    for tc in cases:
        first = tc.steps[0] if tc.steps else None
        existing_keys.add((tc.technique or "",
                           first.method.upper() if first else "",
                           first.path if first else "", tc.title))
        category = classify_case(case_view(tc))
        if category:
            covered[category] += 1

    suggestable = {c: 0 for c in EDGE_CATEGORIES}
    plan, endpoints_by_key = build_plan(db, org_id, project_id, EDGE_CATEGORIES)
    for case in plan:
        if grounding_validate(case, endpoints_by_key):
            continue                       # ungrounded => it would be discarded anyway
        if _dup_key(case) in existing_keys:
            continue                       # already exists => not a NEW case
        suggestable[case["edge_category"]] += 1

    categories = []
    for cid in EDGE_CATEGORIES:
        cov, sug = covered[cid], suggestable[cid]
        if cov > 0:
            status = STATUS_COVERED
        elif sug > 0:
            status = STATUS_GAP
        else:
            status = STATUS_NA
        categories.append({"id": cid, "covered_count": cov,
                           "suggestable_count": sug, "status": status})
    return {"categories": categories, "total_cases": len(cases),
            "total_covered": sum(covered.values()),
            "total_suggestable": sum(suggestable.values())}


@router.get("/projects/{project_id}/insights")
def get_insights(project_id: str, user: User = Depends(require("view")),
                 db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    return build_report(db, user.organisation_id, project_id)


# ---------------------------------------------------------------------------
# D. POST /projects/{id}/insights/generate — 202 + job, same pattern as generate
# ---------------------------------------------------------------------------

def _run_insight(job, org_id: str, user_id: str, project_id: str,
                 categories: list[str], requirement_ids: list[str] | None) -> dict:
    db = SessionLocal()
    try:
        job.message = "Planning edge cases"
        plan, endpoints_by_key = build_plan(db, org_id, project_id, categories,
                                            requirement_ids)

        existing_keys: set[tuple] = set()
        for tc in db.scalars(select(TestCase).where(
                TestCase.project_id == project_id,
                TestCase.organisation_id == org_id,
                TestCase.state != "archived")).all():
            first = tc.steps[0] if tc.steps else None
            existing_keys.add((tc.technique or "",
                               first.method.upper() if first else "",
                               first.path if first else "", tc.title))

        reqs_by_id = {r.id: r for r in db.scalars(select(Requirement).where(
            Requirement.project_id == project_id,
            Requirement.organisation_id == org_id)).all()}

        generated = discarded = duplicates = 0
        by_category = {c: 0 for c in categories}
        total = max(len(plan), 1)
        for idx, case in enumerate(plan):
            job.progress = round(idx / total * 0.95, 3)
            job.message = f"Grounding {case['edge_category']} case {idx + 1}/{len(plan)}"
            # HARD GATE — identical to the main generator, imported not copied (BR-09)
            if grounding_validate(case, endpoints_by_key):
                discarded += 1
                continue
            key = _dup_key(case)
            if key in existing_keys:
                duplicates += 1
                continue
            req = reqs_by_id.get(case["requirement_ids"][0])
            if req is None:
                discarded += 1
                continue
            _persist_case(db, org_id, project_id, req, case, MODEL_NAME,
                          edge_category=case["edge_category"])
            existing_keys.add(key)
            by_category[case["edge_category"]] = by_category.get(case["edge_category"], 0) + 1
            generated += 1
        db.commit()

        job.progress = 0.98
        job.message = f"Generated {generated}, discarded {discarded} (grounding)"
        audit(db, org_id, user_id, "insight.generate", "project", project_id,
              {"categories": list(categories), "created": generated,
               "discarded": discarded, "duplicates": duplicates})
        db.commit()
        # BO-07: discarded is a count only — a discarded case is never shown
        return {"generated": generated, "discarded": discarded, "duplicates": duplicates,
                "categories": list(categories), "by_category": by_category}
    finally:
        db.close()


class InsightGenerateRequest(BaseModel):
    categories: list[str]
    requirement_ids: list[str] | None = None


@router.post("/projects/{project_id}/insights/generate", status_code=202)
def start_insight_generation(project_id: str, body: InsightGenerateRequest,
                             user: User = Depends(require("generate")),
                             db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    categories = list(dict.fromkeys(body.categories or []))  # de-dup, keep order
    if not categories:
        raise HTTPException(422, detail={
            "code": "invalid_category",
            "message": "categories is required and must contain at least one category id"})
    illegal = [c for c in categories if c not in EDGE_CATEGORY_SET]
    if illegal:
        raise HTTPException(422, detail={
            "code": "invalid_category",
            "message": (f"Unknown category id(s): {', '.join(map(str, illegal))}. "
                        f"Legal ids: {', '.join(EDGE_CATEGORIES)}")})

    org_id, user_id = user.organisation_id, user.id
    requirement_ids = list(body.requirement_ids) if body.requirement_ids else None
    job = jobstore.submit(
        "insight",
        lambda job: _run_insight(job, org_id, user_id, project_id, categories, requirement_ids),
        project_id=project_id)
    return {"job_id": job.id}
