"""OpenAPI/Swagger Discovery Engine (TRD §4.2) — fully deterministic, NO LLM.

Imports an OpenAPI 3.x or Swagger 2.0 specification (multipart file or URL), resolves
internal $refs cycle-safely, and flattens every operation into an Endpoint inventory row.
That inventory is the ground truth the generation module's grounding gate validates
against — which is why this engine is deterministic end to end.

Broken/unresolvable operations are recorded as warnings and skipped, never fatal
(FR-DSC-04). URL fetches are SSRF-guarded. Re-import bumps the spec version and
REPLACES the endpoint inventory, returning an added/removed/changed diff.
"""
import ipaddress
import json
import socket
from urllib.parse import urljoin, urlsplit

import httpx
import yaml
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile as StarletteUploadFile

from ..db import get_db
from ..deps import audit, get_project_scoped, require
from ..models import ApiSpec, Endpoint, TestCase, TestResult, TestStep, User

router = APIRouter()

MAX_SPEC_BYTES = 5 * 1024 * 1024
FETCH_TIMEOUT_S = 10.0
MAX_REDIRECTS = 3
HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")
CONSTRAINT_KEYS = ("format", "minimum", "maximum", "minLength", "maxLength", "pattern", "enum")


# --- SSRF-guarded URL fetch ----------------------------------------------------------

def _assert_public_host(hostname: str | None) -> None:
    """Resolve the hostname and reject private/loopback/link-local/metadata targets."""
    if not hostname:
        raise HTTPException(422, detail={"code": "invalid_url", "message": "URL has no host."})
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror:
        raise HTTPException(422, detail={
            "code": "unresolvable_host", "message": f"Cannot resolve host '{hostname}'."})
    for _family, _type, _proto, _canon, sockaddr in infos:
        try:
            ip = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified or str(ip) == "169.254.169.254"):
            raise HTTPException(422, detail={
                "code": "ssrf_blocked",
                "message": "URL resolves to a private, loopback, or metadata address."})


def _fetch_spec(url: str) -> bytes:
    """GET the spec with a 10s timeout, 5MB cap, http/https only, and manual redirect
    following (max 3 hops) so every hop's host passes the SSRF guard."""
    redirects = 0
    while True:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https"):
            raise HTTPException(422, detail={
                "code": "invalid_url", "message": "Only http/https URLs are allowed."})
        _assert_public_host(parts.hostname)
        try:
            with httpx.Client(timeout=FETCH_TIMEOUT_S, follow_redirects=False) as client:
                with client.stream("GET", url) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        redirects += 1
                        if redirects > MAX_REDIRECTS:
                            raise HTTPException(422, detail={
                                "code": "too_many_redirects",
                                "message": f"More than {MAX_REDIRECTS} redirects."})
                        location = resp.headers.get("location")
                        if not location:
                            raise HTTPException(422, detail={
                                "code": "bad_redirect",
                                "message": "Redirect without a Location header."})
                        url = urljoin(url, location)
                        continue
                    if resp.status_code >= 400:
                        raise HTTPException(422, detail={
                            "code": "fetch_failed",
                            "message": f"URL returned HTTP {resp.status_code}."})
                    declared = resp.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > MAX_SPEC_BYTES:
                        raise HTTPException(422, detail={
                            "code": "spec_too_large",
                            "message": "Specification exceeds the 5MB limit."})
                    buf = bytearray()
                    for chunk in resp.iter_bytes():
                        buf.extend(chunk)
                        if len(buf) > MAX_SPEC_BYTES:
                            raise HTTPException(422, detail={
                                "code": "spec_too_large",
                                "message": "Specification exceeds the 5MB limit."})
                    return bytes(buf)
        except HTTPException:
            raise
        except httpx.HTTPError as exc:
            raise HTTPException(422, detail={
                "code": "fetch_failed",
                "message": f"Could not fetch URL ({exc.__class__.__name__})."})


# --- parsing & structural validation --------------------------------------------------

def _parse_spec_bytes(raw: bytes) -> object:
    text = raw.decode("utf-8", errors="replace")
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise HTTPException(422, detail={
                "code": "parse_error", "message": "Invalid JSON specification.",
                "errors": [str(exc)]})
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise HTTPException(422, detail={
            "code": "parse_error", "message": "Invalid YAML specification.",
            "errors": [str(exc)]})


def _validate_structure(spec: object) -> str:
    """Return 'openapi3' | 'swagger2', or raise 422 with a specific errors list."""
    errors: list[str] = []
    if not isinstance(spec, dict):
        errors.append("Specification root must be a mapping/object.")
        raise HTTPException(422, detail={
            "code": "invalid_spec", "message": "Not a valid API specification.",
            "errors": errors})
    fmt = ""
    if spec.get("swagger") == "2.0":
        fmt = "swagger2"
    elif str(spec.get("openapi", "")).startswith("3"):
        fmt = "openapi3"
    else:
        errors.append("Missing version marker: expected 'openapi: 3.x' or 'swagger: \"2.0\"'.")
    paths = spec.get("paths")
    if not isinstance(paths, dict):
        errors.append("Specification has no 'paths' object.")
    elif not paths:
        errors.append("'paths' object is empty — nothing to import.")
    if errors:
        raise HTTPException(422, detail={
            "code": "invalid_spec", "message": "Not a valid API specification.",
            "errors": errors})
    return fmt


# --- $ref resolution (internal refs only, cycle-safe) ----------------------------------

def _resolve(node, root, _seen: frozenset = frozenset()):
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str):
            if not ref.startswith("#/"):
                raise ValueError(f"unsupported external $ref: {ref}")
            if ref in _seen:
                return {"type": "object"}  # cycle — collapse to an opaque object
            target = root
            for part in ref[2:].split("/"):
                part = part.replace("~1", "/").replace("~0", "~")
                if not isinstance(target, dict) or part not in target:
                    raise ValueError(f"broken $ref: {ref}")
                target = target[part]
            return _resolve(target, root, _seen | {ref})
        return {k: _resolve(v, root, _seen) for k, v in node.items()}
    if isinstance(node, list):
        return [_resolve(v, root, _seen) for v in node]
    return node


# --- flattening ------------------------------------------------------------------------

def _constraints_from(schema: dict) -> dict:
    return {k: schema[k] for k in CONSTRAINT_KEYS if k in schema}


def _json_media_schema(container: dict) -> dict | None:
    """Prefer application/json; fall back to the first declared media type."""
    content = container.get("content")
    if not isinstance(content, dict) or not content:
        return None
    media = content.get("application/json")
    if not isinstance(media, dict):
        media = next((v for v in content.values() if isinstance(v, dict)), None)
    if not isinstance(media, dict):
        return None
    schema = media.get("schema")
    return schema if isinstance(schema, dict) else None


def _collect_params(raw_params: list, fmt: str) -> tuple[list, dict | None]:
    """Normalize parameters; a swagger2 body parameter becomes the request_schema."""
    request_schema = None
    merged: dict[tuple, dict] = {}
    for p in raw_params:
        if not isinstance(p, dict) or not p.get("name") and p.get("in") != "body":
            continue
        merged[(p.get("name", ""), p.get("in", ""))] = p  # operation-level overrides path-level

    params = []
    for p in merged.values():
        location = p.get("in", "")
        if fmt == "swagger2" and location == "body":
            schema = p.get("schema")
            request_schema = schema if isinstance(schema, dict) else None
            continue
        # openapi3 keeps the schema nested; swagger2 non-body params carry it inline
        schema_src = p.get("schema") if isinstance(p.get("schema"), dict) else p
        params.append({
            "name": p.get("name", ""),
            "location": location,  # path|query|header|cookie|formData
            "type": schema_src.get("type", ""),
            "required": bool(p.get("required", location == "path")),
            "constraints": _constraints_from(schema_src),
        })
    return params, request_schema


def _response_schemas(op: dict, fmt: str) -> dict:
    out = {}
    for status, robj in (op.get("responses") or {}).items():
        if not isinstance(robj, dict):
            continue
        if fmt == "swagger2":
            schema = robj.get("schema")
            schema = schema if isinstance(schema, dict) else None
        else:
            schema = _json_media_schema(robj)
        if schema is not None:
            out[str(status)] = schema
    return out


def _flatten(spec: dict, fmt: str) -> tuple[list[dict], list[dict]]:
    """Flatten every operation into an endpoint dict. A broken operation is appended to
    warnings and skipped — one bad ref never sinks the import (FR-DSC-04)."""
    operations: list[dict] = []
    warnings: list[dict] = []
    root_security = spec.get("security") if isinstance(spec.get("security"), list) else []

    for path, item in (spec.get("paths") or {}).items():
        if not isinstance(item, dict):
            warnings.append({"path": str(path), "method": "*",
                             "error": "Path item is not an object."})
            continue
        for method in HTTP_METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            try:
                resolved = _resolve(op, spec)
                path_params = [_resolve(p, spec) for p in item.get("parameters", [])
                               if isinstance(p, dict)]
                raw_params = path_params + [p for p in (resolved.get("parameters") or [])
                                            if isinstance(p, dict)]
                params, request_schema = _collect_params(raw_params, fmt)
                if fmt == "openapi3" and request_schema is None:
                    body = resolved.get("requestBody")
                    if isinstance(body, dict):
                        request_schema = _json_media_schema(body)
                security = resolved["security"] if "security" in resolved else root_security
                operations.append({
                    "method": method.upper(),
                    "path": str(path),
                    "operation_id": str(resolved.get("operationId") or ""),
                    "summary": str(resolved.get("summary")
                                   or resolved.get("description") or "")[:500],
                    "parameters": params,
                    "request_schema": request_schema,
                    "response_schemas": _response_schemas(resolved, fmt),
                    "security": security if isinstance(security, list) else [],
                    "tags": [str(t) for t in (resolved.get("tags") or [])],
                })
            except Exception as exc:  # noqa: BLE001 — degrade per-operation
                warnings.append({"path": str(path), "method": method.upper(),
                                 "error": str(exc)})
    return operations, warnings


# --- diff & serialization ---------------------------------------------------------------

def _op_key(method: str, path: str) -> str:
    return f"{method.upper()} {path}"


def _signature(parameters, request_schema, response_schemas, security) -> str:
    return json.dumps({"p": parameters, "rq": request_schema,
                       "rs": response_schemas, "sec": security},
                      sort_keys=True, default=str)


def _endpoint_dict(e: Endpoint) -> dict:
    return {
        "id": e.id, "api_spec_id": e.api_spec_id, "project_id": e.project_id,
        "method": e.method, "path": e.path, "operation_id": e.operation_id,
        "summary": e.summary, "parameters": e.parameters,
        "request_schema": e.request_schema, "response_schemas": e.response_schemas,
        "security": e.security, "tags": e.tags, "excluded": e.excluded,
    }


# --- routes -------------------------------------------------------------------------------

@router.post("/projects/{project_id}/api-specs", status_code=201)
async def import_api_spec(project_id: str, request: Request,
                          user: User = Depends(require("import_spec")),
                          db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)

    content_type = (request.headers.get("content-type") or "").lower()
    if content_type.startswith("multipart/"):
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, StarletteUploadFile):
            raise HTTPException(422, detail={
                "code": "missing_file",
                "message": "Multipart request must include a 'file' part."})
        raw = await upload.read()
        if len(raw) > MAX_SPEC_BYTES:
            raise HTTPException(422, detail={
                "code": "spec_too_large", "message": "Specification exceeds the 5MB limit."})
        source = upload.filename or "spec"
    else:
        try:
            body = await request.json()
        except Exception:
            body = None
        url = body.get("url") if isinstance(body, dict) else None
        if not url or not isinstance(url, str):
            raise HTTPException(422, detail={
                "code": "invalid_request",
                "message": "Provide a multipart 'file' or a JSON body {\"url\": \"...\"}."})
        raw = _fetch_spec(url)
        source = url

    spec = _parse_spec_bytes(raw)
    fmt = _validate_structure(spec)
    operations, warnings = _flatten(spec, fmt)

    # swagger2 host/basePath are recorded as spec source metadata
    if fmt == "swagger2":
        notes = [f"{key}={spec[key]}" for key in ("host", "basePath") if spec.get(key)]
        if notes:
            source = f"{source} [{'; '.join(notes)}]"
    source = source[:500]
    title = str((spec.get("info") or {}).get("title") or "")[:300]

    old_rows = db.query(Endpoint).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == user.organisation_id).all()
    old_by_key = {_op_key(e.method, e.path): e for e in old_rows}
    new_by_key = {_op_key(op["method"], op["path"]): op for op in operations}

    diff = {
        "added": sorted(k for k in new_by_key if k not in old_by_key),
        "removed": sorted(k for k in old_by_key if k not in new_by_key),
        "changed": sorted(
            k for k, op in new_by_key.items()
            if k in old_by_key and _signature(
                op["parameters"], op["request_schema"],
                op["response_schemas"], op["security"],
            ) != _signature(
                old_by_key[k].parameters, old_by_key[k].request_schema,
                old_by_key[k].response_schemas, old_by_key[k].security,
            )
        ),
    }

    spec_row = db.query(ApiSpec).filter(
        ApiSpec.project_id == project_id,
        ApiSpec.organisation_id == user.organisation_id,
    ).order_by(ApiSpec.version.desc()).first()
    if spec_row:
        spec_row.version += 1
        spec_row.source = source
        spec_row.format = fmt
        spec_row.title = title
    else:
        spec_row = ApiSpec(organisation_id=user.organisation_id, project_id=project_id,
                           source=source, format=fmt, version=1, title=title)
        db.add(spec_row)
    db.flush()

    # REPLACE the inventory: detach grounding links, drop old rows, insert fresh ones
    old_ids = [e.id for e in old_rows]
    if old_ids:
        db.query(TestStep).filter(TestStep.endpoint_id.in_(old_ids)).update(
            {TestStep.endpoint_id: None}, synchronize_session=False)
        db.query(Endpoint).filter(Endpoint.id.in_(old_ids)).delete(synchronize_session=False)

    for key, op in new_by_key.items():
        prior = old_by_key.get(key)
        db.add(Endpoint(
            organisation_id=user.organisation_id, api_spec_id=spec_row.id,
            project_id=project_id, method=op["method"], path=op["path"],
            operation_id=op["operation_id"], summary=op["summary"],
            parameters=op["parameters"], request_schema=op["request_schema"],
            response_schemas=op["response_schemas"], security=op["security"],
            tags=op["tags"],
            excluded=prior.excluded if prior else False,  # FR-DSC-05 survives re-import
        ))

    audit(db, user.organisation_id, user.id, "spec.imported", "api_spec", spec_row.id,
          {"source": source, "format": fmt, "version": spec_row.version,
           "endpoints": len(new_by_key), "warnings": len(warnings)})
    db.commit()

    return {
        "spec_id": spec_row.id,
        "version": spec_row.version,
        "endpoints_count": len(new_by_key),
        "warnings": warnings,
        "diff": diff,
    }


def _endpoint_coverage(db: Session, project_id: str, org_id: str,
                       endpoints: list[Endpoint]) -> dict[str, dict]:
    """FR-024 endpoint coverage map, computed at read time from approved-case steps:
    test_count, covered_params_pct (100 when the endpoint has no params), last_outcome."""
    out = {e.id: {"test_count": 0, "covered_params_pct": 100.0, "last_outcome": None}
           for e in endpoints}
    ep_ids = list(out)
    if not ep_ids:
        return out

    step_rows = (db.query(TestStep.endpoint_id, TestStep.test_case_id, TestStep.request)
                 .join(TestCase, TestCase.id == TestStep.test_case_id)
                 .filter(TestStep.endpoint_id.in_(ep_ids),
                         TestCase.state == "approved",
                         TestCase.project_id == project_id,
                         TestCase.organisation_id == org_id)
                 .all())
    cases_by_ep: dict[str, set] = {}
    eps_by_case: dict[str, set] = {}
    referenced: dict[str, set] = {}
    for ep_id, case_id, request in step_rows:
        cases_by_ep.setdefault(ep_id, set()).add(case_id)
        eps_by_case.setdefault(case_id, set()).add(ep_id)
        req = request or {}
        names = set(req.get("params") or {}) | set(req.get("headers") or {})
        referenced.setdefault(ep_id, set()).update(str(n).lower() for n in names)

    for e in endpoints:
        out[e.id]["test_count"] = len(cases_by_ep.get(e.id, ()))
        params = [p for p in (e.parameters or []) if isinstance(p, dict) and p.get("name")]
        if params:
            refs = referenced.get(e.id, set())
            covered = sum(1 for p in params if str(p["name"]).lower() in refs)
            out[e.id]["covered_params_pct"] = round(covered / len(params) * 100, 1)

    case_ids = list(eps_by_case)
    if case_ids:
        res_rows = (db.query(TestResult.test_case_id, TestResult.outcome)
                    .filter(TestResult.test_case_id.in_(case_ids))
                    .order_by(TestResult.created_at.asc(), TestResult.id.asc())
                    .all())
        for case_id, outcome in res_rows:  # ascending: the last write wins = newest
            for ep_id in eps_by_case.get(case_id, ()):
                out[ep_id]["last_outcome"] = outcome
    return out


@router.get("/projects/{project_id}/endpoints")
def list_endpoints(project_id: str, user: User = Depends(require("view")),
                   db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    rows = db.query(Endpoint).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == user.organisation_id,
    ).order_by(Endpoint.path.asc(), Endpoint.method.asc()).all()
    coverage = _endpoint_coverage(db, project_id, user.organisation_id, rows)
    payload = []
    for e in rows:
        d = _endpoint_dict(e)
        d.update(coverage[e.id])
        payload.append(d)
    return payload


@router.patch("/endpoints/{endpoint_id}")
def update_endpoint(endpoint_id: str, body: dict = Body(...),
                    user: User = Depends(require("import_spec")),
                    db: Session = Depends(get_db)):
    endpoint = db.get(Endpoint, endpoint_id)
    if not endpoint or endpoint.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Endpoint not found"})
    excluded = body.get("excluded")
    if not isinstance(excluded, bool):
        raise HTTPException(422, detail={
            "code": "invalid_request", "message": "Body must be {\"excluded\": true|false}."})
    endpoint.excluded = excluded
    audit(db, user.organisation_id, user.id, "endpoint.excluded_toggled",
          "endpoint", endpoint.id, {"excluded": excluded})
    db.commit()
    return _endpoint_dict(endpoint)
