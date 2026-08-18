"""Security generation — phase S0 of docs/SECURITY_TESTING_PLAN.md.

Security is not a separate engine. It is a technique family inside generation
(`technique = "security"`) plus one new inventory: the **weakness catalogue**, a
shipped, versioned data file (`app/data/weaknesses.json`) that is reviewable in a
pull request rather than buried in a table literal.

Three properties hold, and everything in this module exists to keep them:

1. **Deterministic.** No LLM is consulted anywhere here. Every case is a pure
   function of (requirement, endpoint record, catalogue entry), so the coverage
   matrix of §11 is reproducible and a re-run produces byte-identical titles.
2. **Grounded.** Every case passes `generation.grounding_validate` before
   persistence — the same gate, imported, never re-implemented and never
   weakened. A security case that references an endpoint, parameter, body field
   or response property the inventory does not contain is DISCARDED (BO-07).
3. **Traceable.** Every case carries at least one requirement id, from the SAME
   deterministic requirement->endpoint association the Insight engine uses
   (existing traceability links unioned with `generation._prefilter`). An
   endpoint no requirement maps to produces NO security cases; that is the rule
   working, not a bug, and the coverage report says so with its own reason.

`applicable(endpoint, weakness)` is pure and ALWAYS returns a reason when it
answers False. That reason is what turns a skipped pair from an invisible hole
into an auditable line in the report.

S0 GENERATES the classes marked `activity: "active"` (they are part of the
corpus and belong in the matrix) but never runs them: the executor gate is S1's
`security_testing_authorised` flag, and until it exists nothing marked active
may be executed.
"""
import copy
import json
from functools import lru_cache
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..models import (Endpoint, Requirement, RequirementTestCase, TestCase,
                      TestStep, User)
from . import generation
from .insight import _endpoint_requirements

router = APIRouter()

CATALOGUE_PATH = Path(__file__).resolve().parents[1] / "data" / "weaknesses.json"

SEVERITIES = ("critical", "high", "medium", "low")
ACTIVITIES = ("passive", "active")

# Response/body fragments that mean the server handed the caller an oracle: a
# stack trace, a framework version, a database error or an internal path. The
# executor's `body_not_matches` assertion (S1) fails a case that echoes any of
# them; today the assertion type is unknown to the engine and skipped, which is
# why the list ships with the case rather than with the runner.
ERROR_SIGNATURES = [
    "Traceback (most recent call last)",
    "java.lang.",
    "org.springframework",
    "System.Web",
    "psycopg2",
    "SQLSTATE",
    "SQL syntax",
    "ORA-0",
    "node_modules",
    "/usr/local/lib/python",
]

# One probe string, not a copied exploit list: metacharacters that must be
# handled as data. Truncated to the field's own maxLength so the case tests
# escaping rather than length validation.
INJECTION_PROBE = "' OR 1=1;-- <img src=x>"

# Properties a client must not be able to set on itself. The list is closed and
# deterministic on purpose: mass assignment is only testable against a field the
# request schema ALREADY declares — inventing a body field would be discarded by
# the grounding gate, and rightly so.
PRIVILEGED_FIELDS = (
    "id", "role", "roles", "admin", "is_admin", "isadmin", "superuser",
    "is_superuser", "owner", "owner_id", "ownerid", "user_id", "userid",
    "organisation_id", "organization_id", "org_id", "tenant_id",
    "permissions", "scope", "scopes", "verified", "is_verified",
    "email_verified", "balance", "credit", "credits", "password_hash",
    "created_at", "updated_at", "deleted_at",
)

# Placeholders the environment supplies at run time (same {{var}} interpolation
# the execution engine already performs). They are NOT invented values: an
# environment that cannot supply them simply fails the case loudly instead of
# the case quietly testing nothing.
FOREIGN_OBJECT_ID = "{{foreign_object_id}}"
LOW_PRIVILEGE_TOKEN = "Bearer {{low_privilege_token}}"
EXPIRED_TOKEN = "Bearer {{expired_token}}"
UNSIGNED_TOKEN = "Bearer {{unsigned_token}}"

RATE_LIMIT_REQUESTS = 20  # bounded: a QA tool must not be the outage (§7)


# ---------------------------------------------------------------------------
# The catalogue — a shipped data file, validated on load
# ---------------------------------------------------------------------------

def validate_entry(entry, index: int = 0) -> list[str]:
    """Schema check for ONE catalogue entry. Returns problems; empty means valid."""
    p: list[str] = []
    where = f"weaknesses[{index}]"
    if not isinstance(entry, dict):
        return [f"{where}: entry is not an object"]
    wid = entry.get("id")
    if not isinstance(wid, str) or not wid:
        p.append(f"{where}: 'id' must be a non-empty string")
    where = f"weakness '{wid}'"
    if not isinstance(entry.get("title"), str) or not entry.get("title"):
        p.append(f"{where}: 'title' must be a non-empty string")
    refs = entry.get("refs")
    if not isinstance(refs, dict):
        p.append(f"{where}: 'refs' must be an object")
    else:
        if refs.get("owasp_api") is not None and not isinstance(refs["owasp_api"], str):
            p.append(f"{where}: refs.owasp_api must be a string or null")
        for key in ("cwe", "asvs"):
            val = refs.get(key)
            if not isinstance(val, list) or not val or not all(isinstance(x, str) and x for x in val):
                p.append(f"{where}: refs.{key} must be a non-empty list of strings")
    if entry.get("severity") not in SEVERITIES:
        p.append(f"{where}: 'severity' must be one of {', '.join(SEVERITIES)}")
    if entry.get("activity") not in ACTIVITIES:
        p.append(f"{where}: 'activity' must be one of {', '.join(ACTIVITIES)}")
    pre = entry.get("precondition")
    if not isinstance(pre, dict) or not pre:
        p.append(f"{where}: 'precondition' must be a non-empty object")
    else:
        for key, val in pre.items():
            if key not in PRECONDITIONS:
                p.append(f"{where}: unknown precondition '{key}' "
                         f"(vocabulary: {', '.join(sorted(PRECONDITIONS))})")
            if not isinstance(val, bool):
                p.append(f"{where}: precondition '{key}' must be a boolean")
    checks = entry.get("checks")
    if not isinstance(checks, list) or not checks or not all(isinstance(c, str) and c for c in checks):
        p.append(f"{where}: 'checks' must be a non-empty list of strings")
    return p


def validate_catalogue(doc) -> list[str]:
    """Schema check for the whole document. Returns problems; empty means valid."""
    p: list[str] = []
    if not isinstance(doc, dict):
        return ["catalogue root is not an object"]
    if not isinstance(doc.get("version"), str) or not doc.get("version"):
        p.append("'version' must be a non-empty string")
    entries = doc.get("weaknesses")
    if not isinstance(entries, list) or not entries:
        return p + ["'weaknesses' must be a non-empty list"]
    seen: set = set()
    for i, entry in enumerate(entries):
        p.extend(validate_entry(entry, i))
        if isinstance(entry, dict):
            wid = entry.get("id")
            if wid in seen:
                p.append(f"weaknesses[{i}]: duplicate id '{wid}'")
            seen.add(wid)
    return p


@lru_cache(maxsize=1)
def load_catalogue() -> dict:
    """The shipped catalogue, parsed and validated once.

    A malformed catalogue is a build defect, not a runtime condition: it would
    silently shrink the corpus every report claims to cover, so it raises."""
    doc = json.loads(CATALOGUE_PATH.read_text(encoding="utf-8"))
    problems = validate_catalogue(doc)
    if problems:
        raise RuntimeError("invalid weakness catalogue "
                           f"{CATALOGUE_PATH}:\n  - " + "\n  - ".join(problems))
    return doc


def catalogue_version() -> str:
    return load_catalogue()["version"]


def weaknesses() -> list[dict]:
    """Catalogue entries in file order — the order every report iterates in."""
    return load_catalogue()["weaknesses"]


def weakness_by_id(weakness_id: str) -> dict | None:
    for w in weaknesses():
        if w["id"] == weakness_id:
            return w
    return None


# ---------------------------------------------------------------------------
# Endpoint introspection — the closed precondition vocabulary
#
# Every precondition is a named predicate over the endpoint RECORD plus the
# reason printed when it does not hold. Nothing else may appear in the data
# file: a catalogue entry that names a term this table does not define fails
# validation at load, so the corpus can never quietly stop being evaluated.
# ---------------------------------------------------------------------------

def _path_params(ep) -> list[dict]:
    return [p for p in (generation._epget(ep, "parameters") or [])
            if isinstance(p, dict) and p.get("name") and p.get("location") == "path"]


def _string_targets(ep) -> list[dict]:
    """Free-text string inputs: body fields first (richer), then string params."""
    targets = list(generation._free_text_body_fields(ep))
    for p in (generation._epget(ep, "parameters") or []):
        if not isinstance(p, dict) or not p.get("name"):
            continue
        if p.get("location") == "header":
            continue
        sch = generation._param_schema(p)
        if generation._is_free_text(sch):
            targets.append({"name": p["name"], "where": "param", "schema": sch,
                            "required": bool(p.get("required")),
                            "location": p.get("location", "query")})
    return targets


def _violable_inputs(ep) -> list[dict]:
    """Constrained inputs for which a concrete invalid value can be derived."""
    out = []
    for inp in generation._constrained_inputs(ep):
        bad, constraint = generation._invalid_for(inp["schema"])
        if constraint is not None:
            out.append({**inp, "invalid_value": bad, "constraint": constraint})
    return out


def _privileged_fields(ep) -> list[dict]:
    """Declared body properties whose name marks them as server-owned."""
    rs = generation._body_object_schema(ep)
    if not rs:
        return []
    required = rs.get("required") or []
    return [{"name": name, "where": "body", "schema": sch, "required": name in required,
             "location": "body"}
            for name, sch in rs["properties"].items()
            if isinstance(sch, dict) and str(name).lower() in PRIVILEGED_FIELDS]


PRECONDITIONS: dict[str, tuple] = {
    "always": (
        lambda ep: True,
        "the class applies to every endpoint",
    ),
    "declares_security": (
        lambda ep: bool(generation._epget(ep, "security")),
        "endpoint declares no security scheme, so there is no authentication to subvert",
    ),
    "path_has_parameter": (
        lambda ep: bool(_path_params(ep)),
        "path takes no identifier parameter, so there is no object to address as another actor",
    ),
    "request_has_body": (
        lambda ep: generation._body_object_schema(ep) is not None,
        "endpoint declares no object request body",
    ),
    "has_string_field": (
        lambda ep: bool(_string_targets(ep)),
        "endpoint declares no free-text string field to carry a payload",
    ),
    "has_constrained_input": (
        lambda ep: bool(_violable_inputs(ep)),
        "endpoint declares no constrained input, so there is no stated rule to violate",
    ),
    "request_has_privileged_field": (
        lambda ep: bool(_privileged_fields(ep)),
        "request schema declares no server-owned property (id/role/owner/permissions/...), "
        "and a field the schema does not declare cannot be tested without fabricating it",
    ),
}


def applicable(endpoint, weakness: dict) -> tuple[bool, str]:
    """Does this weakness class apply to this endpoint?

    Pure. Returns (True, "") or (False, reason) — the reason is REQUIRED when the
    answer is False, because a skipped pair with no reason is indistinguishable
    from a pair nobody thought about."""
    precondition = weakness.get("precondition") or {}
    if not precondition:
        return False, f"weakness '{weakness.get('id')}' declares no precondition"
    for term, expected in precondition.items():
        entry = PRECONDITIONS.get(term)
        if entry is None:
            return False, f"unknown precondition term '{term}' in weakness '{weakness.get('id')}'"
        predicate, reason = entry
        holds = bool(predicate(endpoint))
        if holds is not bool(expected):
            if expected:
                return False, reason
            return False, f"precondition '{term}' holds but the class requires it not to"
    return True, ""


# ---------------------------------------------------------------------------
# Case builders — pure, deterministic, one code path per weakness class
# ---------------------------------------------------------------------------

def _severity_priority(weakness: dict) -> str:
    """Priority comes from the class's base severity, not from the requirement:
    a critical weakness on a low-priority requirement is still critical."""
    return weakness["severity"]


def _no_5xx() -> dict:
    return {"type": "no_5xx"}


def _no_leak() -> dict:
    return {"type": "body_not_matches", "patterns": list(ERROR_SIGNATURES)}


def _fit(value: str, schema: dict) -> str:
    mx = schema.get("maxLength")
    return value[:mx] if isinstance(mx, int) and 0 < mx < len(value) else value


def _privileged_value(schema: dict):
    """A value that means 'the client is claiming something it must not claim',
    derived from the field's own declared type so the case stays grounded."""
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[-1]
    stype = schema.get("type", "string")
    if stype == "boolean":
        return True
    if stype in ("integer", "number"):
        return 999999 if stype == "integer" else 999999.0
    if stype == "array":
        return ["admin"]
    if stype == "object":
        return {}
    return _fit("admin", schema)


def _mk(req: Requirement, ep, weakness: dict, title: str, ctype: str,
        step: dict, preconditions: str) -> dict:
    """The case dict, in exactly the shape generation._generate_cases returns
    (plus weakness_id) so review, approval and the matrix treat it identically."""
    suffix = f"{ep.method.upper()} {ep.path}"
    refs = weakness.get("refs") or {}
    ref_bits = [r for r in [refs.get("owasp_api")] if r] + list(refs.get("cwe") or [])
    req_ref = req.external_id or req.id[:8]
    description = (
        f"Covers requirement {req_ref}: {(req.description or '')[:300]} — "
        f"verifies weakness class '{weakness['id']}' ({weakness['title']}"
        + (f", {', '.join(ref_bits)}" if ref_bits else "")
        + f") on {suffix}."
    )
    return {
        "title": title[:500],
        "description": description,
        "preconditions": preconditions,
        "type": ctype,
        "priority": _severity_priority(weakness),
        "technique": "security",
        "steps": [step],
        "requirement_ids": [req.id],
        "weakness_id": weakness["id"],
    }


def build_cases(requirement: Requirement, endpoint, weakness: dict) -> list[dict]:
    """Every case this weakness class can ground on this endpoint.

    Pure and deterministic: same inputs -> identical titles, steps and order.
    Returns [] when the class does not apply (`applicable` is the authority) —
    callers report the reason, they never guess one."""
    ok, _reason = applicable(endpoint, weakness)
    if not ok:
        return []
    builder = _BUILDERS.get(weakness["id"])
    if builder is None:
        return []
    ep = endpoint
    params, headers, body = generation._valid_request(ep)
    return builder(requirement, ep, weakness, params, headers, body)


def _suffix(ep) -> str:
    return f"{ep.method.upper()} {ep.path}"


def _build_missing_authn(req, ep, w, params, headers, body):
    anon = {k: v for k, v in headers.items() if k.lower() != "authorization"}
    step = generation._step(ep, params, anon, body, [
        {"type": "status_code", "expected": 401, "expected_any": [401, 403]},
        _no_5xx(), _no_leak(),
    ])
    return [_mk(req, ep, w, f"Security: unauthenticated request is refused — {_suffix(ep)}",
                "negative", step,
                "No credentials are presented; the endpoint declares a security scheme.")]


def _build_bola(req, ep, w, params, headers, body):
    pname = _path_params(ep)[0]["name"]
    p2 = dict(params)
    p2[pname] = FOREIGN_OBJECT_ID
    step = generation._step(ep, p2, headers, body, [
        {"type": "status_code", "expected": 403, "expected_any": [401, 403, 404]},
        _no_5xx(),
    ])
    return [_mk(req, ep, w,
                f"Security: object-level authorisation on '{pname}' — {_suffix(ep)}",
                "negative", step,
                f"Authenticated as actor A; {FOREIGN_OBJECT_ID} identifies an object "
                "owned by actor B.")]


def _build_function_level_authz(req, ep, w, params, headers, body):
    lower = dict(headers)
    lower["Authorization"] = LOW_PRIVILEGE_TOKEN
    step = generation._step(ep, params, lower, body, [
        {"type": "status_code", "expected": 403, "expected_any": [401, 403]},
        _no_5xx(),
    ])
    return [_mk(req, ep, w,
                f"Security: function-level authorisation for a lower-privileged role — {_suffix(ep)}",
                "negative", step,
                f"{LOW_PRIVILEGE_TOKEN} authenticates a role without the capability "
                "this operation requires.")]


def _build_mass_assignment(req, ep, w, params, headers, body):
    field = _privileged_fields(ep)[0]
    value = _privileged_value(field["schema"])
    p2, b2 = generation._apply_input(field, value, params, body)
    assertions: list[dict] = [
        {"type": "status_code", "expected": 200,
         "expected_any": [200, 201, 202, 204, 400, 403, 422]},
        _no_5xx(),
    ]
    # Only assert on the echoed property when the response schema declares it —
    # a json_field target outside the schema is a grounding violation.
    rss = generation._epget(ep, "response_schemas") or {}
    code = generation._first_status(ep, 200, 299)
    resp = rss.get(str(code), rss.get(code)) if code is not None else None
    if (isinstance(resp, dict) and isinstance(resp.get("properties"), dict)
            and field["name"] in resp["properties"]):
        assertions.insert(1, {"type": "json_field", "path": field["name"],
                              "op": "ne", "expected": value})
    step = generation._step(ep, p2, headers, b2, assertions)
    return [_mk(req, ep, w,
                f"Security: mass assignment of privileged field '{field['name']}' — {_suffix(ep)}",
                "negative", step,
                "The client sets a property the server owns; the value must not take effect.")]


def _build_injection_surface(req, ep, w, params, headers, body):
    target = _string_targets(ep)[0]
    payload = _fit(INJECTION_PROBE, target["schema"])
    p2, b2 = generation._apply_input(target, payload, params, body)
    step = generation._step(ep, p2, headers, b2, [
        _no_5xx(), _no_leak(),
        {"type": "status_code", "expected": 400,
         "expected_any": [200, 201, 202, 204, 400, 404, 409, 422]},
    ])
    return [_mk(req, ep, w,
                f"Security: injection metacharacters in '{target['name']}' are handled as data "
                f"— {_suffix(ep)}",
                "negative", step,
                "The field receives metacharacters only; no exploit is executed.")]


def _build_input_validation(req, ep, w, params, headers, body):
    inp = _violable_inputs(ep)[0]
    p2, b2 = generation._apply_input(inp, inp["invalid_value"], params, body)
    step = generation._step(ep, p2, headers, b2, [
        generation._error_assertion(ep), _no_5xx(),
    ])
    return [_mk(req, ep, w,
                f"Security: constraint violation on '{inp['name']}' ({inp['constraint']}) "
                f"is refused without a 5xx — {_suffix(ep)}",
                "negative", step,
                "The request violates one declared constraint and nothing else.")]


def _build_error_leakage(req, ep, w, params, headers, body):
    # Prefer a body the server must fail to parse; fall back to a hostile value in
    # the first declared input; otherwise observe the endpoint's normal response.
    if body is not None:
        step = generation._step(ep, params, headers, None,
                                [_no_5xx(), _no_leak()], raw_body="{{malformed}}")
        precondition = "The request body is deliberately unparseable."
    else:
        targets = _string_targets(ep) or _violable_inputs(ep)
        if targets:
            inp = targets[0]
            value = inp.get("invalid_value", "%00")
            p2, b2 = generation._apply_input(inp, value, params, body)
            step = generation._step(ep, p2, headers, b2, [_no_5xx(), _no_leak()])
            precondition = f"'{inp['name']}' carries a value the endpoint must reject."
        else:
            step = generation._step(ep, params, headers, body, [_no_5xx(), _no_leak()])
            precondition = "A valid request; the response itself must not describe the stack."
    return [_mk(req, ep, w,
                f"Security: error response leaks no stack trace or framework detail — {_suffix(ep)}",
                "negative", step, precondition)]


def _build_security_headers(req, ep, w, params, headers, body):
    step = generation._step(ep, params, headers, body, [
        {"type": "header_present", "name": "Strict-Transport-Security"},
        {"type": "header", "name": "X-Content-Type-Options", "op": "eq", "expected": "nosniff"},
        {"type": "header_absent", "name": "X-Powered-By"},
        {"type": "header_absent", "name": "X-AspNet-Version"},
        _no_5xx(),
    ])
    return [_mk(req, ep, w,
                f"Security: response carries the security headers and no version banner "
                f"— {_suffix(ep)}",
                "positive", step,
                "A valid request over TLS; only the response headers are under test.")]


def _build_token_handling(req, ep, w, params, headers, body):
    cases = []
    for label, token, title in (
        ("expired", EXPIRED_TOKEN, "an expired bearer token is rejected"),
        ("unsigned", UNSIGNED_TOKEN, "a token with a stripped signature is rejected"),
    ):
        h2 = dict(headers)
        h2["Authorization"] = token
        step = generation._step(ep, params, h2, body, [
            {"type": "status_code", "expected": 401, "expected_any": [401, 403]},
            _no_5xx(), _no_leak(),
        ])
        cases.append(_mk(req, ep, w, f"Security: {title} — {_suffix(ep)}", "negative", step,
                         f"{token} is a well-formed but {label} credential."))
    return cases


def _build_rate_limiting(req, ep, w, params, headers, body):
    step = generation._step(ep, params, headers, body, [
        {"type": "rate_limited_within", "requests": RATE_LIMIT_REQUESTS,
         "expected_status": 429},
        _no_5xx(),
    ])
    return [_mk(req, ep, w,
                f"Security: repeated requests are rate limited — {_suffix(ep)}",
                "negative", step,
                f"Bounded probe: at most {RATE_LIMIT_REQUESTS} requests, then back off. "
                "ACTIVE class — never executed without explicit authorisation (S1).")]


_BUILDERS = {
    "missing-authn": _build_missing_authn,
    "broken-object-level-authz": _build_bola,
    "broken-function-level-authz": _build_function_level_authz,
    "mass-assignment": _build_mass_assignment,
    "injection-surface": _build_injection_surface,
    "input-validation": _build_input_validation,
    "error-leakage": _build_error_leakage,
    "security-headers": _build_security_headers,
    "token-handling": _build_token_handling,
    "rate-limiting": _build_rate_limiting,
}


# ---------------------------------------------------------------------------
# The plan — ONE code path shared by the generate job and the coverage matrix
# ---------------------------------------------------------------------------

NO_REQUIREMENT_REASON = (
    "endpoint is not mapped to any confirmed requirement, and a case with no "
    "requirement cannot be traced or grounded (BO-07)"
)
EXISTING_CASE_REASON = "an identical security case for this endpoint and weakness already exists"


def _project_endpoints(db: Session, org_id: str, project_id: str) -> list[Endpoint]:
    endpoints = db.scalars(select(Endpoint).where(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == org_id,
        Endpoint.excluded == False)).all()  # noqa: E712
    return sorted(endpoints, key=lambda e: (e.path, e.method.upper()))


def _existing_rows(db: Session, org_id: str, project_id: str) -> list[tuple]:
    rows = (db.query(TestStep.endpoint_id, TestCase.weakness_id, TestCase.title)
            .join(TestCase, TestCase.id == TestStep.test_case_id)
            .filter(TestCase.project_id == project_id,
                    TestCase.organisation_id == org_id,
                    TestCase.state != "archived",
                    TestCase.weakness_id.isnot(None))
            .all())
    return [r for r in rows if r[0]]


def _existing_pairs(db: Session, org_id: str, project_id: str) -> set[tuple[str, str]]:
    """(endpoint_id, weakness_id) already covered by a non-archived security case.

    Pair granularity: the §11 matrix asks "is this pair covered", not "how many
    cases cover it" — a class that legitimately emits several cases (token
    handling emits an expired and an unsigned token) covers its pair once."""
    return {(eid, wid) for eid, wid, _t in _existing_rows(db, org_id, project_id)}


def _existing_case_keys(db: Session, org_id: str, project_id: str) -> set[tuple[str, str, str]]:
    """(endpoint_id, weakness_id, title) — the DUPLICATE key, deliberately finer
    than the coverage pair so re-running is idempotent without silently dropping
    the second and subsequent cases a class emits for the same pair."""
    return set(_existing_rows(db, org_id, project_id))


def build_plan(db: Session, org_id: str, project_id: str,
               weakness_ids: list[str] | None = None,
               requirement_ids: list[str] | None = None) -> tuple[list[dict], dict, list[dict]]:
    """Deterministically build every security case the corpus can ground.

    Returns (cases, endpoints_by_key, skipped). NOTHING is written, so the plan
    can be inspected — by a test, by a dry run — without side effects. The
    coverage matrix answers a narrower question (is this pair covered?) and only
    needs `applicable`, which is why it does not build the cases it counts."""
    wanted = [w for w in weaknesses()
              if not weakness_ids or w["id"] in set(weakness_ids)]
    endpoints = _project_endpoints(db, org_id, project_id)
    endpoints_by_key = {(e.method.upper(), e.path): e for e in endpoints}
    cases: list[dict] = []
    skipped: list[dict] = []
    if not endpoints or not wanted:
        return cases, endpoints_by_key, skipped

    ep_reqs = _endpoint_requirements(db, org_id, project_id, endpoints, requirement_ids)

    for ep in endpoints:
        reqs = ep_reqs.get(ep.id) or []
        for w in wanted:
            ok, reason = applicable(ep, w)
            if not ok:
                skipped.append({"endpoint_id": ep.id, "method": ep.method.upper(),
                                "path": ep.path, "weakness_id": w["id"],
                                "reason": reason, "applicable": False})
                continue
            if not reqs:
                # BO-07, not a bug: no requirement, no case — reported as its own reason.
                skipped.append({"endpoint_id": ep.id, "method": ep.method.upper(),
                                "path": ep.path, "weakness_id": w["id"],
                                "reason": NO_REQUIREMENT_REASON, "applicable": True})
                continue
            built = build_cases(reqs[0], ep, w)
            if not built:
                skipped.append({"endpoint_id": ep.id, "method": ep.method.upper(),
                                "path": ep.path, "weakness_id": w["id"],
                                "reason": f"no builder produced a case for '{w['id']}'",
                                "applicable": True})
                continue
            cases.extend(built)
    return cases, endpoints_by_key, skipped


# ---------------------------------------------------------------------------
# Persistence + job
# ---------------------------------------------------------------------------

def _persist_case(db: Session, org_id: str, project_id: str, req: Requirement,
                  case: dict) -> None:
    """Persist ONE grounded security case as a draft plus its requirement link.

    Mirrors generation._persist_case; the only difference is weakness_id, which
    that function has no reason to know about."""
    tc = TestCase(
        organisation_id=org_id, project_id=project_id,
        title=case["title"][:500], description=case["description"],
        preconditions=case["preconditions"], type=case["type"], priority=case["priority"],
        state="draft", generated=True, model="deterministic-security",
        prompt_version=settings.PROMPT_VERSION, technique=case["technique"],
        weakness_id=case["weakness_id"],
    )
    db.add(tc)
    db.flush()
    for i, s in enumerate(case["steps"]):
        db.add(TestStep(test_case_id=tc.id, order=i, endpoint_id=s.get("endpoint_id"),
                        method=s["method"], path=s["path"], request=s["request"],
                        assertions=s["assertions"], extractions=s.get("extractions") or []))
    db.add(RequirementTestCase(requirement_id=req.id, test_case_id=tc.id,
                               link_source="generated",
                               requirement_version_at_link=req.version))


def _run_security_generation(job, org_id: str, user_id: str, project_id: str,
                             weakness_ids: list[str] | None,
                             requirement_ids: list[str] | None) -> dict:
    db = SessionLocal()
    try:
        job.message = "Building the security plan"
        cases, endpoints_by_key, skipped = build_plan(
            db, org_id, project_id, weakness_ids, requirement_ids)
        existing = _existing_case_keys(db, org_id, project_id)
        reqs_by_id = {r.id: r for r in db.scalars(select(Requirement).where(
            Requirement.project_id == project_id,
            Requirement.organisation_id == org_id)).all()}

        generated = discarded = 0
        total = max(len(cases), 1)
        for idx, case in enumerate(cases):
            job.progress = round(idx / total * 0.95, 3)
            wid = case["weakness_id"]
            step = case["steps"][0]
            endpoint_id = step.get("endpoint_id")
            job.message = f"Grounding {wid} on {step['method']} {step['path']}"
            key = (endpoint_id, wid, case["title"][:500])
            if key in existing:
                skipped.append({"endpoint_id": endpoint_id, "method": step["method"],
                                "path": step["path"], "weakness_id": wid,
                                "reason": EXISTING_CASE_REASON, "applicable": True})
                continue
            # HARD GATE — the same validator functional generation uses (BR-09)
            if generation.grounding_validate(case, endpoints_by_key):
                discarded += 1
                continue
            req = reqs_by_id.get(case["requirement_ids"][0])
            if req is None:
                discarded += 1
                continue
            _persist_case(db, org_id, project_id, req, case)
            existing.add(key)
            generated += 1
        db.commit()

        job.progress = 0.98
        job.message = (f"Generated {generated}, discarded {discarded} (grounding), "
                       f"{len(skipped)} pairs skipped")
        audit(db, org_id, user_id, "security.generate", "project", project_id,
              {"generated": generated, "discarded": discarded, "skipped": len(skipped),
               "corpus_version": catalogue_version(),
               "weakness_ids": weakness_ids or [w["id"] for w in weaknesses()]})
        db.commit()
        # BO-07: discarded is a count only — a discarded case is never shown.
        return {"generated": generated, "discarded": discarded,
                "skipped": [{"endpoint": f"{s['method']} {s['path']}",
                             "weakness": s["weakness_id"], "reason": s["reason"]}
                            for s in skipped]}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class SecurityGenerateRequest(BaseModel):
    weakness_ids: list[str] | None = None
    requirement_ids: list[str] | None = None


@router.get("/weaknesses")
def list_weaknesses(user: User = Depends(require("view"))):
    """The shipped corpus and its version — every report stamps this version."""
    doc = load_catalogue()
    return {"version": doc["version"], "weaknesses": copy.deepcopy(doc["weaknesses"])}


@router.post("/projects/{project_id}/security/generate", status_code=202)
def start_security_generation(project_id: str, body: SecurityGenerateRequest,
                              user: User = Depends(require("generate")),
                              db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    known = {w["id"] for w in weaknesses()}
    requested = list(dict.fromkeys(body.weakness_ids or []))
    unknown = [w for w in requested if w not in known]
    if unknown:
        raise HTTPException(422, detail={
            "code": "unknown_weakness",
            "message": f"Unknown weakness ids: {', '.join(unknown)}",
            "errors": sorted(known)})
    org_id, user_id = user.organisation_id, user.id
    weakness_ids = requested or None
    req_ids = list(body.requirement_ids) if body.requirement_ids else None
    job = jobstore.submit(
        "security",
        lambda job: _run_security_generation(job, org_id, user_id, project_id,
                                             weakness_ids, req_ids),
        project_id=project_id)
    return {"job_id": job.id}


@router.get("/projects/{project_id}/security/coverage")
def security_coverage(project_id: str, user: User = Depends(require("view")),
                      db: Session = Depends(get_db)):
    """The §11 matrix: endpoints x applicable weakness classes, with the gap count.

    covered + not_applicable + gap == total, always. `gap` is the number that
    matters: applicable, and no case exists for it."""
    get_project_scoped(project_id, user, db)
    org_id = user.organisation_id
    endpoints = _project_endpoints(db, org_id, project_id)
    corpus = weaknesses()
    existing = _existing_pairs(db, org_id, project_id)

    ep_reqs = _endpoint_requirements(db, org_id, project_id, endpoints, None) if endpoints else {}

    by_weakness = {w["id"]: {"weakness_id": w["id"], "covered": 0,
                             "not_applicable": 0, "gap": 0} for w in corpus}
    skipped: list[dict] = []
    covered = not_applicable = gap = 0

    for ep in endpoints:
        for w in corpus:
            ok, reason = applicable(ep, w)
            row = by_weakness[w["id"]]
            if not ok:
                not_applicable += 1
                row["not_applicable"] += 1
                skipped.append({"endpoint_id": ep.id, "method": ep.method.upper(),
                                "path": ep.path, "weakness_id": w["id"], "reason": reason})
                continue
            if (ep.id, w["id"]) in existing:
                covered += 1
                row["covered"] += 1
                continue
            gap += 1
            row["gap"] += 1
            if not (ep_reqs.get(ep.id) or []):
                # Applicable, uncovered, and it CANNOT be covered until a
                # requirement maps here — a distinct reason, stated as such.
                skipped.append({"endpoint_id": ep.id, "method": ep.method.upper(),
                                "path": ep.path, "weakness_id": w["id"],
                                "reason": NO_REQUIREMENT_REASON})

    return {
        "corpus_version": catalogue_version(),
        "pairs": {"total": len(endpoints) * len(corpus), "covered": covered,
                  "not_applicable": not_applicable, "gap": gap},
        "by_weakness": [by_weakness[w["id"]] for w in corpus],
        "skipped": skipped,
    }
