"""Generation module — Mapper (TRD §4.3) + deterministic Generator (§4.4) + Grounding
Validator (§4.5, FR-GEN-06, BR-09).

Philosophy: "the model proposes, the system verifies". The LLM is only consulted for the
requirement -> endpoint mapping over a CLOSED candidate list. Test data, boundaries and
assertions are derived deterministically from the endpoint inventory (ISTQB EP / BVA /
negative / decision-table techniques). Before persistence every case passes the grounding
gate: a single fabricated endpoint, parameter, body field or assertion target means the
case is DISCARDED — never repaired, never shown (BO-07).
"""
import copy
import itertools
import json
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..llm import get_provider
from ..models import Endpoint, Requirement, RequirementTestCase, TestCase, TestStep, User

router = APIRouter()

DEPTHS = ("smoke", "standard", "exhaustive")
MIN_MAP_CONFIDENCE = 0.3
MAX_CANDIDATES = 10
MAX_COMBOS = 8          # decision-table cap
MAX_ENUM_SWEEP = 8

# FR-034 localisation probes (Arabic round-trip) + FR-033 injection-shaped strings
ARABIC_SAMPLE = "محمد الشمري"
ARABIC_SAMPLE_LONG = "منصة الطلبات — اختبار"
INJECTION_PAYLOADS = ("' OR 1=1--", "<script>alert(1)</script>")

MAP_INSTRUCTIONS = (
    "You map ONE software requirement onto API endpoints. Pick ONLY from the closed "
    "candidate list below (TRD §4.3) — respond with the integer indices of the matching "
    "candidates plus your confidence between 0 and 1. Never invent endpoints; an empty "
    "selection is a valid answer.\n"
)
MAP_SCHEMA = {
    "type": "object",
    "properties": {
        "selected": {"type": "array", "items": {"type": "integer"}},
        "confidence": {"type": "number"},
    },
    "required": ["selected", "confidence"],
}

_WORD_RE = re.compile(r"[a-zء-ي]{3,}")
_SAFE_HEADERS = {"authorization", "content-type", "accept"}
_CONSTRAINT_KEYS = ("pattern", "enum", "minimum", "maximum", "minLength", "maxLength", "format")


# ---------------------------------------------------------------------------
# Deterministic value derivation ("the model is not trusted to identify boundaries")
# ---------------------------------------------------------------------------

def _lit(ch: str):
    return lambda k, ch=ch: ch


def _class_unit(chars: str):
    return lambda k, chars=chars: chars[k % len(chars)]


def _expand_class(body: str) -> str:
    chars: list[str] = []
    i = 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            if nxt == "d":
                chars.extend("0123456789")
            elif nxt == "w":
                chars.extend("abcdefghijklmnopqrstuvwxyz0123456789")
            else:
                chars.append(nxt)
            i += 2
        elif i + 2 < len(body) and body[i + 1] == "-":
            a, b = ord(c), ord(body[i + 2])
            if a <= b and b - a < 128:
                chars.extend(chr(x) for x in range(a, b + 1))
            i += 3
        else:
            chars.append(c)
            i += 1
    return "".join(chars)


def _pattern_example(pattern: str) -> str:
    """Tiny example generator for the common regex subset: literals, [..] classes,
    \\d/\\w escapes and {n} counts. Anything fancier falls back to "example".
    e.g. ^05[0-9]{8}$ -> "0501234567"."""
    try:
        p = pattern
        if p.startswith("^"):
            p = p[1:]
        if p.endswith("$") and not p.endswith("\\$"):
            p = p[:-1]
        units: list[list] = []  # [generator, count]
        i = 0
        while i < len(p):
            c = p[i]
            if c == "\\":
                if i + 1 >= len(p):
                    return "example"
                esc = p[i + 1]
                if esc == "d":
                    units.append([_class_unit("0123456789"), 1])
                elif esc == "w":
                    units.append([_class_unit("abcdefghijklmnopqrstuvwxyz0123456789"), 1])
                elif esc == "s":
                    units.append([_lit(" "), 1])
                else:
                    units.append([_lit(esc), 1])
                i += 2
            elif c == "[":
                j = p.find("]", i + 1)
                if j == -1:
                    return "example"
                body = p[i + 1:j]
                if body.startswith("^") or not body:
                    return "example"
                chars = _expand_class(body)
                if not chars:
                    return "example"
                units.append([_class_unit(chars), 1])
                i = j + 1
            elif c == "{":
                j = p.find("}", i + 1)
                if j == -1 or not units:
                    return "example"
                count = p[i + 1:j].split(",")[0].strip()
                if not count.isdigit():
                    return "example"
                units[-1][1] = min(int(count), 64)
                i = j + 1
            elif c in "+*?":
                i += 1  # one repetition already satisfies these quantifiers
            elif c in "()|.":
                return "example"  # groups/alternation/wildcards unsupported
            else:
                units.append([_lit(c), 1])
                i += 1
        out = "".join(fn(k) for fn, n in units for k in range(n))
        return out if re.fullmatch(pattern, out) else "example"
    except Exception:
        return "example"


def value_for(schema: dict | None, depth: int = 0):
    """Valid representative value for a JSON-schema fragment / parameter constraints."""
    if not isinstance(schema, dict) or depth > 8:
        return "example"
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[0]
    stype = schema.get("type")
    if not stype:
        if isinstance(schema.get("properties"), dict):
            stype = "object"
        elif schema.get("items") is not None:
            stype = "array"
        else:
            stype = "string"
    if stype in ("integer", "number"):
        mn, mx = schema.get("minimum"), schema.get("maximum")
        if mn is not None and mx is not None:
            val = (mn + mx) / 2
        elif mn is not None:
            val = mn + 1
        elif mx is not None:
            val = mx - 1
        else:
            val = 1
        return int(val) if stype == "integer" else float(val)
    if stype == "boolean":
        return True
    if stype == "array":
        return [value_for(schema.get("items"), depth + 1)]
    if stype == "object":
        props = schema.get("properties") or {}
        required = schema.get("required")
        keys = [k for k in (required if required else list(props)) if k in props]
        return {k: value_for(props[k], depth + 1) for k in keys}
    # string
    fmt = schema.get("format")
    if fmt == "email":
        return "test@example.sa"
    if fmt == "date":
        return "2026-01-15"
    if fmt == "date-time":
        return "2026-01-15T10:30:00Z"
    if fmt == "uuid":
        return "123e4567-e89b-12d3-a456-426614174000"
    if schema.get("pattern"):
        return _pattern_example(str(schema["pattern"]))
    s = "example"
    mn, mx = schema.get("minLength"), schema.get("maxLength")
    if isinstance(mn, int) and len(s) < mn:
        s = (s * (mn // len(s) + 1))[:mn]
    if isinstance(mx, int) and 0 < mx < len(s):
        s = s[:mx]
    return s


def _invalid_for(schema: dict):
    """One invalid-class value per constrained input (EP, FR-GEN-03).
    Returns (value, violated_constraint) or (None, None)."""
    if schema.get("pattern"):
        return "123", "pattern"
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return "invalid_value", "enum"
    if schema.get("minimum") is not None:
        return schema["minimum"] - 1, "minimum"
    if schema.get("maximum") is not None:
        return schema["maximum"] + 1, "maximum"
    if isinstance(schema.get("minLength"), int) and schema["minLength"] > 0:
        return "x" * (schema["minLength"] - 1), "minLength"
    if isinstance(schema.get("maxLength"), int):
        return "x" * (schema["maxLength"] + 1), "maxLength"
    if schema.get("format"):
        return "invalid", "format"
    if schema.get("type") in ("integer", "number"):
        return "not_a_number", "type"
    if schema.get("type") == "boolean":
        return "not_a_boolean", "type"
    return None, None


# ---------------------------------------------------------------------------
# Endpoint introspection helpers
# ---------------------------------------------------------------------------

def _param_schema(p: dict) -> dict:
    sch = {"type": p.get("type") or "string"}
    for k, v in (p.get("constraints") or {}).items():
        if v is not None:
            sch[k] = v
    return sch


def _is_constrained(sch: dict) -> bool:
    if any(sch.get(k) not in (None, [], "") for k in _CONSTRAINT_KEYS):
        return True
    return sch.get("type") in ("integer", "number", "boolean")


def _body_object_schema(ep) -> dict | None:
    rs = _epget(ep, "request_schema")
    if isinstance(rs, dict) and rs.get("type", "object") == "object" and isinstance(rs.get("properties"), dict):
        return rs
    return None


def _constrained_inputs(ep) -> list[dict]:
    inputs = []
    for p in ep.parameters or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        sch = _param_schema(p)
        if _is_constrained(sch):
            inputs.append({"name": p["name"], "where": "param", "schema": sch,
                           "required": bool(p.get("required")), "location": p.get("location", "query")})
    rs = _body_object_schema(ep)
    if rs:
        required = rs.get("required") or []
        for name, sch in rs["properties"].items():
            if isinstance(sch, dict) and _is_constrained(sch):
                inputs.append({"name": name, "where": "body", "schema": sch,
                               "required": name in required, "location": "body"})
    return inputs


def _is_free_text(sch: dict) -> bool:
    """Free-text string: no enum, no pattern, no format (email/date/uuid/… excluded)."""
    if not isinstance(sch, dict):
        return False
    if sch.get("type", "string") != "string":
        return False
    return not (sch.get("enum") or sch.get("pattern") or sch.get("format"))


def _free_text_body_fields(ep) -> list[dict]:
    """Top-level free-text string fields of the request body (FR-034 targets)."""
    rs = _body_object_schema(ep)
    if not rs:
        return []
    required = rs.get("required") or []
    return [{"name": name, "where": "body", "schema": sch,
             "required": name in required, "location": "body"}
            for name, sch in rs["properties"].items()
            if isinstance(sch, dict) and _is_free_text(sch)]


def _required_inputs(ep) -> list[dict]:
    """Required params (non-path — a missing path param would break the URL, not the API
    contract) and required top-level body fields, for the missing-required negatives."""
    out = []
    for p in ep.parameters or []:
        if isinstance(p, dict) and p.get("required") and p.get("location", "query") not in ("path", "header"):
            out.append({"name": p["name"], "where": "param"})
    rs = _body_object_schema(ep)
    if rs:
        for name in rs.get("required") or []:
            if name in rs["properties"]:
                out.append({"name": name, "where": "body"})
    return out


def _valid_request(ep):
    """Deterministic valid params/headers/body for an endpoint."""
    params: dict = {}
    headers: dict = {}
    for p in ep.parameters or []:
        if not isinstance(p, dict) or not p.get("name"):
            continue
        loc = p.get("location", "query")
        val = value_for(_param_schema(p))
        if loc == "header":
            if p.get("required"):
                headers[p["name"]] = str(val)
        elif loc == "path" or p.get("required"):
            params[p["name"]] = val
    body = None
    rs = _epget(ep, "request_schema")
    if isinstance(rs, dict) and rs:
        body = value_for(rs)
    if body is not None:
        headers["Content-Type"] = "application/json"
    if ep.security:
        headers["Authorization"] = "Bearer {{token}}"
    return params, headers, body


def _first_status(ep, lo: int, hi: int) -> int | None:
    codes = sorted(int(k) for k in (_epget(ep, "response_schemas") or {})
                   if str(k).isdigit() and lo <= int(k) <= hi)
    return codes[0] if codes else None


def _positive_assertions(ep) -> list[dict]:
    code = _first_status(ep, 200, 299) or 200
    assertions: list[dict] = [{"type": "status_code", "expected": code}]
    rss = _epget(ep, "response_schemas") or {}
    sch = rss.get(str(code), rss.get(code))
    if isinstance(sch, dict) and sch:
        assertions.append({"type": "json_schema"})
    assertions.append({"type": "response_time_ms", "max": 2000})
    return assertions


def _error_assertion(ep) -> dict:
    code = _first_status(ep, 400, 499)
    if code is not None:
        return {"type": "status_code", "expected": code}
    return {"type": "status_code", "expected": 422, "expected_any": [400, 422]}


# ---------------------------------------------------------------------------
# GROUNDING VALIDATOR — the hard gate (FR-GEN-06, BR-09). Importable by tests/reporting.
# ---------------------------------------------------------------------------

def _epget(ep, name, default=None):
    if isinstance(ep, dict):
        return ep.get(name, default)
    return getattr(ep, name, default)


def _first_json_path_segment(path: str) -> str:
    p = (path or "").lstrip("$").lstrip(".")
    return re.split(r"[.\[]", p, maxsplit=1)[0]


def _validate_body_fields(body: dict, schema: dict, ctx: str, violations: list[str]) -> None:
    props = schema.get("properties") or {}
    for key, val in body.items():
        if key not in props:
            violations.append(f"{ctx}: body field '{key}' does not exist in the request schema")
            continue
        sub = props.get(key)
        if (isinstance(val, dict) and isinstance(sub, dict)
                and sub.get("type", "object") == "object" and isinstance(sub.get("properties"), dict)):
            _validate_body_fields(val, sub, f"{ctx}.{key}", violations)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def grounding_validate(case: dict, endpoints_by_key: dict) -> list[str]:
    """Validate a candidate case dict against the endpoint inventory.

    Returns a list of violation strings — empty means grounded. Any violation means the
    case is discarded: never repaired, never persisted, never shown (BO-07)."""
    violations: list[str] = []
    if not case.get("requirement_ids"):
        violations.append("case is not linked to any requirement")
    steps = case.get("steps") or []
    if not steps:
        violations.append("case has no steps")
    for si, step in enumerate(steps):
        method = str(step.get("method", "")).upper()
        path = step.get("path", "")
        ep = endpoints_by_key.get((method, path))
        if ep is None:
            violations.append(f"step {si}: endpoint {method} {path} does not exist in the inventory")
            continue
        params_def = [p for p in (_epget(ep, "parameters") or []) if isinstance(p, dict)]
        param_names = {str(p.get("name")) for p in params_def}
        header_param_names = {str(p.get("name", "")).lower() for p in params_def
                              if p.get("location") == "header"}
        request = step.get("request") or {}

        for pname in (request.get("params") or {}):
            if pname not in param_names:
                violations.append(f"step {si}: parameter '{pname}' is not defined on {method} {path}")

        for hname in (request.get("headers") or {}):
            hl = str(hname).lower()
            if hl not in _SAFE_HEADERS and not hl.startswith("x-") and hl not in header_param_names:
                violations.append(f"step {si}: header '{hname}' is neither allowlisted nor a defined header parameter")

        body = request.get("body")
        if isinstance(body, dict):
            rs = _body_object_schema(ep)
            if rs is not None:
                _validate_body_fields(body, rs, f"step {si}", violations)

        # first 2xx response schema with properties — target space for json_field assertions
        rss = _epget(ep, "response_schemas") or {}
        resp_schema = None
        for k in sorted(rss, key=str):
            if str(k).isdigit() and 200 <= int(k) < 300:
                cand = rss[k]
                if isinstance(cand, dict) and isinstance(cand.get("properties"), dict):
                    resp_schema = cand
                    break

        for a in step.get("assertions") or []:
            if not isinstance(a, dict):
                violations.append(f"step {si}: assertion is not an object")
                continue
            atype = a.get("type")
            if atype == "status_code":
                if not _is_int(a.get("expected")):
                    violations.append(f"step {si}: status_code assertion 'expected' must be an integer")
                any_of = a.get("expected_any")
                if any_of is not None and (not isinstance(any_of, list)
                                           or not all(_is_int(x) for x in any_of)):
                    violations.append(f"step {si}: status_code 'expected_any' must be a list of integers")
            elif atype == "json_field" and resp_schema is not None:
                seg = _first_json_path_segment(str(a.get("path", "")))
                if seg and seg not in resp_schema["properties"]:
                    violations.append(f"step {si}: json_field target '{seg}' is not a property of the response schema")
    return violations


# ---------------------------------------------------------------------------
# Case builders (deterministic, techniques per ISTQB)
# ---------------------------------------------------------------------------

def _apply_input(inp: dict, value, params: dict, body):
    p2 = dict(params)
    b2 = copy.deepcopy(body)
    if inp["where"] == "param":
        p2[inp["name"]] = value
    else:
        if not isinstance(b2, dict):
            b2 = {}
        b2[inp["name"]] = value
    return p2, b2


def _drop_input(inp: dict, params: dict, body):
    p2 = dict(params)
    b2 = copy.deepcopy(body)
    if inp["where"] == "param":
        p2.pop(inp["name"], None)
    elif isinstance(b2, dict):
        b2.pop(inp["name"], None)
    return p2, b2


def _step(ep, params, headers, body, assertions, raw_body=None) -> dict:
    request: dict = {"headers": headers, "params": params}
    if raw_body is not None:
        request["raw_body"] = raw_body
    elif body is not None:
        request["body"] = body
    return {"order": 0, "endpoint_id": ep.id, "method": ep.method.upper(), "path": ep.path,
            "request": request, "assertions": assertions, "extractions": []}


def _generate_cases(req: Requirement, ep: Endpoint, depth: str) -> list[dict]:
    suffix = f"{ep.method.upper()} {ep.path}"
    req_ref = req.external_id or req.id[:8]
    description = f"Covers requirement {req_ref}: {(req.description or '')[:400]}"
    preconditions = "Authenticated session" if (ep.security or []) else ""
    params, headers, body = _valid_request(ep)
    inputs = _constrained_inputs(ep)
    cases: list[dict] = []

    def mk(title: str, technique: str, ctype: str, step: dict) -> dict:
        return {"title": title[:500], "description": description, "preconditions": preconditions,
                "type": ctype, "priority": req.priority or "medium", "technique": technique,
                "steps": [step], "requirement_ids": [req.id]}

    # -- Positive (all depths): valid EP class with representative values
    cases.append(mk(f"Positive: valid request — {suffix}", "ep", "positive",
                    _step(ep, params, headers, body, _positive_assertions(ep))))

    # -- Localisation (FR-034, all depths): Arabic round-trip through a free-text field
    free_text = _free_text_body_fields(ep)
    if free_text:
        loc_inp = free_text[0]
        sch = loc_inp["schema"]
        arabic = ARABIC_SAMPLE
        mn, mx = sch.get("minLength"), sch.get("maxLength")
        if isinstance(mn, int) and mn > len(arabic):
            arabic = ARABIC_SAMPLE_LONG if mn <= len(ARABIC_SAMPLE_LONG) else None
        if arabic is not None and isinstance(mx, int) and mx < len(arabic):
            arabic = None
        if arabic is not None:
            p2, b2 = _apply_input(loc_inp, arabic, params, body)
            ok_code = _first_status(ep, 200, 299) or 200
            assertions: list[dict] = [{"type": "status_code", "expected": ok_code}]
            rss = _epget(ep, "response_schemas") or {}
            resp_sch = rss.get(str(ok_code), rss.get(ok_code))
            if (isinstance(resp_sch, dict) and isinstance(resp_sch.get("properties"), dict)
                    and loc_inp["name"] in resp_sch["properties"]):
                assertions.append({"type": "json_field", "path": loc_inp["name"],
                                   "op": "eq", "expected": arabic})
            assertions.append({"type": "header", "name": "Content-Type",
                               "op": "contains", "expected": "utf-8"})
            cases.append(mk(f"Localisation: Arabic round-trip in {loc_inp['name']} — {suffix}",
                            "localisation", "positive",
                            _step(ep, p2, headers, b2, assertions)))

    if depth == "smoke":
        return cases

    # -- EP invalid-class: one case per constrained input (FR-GEN-03)
    for inp in inputs:
        bad, constraint = _invalid_for(inp["schema"])
        if constraint is None:
            continue
        p2, b2 = _apply_input(inp, bad, params, body)
        cases.append(mk(f"EP: invalid {inp['name']} ({constraint}) — {suffix}", "ep", "negative",
                        _step(ep, p2, headers, b2, [_error_assertion(ep)])))

    # -- BVA: min / min+1 / max-1 / max — only explicit bounds (FR-GEN-04)
    for inp in inputs:
        sch = inp["schema"]
        if isinstance(sch.get("enum"), list) and sch["enum"]:
            continue
        boundaries: list[tuple[str, object]] = []
        if sch.get("type") in ("integer", "number"):
            mn, mx = sch.get("minimum"), sch.get("maximum")
            if mn is not None:
                boundaries.append(("minimum", mn))
                if mx is None or mn + 1 <= mx:
                    boundaries.append(("minimum+1", mn + 1))
            if mx is not None:
                if mn is None or mx - 1 >= mn:
                    boundaries.append(("maximum-1", mx - 1))
                boundaries.append(("maximum", mx))
        elif not sch.get("pattern"):
            if isinstance(sch.get("minLength"), int):
                boundaries.append(("minLength", "x" * sch["minLength"]))
            if isinstance(sch.get("maxLength"), int):
                boundaries.append(("maxLength", "x" * sch["maxLength"]))
        seen: set = set()
        for label, val in boundaries:
            key = repr(val)
            if key in seen:
                continue
            seen.add(key)
            p2, b2 = _apply_input(inp, val, params, body)
            cases.append(mk(f"BVA: {inp['name']} at {label} boundary — {suffix}", "bva", "boundary",
                            _step(ep, p2, headers, b2, _positive_assertions(ep))))

    # -- Negative suite (FR-GEN-08)
    for missing in _required_inputs(ep):
        p2, b2 = _drop_input(missing, params, body)
        cases.append(mk(f"Negative: missing required {missing['name']} — {suffix}", "negative", "negative",
                        _step(ep, p2, headers, b2, [_error_assertion(ep)])))

    for inp in inputs:
        if inp["schema"].get("type") in ("integer", "number"):
            p2, b2 = _apply_input(inp, "not_a_number", params, body)
            cases.append(mk(f"Negative: wrong type for {inp['name']} — {suffix}", "negative", "negative",
                            _step(ep, p2, headers, b2, [_error_assertion(ep)])))
            break  # one wrong-type probe per endpoint

    if ep.security:
        anon_headers = {k: v for k, v in headers.items() if k.lower() != "authorization"}
        unauth_case = mk(f"Negative: unauthenticated access — {suffix}", "negative", "negative",
                         _step(ep, params, anon_headers, body,
                               [{"type": "status_code", "expected": 401, "expected_any": [401, 403]}]))
        unauth_case["preconditions"] = ""
        cases.append(unauth_case)

    if body is not None:
        cases.append(mk(f"Negative: malformed JSON body — {suffix}", "negative", "negative",
                        _step(ep, params, headers, None, [_error_assertion(ep)],
                              raw_body="{{malformed}}")))

    # -- FR-033: oversized payload — one probe on the first bounded string input
    for inp in inputs:
        sch = inp["schema"]
        if sch.get("type", "string") == "string" and isinstance(sch.get("maxLength"), int):
            p2, b2 = _apply_input(inp, "x" * (sch["maxLength"] + 1000), params, body)
            cases.append(mk(f"Negative: oversized payload in {inp['name']} — {suffix}",
                            "negative", "negative",
                            _step(ep, p2, headers, b2,
                                  [{"type": "status_code", "expected": 400,
                                    "expected_any": [400, 413, 422]}])))
            break

    # -- FR-033: injection-shaped strings — must be handled, never a 5xx
    if free_text:
        inj_inp = free_text[0]
        for payload in INJECTION_PAYLOADS:
            label = "SQL-shaped" if payload.startswith("'") else "script-shaped"
            p2, b2 = _apply_input(inj_inp, payload, params, body)
            cases.append(mk(f"Negative: injection-shaped input ({label}) in {inj_inp['name']} — {suffix}",
                            "negative", "negative",
                            _step(ep, p2, headers, b2,
                                  [{"type": "status_code", "expected": 200,
                                    "expected_any": [200, 201, 400, 422]}])))

    if depth != "exhaustive":
        return cases

    # -- Enum sweeps (FR-GEN-05)
    for inp in inputs:
        enum = inp["schema"].get("enum")
        if isinstance(enum, list) and enum:
            for val in enum[:MAX_ENUM_SWEEP]:
                p2, b2 = _apply_input(inp, val, params, body)
                cases.append(mk(f"EP: enum sweep {inp['name']}={val} — {suffix}", "ep", "positive",
                                _step(ep, p2, headers, b2, _positive_assertions(ep))))

    # -- Decision tables: valid/invalid combinations when ≥2 constrained inputs interact
    if len(inputs) >= 2:
        combos = itertools.islice(itertools.product([True, False], repeat=len(inputs)), MAX_COMBOS)
        for ci, combo in enumerate(combos):
            p2, b2, labels = dict(params), copy.deepcopy(body), []
            for inp, ok in zip(inputs, combo):
                if ok:
                    labels.append(f"{inp['name']}=valid")
                else:
                    bad, _c = _invalid_for(inp["schema"])
                    if bad is None:
                        labels.append(f"{inp['name']}=valid")
                        continue
                    p2, b2 = _apply_input(inp, bad, p2, b2)
                    labels.append(f"{inp['name']}=invalid")
            all_valid = all(combo)
            assertions = _positive_assertions(ep) if all_valid else [_error_assertion(ep)]
            cases.append(mk(f"Decision table {ci + 1}: {', '.join(labels)} — {suffix}",
                            "decision_table", "positive" if all_valid else "negative",
                            _step(ep, p2, headers, b2, assertions)))
    return cases


# ---------------------------------------------------------------------------
# Mapper — lexical prefilter + closed-list LLM pick (TRD §4.3)
# ---------------------------------------------------------------------------

def _tokens(text: str) -> set[str]:
    return set(_WORD_RE.findall((text or "").lower()))


def _prefilter(req_text: str, endpoints: list[Endpoint]) -> list[Endpoint]:
    toks = _tokens(req_text)
    scored = []
    for ep in endpoints:
        blob = " ".join([ep.method or "", ep.path or "", ep.summary or "",
                         ep.operation_id or "", " ".join(str(t) for t in (ep.tags or []))])
        overlap = len(toks & _tokens(blob))
        path_overlap = len(toks & _tokens((ep.path or "").replace("/", " ")))  # path segments count double
        score = overlap + path_overlap
        if score > 0:
            scored.append((score, ep))
    scored.sort(key=lambda t: (-t[0], t[1].path, t[1].method))
    return [ep for _s, ep in scored[:MAX_CANDIDATES]]


# ---------------------------------------------------------------------------
# Job + route
# ---------------------------------------------------------------------------

def _persist_case(db: Session, org_id: str, project_id: str, req: Requirement,
                  case: dict, model_name: str) -> None:
    tc = TestCase(
        organisation_id=org_id, project_id=project_id,
        title=case["title"][:500], description=case["description"],
        preconditions=case["preconditions"], type=case["type"], priority=case["priority"],
        state="draft", generated=True, model=model_name,
        prompt_version=settings.PROMPT_VERSION, technique=case["technique"],
    )
    db.add(tc)
    db.flush()
    for i, s in enumerate(case["steps"]):
        db.add(TestStep(test_case_id=tc.id, order=i, endpoint_id=s.get("endpoint_id"),
                        method=s["method"], path=s["path"], request=s["request"],
                        assertions=s["assertions"], extractions=s.get("extractions") or []))
    db.add(RequirementTestCase(requirement_id=req.id, test_case_id=tc.id,
                               link_source="generated", requirement_version_at_link=req.version))


def _run_generation(job, org_id: str, user_id: str, project_id: str,
                    requirement_ids: list[str] | None, depth: str) -> dict:
    db = SessionLocal()
    try:
        unmappable: list[dict] = []
        base = select(Requirement).where(Requirement.project_id == project_id,
                                         Requirement.organisation_id == org_id)
        if requirement_ids:
            found = db.scalars(base.where(Requirement.id.in_(requirement_ids))).all()
            found_ids = {r.id for r in found}
            for rid in requirement_ids:
                if rid not in found_ids:
                    unmappable.append({"requirement_id": rid, "reason": "requirement not found in project"})
            reqs = []
            for r in found:
                if r.state != "confirmed":
                    unmappable.append({"requirement_id": r.id,
                                       "reason": f"requirement state is '{r.state}', not confirmed"})
                else:
                    reqs.append(r)
        else:
            reqs = db.scalars(base.where(Requirement.state == "confirmed")).all()

        endpoints = db.scalars(select(Endpoint).where(
            Endpoint.project_id == project_id,
            Endpoint.organisation_id == org_id,
            Endpoint.excluded == False)).all()  # noqa: E712
        endpoints_by_key = {(e.method.upper(), e.path): e for e in endpoints}

        # duplicate index over already-approved cases (FR-GEN-11)
        dup_keys: set[tuple] = set()
        approved = db.scalars(select(TestCase).where(
            TestCase.project_id == project_id,
            TestCase.organisation_id == org_id,
            TestCase.state == "approved")).all()
        for c in approved:
            first = c.steps[0] if c.steps else None
            dup_keys.add((c.technique, first.method.upper() if first else "",
                          first.path if first else "", c.title))

        provider = get_provider()
        generated = discarded = duplicates = 0
        total = max(len(reqs), 1)

        for idx, req in enumerate(reqs):
            job.progress = round(idx / total * 0.95, 3)
            job.message = f"Mapping requirement {req.external_id or req.id[:8]}"
            if not endpoints:
                unmappable.append({"requirement_id": req.id, "reason": "endpoint inventory is empty"})
                continue
            req_text = " ".join([req.description or ""] + [str(a) for a in (req.acceptance_criteria or [])]).strip()
            candidates = _prefilter(req_text, endpoints)
            if not candidates:
                unmappable.append({"requirement_id": req.id,
                                   "reason": "no candidate endpoints matched the requirement text"})
                continue
            payload = {"requirement": req_text,
                       "candidates": [{"method": e.method, "path": e.path, "summary": e.summary,
                                       "operation_id": e.operation_id, "tags": e.tags or []}
                                      for e in candidates]}
            try:
                result = provider.complete_json(
                    "map_requirement",
                    MAP_INSTRUCTIONS + "PAYLOAD:\n" + json.dumps(payload, ensure_ascii=False),
                    MAP_SCHEMA)
            except Exception as exc:  # noqa: BLE001 — one bad mapping must not sink the job
                unmappable.append({"requirement_id": req.id, "reason": f"mapping failed: {exc}"})
                continue
            selected = [i for i in (result.data.get("selected") or [])
                        if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < len(candidates)]
            confidence = float(result.data.get("confidence") or 0.0)
            if not selected:
                unmappable.append({"requirement_id": req.id, "reason": "mapper selected no endpoint"})
                continue
            if confidence < MIN_MAP_CONFIDENCE:
                unmappable.append({"requirement_id": req.id,
                                   "reason": f"mapping confidence {confidence:.2f} below {MIN_MAP_CONFIDENCE}"})
                continue
            model_name = getattr(result, "model", "") or "deterministic"

            for ci in dict.fromkeys(selected):  # de-dup, keep order
                ep = candidates[ci]
                job.message = f"Generating cases for {ep.method.upper()} {ep.path}"
                for case in _generate_cases(req, ep, depth):
                    # HARD GATE — the model proposes, the system verifies (BR-09)
                    if grounding_validate(case, endpoints_by_key):
                        discarded += 1
                        continue
                    first = case["steps"][0]
                    if (case["technique"], first["method"], first["path"], case["title"]) in dup_keys:
                        duplicates += 1
                        continue
                    _persist_case(db, org_id, project_id, req, case, model_name)
                    generated += 1
            db.commit()

        job.progress = 0.98
        job.message = f"Generated {generated}, discarded {discarded} (grounding), {len(unmappable)} unmappable"
        audit(db, org_id, user_id, "generation.completed", "project", project_id,
              {"generated": generated, "discarded": discarded, "duplicates": duplicates,
               "unmappable": len(unmappable), "depth": depth})
        db.commit()
        # BO-07: discarded is reported as a count only — the cases themselves are never shown
        return {"generated": generated, "discarded": discarded,
                "unmappable": unmappable, "duplicates": duplicates}
    finally:
        db.close()


def try_autopilot_generation(db: Session, org_id: str, actor_id: str,
                             project_id: str) -> str | None:
    """Autopilot generation trigger (contract 4b) — callers have already checked
    project.automation == "auto".

    Enqueues a standard-depth generation job over ALL confirmed requirements when
    the project has >= 1 included endpoint, >= 1 confirmed requirement, and no
    generation job for this project is currently queued/running. Returns the job
    id, or None when a precondition fails. Runs the exact same job body as the
    manual POST /projects/{id}/generate route. Approval stays manual (BO-07)."""
    has_endpoint = db.query(Endpoint.id).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == org_id,
        Endpoint.excluded == False).first()  # noqa: E712
    if has_endpoint is None:
        return None
    has_confirmed = db.query(Requirement.id).filter(
        Requirement.project_id == project_id,
        Requirement.organisation_id == org_id,
        Requirement.state == "confirmed").first()
    if has_confirmed is None:
        return None
    if jobstore.has_active("generate", project_id):
        return None  # double-trigger guard

    audit(db, org_id, actor_id, "auto.generate", "project", project_id,
          {"depth": "standard"})
    db.commit()
    job = jobstore.submit(
        "generate",
        lambda job: _run_generation(job, org_id, actor_id, project_id, None, "standard"),
        project_id=project_id)
    return job.id


class GenerateRequest(BaseModel):
    requirement_ids: list[str] | None = None
    depth: str = "standard"


@router.post("/projects/{project_id}/generate", status_code=202)
def start_generation(project_id: str, body: GenerateRequest,
                     user: User = Depends(require("generate")),
                     db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    if body.depth not in DEPTHS:
        raise HTTPException(422, detail={"code": "invalid_depth",
                                         "message": f"depth must be one of {', '.join(DEPTHS)}"})
    org_id, user_id = user.organisation_id, user.id
    requirement_ids = list(body.requirement_ids) if body.requirement_ids else None
    depth = body.depth
    job = jobstore.submit(
        "generate",
        lambda job: _run_generation(job, org_id, user_id, project_id, requirement_ids, depth),
        project_id=project_id)
    return {"job_id": job.id}
