"""Discovery Engine (TRD §4.2) — fully deterministic, NO LLM.

Imports an API description (multipart file or URL) and flattens every operation into
an Endpoint inventory row. That inventory is the ground truth the generation module's
grounding gate validates against — which is why this engine is deterministic end to
end. Five input formats share ONE route:

  * OpenAPI 3.x / Swagger 2.0 — parsed here, internal $refs resolved cycle-safely.
  * Postman Collection v2.0/v2.1, HAR 1.2, Insomnia v4 — converted by
    modules/collections.py into the identical inventory shape.

Broken/unresolvable operations are recorded as warnings and skipped, never fatal
(FR-DSC-04). URL fetches are SSRF-guarded. Re-import bumps the spec version and
rewrites the endpoint inventory, returning an added/removed/changed diff — subject
to the fidelity order spec > traffic > dom > postman (SRS §L2): an import never
overwrites or deletes rows discovered by a higher-fidelity mode.

Collection imports may additionally be annotated by the optional AI enrichment step
(modules/enrichment.py) when the project runs on automation=auto. That step can only
add commentary to rows this file already created — see the gate documented there.
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
from ..models import ApiSpec, Endpoint, Environment, TestCase, TestResult, TestStep, User
from .collections import (COLLECTION_FORMATS, SUPPORTED_FORMATS_HINT, convert,
                          derive_environment, detect_format, imported_environment_name)
from .enrichment import enrich
from .generation import try_autopilot_generation
from .projects import EnvironmentCreate, create_environment_record

router = APIRouter()

MAX_SPEC_BYTES = 5 * 1024 * 1024
FETCH_TIMEOUT_S = 10.0
MAX_REDIRECTS = 3
HTTP_METHODS = ("get", "post", "put", "patch", "delete", "head", "options")
# "example"/"default" are not constraints, but they are the document's own
# statement of a usable value — the generator prefers them over a synthesised
# one, which is what makes a path parameter address a real resource.
CONSTRAINT_KEYS = ("format", "minimum", "maximum", "minLength", "maxLength", "pattern", "enum",
                   "example", "default")

# Discovery-mode fidelity (SRS §L2). A declared contract beats observed traffic,
# which beats a crawled DOM, which beats a hand-curated request collection. The
# ranking decides who wins when two modes describe the same method+path.
FIDELITY = {"spec": 3, "traffic": 2, "dom": 1, "postman": 0}


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
    """Return 'openapi3' | 'swagger2', or raise 422 with a specific errors list.

    Only reached once collection detection has already declined the document, so
    every rejection names the formats that WOULD have been accepted — a 422 that
    just says "invalid" leaves the owner guessing why their real Postman export
    was refused.
    """
    errors: list[str] = []
    if not isinstance(spec, dict):
        errors.append("Specification root must be a mapping/object.")
        errors.append(SUPPORTED_FORMATS_HINT)
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
        errors.append(SUPPORTED_FORMATS_HINT)
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
        constraints = _constraints_from(schema_src)
        # OpenAPI 3 allows example/examples beside the schema, not only inside it.
        if "example" not in constraints and p.get("example") is not None:
            constraints["example"] = p["example"]
        if "example" not in constraints and isinstance(p.get("examples"), dict) and p["examples"]:
            first = next(iter(p["examples"].values()))
            if isinstance(first, dict) and "value" in first:
                constraints["example"] = first["value"]
        params.append({
            "name": p.get("name", ""),
            "location": location,  # path|query|header|cookie|formData
            "type": schema_src.get("type", ""),
            "required": bool(p.get("required", location == "path")),
            "constraints": constraints,
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
        # Which discovery mode found this endpoint, and how many times traffic
        # capture observed it — shown on the coverage map (FR-024) once the
        # non-spec modes land (FR-021/022/023).
        "source": e.source, "observed_count": e.observed_count,
        # Optional AI annotations (nullable). Commentary only — every one was
        # matched back to this exact method+path before being stored.
        "ai_description": e.ai_description, "ai_group": e.ai_group,
        "ai_criticality": e.ai_criticality,
    }


# --- environment auto-creation (contract item 3) -------------------------------------------

def _autocreate_environment(db: Session, user: User, project_id: str, spec: object,
                            fmt: str, title: str) -> dict | None:
    """Fill an EMPTY Environments list from the document that was just imported.

    "I only added a Postman collection for the API connection" — and the New run
    screen still had nothing to run against, because the base URL sitting in the
    uploaded file was never turned into an environment. This closes that gap.

    Three conditions, all required, none negotiable:
      * the project currently has ZERO environments — this fills a void, it never
        touches, overwrites or shadows an environment the owner already has;
      * a base URL could be DERIVED from the document (collections.derive_environment,
        deterministic, no LLM, no invented host);
      * creation goes through the projects module's write path, so the derived
        environment is validated and audited exactly like a hand-typed one.

    Returns the {id, name, base_url} payload, or None when nothing was created.
    The caller commits; a failure here is not worth failing an otherwise good
    import over, so it degrades to None.
    """
    # Derivation and request-model validation are pure and may be swallowed.
    # The database write below deliberately is NOT wrapped: a half-failed flush
    # must surface, not poison the transaction the caller is about to commit.
    try:
        derived = derive_environment(spec, fmt)
        body = EnvironmentCreate(
            name=imported_environment_name(title),
            base_url=derived["base_url"],
            auth_type="none",  # the document proves a URL, it never proves a credential
            variables=derived["variables"],
            tls_strict=True,
        ) if derived else None
    except Exception:  # noqa: BLE001 — a convenience must never sink the import
        return None
    if body is None:
        return None

    existing = db.query(Environment.id).filter(
        Environment.project_id == project_id,
        Environment.organisation_id == user.organisation_id).first()
    if existing is not None:
        return None

    env = create_environment_record(
        db, org_id=user.organisation_id, user_id=user.id, project_id=project_id, body=body,
        action="environment.autocreated",
        # the source format is what makes this entry auditable; variable NAMES
        # are recorded, values never are (credentials arrive empty by design).
        extra_audit={"format": fmt, "base_url": body.base_url,
                     "variables": sorted(body.variables)},
    )
    return {"id": env.id, "name": env.name, "base_url": env.base_url}


# --- routes -------------------------------------------------------------------------------

@router.post("/projects/{project_id}/api-specs", status_code=201)
async def import_api_spec(project_id: str, request: Request,
                          user: User = Depends(require("import_spec")),
                          db: Session = Depends(get_db)):
    project = get_project_scoped(project_id, user, db)

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
    # ONE route, five formats: collection formats are converted deterministically
    # into the same inventory _flatten produces; anything else takes the original
    # OpenAPI/Swagger path, unchanged.
    fmt = detect_format(spec)
    if fmt in COLLECTION_FORMATS:
        operations, warnings, title, incoming_source = convert(spec, fmt)
    else:
        fmt = _validate_structure(spec)
        operations, warnings = _flatten(spec, fmt)
        title = str((spec.get("info") or {}).get("title") or "")
        incoming_source = "spec"

    # swagger2 host/basePath are recorded as spec source metadata
    if fmt == "swagger2":
        notes = [f"{key}={spec[key]}" for key in ("host", "basePath") if spec.get(key)]
        if notes:
            source = f"{source} [{'; '.join(notes)}]"
    source = source[:500]
    title = title[:300]

    old_rows = db.query(Endpoint).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == user.organisation_id).all()
    old_by_key = {_op_key(e.method, e.path): e for e in old_rows}
    new_by_key = {_op_key(op["method"], op["path"]): op for op in operations}

    # FIDELITY GATE (SRS §L2). An incoming operation is written only when its mode
    # ranks at least as high as the mode that produced the existing row — so a
    # Postman import can never downgrade an endpoint already known from a spec,
    # while a later spec import overwrites collection-derived rows. Rows this
    # import does not cover are deleted only when they came from the SAME mode:
    # importing a spec must not delete endpoints discovered from a collection.
    incoming_rank = FIDELITY.get(incoming_source, 0)
    writable = {
        k for k in new_by_key
        if k not in old_by_key
        or incoming_rank >= FIDELITY.get(old_by_key[k].source or "spec", 0)
    }
    superseded = [k for k in old_by_key if k not in new_by_key
                  and (old_by_key[k].source or "spec") == incoming_source]

    diff = {
        "added": sorted(k for k in new_by_key if k not in old_by_key),
        "removed": sorted(superseded),
        "changed": sorted(
            k for k, op in new_by_key.items()
            if k in old_by_key and k in writable and _signature(
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

    # REWRITE the inventory: detach grounding links, drop the rows this import
    # replaces or supersedes, insert fresh ones. Rows held by a higher-fidelity
    # mode, and rows of another mode this document simply does not mention, are
    # left exactly as they are.
    old_ids = [old_by_key[k].id for k in set(superseded) | (writable & set(old_by_key))]
    if old_ids:
        db.query(TestStep).filter(TestStep.endpoint_id.in_(old_ids)).update(
            {TestStep.endpoint_id: None}, synchronize_session=False)
        db.query(Endpoint).filter(Endpoint.id.in_(old_ids)).delete(synchronize_session=False)

    rows_by_key: dict[tuple[str, str], Endpoint] = {}
    for key, op in new_by_key.items():
        if key not in writable:
            continue  # a higher-fidelity mode already owns this method+path
        prior = old_by_key.get(key)
        row = Endpoint(
            organisation_id=user.organisation_id, api_spec_id=spec_row.id,
            project_id=project_id, method=op["method"], path=op["path"],
            operation_id=op["operation_id"], summary=op["summary"],
            parameters=op["parameters"], request_schema=op["request_schema"],
            response_schemas=op["response_schemas"], security=op["security"],
            tags=op["tags"],
            excluded=prior.excluded if prior else False,  # FR-DSC-05 survives re-import
            source=op.get("source", "spec"),
            observed_count=op.get("observed_count", 0),
            # annotations survive a re-import the same way `excluded` does
            ai_description=prior.ai_description if prior else None,
            ai_group=prior.ai_group if prior else None,
            ai_criticality=prior.ai_criticality if prior else None,
        )
        db.add(row)
        rows_by_key[(op["method"].upper(), op["path"])] = row

    # AI ENRICHMENT (contract item 3) — collection imports only, automation=auto
    # only, and strictly after the deterministic inventory exists. The model sees
    # the derived inventory, never the uploaded file; every annotation it returns
    # is matched back to a method+path above or discarded. A failure here costs
    # annotations, never the import.
    enriched = enrichment_discarded = 0
    if fmt in COLLECTION_FORMATS and project.automation == "auto":
        annotations, enrichment_discarded = enrich(
            [op for k, op in new_by_key.items() if k in writable])
        for key, annotation in annotations.items():
            row = rows_by_key.get(key)
            if row is None:
                enrichment_discarded += 1
                continue
            row.ai_description = annotation["ai_description"]
            row.ai_group = annotation["ai_group"] or None
            row.ai_criticality = annotation["ai_criticality"]
            enriched += 1

    audit(db, user.organisation_id, user.id, "spec.imported", "api_spec", spec_row.id,
          {"source": source, "format": fmt, "version": spec_row.version,
           "endpoints": len(new_by_key), "warnings": len(warnings),
           "enriched": enriched, "enrichment_discarded": enrichment_discarded})

    environment_created = _autocreate_environment(db, user, project_id, spec, fmt, title)
    db.commit()

    total = db.query(Endpoint).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == user.organisation_id).count()

    # Autopilot (contract 4b): a successful spec import may complete the
    # "endpoints + confirmed requirements" precondition — try the generation
    # trigger, attributed to the importing user. No-op unless automation=auto.
    if project.automation == "auto":
        try_autopilot_generation(db, user.organisation_id, user.id, project_id)

    return {
        "spec_id": spec_row.id,
        "version": spec_row.version,
        # endpoints_count keeps its original meaning: operations found in THIS
        # document. `total` is the project inventory after the fidelity rules ran.
        "endpoints_count": len(new_by_key),
        "warnings": warnings,
        "diff": diff,
        "format": fmt,
        "added": len(diff["added"]),
        "updated": len(writable & set(old_by_key)),
        "removed": len(diff["removed"]),
        "total": total,
        "enriched": enriched,
        "enrichment_discarded": enrichment_discarded,
        # null unless THIS import filled an empty Environments list (contract 4).
        "environment_created": environment_created,
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
