"""Execution Engine (TRD §4.6) — runs approved test cases against a project environment.

Auth resolved ONCE per run (FR-EXE-04), variable interpolation + response chaining
(FR-EXE-05), failed vs errored distinction (FR-EXE-11), redacted evidence capture
(NFR-SEC-03), partial results streamed to DB, best-effort cancel (FR-EXE-10),
per-run concurrency 1..32 (FR-040) and a run-namespaced fixture lifecycle whose
teardown executes on success, failure and cancellation alike (FR-043).
"""
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import assert_token_scope, audit, get_project_scoped, require
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


def _build_auth(auth_type: str, cfg: dict, tls_strict: bool):
    """Returns (headers, query_params, httpx_auth, oauth_token)."""
    headers: dict[str, str] = {}
    params: dict[str, str] = {}
    auth = None
    token = None
    auth_type = auth_type or "none"
    if auth_type == "none":
        return headers, params, auth, token
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
    else:
        raise _AuthSetupError(f"unsupported auth_type '{auth_type}'")
    return headers, params, auth, token


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


def _eval_assertion(a: dict, resp, resp_json, elapsed_ms: int, endpoint_schemas: dict | None):
    """Returns (ok, actual, skipped)."""
    kind = a.get("type")

    if kind == "status_code":
        actual = resp.status_code
        allowed = a.get("expected_any")
        if allowed is not None:
            return actual in allowed, actual, False
        return _eq(actual, a.get("expected")), actual, False

    if kind == "json_field":
        op = a.get("op", "eq")
        try:
            actual = _resolve_path(resp_json, a.get("path", ""))
            found = True
        except (KeyError, TypeError):
            actual, found = None, False
        if op == "exists":
            return found, (actual if found else "<missing>"), False
        if op == "absent":
            return not found, (actual if found else "<missing>"), False
        if not found:
            return False, "<missing>", False
        expected = a.get("expected")
        allowed = a.get("expected_any")
        if op == "eq":
            if allowed is not None:
                return any(_eq(actual, e) for e in allowed), actual, False
            return _eq(actual, expected), actual, False
        if op == "ne":
            return not _eq(actual, expected), actual, False
        if op in ("gt", "lt"):
            av, ev = _num(actual), _num(expected)
            if av is None or ev is None:
                return False, actual, False
            return (av > ev) if op == "gt" else (av < ev), actual, False
        if op == "contains":
            try:
                if isinstance(actual, str):
                    return str(expected) in actual, actual, False
                return expected in actual, actual, False
            except TypeError:
                return False, actual, False
        if op == "regex":
            try:
                return bool(re.search(str(expected), str(actual))), actual, False
            except re.error:
                return False, actual, False
        return False, actual, False

    if kind == "response_time_ms":
        limit = a.get("max", a.get("expected"))
        if limit is None:
            return True, elapsed_ms, True
        return elapsed_ms <= float(limit), elapsed_ms, False

    if kind == "header":
        actual = resp.headers.get(a.get("name", ""))
        op = a.get("op", "eq")
        expected = a.get("expected")
        allowed = a.get("expected_any")
        if actual is None:
            return False, None, False
        if op == "contains":
            return str(expected) in actual, actual, False
        if allowed is not None:
            return any(_eq(actual, e) for e in allowed), actual, False
        return _eq(actual, expected), actual, False

    if kind == "json_schema":
        # Validate against the step endpoint's 2xx response schema; skip gracefully.
        if jsonschema is None or not endpoint_schemas:
            return True, "skipped (no schema/validator)", True
        schema = endpoint_schemas.get(str(resp.status_code))
        if schema is None:
            for k, v in endpoint_schemas.items():
                if str(k).startswith("2"):
                    schema = v
                    break
        if schema is None:
            schema = endpoint_schemas.get("default")
        if not schema:
            return True, "skipped (no schema)", True
        if resp_json is None:
            return False, "response body is not JSON", False
        try:
            jsonschema.validate(resp_json, schema)
            return True, "valid", False
        except jsonschema.ValidationError as e:
            return False, e.message, False
        except Exception:  # noqa: BLE001 — malformed schema: skip, don't fail the case
            return True, "skipped (invalid schema)", True

    return True, None, True  # unknown assertion types are skipped, never failed


# ---------------------------------------------------------------------------
# Per-case execution (runs on a pool thread; writes its own result — partial visibility)
# ---------------------------------------------------------------------------

class _RunTimeout(Exception):
    pass


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

            body_kwargs: dict = {}
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
            assertion_records = []
            failed_assertion = None
            for a in step.get("assertions") or []:
                ok, actual, skipped = _eval_assertion(a, resp, resp_json, elapsed_ms, schemas)
                assertion_records.append({
                    "assertion": a,
                    "outcome": "skipped" if skipped else ("passed" if ok else "failed"),
                    "actual": actual,
                })
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

    except _RunTimeout:
        outcome = "errored"
        failure_reason = {"error": "run timeout", "step_index": max(step_index, 0)}
    except Exception as e:  # noqa: BLE001 — unexpected exception = errored (FR-EXE-11)
        outcome = "errored"
        failure_reason = {"error": redact(f"{type(e).__name__}: {e}", secrets),
                          "step_index": max(step_index, 0)}

    duration_ms = int((time.monotonic() - started) * 1000)

    # Immutable result, committed as the case finishes (partial visibility)
    with _db_write_lock:
        db = SessionLocal()
        try:
            db.add(TestResult(run_id=run_id, test_case_id=case["id"],
                              test_case_version=case["version"], outcome=outcome,
                              duration_ms=duration_ms, failure_reason=failure_reason,
                              evidence=evidence))
            db.commit()
        finally:
            db.close()
    return outcome


# ---------------------------------------------------------------------------
# Test-data lifecycle (FR-043) — fixtures created before the suite, torn down after
# ---------------------------------------------------------------------------

def _fixture_namespace(run_id: str) -> str:
    """Every fixture this run creates carries this token, so leftovers are
    identifiable in the target system by run (FR-043 AC1)."""
    return f"traceo-run-{run_id}"  # the exact token SRS §4.4 specifies


def _fixture_request(client: httpx.Client, spec: dict, context: dict,
                     auth_headers: dict, auth_params: dict, auth_obj,
                     secrets: list[str]) -> tuple[bool, object, str | None]:
    """Issue one fixture request. Returns (ok, parsed_json, error)."""
    method = (spec.get("method") or "POST").upper()
    path = str(_interpolate(spec.get("path") or "/", context))
    headers = dict(auth_headers)
    headers.update({k: str(v) for k, v in (_interpolate(spec.get("headers") or {}, context)).items()})
    params = dict(auth_params)
    params.update(_interpolate(spec.get("params") or {}, context) or {})
    kwargs: dict = {"headers": headers, "timeout": settings.REQUEST_TIMEOUT_S}
    if params:
        kwargs["params"] = params
    if spec.get("body") is not None:
        kwargs["json"] = _interpolate(spec.get("body"), context)
    if auth_obj is not None:
        kwargs["auth"] = auth_obj
    try:
        resp = client.request(method, path, **kwargs)
    except Exception as e:  # noqa: BLE001
        return False, None, redact(f"{type(e).__name__}: {e}", secrets)
    if resp.status_code >= 400:
        return False, None, f"HTTP {resp.status_code}"
    try:
        return True, resp.json(), None
    except Exception:  # noqa: BLE001
        return True, None, None


def _setup_fixtures(specs: list, client: httpx.Client, context: dict,
                    auth_headers: dict, auth_params: dict, auth_obj,
                    secrets: list[str]) -> tuple[list[dict], list[dict]]:
    """Create each declared fixture and publish its extracted values into the run
    context. Returns (created, failed)."""
    created: list[dict] = []
    failed: list[dict] = []
    for spec in specs or []:
        if not isinstance(spec, dict) or not spec.get("create"):
            continue
        name = str(spec.get("name") or "fixture")
        ok, data, error = _fixture_request(client, spec["create"], context,
                                           auth_headers, auth_params, auth_obj, secrets)
        if not ok:
            failed.append({"name": name, "reason": error or "create failed"})
            continue
        extracted = {}
        for var, path in (spec.get("extract") or {}).items():
            try:
                value = _resolve_path(data, str(path))
            except Exception:  # noqa: BLE001
                failed.append({"name": name, "reason": f"could not extract '{var}' from the response"})
                continue
            context[var] = value
            extracted[var] = value
        created.append({"name": name, "extracted": extracted})
    return created, failed


def _teardown_fixtures(specs: list, created: list[dict], client: httpx.Client,
                       context: dict, auth_headers: dict, auth_params: dict, auth_obj,
                       secrets: list[str]) -> tuple[list[str], list[dict]]:
    """Delete fixtures in reverse creation order. Runs on success, failure and
    cancellation (FR-043 AC2); whatever cannot be removed is reported (AC3)."""
    by_name = {str(s.get("name") or "fixture"): s for s in (specs or []) if isinstance(s, dict)}
    removed: list[str] = []
    orphans: list[dict] = []
    for entry in reversed(created):
        spec = by_name.get(entry["name"]) or {}
        delete = spec.get("delete")
        if not delete:
            orphans.append({"name": entry["name"], "reason": "no teardown declared for this fixture"})
            continue
        ok, _data, error = _fixture_request(client, delete, context,
                                            auth_headers, auth_params, auth_obj, secrets)
        if ok:
            removed.append(entry["name"])
        else:
            orphans.append({"name": entry["name"], "reason": error or "delete failed"})
    return removed, orphans


# ---------------------------------------------------------------------------
# Run job (executes on a jobstore thread; owns its own SessionLocal)
# ---------------------------------------------------------------------------

def _announce_run(db: Session, run: Run) -> None:
    """Run completion posts a summary to any connected channel (FR-072 AC2).
    A delivery problem is logged on the integration, never raised into the run."""
    try:
        from .automation import _outcomes_of, _previous_completed_run
        from .integrations import notify_run

        previous_run = _previous_completed_run(db, run)
        regressions = 0
        if previous_run:
            current = _outcomes_of(db, run.id)
            previous = _outcomes_of(db, previous_run.id)
            regressions = sum(1 for cid, res in current.items()
                              if res.outcome in ("failed", "errored")
                              and previous.get(cid) is not None
                              and previous[cid].outcome == "passed")
        notify_run(db, run, regressions)
    except Exception:  # noqa: BLE001 — notification is never allowed to fail a run
        pass


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
            auth_headers, auth_params, auth_obj, token = _build_auth(
                env.auth_type, cfg, env.tls_strict)
        except _AuthSetupError as e:
            # FR-EXE-04: single diagnostic, NO per-case failures
            run.state = "aborted"
            run.abort_reason = redact(str(e), secrets)
            run.finished_at = _utcnow()
            run.counts = {"total": 0, "passed": 0, "failed": 0, "errored": 0}
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
                "steps": [{"order": s.order, "endpoint_id": s.endpoint_id,
                           "method": s.method, "path": s.path,
                           "request": s.request or {},
                           "assertions": s.assertions or [],
                           "extractions": s.extractions or []}
                          for s in sorted(tc.steps, key=lambda s: s.order)],
            })

        ep_ids = {s["endpoint_id"] for c in cases for s in c["steps"] if s["endpoint_id"]}
        endpoint_schemas = {}
        if ep_ids:
            for ep in db.query(Endpoint).filter(Endpoint.id.in_(ep_ids)).all():
                endpoint_schemas[ep.id] = ep.response_schemas or {}

        env_vars = dict(env.variables or {})
        env_vars["run_ns"] = _fixture_namespace(run_id)  # FR-043 AC1 namespacing
        env_vars["run_id"] = run_id
        base_url = env.base_url
        tls_strict = env.tls_strict
        fixture_specs = list(env.fixtures or [])
        total = len(cases)
        deadline = time.monotonic() + settings.RUN_TIMEOUT_S
        # FR-040 AC2: per-run concurrency, clamped to the configured ceiling.
        workers = run.concurrency or settings.RUN_CONCURRENCY
        workers = max(1, min(int(workers), settings.RUN_CONCURRENCY_MAX))

        fixture_report = {"created": [], "removed": [], "orphans": [], "setup_failed": []}
        with httpx.Client(base_url=base_url, verify=tls_strict,
                          timeout=settings.REQUEST_TIMEOUT_S) as client:
            created: list[dict] = []
            try:
                if fixture_specs:
                    job.message = "Creating fixtures"
                    created, setup_failed = _setup_fixtures(
                        fixture_specs, client, env_vars, auth_headers, auth_params,
                        auth_obj, secrets)
                    fixture_report["created"] = [c["name"] for c in created]
                    fixture_report["setup_failed"] = setup_failed

                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = [pool.submit(_case_worker, run_id, case, client,
                                           auth_headers, auth_params, auth_obj,
                                           env_vars, endpoint_schemas, deadline, secrets)
                               for case in cases]
                    done = 0
                    for fut in as_completed(futures):
                        fut.result()  # workers never raise
                        done += 1
                        job.progress = done / total if total else 1.0
            finally:
                # FR-043 AC2: teardown runs on success, failure AND cancellation.
                if created:
                    job.message = "Tearing down fixtures"
                    removed, orphans = _teardown_fixtures(
                        fixture_specs, created, client, env_vars, auth_headers,
                        auth_params, auth_obj, secrets)
                    fixture_report["removed"] = removed
                    fixture_report["orphans"] = orphans

        cancelled = _cancel_flags.pop(run_id, False)

        db.expire_all()
        results = db.query(TestResult).filter(TestResult.run_id == run_id).all()
        counts = {"total": len(results), "passed": 0, "failed": 0, "errored": 0}
        for r in results:
            counts[r.outcome] = counts.get(r.outcome, 0) + 1
        run = db.get(Run, run_id)
        run.counts = counts
        run.state = "cancelled" if cancelled else "completed"
        run.finished_at = _utcnow()
        run.fixtures = fixture_report
        db.commit()
        _announce_run(db, run)
        return {"run_id": run_id, "state": run.state, "counts": counts,
                "fixtures": fixture_report}
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
    branch: str = ""              # FR-054 trend filter
    concurrency: int | None = None  # FR-040 AC2, 1..RUN_CONCURRENCY_MAX


class RunQueued(Exception):
    """Raised when an environment already has a run in flight (FR-060 AC3)."""

    def __init__(self, run_id: str):
        super().__init__(run_id)
        self.run_id = run_id


class NoApprovedCases(Exception):
    pass


def _get_run(run_id: str, user: User, db: Session) -> Run:
    run = db.get(Run, run_id)
    if not run or run.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Run not found"})
    return run


def _run_dict(run: Run) -> dict:
    return {
        "id": run.id, "project_id": run.project_id, "environment_id": run.environment_id,
        "state": run.state, "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at), "counts": run.counts or {},
        "initiated_by": run.initiated_by, "abort_reason": run.abort_reason,
        "created_at": _iso(run.created_at),
        "source": run.source or "manual", "branch": run.branch or "",
        "fixtures": run.fixtures or {},
    }


def start_run(db: Session, org_id: str, project_id: str, env: Environment,
              initiated_by: str, *, test_case_ids: list[str] | None = None,
              source: str = "manual", branch: str = "", concurrency: int | None = None,
              serialise_per_environment: bool = False) -> tuple[str, str]:
    """Create a run row and hand it to the job store. Shared by the manual, CI
    (FR-061) and scheduled (FR-060) entry points so all three behave identically.
    Returns (job_id, run_id). Raises NoApprovedCases / RunQueued."""
    if serialise_per_environment:
        # FR-060 AC3: never execute two runs concurrently against one environment.
        in_flight = (db.query(Run)
                     .filter(Run.environment_id == env.id,
                             Run.state.in_(("queued", "running")))
                     .order_by(Run.created_at.desc()).first())
        if in_flight:
            raise RunQueued(in_flight.id)

    q = db.query(TestCase).filter(
        TestCase.project_id == project_id,
        TestCase.organisation_id == org_id,
        TestCase.state == "approved")
    if test_case_ids:
        q = q.filter(TestCase.id.in_(test_case_ids))
    cases = q.all()
    if not cases:
        raise NoApprovedCases()

    clamped = 0
    if concurrency is not None:
        clamped = max(1, min(int(concurrency), settings.RUN_CONCURRENCY_MAX))

    run = Run(organisation_id=org_id, project_id=project_id, environment_id=env.id,
              state="queued", initiated_by=initiated_by, counts={}, source=source,
              branch=branch[:200], concurrency=clamped, fixtures={})
    db.add(run)
    db.flush()
    audit(db, org_id, initiated_by, "run.started", "run", run.id,
          {"environment_id": env.id, "case_count": len(cases),
           "source": source, "branch": branch})
    db.commit()

    run_id = run.id
    case_ids = [c.id for c in cases]
    job = jobstore.submit("execute", lambda j: _execute_run(j, run_id, case_ids))
    return job.id, run_id


def get_environment_scoped(project_id: str, env_id: str, org_id: str,
                           db: Session) -> Environment:
    env = db.get(Environment, env_id)
    if not env or env.project_id != project_id or env.organisation_id != org_id:
        raise HTTPException(404, detail={"code": "not_found",
                                         "message": "Environment not found in this project"})
    return env


@router.post("/projects/{project_id}/runs", status_code=202)
def create_run(project_id: str, payload: RunCreate,
               user: User = Depends(require("trigger_run")),
               db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    assert_token_scope(user, project_id)
    env = get_environment_scoped(project_id, payload.environment_id,
                                 user.organisation_id, db)
    if payload.concurrency is not None and not (1 <= payload.concurrency <= settings.RUN_CONCURRENCY_MAX):
        raise HTTPException(422, detail={
            "code": "invalid_concurrency",
            "message": f"concurrency must be between 1 and {settings.RUN_CONCURRENCY_MAX}"})
    try:
        job_id, run_id = start_run(db, user.organisation_id, project_id, env, user.id,
                                   test_case_ids=payload.test_case_ids,
                                   branch=payload.branch,
                                   concurrency=payload.concurrency)
    except NoApprovedCases:
        raise HTTPException(409, detail={"code": "no_approved_cases",
                                         "message": "No approved test cases to execute"})
    return {"job_id": job_id, "run_id": run_id}


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
