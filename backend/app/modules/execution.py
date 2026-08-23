"""Execution Engine (TRD §4.6) — runs approved test cases against a project environment.

Auth resolved ONCE per run (FR-EXE-04), variable interpolation + response chaining
(FR-EXE-05), failed vs errored distinction (FR-EXE-11), redacted evidence capture
(NFR-SEC-03), partial results streamed to DB, best-effort cancel (FR-EXE-10).
"""
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..models import Endpoint, Environment, Run, TestCase, TestResult, User
from ..security import decrypt_secret, redact
from .traceability import run_display_id, run_display_ids

try:  # optional — json_schema assertions skip gracefully when absent
    import jsonschema
except Exception:  # noqa: BLE001
    jsonschema = None

router = APIRouter()

# Best-effort cancellation flags (FR-EXE-10): run_id -> True. Checked between cases.
_cancel_flags: dict[str, bool] = {}
_db_write_lock = threading.Lock()

_VAR_RE = re.compile(r"\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.\[\]-]*)\s*\}\}")
# OpenAPI-style single-brace path placeholders: /images/{imageId}
_PATH_PARAM_RE = re.compile(r"\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}")


def _bind_path_params(path: str, params: dict, context: dict) -> str:
    """Fill {name} placeholders in the path and drop the keys they consumed.

    Inventories store paths as templates (/images/{imageId}); the value lives in
    the step's params. Sending the template literally requests a URL that cannot
    exist, so every path-parameterised case would fail on a 404 no matter what
    the system under test does.
    """
    consumed: list[str] = []

    def _sub(m: re.Match) -> str:
        name = m.group(1)
        if name in params and params[name] is not None:
            consumed.append(name)
            return quote(str(params[name]), safe="")
        value = context.get(name) if isinstance(context, dict) else None
        if value is not None:
            return quote(str(value), safe="")
        return m.group(0)

    bound = _PATH_PARAM_RE.sub(_sub, path)
    for key in consumed:
        params.pop(key, None)
    return bound
_PATH_TOKEN_RE = re.compile(r"([^.\[\]]+)|\[(-?\d+)\]")

# Non-secret config keys — everything else in an auth config is treated as secret.
_NON_SECRET_CFG_KEYS = {"header", "in", "location", "param", "name", "token_url",
                        "username", "scope", "audience", "grant_type"}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


# ---------------------------------------------------------------------------
# Helpers: interpolation, JSON paths, secrets, truncation
# ---------------------------------------------------------------------------

def _resolve_path(data, path: str):
    """Resolve a dot/bracket path like "a.b[0].c" into a JSON structure. Raises KeyError."""
    if data is None:
        raise KeyError(path)
    cur = data
    tokens = _PATH_TOKEN_RE.findall(path or "")
    if tokens and tokens[0][0] == "json" and not (isinstance(cur, dict) and "json" in cur):
        tokens = tokens[1:]  # tolerate a conventional "json." prefix on extraction paths
    if not tokens:
        raise KeyError(path)
    for name, idx in tokens:
        if name:
            if isinstance(cur, dict) and name in cur:
                cur = cur[name]
            else:
                raise KeyError(path)
        else:
            i = int(idx)
            if isinstance(cur, list) and -len(cur) <= i < len(cur):
                cur = cur[i]
            else:
                raise KeyError(path)
    return cur


def _interpolate(value, context: dict):
    """Recursively substitute {{name}} placeholders. A string that IS a single
    placeholder keeps the context value's native type (FR-EXE-05)."""
    if isinstance(value, str):
        full = _VAR_RE.fullmatch(value.strip())
        if full and full.group(1) in context:
            return context[full.group(1)]
        return _VAR_RE.sub(
            lambda m: str(context[m.group(1)]) if m.group(1) in context else m.group(0), value)
    if isinstance(value, dict):
        return {k: _interpolate(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [_interpolate(v, context) for v in value]
    return value


def _collect_secrets(cfg: dict) -> list[str]:
    """Every string value in the auth config except structural keys (NFR-SEC-03)."""
    secrets: list[str] = []

    def walk(obj, key=""):
        if isinstance(obj, str):
            if key not in _NON_SECRET_CFG_KEYS and len(obj) > 3:
                secrets.append(obj)
        elif isinstance(obj, dict):
            for k, v in obj.items():
                walk(v, k)
        elif isinstance(obj, list):
            for v in obj:
                walk(v, key)

    walk(cfg or {})
    return secrets


def _truncate(text: str | None) -> str | None:
    if text is None:
        return None
    if len(text) > settings.EVIDENCE_MAX_BYTES:
        return text[: settings.EVIDENCE_MAX_BYTES] + "…[truncated]"
    return text


# ---------------------------------------------------------------------------
# Auth — once per run (FR-EXE-04). Token kept in memory only.
# ---------------------------------------------------------------------------

class _AuthSetupError(Exception):
    """Auth could not be established: run is aborted with a single diagnostic."""


# Credentials the security and insight builders reference by name. Two of them
# are DETERMINISTIC — a token past its expiry and a token with its signature
# stripped are constructed, not obtained — so the engine supplies them and the
# cases that need them can actually run. The third is a real second account and
# only a human can provide it.
def _synthetic_credentials() -> dict:
    """A structurally valid JWT that expired in 2020, and one with no signature."""
    import base64

    def b64(payload: dict) -> str:
        raw = json.dumps(payload, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    header = b64({"alg": "HS256", "typ": "JWT"})
    expired = b64({"sub": "traceo-probe", "iat": 1577836800, "exp": 1577923200})
    return {
        # exp = 2020-01-02. Any implementation that checks it must refuse this.
        "expired_token": f"{header}.{expired}.c2lnbmF0dXJl",
        # the signature segment removed entirely — the classic alg=none shape
        "unsigned_token": f"{header}.{b64({'sub': 'traceo-probe'})}.",
    }


def _login_flow(cfg: dict, base_url: str, tls_strict: bool) -> tuple[dict, dict]:
    """Sign in the way the application itself does, and keep what comes back.

    Every other auth_type here assumes the caller already HAS a credential. Most
    products do not work that way: the credential is minted by a sign-in call,
    and without this the engine could only ever test unauthenticated behaviour —
    which is why an entire test track used to collapse into 401s (TR-004).

    Config shape:
        {"method": "POST", "path": "/api/auth/login",
         "body": {"email": "...", "password": "..."},
         "extract": {"token": "$.token"},
         "inject": {"header": "Authorization", "template": "Bearer {{token}}"}}

    Returns (headers_to_send, extracted_variables). The extracted values also
    reach every case as context, so a step written against `{{token}}` resolves.
    """
    path = cfg.get("path") or cfg.get("url")
    if not path:
        raise _AuthSetupError("login auth is configured without a path")
    method = (cfg.get("method") or "POST").upper()
    extract = cfg.get("extract") or {"token": "token"}

    url = path if path.startswith(("http://", "https://")) \
        else base_url.rstrip("/") + "/" + path.lstrip("/")
    kwargs: dict = {"timeout": settings.REQUEST_TIMEOUT_S, "verify": tls_strict}
    if cfg.get("body") is not None:
        kwargs["json"] = cfg["body"]
    if cfg.get("form") is not None:
        kwargs["data"] = cfg["form"]
    if cfg.get("headers"):
        kwargs["headers"] = cfg["headers"]
    if cfg.get("params"):
        kwargs["params"] = cfg["params"]

    try:
        resp = httpx.request(method, url, **kwargs)
    except Exception as e:  # noqa: BLE001 — diagnostic must never carry the password
        raise _AuthSetupError(f"sign-in request failed: {type(e).__name__}") from e
    if resp.status_code >= 400:
        raise _AuthSetupError(
            f"sign-in endpoint answered HTTP {resp.status_code} — check the "
            "credentials and the path on this environment")
    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        raise _AuthSetupError("sign-in response was not JSON, so no token could be read")

    variables: dict = {}
    for name, jpath in extract.items():
        try:
            variables[name] = _resolve_path(payload, str(jpath).lstrip("$."))
        except KeyError:
            raise _AuthSetupError(
                f"sign-in succeeded but '{jpath}' is not in the response, so "
                f"'{name}' could not be read") from None
    if not variables:
        raise _AuthSetupError("sign-in extracted nothing to authenticate with")

    inject = cfg.get("inject") or {"header": "Authorization",
                                   "template": "Bearer {{%s}}" % next(iter(variables))}
    header_name = inject.get("header") or "Authorization"
    template = inject.get("template") or "Bearer {{%s}}" % next(iter(variables))
    return {header_name: str(_interpolate(template, variables))}, variables


def _build_auth(auth_type: str, cfg: dict, tls_strict: bool, base_url: str = ""):
    """Returns (headers, query_params, httpx_auth, oauth_token, variables)."""
    headers: dict[str, str] = {}
    params: dict[str, str] = {}
    auth = None
    token = None
    variables: dict = {}
    auth_type = auth_type or "none"
    if auth_type == "none":
        return headers, params, auth, token, variables
    if not cfg:
        raise _AuthSetupError(
            f"auth configuration for type '{auth_type}' is missing or could not be decrypted")

    if auth_type == "api_key":
        key = cfg.get("key") or cfg.get("api_key") or cfg.get("value") or ""
        if not key:
            raise _AuthSetupError("api_key auth is configured without a key")
        location = cfg.get("in") or cfg.get("location") or "header"
        if location == "query":
            params[cfg.get("param") or cfg.get("name") or "api_key"] = key
        else:
            headers[cfg.get("header") or "X-API-Key"] = key
    elif auth_type == "basic":
        auth = httpx.BasicAuth(cfg.get("username", ""), cfg.get("password", ""))
    elif auth_type == "bearer":
        tok = cfg.get("token") or cfg.get("key") or ""
        if not tok:
            raise _AuthSetupError("bearer auth is configured without a token")
        headers["Authorization"] = f"Bearer {tok}"
    elif auth_type == "oauth2_cc":
        token_url = cfg.get("token_url")
        if not token_url:
            raise _AuthSetupError("oauth2_cc auth is configured without a token_url")
        try:
            resp = httpx.post(
                token_url,
                data={"grant_type": "client_credentials",
                      "client_id": cfg.get("client_id", ""),
                      "client_secret": cfg.get("client_secret", "")},
                timeout=settings.REQUEST_TIMEOUT_S, verify=tls_strict)
        except Exception as e:  # noqa: BLE001 — diagnostic must not leak secrets
            raise _AuthSetupError(
                f"oauth2 token request failed: {type(e).__name__}") from e
        if resp.status_code >= 400:
            raise _AuthSetupError(
                f"oauth2 token endpoint returned HTTP {resp.status_code}")
        try:
            token = resp.json().get("access_token")
        except Exception:  # noqa: BLE001
            token = None
        if not token:
            raise _AuthSetupError("oauth2 token response did not contain access_token")
        headers["Authorization"] = f"Bearer {token}"
    elif auth_type == "login":
        login_headers, variables = _login_flow(cfg, base_url, tls_strict)
        headers.update(login_headers)
        token = next((str(v) for v in variables.values() if v), None)
    else:
        raise _AuthSetupError(f"unsupported auth_type '{auth_type}'")
    return headers, params, auth, token, variables


# ---------------------------------------------------------------------------
# Assertion evaluator
# ---------------------------------------------------------------------------

def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _eq(actual, expected) -> bool:
    if actual == expected:
        return True
    a, b = _num(actual), _num(expected)
    if a is not None and b is not None:
        return a == b
    return str(actual) == str(expected)


def _eval_assertion(a: dict, resp, resp_json, elapsed_ms: int, endpoint_schemas: dict | None,
                    resp_text: str = "", probe: dict | None = None):
    """Returns (ok, actual, skipped, reason).

    `reason` is non-empty only when skipped, and says WHY — "nothing ran" must
    never be indistinguishable from "ran and passed" (H1). The caller turns a
    case whose every assertion was skipped into `inconclusive`, never `passed`.
    """
    kind = a.get("type")

    # --- S1 security assertions (TR-002) -----------------------------------
    # These three were emitted by the security builders and understood by
    # nobody, so every case carrying them reported `passed` without testing
    # anything. They are cheap; the reason they were missing was oversight.

    if kind == "no_5xx":
        # A malformed request is a client error. Answering 5xx means the input
        # reached something that could not cope with it.
        return resp.status_code < 500, resp.status_code, False, ""

    if kind == "body_not_matches":
        patterns = a.get("patterns") or []
        if not patterns:
            return True, None, True, "the assertion carries no patterns"
        hay = resp_text or ""
        hit = next((p for p in patterns if p and p in hay), None)
        if hit is None:
            return True, "no signature found", False, ""
        # Report WHAT leaked and its surroundings — a bare "failed" would send
        # the reader back to the raw body to find out why.
        at = hay.find(hit)
        window = hay[max(0, at - 40):at + len(hit) + 80].replace("\n", "\\n")
        return False, f"leaked {hit!r} in: …{window}…", False, ""

    if kind == "rate_limited_within":
        # ACTIVE probe: it deliberately floods an endpoint, so it runs only with
        # explicit authorisation (S1). Unauthorised it is INCONCLUSIVE, never a
        # pass — the whole point of this class of bug.
        if probe is None:
            return True, None, True, ("active probe not authorised — set "
                                      "TRACEO_ACTIVE_SECURITY_PROBES=1 to run it")
        if probe.get("error"):
            return True, None, True, f"probe could not run: {probe['error']}"
        statuses = probe.get("statuses") or []
        want = int(a.get("expected_status", 429))
        ok = want in statuses
        return ok, {"sent": len(statuses), "statuses": statuses,
                    "expected": want}, False, ""

    if kind == "status_code":
        actual = resp.status_code
        allowed = a.get("expected_any")
        if allowed is not None:
            return actual in allowed, actual, False, ""
        return _eq(actual, a.get("expected")), actual, False, ""

    if kind == "json_field":
        op = a.get("op", "eq")
        try:
            actual = _resolve_path(resp_json, a.get("path", ""))
            found = True
        except (KeyError, TypeError):
            actual, found = None, False
        if op == "exists":
            return found, (actual if found else "<missing>"), False, ""
        if op == "absent":
            return not found, (actual if found else "<missing>"), False, ""
        if not found:
            return False, "<missing>", False, ""
        expected = a.get("expected")
        allowed = a.get("expected_any")
        if op == "eq":
            if allowed is not None:
                return any(_eq(actual, e) for e in allowed), actual, False, ""
            return _eq(actual, expected), actual, False, ""
        if op == "ne":
            return not _eq(actual, expected), actual, False, ""
        if op in ("gt", "lt"):
            av, ev = _num(actual), _num(expected)
            if av is None or ev is None:
                return False, actual, False, ""
            return (av > ev) if op == "gt" else (av < ev), actual, False, ""
        if op == "contains":
            try:
                if isinstance(actual, str):
                    return str(expected) in actual, actual, False, ""
                return expected in actual, actual, False, ""
            except TypeError:
                return False, actual, False, ""
        if op == "regex":
            try:
                return bool(re.search(str(expected), str(actual))), actual, False, ""
            except re.error:
                return False, actual, False, ""
        return False, actual, False, ""

    if kind == "response_time_ms":
        limit = a.get("max", a.get("expected"))
        if limit is None:
            return True, elapsed_ms, True, "the case records no time budget"
        return elapsed_ms <= float(limit), elapsed_ms, False, ""

    if kind == "header":
        actual = resp.headers.get(a.get("name", ""))
        op = a.get("op", "eq")
        expected = a.get("expected")
        allowed = a.get("expected_any")
        if actual is None:
            return False, None, False, ""
        if op == "contains":
            return str(expected) in actual, actual, False, ""
        if allowed is not None:
            return any(_eq(actual, e) for e in allowed), actual, False, ""
        return _eq(actual, expected), actual, False, ""

    if kind in ("header_present", "header_absent"):
        # Emitted by the security-headers builder alongside `header`, and — like
        # the three above — understood by nobody, so "carries HSTS" and "does not
        # advertise its framework" were never actually checked (TR-002).
        name = a.get("name", "")
        actual = resp.headers.get(name)
        if kind == "header_present":
            return actual is not None, actual, False, ""
        return actual is None, actual, False, ""

    if kind == "json_schema":
        # Validate against the step endpoint's 2xx response schema; skip gracefully.
        if jsonschema is None or not endpoint_schemas:
            return True, None, True, "no response schema on the endpoint, or jsonschema is not installed"
        schema = endpoint_schemas.get(str(resp.status_code))
        if schema is None:
            for k, v in endpoint_schemas.items():
                if str(k).startswith("2"):
                    schema = v
                    break
        if schema is None:
            schema = endpoint_schemas.get("default")
        if not schema:
            return True, None, True, "the endpoint declares no schema for this status"
        if resp_json is None:
            return False, "response body is not JSON", False, ""
        try:
            jsonschema.validate(resp_json, schema)
            return True, "valid", False, ""
        except jsonschema.ValidationError as e:
            return False, e.message, False, ""
        except Exception:  # noqa: BLE001 — malformed schema: skip, don't fail the case
            return True, None, True, "the endpoint schema is malformed"

    return True, None, True, f"no evaluator implements assertion type {kind!r}"


# ---------------------------------------------------------------------------
# Per-case execution (runs on a pool thread; writes its own result — partial visibility)
# ---------------------------------------------------------------------------

class _RunTimeout(Exception):
    pass


class _UnresolvedVariable(Exception):
    """A {{placeholder}} survived interpolation (TR-003).

    Sending it literally is the worst of the three options: the request goes out
    with `Authorization: Bearer {{token}}`, the target answers 401, and the case
    reports a security finding that is really a configuration mistake. Failing
    loudly names the variable instead.
    """


def _assert_resolved(where: str, value, seen: set[str]) -> None:
    """Collect any {{name}} left in `value` after interpolation."""
    if isinstance(value, str):
        for m in _VAR_RE.finditer(value):
            seen.add(f"{m.group(1)} (in {where})")
    elif isinstance(value, dict):
        for k, v in value.items():
            _assert_resolved(f"{where}.{k}", v, seen)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _assert_resolved(f"{where}[{i}]", v, seen)


def _rate_limit_probe(client, method: str, path: str, send_kwargs: dict,
                      assertion: dict, first_status: int, deadline: float) -> dict:
    """Repeat the request until the rate limit answers, or the budget runs out.

    Bounded on purpose (R2 in the development plan): at most `requests` attempts
    including the one already sent, and it stops the moment the expected status
    appears so an endpoint that IS limited is not hammered past the proof.
    """
    want = int(assertion.get("expected_status", 429))
    total = max(1, min(int(assertion.get("requests", 20)), settings.ACTIVE_PROBE_MAX_REQUESTS))
    statuses = [first_status]
    if first_status == want:
        return {"statuses": statuses}
    probe_kwargs = dict(send_kwargs)
    for _ in range(total - 1):
        if time.monotonic() >= deadline:
            return {"statuses": statuses, "error": "run budget exhausted"}
        probe_kwargs["timeout"] = max(0.001, min(settings.REQUEST_TIMEOUT_S,
                                                 deadline - time.monotonic()))
        try:
            r = client.request(method, path, **probe_kwargs)
        except (httpx.TimeoutException, httpx.TransportError) as e:
            return {"statuses": statuses, "error": f"{type(e).__name__}: {e}"}
        statuses.append(r.status_code)
        if r.status_code == want:
            break
    return {"statuses": statuses}


def decide_outcome(outcome: str, failure_reason: dict | None,
                   evaluated: int, skipped: int,
                   evidence: list[dict]) -> tuple[str, dict | None]:
    """The terminal state of a case, given what was actually checked (H1/TR-001).

    A case that reached the end without a failure has NOT passed unless something
    was evaluated. Reporting "passed" for a case whose every assertion was
    skipped is the single most damaging thing this engine used to do: it
    manufactured confidence out of an unimplemented check, 125 times in one
    measured run. Kept as a pure function so the rule can be tested on its own.
    """
    if outcome != "passed" or evaluated > 0:
        return outcome, failure_reason
    reasons = sorted({r.get("reason") for step in evidence
                      for r in (step.get("assertions") or [])
                      if r.get("outcome") in ("skipped", "unsupported") and r.get("reason")})
    return "inconclusive", {
        "code": "not_evaluated",
        "message": ("Nothing was checked: every assertion on this case was skipped."
                    if skipped else "This case carries no assertion to check."),
        "skipped": skipped,
        "reasons": reasons,
    }


def _case_worker(run_id: str, case: dict, client: httpx.Client,
                 auth_headers: dict, auth_params: dict, auth_obj,
                 env_vars: dict, endpoint_schemas: dict, deadline: float,
                 secrets: list[str]) -> str:
    if _cancel_flags.get(run_id):
        return "skipped"

    started = time.monotonic()
    context = dict(env_vars)
    evidence: list[dict] = []
    outcome = "passed"
    failure_reason: dict | None = None
    step_index = -1
    # H1 (TR-001): a case is only allowed to be `passed` if something was
    # actually checked. These two counters are what make that decidable, and
    # they are carried on the result so a reader can see it too.
    evaluated_assertions = 0
    skipped_assertions = 0

    try:
        for step_index, step in enumerate(case["steps"]):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise _RunTimeout()

            req = step.get("request") or {}
            raw_headers = req.get("headers") or {}
            # Unauthenticated-negative support: an explicitly empty Authorization
            # header means "send this request without any credentials".
            strip_auth = raw_headers.get("Authorization") == ""

            method = (step.get("method") or "GET").upper()
            path = str(_interpolate(step.get("path") or "/", context))
            step_params = _interpolate(req.get("params") or {}, context)
            step_headers = _interpolate(raw_headers, context)

            headers: dict[str, str] = {} if strip_auth else dict(auth_headers)
            for k, v in (step_headers or {}).items():
                if strip_auth and k == "Authorization":
                    continue
                if v is None or v == "":
                    headers.pop(k, None)
                else:
                    headers[k] = str(v)
            if strip_auth:
                headers.pop("Authorization", None)

            params: dict = {} if strip_auth else dict(auth_params)
            for k, v in (step_params or {}).items():
                params[k] = v

            path = _bind_path_params(path, params, context)

            body_kwargs: dict = {}
            # TR-003 / H3. Checked AFTER path binding so an OpenAPI {id} that the
            # binder consumed is not mistaken for a missing variable, and BEFORE
            # anything is sent, so an unconfigured environment can never be
            # reported as a finding about the target.
            unresolved: set[str] = set()
            _assert_resolved("path", path, unresolved)
            _assert_resolved("headers", headers, unresolved)
            _assert_resolved("params", params, unresolved)
            body_source = req.get("raw_body") if req.get("raw_body") is not None else req.get("body")
            if body_source is not None and not (
                    isinstance(body_source, str) and "{{malformed}}" in body_source):
                # {{malformed}} is a deliberate marker for the broken-JSON
                # negative below, not a variable anyone forgot to set.
                _assert_resolved("body", _interpolate(body_source, context), unresolved)
            if unresolved:
                raise _UnresolvedVariable(", ".join(sorted(unresolved)))

            body_repr: str | None = None
            raw_body = req.get("raw_body")
            if isinstance(raw_body, str) and "{{malformed}}" in raw_body:
                # FR-GEN-08 malformed-body negative: intentionally broken JSON payload
                body_kwargs["content"] = "not-json{{{"
                headers.setdefault("Content-Type", "application/json")
                body_repr = "not-json{{{"
            elif raw_body is not None:
                content = str(_interpolate(raw_body, context))
                body_kwargs["content"] = content
                body_repr = content
            elif req.get("body") is not None:
                body = _interpolate(req.get("body"), context)
                body_kwargs["json"] = body
                try:
                    body_repr = json.dumps(body, ensure_ascii=False, default=str)
                except Exception:  # noqa: BLE001
                    body_repr = str(body)

            req_evidence = {
                "method": method,
                "url": redact(str(client.base_url).rstrip("/") + path, secrets),
                "headers": {k: redact(str(v), secrets) for k, v in headers.items()},
                "body": _truncate(redact(body_repr, secrets) if body_repr else body_repr),
            }

            send_kwargs = dict(body_kwargs)
            if params:
                send_kwargs["params"] = params
            if headers:
                send_kwargs["headers"] = headers
            if auth_obj is not None and not strip_auth:
                send_kwargs["auth"] = auth_obj
            send_kwargs["timeout"] = max(0.001, min(settings.REQUEST_TIMEOUT_S, remaining))

            t0 = time.monotonic()
            try:
                resp = client.request(method, path, **send_kwargs)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                msg = redact(f"{type(e).__name__}: {e}", secrets)
                evidence.append({"request": req_evidence, "response": None,
                                 "elapsed_ms": elapsed_ms, "assertions": [],
                                 "error": msg})
                outcome = "errored"
                failure_reason = {"error": msg, "step_index": step_index}
                break

            elapsed_ms = int((time.monotonic() - t0) * 1000)
            req_evidence["url"] = redact(str(resp.request.url), secrets)
            try:
                resp_text = resp.text
            except Exception:  # noqa: BLE001
                resp_text = "<undecodable body>"
            try:
                resp_json = resp.json()
            except Exception:  # noqa: BLE001
                resp_json = None

            schemas = endpoint_schemas.get(step.get("endpoint_id")) if step.get("endpoint_id") else None
            step_assertions = step.get("assertions") or []

            # An ACTIVE rate-limit probe needs more than the one response above,
            # so it is fired here rather than inside the evaluator. It is bounded
            # and stops the moment the expected status appears.
            probe = None
            rate_a = next((a for a in step_assertions
                           if a.get("type") == "rate_limited_within"), None)
            if rate_a is not None and settings.ACTIVE_SECURITY_PROBES:
                probe = _rate_limit_probe(client, method, path, send_kwargs, rate_a,
                                          resp.status_code, deadline)

            assertion_records = []
            failed_assertion = None
            for a in step_assertions:
                ok, actual, skipped, why = _eval_assertion(
                    a, resp, resp_json, elapsed_ms, schemas, resp_text, probe)
                record = {
                    "assertion": a,
                    "outcome": "skipped" if skipped else ("passed" if ok else "failed"),
                    "actual": actual,
                }
                if skipped:
                    # H1: a skip must say why. "Nothing ran" is a result, not silence.
                    record["reason"] = why
                    skipped_assertions += 1
                else:
                    evaluated_assertions += 1
                assertion_records.append(record)
                if not ok and not skipped:
                    failed_assertion = (a, actual)
                    break  # halt at first failed assertion (FR-EXE-11)

            evidence.append({
                "request": req_evidence,
                "response": {
                    "status": resp.status_code,
                    "headers": {k: resp.headers[k] for k in
                                ("content-type", "content-length", "server",
                                 "date", "x-request-id") if k in resp.headers},
                    "body": _truncate(redact(resp_text, secrets)),
                },
                "elapsed_ms": elapsed_ms,
                "assertions": assertion_records,
            })

            if failed_assertion:
                a, actual = failed_assertion
                outcome = "failed"
                failure_reason = {
                    "assertion": a,
                    "expected": a.get("expected", a.get("expected_any", a.get("max"))),
                    "actual": actual,
                    "step_index": step_index,
                }
                break

            # Chaining (FR-EXE-05): pull values from the response into context
            for ex in step.get("extractions") or []:
                try:
                    context[ex["name"]] = _resolve_path(resp_json, ex.get("path", ""))
                except Exception:  # noqa: BLE001 — leave placeholder unresolved
                    pass

    except _UnresolvedVariable as e:
        # Not a finding about the target — a finding about this project's
        # configuration. A case that needs a second, lower-privileged account
        # cannot run without one, and that is `inconclusive`: reporting it as a
        # failure would blame the target for a gap in the setup, and reporting it
        # as a pass would be the old lie (TR-003, H1).
        missing = str(e)
        needs_actor = any(name in missing for name in
                          ("low_privilege_token", "foreign_object_id"))
        outcome = "inconclusive" if needs_actor else "errored"
        failure_reason = {
            "code": "actor_not_configured" if needs_actor else "unresolved_variable",
            "error": (f"This case needs {missing}, which no one has supplied. "
                      "Add a second, lower-privileged account to the environment "
                      "to run it." if needs_actor else
                      f"Unresolved variable(s): {missing}. "
                      "Set them on the environment, or configure its sign-in flow."),
            "step_index": max(step_index, 0),
        }
    except _RunTimeout:
        outcome = "errored"
        failure_reason = {"error": "run timeout", "step_index": max(step_index, 0)}
    except Exception as e:  # noqa: BLE001 — unexpected exception = errored (FR-EXE-11)
        outcome = "errored"
        failure_reason = {"error": redact(f"{type(e).__name__}: {e}", secrets),
                          "step_index": max(step_index, 0)}

    duration_ms = int((time.monotonic() - started) * 1000)

    outcome, failure_reason = decide_outcome(
        outcome, failure_reason, evaluated_assertions, skipped_assertions, evidence)

    # Immutable result, committed as the case finishes (partial visibility)
    with _db_write_lock:
        db = SessionLocal()
        try:
            db.add(TestResult(run_id=run_id, test_case_id=case["id"],
                              test_case_version=case["version"], outcome=outcome,
                              duration_ms=duration_ms, failure_reason=failure_reason,
                              evidence=evidence,
                              assertions_evaluated=evaluated_assertions,
                              assertions_skipped=skipped_assertions))
            db.commit()
        finally:
            db.close()
    return outcome


# ---------------------------------------------------------------------------
# Run job (executes on a jobstore thread; owns its own SessionLocal)
# ---------------------------------------------------------------------------

def _execute_run(job, run_id: str, case_ids: list[str]):
    db = SessionLocal()
    try:
        run = db.get(Run, run_id)
        if run is None:
            return {"run_id": run_id, "state": "missing"}
        env = db.get(Environment, run.environment_id)
        run.state = "running"
        run.started_at = _utcnow()
        db.commit()

        cfg = decrypt_secret(env.auth_config_encrypted)
        secrets = _collect_secrets(cfg)
        try:
            auth_headers, auth_params, auth_obj, token, auth_vars = _build_auth(
                env.auth_type, cfg, env.tls_strict, env.base_url)
        except _AuthSetupError as e:
            # FR-EXE-04: single diagnostic, NO per-case failures
            run.state = "aborted"
            run.abort_reason = redact(str(e), secrets)
            run.finished_at = _utcnow()
            run.counts = {"total": 0, "passed": 0, "failed": 0, "errored": 0,
                          "inconclusive": 0}
            db.commit()
            _cancel_flags.pop(run_id, None)
            return {"run_id": run_id, "state": "aborted", "reason": run.abort_reason}
        if token:
            secrets.append(token)  # token lives in memory only, never persisted

        # Snapshot cases/steps into plain dicts (workers must not share ORM state)
        cases: list[dict] = []
        for cid in case_ids:
            tc = db.get(TestCase, cid)
            if tc is None:
                continue
            cases.append({
                "id": tc.id, "version": tc.version,
                "mutates": bool(tc.mutates),
                "steps": [{"order": s.order, "endpoint_id": s.endpoint_id,
                           "method": s.method, "path": s.path,
                           "request": s.request or {},
                           "assertions": s.assertions or [],
                           "extractions": s.extractions or []}
                          for s in sorted(tc.steps, key=lambda s: s.order)],
            })

        # TR-015: read-only cases first, mutating ones after. A case that posts a
        # 4000-character name used to run in the middle of the fan-out and make
        # three unrelated LISTING cases fail schema validation on a record they
        # never created — a failure the reader has no way to attribute correctly.
        cases.sort(key=lambda c: (c["mutates"], c["id"]))

        ep_ids = {s["endpoint_id"] for c in cases for s in c["steps"] if s["endpoint_id"]}
        endpoint_schemas = {}
        if ep_ids:
            for ep in db.query(Endpoint).filter(Endpoint.id.in_(ep_ids)).all():
                endpoint_schemas[ep.id] = ep.response_schemas or {}

        # Order matters: the engine's synthetic credentials are defaults, and an
        # environment that names its own always wins.
        env_vars = dict(_synthetic_credentials())
        env_vars.update(env.variables or {})
        # Whatever sign-in returned is a variable like any other, so a step
        # written against {{token}} resolves instead of being sent literally.
        env_vars.update(auth_vars)
        base_url = env.base_url
        tls_strict = env.tls_strict
        total = len(cases)
        deadline = time.monotonic() + settings.RUN_TIMEOUT_S

        with httpx.Client(base_url=base_url, verify=tls_strict,
                          timeout=settings.REQUEST_TIMEOUT_S) as client:
            with ThreadPoolExecutor(max_workers=max(1, settings.RUN_CONCURRENCY)) as pool:
                futures = [pool.submit(_case_worker, run_id, case, client,
                                       auth_headers, auth_params, auth_obj,
                                       env_vars, endpoint_schemas, deadline, secrets)
                           for case in cases]
                done = 0
                for fut in as_completed(futures):
                    fut.result()  # workers never raise
                    done += 1
                    job.progress = done / total if total else 1.0

        cancelled = _cancel_flags.pop(run_id, False)

        db.expire_all()
        results = db.query(TestResult).filter(TestResult.run_id == run_id).all()
        # `inconclusive` is a first-class outcome, not a footnote: a reader who
        # sees only passed/failed/errored would read "nothing was checked" as
        # "nothing was wrong" (H1, H8).
        counts = {"total": len(results), "passed": 0, "failed": 0, "errored": 0,
                  "inconclusive": 0}
        assertions_evaluated = assertions_skipped = 0
        for r in results:
            counts[r.outcome] = counts.get(r.outcome, 0) + 1
            assertions_evaluated += r.assertions_evaluated or 0
            assertions_skipped += r.assertions_skipped or 0
        counts["assertions_evaluated"] = assertions_evaluated
        counts["assertions_skipped"] = assertions_skipped
        run = db.get(Run, run_id)
        run.counts = counts
        run.state = "cancelled" if cancelled else "completed"
        run.finished_at = _utcnow()
        db.commit()

        # v2 addendum: notify project webhooks after the terminal state (lazy import
        # avoids a module cycle; a webhook failure must never break a run).
        try:
            from ..models import Project
            from .integrations import fire_webhooks
            project = db.get(Project, run.project_id)
            total, passed = counts.get("total", 0), counts.get("passed", 0)
            fire_webhooks(db, run.project_id, "run.completed", {
                "event": "run.completed",
                "project": {"id": run.project_id,
                            "name": project.name if project else ""},
                "run": {"id": run.id, "display_id": run_display_id(db, run),
                        "state": run.state, "counts": counts,
                        "coverage_pct": round(passed / total * 100, 1) if total else None},
                "timestamp": _utcnow().isoformat(),
            })
        except Exception:  # noqa: BLE001
            pass
        return {"run_id": run_id, "state": run.state, "counts": counts}
    except Exception as e:  # noqa: BLE001 — never leave a run stuck in 'running'
        try:
            run = db.get(Run, run_id)
            if run and run.state in ("queued", "running"):
                run.state = "aborted"
                run.abort_reason = f"internal error: {type(e).__name__}"
                run.finished_at = _utcnow()
                db.commit()
        except Exception:  # noqa: BLE001
            pass
        _cancel_flags.pop(run_id, None)
        raise
    finally:
        db.close()


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------

class RunCreate(BaseModel):
    environment_id: str
    test_case_ids: list[str] | None = None


def _get_run(run_id: str, user: User, db: Session) -> Run:
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    return run


def _run_dict(run: Run) -> dict:
    return {
        "id": run.id, "project_id": run.project_id, "environment_id": run.environment_id,
        # rows written before the column existed read back as NULL under SQLite's
        # ALTER TABLE; "functional" is what they were.
        "kind": run.kind or "functional",
        "state": run.state, "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at), "counts": run.counts or {},
        "initiated_by": run.initiated_by, "abort_reason": run.abort_reason,
        "created_at": _iso(run.created_at),
    }


@router.post("/projects/{project_id}/runs", status_code=202)
def create_run(project_id: str, payload: RunCreate,
               user: User = Depends(require("trigger_run")),
               db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)

    env = db.get(Environment, payload.environment_id)
    if (not env or env.project_id != project_id
            or env.organisation_id != user.organisation_id):
        raise HTTPException(404, detail={"code": "not_found",
                                         "message": "Environment not found in this project"})

    q = db.query(TestCase).filter(
        TestCase.project_id == project_id,
        TestCase.organisation_id == user.organisation_id,
        TestCase.state == "approved")
    if payload.test_case_ids:
        q = q.filter(TestCase.id.in_(payload.test_case_ids))
    cases = q.all()
    if not cases:
        raise HTTPException(409, detail={"code": "no_approved_cases",
                                         "message": "No approved test cases to execute"})

    run = Run(organisation_id=user.organisation_id, project_id=project_id,
              environment_id=env.id, state="queued", initiated_by=user.id, counts={})
    db.add(run)
    db.flush()
    audit(db, user.organisation_id, user.id, "run.started", "run", run.id,
          {"environment_id": env.id, "case_count": len(cases)})
    db.commit()

    run_id = run.id
    case_ids = [c.id for c in cases]
    job = jobstore.submit("execute", lambda j: _execute_run(j, run_id, case_ids))
    return {"job_id": job.id, "run_id": run_id}


@router.get("/projects/{project_id}/runs")
def list_runs(project_id: str, user: User = Depends(require("view")),
              db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    runs = (db.query(Run)
            .filter(Run.project_id == project_id,
                    Run.organisation_id == user.organisation_id)
            .order_by(Run.created_at.desc()).all())
    display_ids = run_display_ids(db, project_id)
    payload = []
    for r in runs:
        d = _run_dict(r)
        d["display_id"] = display_ids.get(r.id)
        payload.append(d)
    return {"runs": payload}


@router.get("/runs/{run_id}")
def get_run(run_id: str, user: User = Depends(require("view")),
            db: Session = Depends(get_db)):
    run = _get_run(run_id, user, db)
    d = _run_dict(run)
    d["display_id"] = run_display_id(db, run)
    return d


@router.get("/runs/{run_id}/results")
def get_run_results(run_id: str, outcome: str | None = None,
                    user: User = Depends(require("view")),
                    db: Session = Depends(get_db)):
    run = _get_run(run_id, user, db)
    q = (db.query(TestResult, TestCase)
         .join(TestCase, TestCase.id == TestResult.test_case_id)
         .filter(TestResult.run_id == run.id))
    if outcome:
        q = q.filter(TestResult.outcome == outcome)
    rows = q.order_by(TestResult.created_at.asc()).all()
    return {"run_id": run.id, "results": [{
        "id": res.id,
        "test_case": {"id": tc.id, "title": tc.title, "type": tc.type,
                      "priority": tc.priority, "state": tc.state},
        "test_case_version": res.test_case_version,
        "outcome": res.outcome,
        "duration_ms": res.duration_ms,
        "failure_reason": res.failure_reason,
        "evidence": res.evidence,
        "created_at": _iso(res.created_at),
    } for res, tc in rows]}


@router.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str, user: User = Depends(require("trigger_run")),
               db: Session = Depends(get_db)):
    run = _get_run(run_id, user, db)
    if run.state not in ("queued", "running"):
        raise HTTPException(409, detail={"code": "not_cancellable",
                                         "message": f"Run is already {run.state}"})
    _cancel_flags[run.id] = True  # best-effort (FR-EXE-10); partial results kept
    audit(db, user.organisation_id, user.id, "run.cancel_requested", "run", run.id)
    db.commit()
    return {"run_id": run.id, "state": run.state, "cancel_requested": True}
