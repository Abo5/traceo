"""Discovery sources beyond the specification (TRD §4.2 · FR-021, FR-022, FR-023).

A specification is the highest-fidelity description of an API, but most systems that
need testing do not have a current one. This module builds the same endpoint surface
from what the running system actually does:

FR-021 Traffic capture  observed requests (HAR from a proxy or the headless driver)
                        become endpoints; concrete paths are generalised into
                        templates; every observation increments a counter; credentials
                        are redacted BEFORE anything is written.
FR-022 DOM crawl        form fields, their types, required flags, patterns and any RTL
                        container are attached to the endpoint the form submits to.
FR-023 Postman import   a v2.1 collection is treated as a discovered surface; folders
                        become tags; unresolved variables are reported, not guessed.

Merge rule (SRS §4.2): one surface, highest-fidelity source wins per attribute —
openapi > traffic > dom > postman. Observation counts always accumulate.
"""
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import audit, get_project_scoped, require
from ..models import ApiSpec, Endpoint, TestStep, User

router = APIRouter()

SOURCE_FIDELITY = {"openapi": 3, "traffic": 2, "dom": 1, "postman": 0}

# Anything matching these names is a credential: never stored, in any position.
_SECRET_NAME_RE = re.compile(
    r"(authorization|cookie|token|secret|password|passwd|api[-_]?key|"
    r"x-api-key|session|credential|bearer|auth)", re.IGNORECASE)
REDACTED = "«redacted»"

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HEX_RE = re.compile(r"^[0-9a-f]{16,}$", re.I)
_DIGITS_RE = re.compile(r"^\d+$")
_ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Prefixed business identifiers — CUST-001, ORD-1001, INV-2001, REQ_14. The digit
# requirement is what separates an identifier from a hyphenated word like
# "sign-up" or "order-history", which must stay a literal path segment.
_PREFIXED_ID_RE = re.compile(r"^[A-Za-z]{1,12}[-_][0-9A-Za-z]{1,24}$")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Path templating (FR-021 AC2)
# ---------------------------------------------------------------------------

def templatize(path: str) -> str:
    """`/orders/8812` -> `/orders/{orderId}`. A segment is treated as an identifier
    when it is numeric, a UUID/ULID, a long hex string, an ISO date, or a prefixed
    business id such as `CUST-001` — the dominant style in the systems this product
    tests. The template name is derived from the preceding segment so two different
    collections do not collide: `/orders/{orderId}` and `/users/{userId}`."""
    if not path:
        return "/"
    if not path.startswith("/"):
        path = "/" + path
    segments = path.split("/")
    out: list[str] = []
    for index, segment in enumerate(segments):
        if not segment:
            out.append(segment)
            continue
        prefixed_id = bool(_PREFIXED_ID_RE.match(segment)) and any(ch.isdigit() for ch in segment)
        if (_DIGITS_RE.match(segment) or _UUID_RE.match(segment)
                or _HEX_RE.match(segment) or _ULID_RE.match(segment)
                or _DATE_RE.match(segment) or prefixed_id):
            parent = ""
            for prior in reversed(segments[:index]):
                if prior and not prior.startswith("{"):
                    parent = prior
                    break
            name = "id"
            if parent:
                singular = parent[:-3] + "y" if parent.endswith("ies") else parent.rstrip("s")
                name = f"{singular}Id" if singular else "id"
            out.append("{" + name + "}")
        else:
            out.append(segment)
    return "/".join(out) or "/"


# ---------------------------------------------------------------------------
# Redaction (FR-021 AC4) — applied at capture point, before persistence
# ---------------------------------------------------------------------------

def redact_pairs(pairs: dict) -> dict:
    return {k: (REDACTED if _SECRET_NAME_RE.search(str(k)) else v)
            for k, v in (pairs or {}).items()}


def redact_value(value):
    """Recursively blank out credential-shaped keys anywhere in a body."""
    if isinstance(value, dict):
        return {k: (REDACTED if _SECRET_NAME_RE.search(str(k)) else redact_value(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [redact_value(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# Shape inference — the "inferred" schema FR-041 AC2 falls back to
# ---------------------------------------------------------------------------

def infer_schema(value) -> dict:
    if isinstance(value, bool):
        return {"type": "boolean"}
    if isinstance(value, int):
        return {"type": "integer"}
    if isinstance(value, float):
        return {"type": "number"}
    if isinstance(value, str):
        return {"type": "string"}
    if value is None:
        return {"type": "null"}
    if isinstance(value, list):
        return {"type": "array", "items": infer_schema(value[0]) if value else {}}
    if isinstance(value, dict):
        return {"type": "object",
                "properties": {k: infer_schema(v) for k, v in value.items()},
                "x-traceo-inferred": True}
    return {}


def merge_schema(a: dict | None, b: dict | None) -> dict:
    """Union two inferred shapes: a field seen in either observation is kept, and a
    field whose type differs between observations widens to no constraint."""
    if not a:
        return b or {}
    if not b:
        return a
    if a.get("type") != b.get("type"):
        return {"x-traceo-inferred": True}
    if a.get("type") == "object":
        props = dict(a.get("properties") or {})
        for key, schema in (b.get("properties") or {}).items():
            props[key] = merge_schema(props.get(key), schema)
        return {"type": "object", "properties": props, "x-traceo-inferred": True}
    if a.get("type") == "array":
        return {"type": "array", "items": merge_schema(a.get("items"), b.get("items")),
                "x-traceo-inferred": True}
    return a


# ---------------------------------------------------------------------------
# HAR parsing (FR-021)
# ---------------------------------------------------------------------------

_IGNORED_CONTENT = re.compile(
    r"(text/html|text/css|javascript|image/|font/|video/|audio/|"
    r"application/wasm|text/plain;\s*charset=utf-8$)", re.IGNORECASE)


def _looks_like_api(entry_url: str, mime: str, accept_all: bool) -> bool:
    if accept_all:
        return True
    if mime and not _IGNORED_CONTENT.search(mime):
        return True
    path = urlparse(entry_url).path or ""
    return bool(re.search(r"(^|/)(api|v\d+|graphql|rest)(/|$)", path, re.IGNORECASE))


def parse_har(har: dict, base_url: str | None = None,
              include_all: bool = False) -> tuple[list[dict], list[dict]]:
    """HAR -> observation records. Returns (observations, warnings).

    Each observation is {method, path, query, request_schema, response_schemas,
    times_seen, security} with every credential already redacted."""
    entries = ((har or {}).get("log") or {}).get("entries")
    if not isinstance(entries, list):
        raise ValueError("not a HAR document: expected log.entries[]")

    base_path = urlparse(base_url).path.rstrip("/") if base_url else ""
    observed: dict[tuple[str, str], dict] = {}
    warnings: list[dict] = []

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        request = entry.get("request") or {}
        response = entry.get("response") or {}
        url = str(request.get("url") or "")
        method = str(request.get("method") or "GET").upper()
        if not url:
            continue
        content = response.get("content") or {}
        mime = str(content.get("mimeType") or "")
        if not _looks_like_api(url, mime, include_all):
            continue

        parsed = urlparse(url)
        path = parsed.path or "/"
        if base_path and path.startswith(base_path):
            path = path[len(base_path):] or "/"
        template = templatize(path)
        key = (method, template)

        record = observed.setdefault(key, {
            "method": method, "path": template, "times_seen": 0,
            "parameters": {}, "request_schema": None, "response_schemas": {},
            "security": [], "sample_paths": [],
        })
        record["times_seen"] += 1
        if path not in record["sample_paths"] and len(record["sample_paths"]) < 3:
            record["sample_paths"].append(path)

        # Query + path parameters — names only; values are never persisted.
        for q in request.get("queryString") or []:
            name = str((q or {}).get("name") or "")
            if name:
                record["parameters"].setdefault(name, {
                    "name": name, "in": "query", "type": "string",
                    "required": False, "constraints": {}})
        for token in re.findall(r"\{([^}]+)\}", template):
            record["parameters"].setdefault(token, {
                "name": token, "in": "path", "type": "string",
                "required": True, "constraints": {}})

        # Auth scheme observed on the wire (never the credential itself).
        for header in request.get("headers") or []:
            name = str((header or {}).get("name") or "").lower()
            if name == "authorization":
                value = str(header.get("value") or "")
                scheme = value.split(" ", 1)[0].lower() if value else "bearer"
                marker = {"observed": scheme or "bearer"}
                if marker not in record["security"]:
                    record["security"].append(marker)

        post = request.get("postData") or {}
        raw_request = post.get("text")
        if raw_request:
            try:
                body = json.loads(raw_request)
                record["request_schema"] = merge_schema(
                    record["request_schema"], infer_schema(redact_value(body)))
            except (ValueError, TypeError):
                warnings.append({"method": method, "path": template,
                                 "warning": "request body was not JSON; shape not inferred"})

        status = str(response.get("status") or "")
        raw_response = content.get("text")
        if status and raw_response:
            try:
                body = json.loads(raw_response)
            except (ValueError, TypeError):
                body = None
            if body is not None:
                schemas = record["response_schemas"]
                schemas[status] = merge_schema(schemas.get(status),
                                               infer_schema(redact_value(body)))

    for record in observed.values():
        record["parameters"] = list(record["parameters"].values())
    return list(observed.values()), warnings


# ---------------------------------------------------------------------------
# Postman v2.1 (FR-023)
# ---------------------------------------------------------------------------

def parse_postman(collection: dict, variables: dict | None = None) -> tuple[list[dict], list[dict]]:
    """Collection -> endpoint records. Folders become tags (AC1); variables are
    resolved from the collection + supplied environment, and anything left
    unresolved is REPORTED rather than guessed (AC2)."""
    info = (collection or {}).get("info") or {}
    schema = str(info.get("schema") or "")
    if "v2.1" not in schema and "v2.0" not in schema:
        raise ValueError("expected a Postman Collection v2.1 document")

    resolved = {str(v.get("key")): str(v.get("value", ""))
                for v in (collection.get("variable") or []) if isinstance(v, dict)}
    resolved.update({str(k): str(v) for k, v in (variables or {}).items()})

    unresolved: set[str] = set()
    warnings: list[dict] = []

    def subst(text: str) -> str:
        def replace(match):
            name = match.group(1).strip()
            if name in resolved:
                return resolved[name]
            unresolved.add(name)
            return match.group(0)
        return re.sub(r"\{\{([^}]+)\}\}", replace, text or "")

    records: list[dict] = []

    def walk(items, folders: list[str]):
        for item in items or []:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("item"), list):
                walk(item["item"], folders + [str(item.get("name") or "")])
                continue
            request = item.get("request")
            if not isinstance(request, dict):
                continue
            method = str(request.get("method") or "GET").upper()
            url = request.get("url")
            if isinstance(url, dict):
                raw = str(url.get("raw") or "")
                query_names = [str(q.get("key")) for q in (url.get("query") or [])
                               if isinstance(q, dict) and q.get("key")]
            else:
                raw, query_names = str(url or ""), []
            raw = subst(raw)
            path = urlparse(raw).path or "/"
            if not path.startswith("/"):
                path = "/" + path
            template = re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", path)
            template = templatize(template)

            parameters = [{"name": n, "in": "query", "type": "string",
                           "required": False, "constraints": {}} for n in query_names]
            for token in re.findall(r"\{([^}]+)\}", template):
                parameters.append({"name": token, "in": "path", "type": "string",
                                   "required": True, "constraints": {}})

            request_schema = None
            body = request.get("body") or {}
            if str(body.get("mode")) == "raw" and body.get("raw"):
                try:
                    request_schema = infer_schema(redact_value(json.loads(subst(body["raw"]))))
                except (ValueError, TypeError):
                    warnings.append({"method": method, "path": template,
                                     "warning": "request body was not JSON; shape not inferred"})

            records.append({
                "method": method, "path": template,
                "operation_id": str(item.get("name") or "")[:200],
                "summary": str(item.get("name") or "")[:500],
                "parameters": parameters, "request_schema": request_schema,
                "response_schemas": {}, "security": [],
                "tags": [f for f in folders if f], "times_seen": 0,
            })

    walk(collection.get("item"), [])
    for name in sorted(unresolved):
        warnings.append({"warning": f"unresolved collection variable '{{{{{name}}}}}'",
                         "variable": name})
    return records, warnings


# ---------------------------------------------------------------------------
# DOM crawl payload (FR-022)
# ---------------------------------------------------------------------------

def parse_dom_forms(forms: list[dict], base_url: str | None = None) -> tuple[list[dict], list[dict]]:
    """Form descriptors -> endpoint records carrying `dom_fields`. Client-side
    validation attributes become candidate boundary/equivalence constraints (AC2)."""
    base_path = urlparse(base_url).path.rstrip("/") if base_url else ""
    records: list[dict] = []
    notes: list[dict] = []
    for form in forms or []:
        if not isinstance(form, dict):
            continue
        action = str(form.get("action") or "/")
        path = urlparse(action).path or "/"
        if base_path and path.startswith(base_path):
            path = path[len(base_path):] or "/"
        method = str(form.get("method") or "POST").upper()
        fields = []
        parameters = []
        for field in form.get("fields") or []:
            if not isinstance(field, dict) or not field.get("name"):
                continue
            constraints = {}
            for source, target in (("pattern", "pattern"), ("minlength", "minLength"),
                                   ("maxlength", "maxLength"), ("min", "minimum"),
                                   ("max", "maximum")):
                if field.get(source) not in (None, ""):
                    constraints[target] = field[source]
            entry = {"name": str(field["name"]),
                     "type": str(field.get("type") or "text"),
                     "required": bool(field.get("required")),
                     "constraints": constraints}
            fields.append(entry)
            parameters.append({"name": entry["name"], "in": "body",
                               "type": "string", "required": entry["required"],
                               "constraints": constraints})
        if form.get("dir") == "rtl" or form.get("rtl"):
            notes.append({"path": path, "note": "RTL container detected"})  # AC3
        if form.get("locale_switch"):
            notes.append({"path": path, "note": "locale switch detected"})
        records.append({
            "method": method, "path": templatize(path),
            "operation_id": str(form.get("id") or "")[:200],
            "summary": str(form.get("name") or form.get("id") or "")[:500],
            "parameters": parameters, "request_schema": None,
            "response_schemas": {}, "security": [], "tags": [],
            "dom_fields": fields, "times_seen": 0,
        })
    return records, notes


# ---------------------------------------------------------------------------
# Merge into the endpoint surface
# ---------------------------------------------------------------------------

def _spec_row_for(db: Session, org_id: str, project_id: str, source: str) -> ApiSpec:
    row = (db.query(ApiSpec)
           .filter(ApiSpec.project_id == project_id,
                   ApiSpec.organisation_id == org_id,
                   ApiSpec.format == source)
           .order_by(ApiSpec.version.desc()).first())
    if row:
        row.version += 1
        return row
    row = ApiSpec(organisation_id=org_id, project_id=project_id, source=source,
                  format=source, version=1, title=f"{source} discovery")
    db.add(row)
    db.flush()
    return row


def same_shape(a: str, b: str) -> bool:
    """Two templates describe the same endpoint when their literal segments match and
    their parameter positions line up — `/customers/{id}` and `/customers/{customerId}`
    are one endpoint under two naming conventions."""
    sa, sb = a.split("/"), b.split("/")
    if len(sa) != len(sb):
        return False
    for x, y in zip(sa, sb):
        x_param = x.startswith("{") and x.endswith("}")
        y_param = y.startswith("{") and y.endswith("}")
        if x_param != y_param:
            return False
        if not x_param and x != y:
            return False
    return True


def reconcile_path(method: str, path: str, existing: dict) -> tuple[str, str]:
    """Map an observed template onto an endpoint already in the surface, so a capture
    reinforces the declared endpoint instead of forking a near-duplicate. The
    incumbent's parameter naming wins — it is what the test cases already target."""
    key = (method.upper(), path)
    if key in existing:
        return key
    matches = [k for k in existing
               if k[0] == method.upper() and same_shape(k[1], path)]
    return matches[0] if len(matches) == 1 else key


def merge_records(db: Session, org_id: str, project_id: str, source: str,
                  records: list[dict]) -> dict:
    """Fold discovered records into the surface. Never deletes: a lower-fidelity
    source may add endpoints and observations but may not overwrite what a
    specification declared (SRS §4.2 precedence)."""
    spec_row = _spec_row_for(db, org_id, project_id, source)
    existing = {(e.method.upper(), e.path): e for e in db.query(Endpoint).filter(
        Endpoint.project_id == project_id, Endpoint.organisation_id == org_id).all()}

    added = updated = observed_only = 0
    for record in records:
        key = reconcile_path(record["method"], record["path"], existing)
        current = existing.get(key)
        if current is None:
            fresh = Endpoint(
                organisation_id=org_id, api_spec_id=spec_row.id, project_id=project_id,
                method=record["method"].upper(), path=record["path"],
                operation_id=record.get("operation_id", ""),
                summary=record.get("summary", ""),
                parameters=record.get("parameters") or [],
                request_schema=record.get("request_schema"),
                response_schemas=record.get("response_schemas") or {},
                security=record.get("security") or [],
                tags=record.get("tags") or [],
                discovery_source=source,
                times_seen=int(record.get("times_seen") or 0),
                inferred=source != "openapi",
                dom_fields=record.get("dom_fields") or [])
            db.add(fresh)
            # Register it immediately so a later record in the same batch reconciles
            # against it rather than creating a second near-duplicate row.
            existing[key] = fresh
            added += 1
            continue

        current.times_seen = (current.times_seen or 0) + int(record.get("times_seen") or 0)
        incumbent = SOURCE_FIDELITY.get(current.discovery_source or "openapi", 0)
        challenger = SOURCE_FIDELITY.get(source, 0)
        if challenger < incumbent:
            # Observations still count, but a declared attribute is never overwritten.
            if record.get("dom_fields") and not current.dom_fields:
                current.dom_fields = record["dom_fields"]
            observed_only += 1
            continue

        if record.get("parameters"):
            by_name = {p.get("name"): p for p in (current.parameters or [])
                       if isinstance(p, dict)}
            for param in record["parameters"]:
                by_name.setdefault(param.get("name"), param)
            current.parameters = list(by_name.values())
        if record.get("request_schema"):
            current.request_schema = merge_schema(current.request_schema,
                                                  record["request_schema"])
        if record.get("response_schemas"):
            merged = dict(current.response_schemas or {})
            for status, schema in record["response_schemas"].items():
                merged[status] = merge_schema(merged.get(status), schema)
            current.response_schemas = merged
        if record.get("dom_fields"):
            current.dom_fields = record["dom_fields"]
        if record.get("tags"):
            current.tags = sorted(set((current.tags or []) + record["tags"]))
        if challenger > incumbent:
            current.discovery_source = source
            current.inferred = source != "openapi"
        updated += 1

    db.commit()
    return {"added": added, "updated": updated, "observations_only": observed_only,
            "spec_id": spec_row.id, "version": spec_row.version}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

class TrafficBody(BaseModel):
    har: dict | None = None
    base_url: str | None = None
    include_all: bool = False


@router.post("/projects/{project_id}/discovery/traffic", status_code=201)
def import_traffic(project_id: str, body: TrafficBody,
                   user: User = Depends(require("import_spec")),
                   db: Session = Depends(get_db)):
    """FR-021 — a HAR captured by a proxy, the browser devtools or Traceo's own
    headless driver becomes part of the endpoint surface."""
    get_project_scoped(project_id, user, db)
    if not body.har:
        raise HTTPException(422, detail={"code": "missing_har",
                                         "message": "Provide a HAR document as {\"har\": {...}}"})
    try:
        records, warnings = parse_har(body.har, body.base_url, body.include_all)
    except ValueError as e:
        raise HTTPException(422, detail={"code": "invalid_har", "message": str(e)})
    if not records:
        return {"endpoints_count": 0, "added": 0, "updated": 0,
                "warnings": [{"warning": "no API-shaped requests found in this capture; "
                                         "re-import with include_all=true to keep every entry"}]}
    result = merge_records(db, user.organisation_id, project_id, "traffic", records)
    audit(db, user.organisation_id, user.id, "discovery.traffic", "project", project_id,
          {"endpoints": len(records), **{k: result[k] for k in ("added", "updated")}})
    db.commit()
    return {"endpoints_count": len(records), "warnings": warnings, **result}


class PostmanBody(BaseModel):
    collection: dict
    variables: dict = Field(default_factory=dict)


@router.post("/projects/{project_id}/discovery/postman", status_code=201)
def import_postman(project_id: str, body: PostmanBody,
                   user: User = Depends(require("import_spec")),
                   db: Session = Depends(get_db)):
    """FR-023 — an existing collection treated as the discovered surface."""
    get_project_scoped(project_id, user, db)
    try:
        records, warnings = parse_postman(body.collection, body.variables)
    except ValueError as e:
        raise HTTPException(422, detail={"code": "invalid_collection", "message": str(e)})
    result = merge_records(db, user.organisation_id, project_id, "postman", records)
    audit(db, user.organisation_id, user.id, "discovery.postman", "project", project_id,
          {"endpoints": len(records), **{k: result[k] for k in ("added", "updated")}})
    db.commit()
    return {"endpoints_count": len(records), "warnings": warnings, **result}


class DomBody(BaseModel):
    forms: list[dict]
    base_url: str | None = None


@router.post("/projects/{project_id}/discovery/dom", status_code=201)
def import_dom(project_id: str, body: DomBody,
               user: User = Depends(require("import_spec")),
               db: Session = Depends(get_db)):
    """FR-022 — form fields, validation patterns and RTL containers from the DOM."""
    get_project_scoped(project_id, user, db)
    records, notes = parse_dom_forms(body.forms, body.base_url)
    result = merge_records(db, user.organisation_id, project_id, "dom", records)
    audit(db, user.organisation_id, user.id, "discovery.dom", "project", project_id,
          {"forms": len(records), **{k: result[k] for k in ("added", "updated")}})
    db.commit()
    return {"endpoints_count": len(records), "notes": notes, **result}


class CrawlBody(BaseModel):
    url: str
    max_pages: int = Field(default=5, ge=1, le=25)
    wait_ms: int = Field(default=1500, ge=0, le=15000)


@router.post("/projects/{project_id}/discovery/crawl", status_code=201)
def crawl(project_id: str, body: CrawlBody,
          user: User = Depends(require("import_spec")),
          db: Session = Depends(get_db)):
    """FR-021/FR-022 — drive the application with a headless browser and build the
    surface from what it does. Playwright is an optional dependency: without it the
    HAR and DOM import endpoints above accept a capture produced elsewhere."""
    get_project_scoped(project_id, user, db)
    try:
        from ..crawler import crawl_application  # optional, imports playwright lazily
    except ImportError as e:
        raise HTTPException(501, detail={
            "code": "crawler_unavailable",
            "message": (f"The headless crawler needs Playwright: {e}. Install it with "
                        "`pip install playwright && playwright install chromium`, or "
                        "POST a capture to /discovery/traffic and /discovery/dom instead.")})
    try:
        har, forms = crawl_application(body.url, body.max_pages, body.wait_ms)
    except RuntimeError as e:
        raise HTTPException(502, detail={"code": "crawl_failed", "message": str(e)})

    traffic_records, warnings = parse_har(har, body.url)
    dom_records, notes = parse_dom_forms(forms, body.url)
    traffic_result = merge_records(db, user.organisation_id, project_id,
                                   "traffic", traffic_records)
    dom_result = merge_records(db, user.organisation_id, project_id, "dom", dom_records)
    audit(db, user.organisation_id, user.id, "discovery.crawl", "project", project_id,
          {"url": body.url, "traffic_endpoints": len(traffic_records),
           "forms": len(dom_records)})
    db.commit()
    return {"traffic": {"endpoints_count": len(traffic_records), **traffic_result},
            "dom": {"endpoints_count": len(dom_records), **dom_result},
            "warnings": warnings, "notes": notes}


@router.post("/projects/{project_id}/discovery/reset", status_code=200)
def reset_observed(project_id: str, body: dict = Body(default={}),
                   user: User = Depends(require("import_spec")),
                   db: Session = Depends(get_db)):
    """Drop endpoints contributed by a non-specification source, for when a capture
    turns out to be noise. Specification endpoints are never touched here."""
    get_project_scoped(project_id, user, db)
    source = str(body.get("source") or "")
    if source not in ("traffic", "dom", "postman"):
        raise HTTPException(422, detail={
            "code": "invalid_source",
            "message": "source must be one of: traffic, dom, postman"})
    rows = db.query(Endpoint).filter(
        Endpoint.project_id == project_id,
        Endpoint.organisation_id == user.organisation_id,
        Endpoint.discovery_source == source).all()
    ids = [e.id for e in rows]
    if ids:
        db.query(TestStep).filter(TestStep.endpoint_id.in_(ids)).update(
            {TestStep.endpoint_id: None}, synchronize_session=False)
        db.query(Endpoint).filter(Endpoint.id.in_(ids)).delete(synchronize_session=False)
    audit(db, user.organisation_id, user.id, "discovery.reset", "project", project_id,
          {"source": source, "removed": len(ids)})
    db.commit()
    return {"removed": len(ids), "source": source}
