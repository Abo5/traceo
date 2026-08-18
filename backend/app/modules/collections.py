"""API collection importers — Postman v2.x, HAR 1.2, Insomnia v4 (FR-023 / FR-021).

WHY THIS MODULE EXISTS
----------------------
``Endpoint.source`` has always documented "postman" as a legal value, but the
import route only ever accepted OpenAPI 3.x / Swagger 2.0 — uploading a real
Postman collection returned 422 invalid_spec. This module closes that gap by
converting the three collection/traffic formats teams actually have on hand into
the SAME internal endpoint inventory ``discovery._flatten`` produces, so the rest
of the system (grounding gate, coverage map, generation) needs no changes.

DESIGN RULES
------------
* **Deterministic and pure.** Every function here is a pure function of its
  arguments: no network, no database, no clock, no LLM. This inventory is the
  grounding source of truth, so it must be reproducible byte-for-byte from the
  uploaded file alone. The optional AI enrichment layer (modules/enrichment.py)
  runs *after* conversion and may only annotate what is produced here.
* **Nothing is invented.** Schemas are inferred from example values only; a field
  that is not in the file never appears in the inventory.
* **Parity.** The Go port must produce the identical inventory for the identical
  file, so every heuristic below is spelled out rather than left to taste.
* **`disabled` is honoured for values, ignored for surface.** A disabled
  collection/environment VARIABLE does not resolve (it would fabricate a path);
  a disabled query parameter, header or form field is still CAPTURED. Postman's
  own OpenAPI converter exports every optional parameter disabled — the calendar
  fixture hides 3 of its 35 query parameters that way — so skipping them would
  silently drop part of the API surface. A disabled entry is never required.
"""
from __future__ import annotations

import json
import re
from urllib.parse import parse_qsl, urlsplit

# Formats this module owns. OpenAPI/Swagger stay in discovery.py, untouched.
COLLECTION_FORMATS = ("postman2", "har", "insomnia4")

# Named in the 422 so a rejected upload tells the owner what WOULD be accepted.
SUPPORTED_FORMATS_HINT = (
    "Supported formats: OpenAPI 3.x, Swagger 2.0, "
    "Postman Collection v2.0/v2.1, HAR 1.2, Insomnia v4 export."
)

# Endpoint.source per format. Insomnia deliberately reuses "postman" rather than
# extending the source enum in two backends for one importer — both are
# "a hand-curated request collection", which is exactly what the fidelity order
# spec > traffic > dom > postman ranks lowest.
SOURCE_BY_FORMAT = {"postman2": "postman", "har": "traffic", "insomnia4": "postman"}

# Headers that describe the transport rather than the API contract. Captured
# headers are useful (X-Api-Key, X-Tenant); these are noise on every request.
_TRANSPORT_HEADERS = frozenset({
    "accept", "accept-charset", "accept-encoding", "accept-language", "cache-control",
    "connection", "content-length", "content-type", "cookie", "date", "expect", "host",
    "if-modified-since", "if-none-match", "origin", "pragma", "referer", "te",
    "transfer-encoding", "upgrade", "user-agent", "via",
})

# Headers whose VALUE is a credential. The name is captured, the value never is.
_CREDENTIAL_HEADERS = frozenset({
    "authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token",
    "proxy-authorization",
})

_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                      r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_OBJECT_ID_RE = re.compile(r"^[0-9a-f]{24}$")
_VAR_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
_TEMPLATED_RE = re.compile(r"^\{(.+)\}$")
_INT_RE = re.compile(r"^-?\d+$")
_NUM_RE = re.compile(r"^-?\d*\.\d+(?:[eE][-+]?\d+)?$")
_SLUG_RE = re.compile(r"[^a-z0-9]+")
# A leading variable with one of these names is a base URL even when the export
# ships without its value — otherwise an unresolved {{baseUrl}} would silently
# become a path parameter and every path in the file would be wrong.
_BASE_URL_NAMES = re.compile(r"^(base[_-]?url|host|server|api[_-]?url|url|endpoint|domain)$",
                             re.IGNORECASE)


def _is_base_url(var_name: str | None, resolved: str) -> bool:
    return "://" in resolved or bool(var_name and _BASE_URL_NAMES.match(var_name))


# --------------------------------------------------------------------------- detection

def detect_format(doc: object) -> str | None:
    """Deterministic format detection from the parsed document alone.

    Order matters only in the pathological case of a document carrying several
    markers: the OpenAPI/Swagger markers are tested FIRST so the pre-existing
    import path can never be diverted by a stray key.

    Returns "openapi3" | "swagger2" | "postman2" | "har" | "insomnia4", or None
    when nothing matches (the caller then raises the existing 422 invalid_spec).
    """
    if not isinstance(doc, dict):
        return None
    # 1. OpenAPI 3.x / Swagger 2.0 — unchanged, wins over everything.
    if doc.get("swagger") == "2.0":
        return "swagger2"
    if str(doc.get("openapi", "")).startswith("3"):
        return "openapi3"
    # 2. Postman Collection v2.0 / v2.1 — the schema URL is the only reliable marker
    #    (both minor versions share the "collection/v2" prefix).
    info = doc.get("info")
    if isinstance(info, dict):
        schema = info.get("schema")
        if isinstance(schema, str) and "getpostman.com/json/collection/v2" in schema:
            return "postman2"
    # 3. HAR 1.2 — a top-level "log" object holding "entries".
    log = doc.get("log")
    if isinstance(log, dict) and isinstance(log.get("entries"), list):
        return "har"
    # 4. Insomnia v4 export — {"_type": "export", "resources": [...]}.
    if doc.get("_type") == "export" and isinstance(doc.get("resources"), list):
        return "insomnia4"
    return None


# --------------------------------------------------------------------- scalar helpers

def _scalar_type(value: object) -> str:
    """JSON Schema type name for a *string* example (collections store everything
    as text). "true"/"false" -> boolean, integer literal -> integer, decimal ->
    number, everything else -> string. Unresolved {{vars}} stay strings."""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    text = str(value).strip()
    low = text.lower()
    if low in ("true", "false"):
        return "boolean"
    if _INT_RE.match(text):
        return "integer"
    if _NUM_RE.match(text):
        return "number"
    return "string"


def _slug(text: str) -> str:
    """operation_id from a request name: lowercase, non-alphanumeric runs -> '_'."""
    return _SLUG_RE.sub("_", str(text).lower()).strip("_")[:200]


def _resolve_vars(text: str, variables: dict) -> str:
    """Substitute {{var}} / {{ _.var }} from collection + environment variables.
    Unknown variables are left verbatim — guessing a value would be inventing data."""
    if "{{" not in text:
        return text

    def _sub(m):
        name = m.group(1).strip()
        if name.startswith("_."):
            name = name[2:].strip()
        return str(variables[name]) if name in variables else m.group(0)

    return _VAR_RE.sub(_sub, text)


def _var_name(token: str) -> str | None:
    """'{{calendarId}}' / '{{ _.calendarId }}' -> 'calendarId'; otherwise None."""
    m = _VAR_RE.fullmatch(str(token).strip())
    if not m:
        return None
    name = m.group(1).strip()
    return name[2:].strip() if name.startswith("_.") else name


# ------------------------------------------------------------------ schema inference

def infer_json_schema(value: object) -> dict:
    """JSON Schema inferred from ONE example value. Types come from the value;
    objects and arrays recurse. No required list, no formats, no invented fields —
    an example proves a field exists and its type, nothing more."""
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
        items: dict = {}
        for element in value:
            items = merge_schema(items, infer_json_schema(element))
        return {"type": "array", "items": items}
    if isinstance(value, dict):
        return {"type": "object",
                "properties": {str(k): infer_json_schema(v) for k, v in value.items()}}
    return {}


def merge_schema(a: dict | None, b: dict | None) -> dict | None:
    """Least-surprising union of two inferred schemas — used for heterogeneous
    array elements and for duplicate requests on the same method+path.

    object+object  -> union of properties (recursively merged)
    array+array    -> merged items
    integer+number -> number          (numeric widening)
    X+null         -> X               (a null example means nullable, not typeless)
    otherwise      -> {} (any) when the types genuinely conflict
    """
    if not a:
        return b
    if not b:
        return a
    if a == b:
        return a
    ta, tb = a.get("type"), b.get("type")
    if ta == "object" and tb == "object":
        props = dict(a.get("properties") or {})
        for k, v in (b.get("properties") or {}).items():
            props[k] = merge_schema(props.get(k), v) if k in props else v
        out = {"type": "object", "properties": props}
        media = a.get("x-media-type") or b.get("x-media-type")
        if media:
            out["x-media-type"] = media
        return out
    if ta == "array" and tb == "array":
        return {"type": "array",
                "items": merge_schema(a.get("items") or {}, b.get("items") or {}) or {}}
    if ta == tb:
        return a
    if {ta, tb} == {"integer", "number"}:
        return {"type": "number"}
    if ta == "null":
        return b
    if tb == "null":
        return a
    return {}


# ------------------------------------------------------------------ path templating

def template_segment(segment: str, *, template_ids: bool, seen_ids: list[str]) -> str:
    """Turn ONE concrete or Postman-style path segment into a template segment.

    Rules, in order (identical for all three importers):
      1. ":calendarId"          -> "{calendarId}"   (Postman/Insomnia convention)
      2. "{{calendarId}}"       -> "{calendarId}"   (a variable used as a segment
                                                     IS a path parameter)
      3. "{alreadyTemplated}"   -> unchanged
      4. concrete id, only when template_ids=True (HAR/Insomnia — files that carry
         real values rather than templates): all-digits, a canonical UUID, or a
         24-char lowercase hex ObjectId becomes "{id}". Repeats inside one path
         are numbered "{id}", "{id2}", "{id3}" … so parameter names stay unique.
      5. anything else is a literal segment, verbatim.
    """
    seg = str(segment).strip()
    if seg.startswith(":") and len(seg) > 1:
        return "{" + seg[1:] + "}"
    var = _var_name(seg)
    if var:
        return "{" + var + "}"
    if _TEMPLATED_RE.match(seg):
        return seg
    if template_ids and (seg.isdigit() or _UUID_RE.match(seg) or _OBJECT_ID_RE.match(seg)):
        name = "id" if not seen_ids else f"id{len(seen_ids) + 1}"
        seen_ids.append(name)
        return "{" + name + "}"
    return seg


def _build_path(segments: list, variables: dict, *, template_ids: bool) -> str:
    """Join templated segments into a server-relative path.

    The leading base-URL element is stripped so the result matches what the
    OpenAPI importer stores (which ignores `servers`/`host` entirely): a first
    segment that resolves to an absolute URL — or is a variable named like a base
    URL ({{baseUrl}}, {{host}}, {{api_url}} …) — is dropped along with any path
    prefix it carries.
    """
    parts: list[str] = []
    seen_ids: list[str] = []
    for raw in segments:
        seg = raw.get("value", "") if isinstance(raw, dict) else raw
        seg = str(seg)
        if not seg:
            continue
        if not parts:
            if _is_base_url(_var_name(seg), _resolve_vars(seg, variables)):
                continue
        parts.append(template_segment(seg, template_ids=template_ids, seen_ids=seen_ids))
    return "/" + "/".join(parts)


def _split_url_string(url: str, variables: dict) -> tuple[list[str], list[tuple[str, str]]]:
    """Split a raw URL string (Postman string form, Insomnia, HAR) into path
    segments and (key, value) query pairs, stripping scheme/host or a leading
    base-url variable."""
    text = str(url).strip()
    path_part, _, query_part = text.partition("?")
    query = list(parse_qsl(query_part, keep_blank_values=True)) if query_part else []

    lead = _VAR_RE.match(path_part)
    if lead:
        name = _var_name(lead.group(0))
        resolved = str(variables.get(name, "")) if name else ""
        # A leading variable is a base URL when it resolves to an origin or is
        # NAMED like one; otherwise it is an ordinary path parameter.
        if _is_base_url(name, resolved):
            path_part = path_part[lead.end():]
    elif "://" in path_part:
        path_part = urlsplit(path_part).path
    path_part = _resolve_vars(path_part, variables)
    if "://" in path_part:
        path_part = urlsplit(path_part).path
    return [s for s in path_part.split("/") if s], query


# --------------------------------------------------------------- inventory building

def _param(name: str, location: str, value: object, *, required: bool,
           description: str = "") -> dict:
    """One inventory parameter. Shape is identical to the OpenAPI importer's; the
    observed example lands in `constraints.example`, which is already a free-form
    bag of schema facts there."""
    constraints: dict = {}
    if value not in (None, ""):
        constraints["example"] = value
    return {"name": str(name), "location": location, "type": _scalar_type(value),
            "required": bool(required or _is_required_marker(description)),
            "constraints": constraints}


def _is_required_marker(description: str) -> bool:
    """Postman's OpenAPI converter prefixes required params with "(Required)" —
    the only required-ness signal a collection carries."""
    return str(description or "").strip().lower().startswith("(required)")


def _header_params(headers: list, variables: dict) -> list[dict]:
    """Headers become header parameters — never query parameters. Transport
    headers (Content-Type, Accept, User-Agent …) are dropped as noise, and the
    VALUE of a credential-bearing header is never recorded: a HAR capture or a
    working collection routinely carries a live session token, and the inventory
    is rendered in the UI. The header itself is still captured — that it is
    required is part of the API surface; its value is not."""
    out = []
    for h in headers or []:
        if not isinstance(h, dict):
            continue
        name = str(h.get("key") or h.get("name") or "").strip()
        if not name or name.lower() in _TRANSPORT_HEADERS or name.startswith(":"):
            continue
        value = _resolve_vars(str(h.get("value") or ""), variables)
        if name.lower() in _CREDENTIAL_HEADERS:
            value = ""
        out.append(_param(name, "header", value, required=False,
                          description=str(h.get("description") or "")))
    return out


def _path_params(path: str, examples: dict) -> list[dict]:
    """One parameter per {template} segment, in path order, always required."""
    out = []
    for name in re.findall(r"\{([^{}]+)\}", path):
        example = examples.get(name, "")
        out.append(_param(name, "path", example, required=True))
    return out


def _body_from_json_text(text: str) -> dict | None:
    """Infer a schema from a raw JSON example body; unparseable text is recorded
    as an opaque string body rather than dropped."""
    stripped = str(text or "").strip()
    if not stripped:
        return None
    try:
        return infer_json_schema(json.loads(stripped))
    except (ValueError, TypeError):
        return {"type": "string", "x-media-type": "text/plain"}


def _fields_only_body(media_type: str, fields: list[tuple[str, bool]]) -> dict:
    """Non-JSON bodies (formdata / urlencoded / binary): media type + field names
    only. `fields` is [(name, is_file)]."""
    props = {name: ({"type": "string", "format": "binary"} if is_file
                    else {"type": "string"}) for name, is_file in fields}
    out: dict = {"type": "object", "x-media-type": media_type}
    if props:
        out["properties"] = props
    return out


def _new_op(method: str, path: str) -> dict:
    """An inventory row with exactly the keys discovery._flatten emits, plus the
    two discovery-mode fields the Endpoint model already carries."""
    return {"method": method.upper(), "path": path, "operation_id": "", "summary": "",
            "parameters": [], "request_schema": None, "response_schemas": {},
            "security": [], "tags": [], "source": "postman", "observed_count": 0}


class _Inventory:
    """Accumulates operations, deduplicating on method+path and merging what the
    duplicates add. Insertion order of first appearance is preserved so both
    backends emit the same list."""

    def __init__(self, source: str):
        self.source = source
        self._ops: dict[tuple[str, str], dict] = {}
        self.warnings: list[dict] = []

    def warn(self, method: str, path: str, error: str) -> None:
        self.warnings.append({"path": path, "method": method, "error": error})

    def add(self, method: str, path: str, *, parameters: list[dict],
            request_schema: dict | None, response_schemas: dict, summary: str = "",
            operation_id: str = "", tags: list[str] | None = None,
            security: list | None = None, observed: int = 0) -> dict:
        key = (method.upper(), path)
        op = self._ops.get(key)
        if op is None:
            op = _new_op(method, path)
            op["source"] = self.source
            self._ops[key] = op
        # parameters: union on (name, location); required is sticky, first
        # occurrence keeps its type, later ones fill in missing constraints.
        index = {(p["name"], p["location"]): p for p in op["parameters"]}
        for p in parameters:
            existing = index.get((p["name"], p["location"]))
            if existing is None:
                op["parameters"].append(p)
                index[(p["name"], p["location"])] = p
                continue
            existing["required"] = existing["required"] or p["required"]
            for k, v in p["constraints"].items():
                existing["constraints"].setdefault(k, v)
        op["request_schema"] = merge_schema(op["request_schema"], request_schema)
        for status, schema in (response_schemas or {}).items():
            op["response_schemas"][status] = merge_schema(
                op["response_schemas"].get(status), schema) or {}
        if summary and not op["summary"]:
            op["summary"] = summary[:500]
        if operation_id and not op["operation_id"]:
            op["operation_id"] = operation_id
        for tag in tags or []:
            if tag and tag not in op["tags"]:
                op["tags"].append(tag)
        if security and not op["security"]:
            op["security"] = security
        op["observed_count"] += observed
        return op

    def operations(self) -> list[dict]:
        return list(self._ops.values())


# ------------------------------------------------------------------------- Postman

def _postman_variables(doc: dict) -> dict:
    out: dict[str, str] = {}
    for v in doc.get("variable") or []:
        if isinstance(v, dict) and v.get("key") is not None and v.get("disabled") is not True:
            out.setdefault(str(v["key"]), str(v.get("value", "")))
    return out


def _postman_auth(auth: object) -> list:
    """Postman's auth block mapped onto the OpenAPI-shaped security list:
    {"type": "bearer"} -> [{"bearer": []}]. Absent/none -> []."""
    if not isinstance(auth, dict):
        return []
    kind = str(auth.get("type") or "").strip()
    if not kind or kind == "noauth":
        return []
    return [{kind: []}]


def _postman_walk(items: object, folders: tuple[str, ...] = ()):
    """Depth-first walk yielding (folder names, request item). Folders become tags."""
    if not isinstance(items, list):
        return
    for item in items:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("item"), list):
            yield from _postman_walk(item["item"], folders + (str(item.get("name") or ""),))
        elif isinstance(item.get("request"), (dict, str)):
            yield folders, item


def _postman_body(body: object, variables: dict) -> dict | None:
    if not isinstance(body, dict) or body.get("disabled") is True:
        return None
    mode = str(body.get("mode") or "")
    if mode == "raw":
        language = str(((body.get("options") or {}).get("raw") or {}).get("language") or "")
        text = str(body.get("raw") or "")
        if not text.strip():
            return None
        if language and language != "json":
            return {"type": "string", "x-media-type": f"text/{language}"}
        return _body_from_json_text(text)
    if mode == "urlencoded":
        fields = [(str(f.get("key") or ""), False) for f in body.get("urlencoded") or []
                  if isinstance(f, dict) and f.get("key")]
        return _fields_only_body("application/x-www-form-urlencoded", fields)
    if mode == "formdata":
        fields = [(str(f.get("key") or ""), str(f.get("type") or "") == "file")
                  for f in body.get("formdata") or []
                  if isinstance(f, dict) and f.get("key")]
        return _fields_only_body("multipart/form-data", fields)
    if mode in ("file", "binary"):
        return {"type": "string", "format": "binary",
                "x-media-type": "application/octet-stream"}
    if mode == "graphql":
        return {"type": "object", "x-media-type": "application/graphql"}
    return None


def _postman_responses(item: dict) -> dict:
    """Saved response examples -> observed status codes, with a schema whenever the
    example body is JSON."""
    out: dict[str, dict] = {}
    for r in item.get("response") or []:
        if not isinstance(r, dict):
            continue
        code = r.get("code")
        if code in (None, ""):
            continue
        schema = _body_from_json_text(r.get("body") or "") or {}
        status = str(code)
        out[status] = merge_schema(out.get(status), schema) or {}
    return out


def _convert_postman(doc: dict) -> tuple[_Inventory, str]:
    inv = _Inventory(SOURCE_BY_FORMAT["postman2"])
    variables = _postman_variables(doc)
    collection_auth = _postman_auth(doc.get("auth"))
    title = str((doc.get("info") or {}).get("name") or "")

    for folders, item in _postman_walk(doc.get("item")):
        name = str(item.get("name") or "")
        try:
            request = item.get("request")
            if isinstance(request, str):  # shorthand: "GET https://..." is not legal,
                request = {"method": "GET", "url": request}  # a bare URL means GET
            method = str(request.get("method") or "GET").upper()
            url = request.get("url")
            examples: dict[str, str] = {}
            if isinstance(url, dict):
                raw_segments = url.get("path")
                if isinstance(raw_segments, str):
                    raw_segments = [s for s in raw_segments.split("/") if s]
                if not isinstance(raw_segments, list):
                    raw_segments = []
                path = _build_path(raw_segments, variables, template_ids=False)
                query = [(str(q.get("key") or ""), _resolve_vars(str(q.get("value") or ""),
                                                                 variables))
                         for q in url.get("query") or []
                         if isinstance(q, dict) and q.get("key")]
                query_desc = {str(q.get("key")): str(q.get("description") or "")
                              for q in url.get("query") or [] if isinstance(q, dict)}
                for v in url.get("variable") or []:
                    if isinstance(v, dict) and v.get("key") is not None:
                        key = str(v["key"]).lstrip(":")
                        key = _var_name(key) or key  # some exports write "{{calendarId}}"
                        examples[key] = _resolve_vars(str(v.get("value") or ""), variables)
                if not path.strip("/") and isinstance(url.get("raw"), str):
                    segs, raw_query = _split_url_string(url["raw"], variables)
                    path = _build_path(segs, variables, template_ids=False)
                    query = query or raw_query
            else:
                segs, query = _split_url_string(str(url or ""), variables)
                path = _build_path(segs, variables, template_ids=False)
                query_desc = {}
            if not path:
                inv.warn(method, "", f"request '{name}' has no usable URL")
                continue

            params = _path_params(path, examples)
            params += [_param(k, "query", v, required=False,
                              description=query_desc.get(k, "")) for k, v in query]
            params += _header_params(request.get("header"), variables)
            security = _postman_auth(request.get("auth")) or collection_auth
            inv.add(method, path, parameters=params,
                    request_schema=_postman_body(request.get("body"), variables),
                    response_schemas=_postman_responses(item),
                    summary=name, operation_id=_slug(name),
                    tags=[f for f in folders if f], security=security)
        except Exception as exc:  # noqa: BLE001 — one bad request never sinks the import
            inv.warn("*", name, str(exc))
    return inv, title


# ----------------------------------------------------------------------------- HAR

def _har_body(post_data: object) -> dict | None:
    if not isinstance(post_data, dict):
        return None
    mime = str(post_data.get("mimeType") or "").split(";")[0].strip().lower()
    params = [p for p in post_data.get("params") or [] if isinstance(p, dict) and p.get("name")]
    if params:
        fields = [(str(p["name"]), bool(p.get("fileName"))) for p in params]
        return _fields_only_body(mime or "application/x-www-form-urlencoded", fields)
    text = str(post_data.get("text") or "")
    if not text.strip():
        return None
    if "json" in mime or not mime:
        return _body_from_json_text(text)
    return {"type": "string", "x-media-type": mime}


def _convert_har(doc: dict) -> tuple[_Inventory, str]:
    inv = _Inventory(SOURCE_BY_FORMAT["har"])
    log = doc.get("log") or {}
    creator = log.get("creator") or {}
    title = str(creator.get("name") or "") if isinstance(creator, dict) else ""

    for index, entry in enumerate(log.get("entries") or []):
        if not isinstance(entry, dict):
            continue
        request = entry.get("request")
        if not isinstance(request, dict):
            continue
        method = str(request.get("method") or "GET").upper()
        try:
            segs, url_query = _split_url_string(str(request.get("url") or ""), {})
            path = _build_path(segs, {}, template_ids=True)
            if not path:
                inv.warn(method, "", f"entry {index} has no usable URL")
                continue
            query = [(str(q.get("name") or ""), str(q.get("value") or ""))
                     for q in request.get("queryString") or []
                     if isinstance(q, dict) and q.get("name")] or url_query
            params = _path_params(path, {})
            params += [_param(k, "query", v, required=False) for k, v in query]
            params += _header_params(request.get("headers"), {})

            responses: dict = {}
            response = entry.get("response")
            if isinstance(response, dict) and response.get("status"):
                content = response.get("content") if isinstance(
                    response.get("content"), dict) else {}
                mime = str(content.get("mimeType") or "").lower()
                schema = (_body_from_json_text(content.get("text") or "")
                          if "json" in mime else None) or {}
                responses[str(response["status"])] = schema
            inv.add(method, path, parameters=params,
                    request_schema=_har_body(request.get("postData")),
                    response_schemas=responses, observed=1)
        except Exception as exc:  # noqa: BLE001
            inv.warn(method, f"entry {index}", str(exc))
    return inv, title


# ------------------------------------------------------------------------ Insomnia

def _insomnia_variables(resources: list) -> dict:
    """Merge environment resources in file order; the first definition of a name
    wins (base environments are exported before the sub-environments that
    override them, and a deterministic winner matters more than a clever one)."""
    out: dict[str, str] = {}
    for r in resources:
        if isinstance(r, dict) and r.get("_type") == "environment":
            for k, v in (r.get("data") or {}).items():
                if isinstance(v, (str, int, float, bool)):
                    out.setdefault(str(k), str(v))
    return out


def _insomnia_body(body: object) -> dict | None:
    if not isinstance(body, dict):
        return None
    mime = str(body.get("mimeType") or "").split(";")[0].strip().lower()
    params = [p for p in body.get("params") or []
              if isinstance(p, dict) and p.get("name")]
    if params:
        fields = [(str(p["name"]), str(p.get("type") or "") == "file") for p in params]
        return _fields_only_body(mime or "application/x-www-form-urlencoded", fields)
    text = str(body.get("text") or "")
    if not text.strip():
        return None
    if "json" in mime or not mime:
        return _body_from_json_text(text)
    return {"type": "string", "x-media-type": mime}


def _insomnia_auth(auth: object) -> list:
    if not isinstance(auth, dict):
        return []
    kind = str(auth.get("type") or "").strip()
    if not kind or kind == "none" or auth.get("disabled") is True:
        return []
    return [{kind: []}]


def _convert_insomnia(doc: dict) -> tuple[_Inventory, str]:
    inv = _Inventory(SOURCE_BY_FORMAT["insomnia4"])
    resources = [r for r in doc.get("resources") or [] if isinstance(r, dict)]
    variables = _insomnia_variables(resources)
    groups = {str(r.get("_id")): r for r in resources if r.get("_type") == "request_group"}
    workspace = next((r for r in resources if r.get("_type") == "workspace"), {})
    title = str(workspace.get("name") or "")

    def _folders(parent_id: object) -> list[str]:
        chain: list[str] = []
        seen: set[str] = set()
        current = str(parent_id or "")
        while current in groups and current not in seen:
            seen.add(current)
            chain.append(str(groups[current].get("name") or ""))
            current = str(groups[current].get("parentId") or "")
        return [c for c in reversed(chain) if c]

    for r in resources:
        if r.get("_type") != "request":
            continue
        name = str(r.get("name") or "")
        method = str(r.get("method") or "GET").upper()
        try:
            segs, url_query = _split_url_string(str(r.get("url") or ""), variables)
            # Insomnia files mix templates and real ids, so both rules apply.
            path = _build_path(segs, variables, template_ids=True)
            if not path:
                inv.warn(method, "", f"request '{name}' has no usable URL")
                continue
            # (name, value, description) — the description carries the only
            # required-ness signal an export has, exactly as in the Postman path.
            query = [(str(p.get("name") or ""),
                      _resolve_vars(str(p.get("value") or ""), variables),
                      str(p.get("description") or ""))
                     for p in r.get("parameters") or []
                     if isinstance(p, dict) and p.get("name")] or [
                         (k, v, "") for k, v in url_query]
            params = _path_params(path, {})
            params += [_param(k, "query", v, required=False, description=d)
                       for k, v, d in query]
            params += _header_params(r.get("headers"), variables)
            inv.add(method, path, parameters=params,
                    request_schema=_insomnia_body(r.get("body")),
                    response_schemas={}, summary=name, operation_id=_slug(name),
                    tags=_folders(r.get("parentId")),
                    security=_insomnia_auth(r.get("authentication")))
        except Exception as exc:  # noqa: BLE001
            inv.warn(method, name, str(exc))
    return inv, title


# ------------------------------------------------------------------------ entrypoint

_CONVERTERS = {"postman2": _convert_postman, "har": _convert_har,
               "insomnia4": _convert_insomnia}


def convert(doc: dict, fmt: str) -> tuple[list[dict], list[dict], str, str]:
    """Convert a detected collection document into the internal inventory.

    Returns (operations, warnings, title, source) where `operations` carries the
    same keys discovery._flatten produces plus "source"/"observed_count".
    """
    converter = _CONVERTERS.get(fmt)
    if converter is None:
        raise ValueError(f"no converter for format '{fmt}'")
    inv, title = converter(doc if isinstance(doc, dict) else {})
    return inv.operations(), inv.warnings, title, inv.source


# ------------------------------------------------------- environment derivation
#
# WHY THIS LIVES HERE
# -------------------
# "I only added a Postman collection for the API connection" — and the New run
# screen then showed an empty Environment picker, so nothing could be executed.
# The base URL is *in the uploaded document*; asking the owner to retype it is
# the product failing. The derivation is part of the conversion, so it lives
# beside the converters — including the OpenAPI/Swagger case, which the route in
# discovery.py calls into rather than duplicating.
#
# THE INVARIANT that governs every rule below:
#
#     base_url + <stored endpoint path> == the original URL, exactly.
#
# The converters store endpoint paths server-relative, stripping the leading
# base element (a scheme://host, or a variable named like a base URL). Whatever
# was stripped — INCLUDING a path prefix such as /calendar/v3 — is what the
# derived base_url must carry back. Conversely, nothing that was NOT stripped
# may appear in base_url: HAR/raw-URL requests keep their /v1 prefix in the
# path, so their base_url is the bare origin. That is why the "common prefix"
# is never computed by string comparison; it is read back off the element the
# converter actually removed.
#
# Everything here is a pure, deterministic function of the document: no network,
# no clock, no LLM. If no base URL can be read out of the file, NOTHING is
# derived — a host is never invented, and a value without a scheme is not a
# usable base URL, so it is declined rather than decorated with "https://".

ENV_NAME_MAX = 100          # environments.name column limit
ENV_BASE_URL_MAX = 500      # environments.base_url column limit
ENV_NAME_SUFFIX = " (imported)"
ENV_NAME_FALLBACK = "Imported environment"

# Variable names that mean "this is the base URL", case-insensitive, exact match.
# Deliberately narrower than _BASE_URL_NAMES (which decides what to STRIP from a
# path): picking a base URL out of a variable map is a guess, and a wrong guess
# writes a wrong environment, so only the four unambiguous names qualify.
BASE_URL_VAR_NAMES = ("baseurl", "base_url", "url", "host")

# A variable whose NAME contains any of these is a credential. Its key is
# carried so the user knows it must be filled; its value is never copied,
# returned, or logged.
CREDENTIAL_NAME_TOKENS = ("token", "secret", "key", "password", "auth", "bearer", "apikey")


def is_credential_name(name: object) -> bool:
    """Case-insensitive substring test — 'X-Api-Key', 'authToken', 'CLIENT_SECRET'."""
    low = str(name or "").lower()
    return any(token in low for token in CREDENTIAL_NAME_TOKENS)


def imported_environment_name(title: str) -> str:
    """'<document title> (imported)', trimmed to the column limit.

    The suffix is what tells the owner where the environment came from, so the
    TITLE is what gets truncated — never the suffix. An empty title falls back
    to a fixed English name rather than producing a bare '(imported)'.
    """
    base = str(title or "").strip()
    if not base:
        return ENV_NAME_FALLBACK
    return base[:ENV_NAME_MAX - len(ENV_NAME_SUFFIX)].strip() + ENV_NAME_SUFFIX


def _normalize_base(text: object) -> str:
    """A base URL is only usable if it carries a scheme. Trailing '/' is dropped
    so base_url + '/path' never doubles the separator. Anything else -> ''."""
    value = str(text or "").strip()
    if "://" not in value:
        return ""
    return value.rstrip("/")


def _most_frequent(candidates: list[str]) -> str:
    """Most frequent value; ties broken lexicographically so two backends (and
    two runs) always pick the same one."""
    if not candidates:
        return ""
    counts: dict[str, int] = {}
    for c in candidates:
        counts[c] = counts.get(c, 0) + 1
    return sorted(counts, key=lambda c: (-counts[c], c))[0]


def _named_base_url(variables: dict) -> tuple[str, str | None]:
    """(base_url, variable name) from a variable named like a base URL.

    Document order decides: the FIRST variable whose name matches wins, so the
    result depends only on the file, not on our list ordering.
    """
    for name, value in variables.items():
        if str(name).strip().lower() in BASE_URL_VAR_NAMES:
            base = _normalize_base(_resolve_vars(str(value or ""), variables))
            if base:
                return base, str(name)
    return "", None


def _base_from_url_text(text: str, variables: dict) -> tuple[str, str | None]:
    """The base element a converter would strip off this URL, as (base, var name).

    Mirrors _split_url_string exactly: a leading base-URL variable is the base
    (value and all — that is how /calendar/v3 survives), otherwise the
    scheme://host of an absolute URL. A relative URL contributes nothing.
    """
    value = str(text or "").strip()
    lead = _VAR_RE.match(value)
    if lead:
        name = _var_name(lead.group(0))
        resolved = _resolve_vars(str(variables.get(name, "")), variables) if name else ""
        if _is_base_url(name, resolved):
            return _normalize_base(resolved), name
        return "", None
    if "://" in value:
        parts = urlsplit(_resolve_vars(value, variables))
        if parts.scheme and parts.netloc:
            return f"{parts.scheme}://{parts.netloc}", None
    return "", None


def _observed_base_url(url_texts: list[str], variables: dict) -> tuple[str, str | None]:
    """Fallback derivation: the most frequent base element across request URLs."""
    candidates: list[str] = []
    var_by_base: dict[str, str] = {}
    for text in url_texts:
        base, name = _base_from_url_text(text, variables)
        if not base:
            continue
        candidates.append(base)
        if name and base not in var_by_base:
            var_by_base[base] = name
    winner = _most_frequent(candidates)
    return winner, var_by_base.get(winner)


def suggested_variables(variables: dict, base_url: str, base_var: str | None) -> dict:
    """Item 2: every variable EXCEPT the base-URL one, credentials emptied.

    The base-URL variable is excluded both by name and by value — a collection
    that spells it twice must not leave a copy of the host sitting in the
    variables map.
    """
    out: dict[str, str] = {}
    for name, value in variables.items():
        key = str(name)
        if base_var is not None and key == base_var:
            continue
        text = "" if value is None else str(value)
        if base_url and text.strip().rstrip("/") == base_url:
            continue
        out[key] = "" if is_credential_name(key) else text
    return out


def _result(base_url: str, variables: dict, base_var: str | None) -> dict | None:
    if not base_url:
        return None
    return {"base_url": base_url[:ENV_BASE_URL_MAX],
            "variables": suggested_variables(variables, base_url, base_var)}


def _postman_url_text(url: object) -> str:
    """The raw URL text of a Postman request — `raw` when present, otherwise
    rebuilt from protocol/host/port so a raw-less export still contributes."""
    if isinstance(url, str):
        return url.strip()
    if not isinstance(url, dict):
        return ""
    raw = url.get("raw")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    host = url.get("host")
    if isinstance(host, list):
        host_text = ".".join(str(h).strip() for h in host if str(h).strip())
    else:
        host_text = str(host or "").strip()
    if not host_text:
        return ""
    port = str(url.get("port") or "").strip()
    if port:
        host_text = f"{host_text}:{port}"
    protocol = str(url.get("protocol") or "").strip()
    return f"{protocol}://{host_text}" if protocol else host_text


def derive_postman_environment(doc: dict) -> dict | None:
    variables = _postman_variables(doc)
    base, base_var = _named_base_url(variables)
    if not base:
        texts = []
        for _folders, item in _postman_walk(doc.get("item")):
            request = item.get("request")
            if isinstance(request, str):
                request = {"url": request}
            if isinstance(request, dict):
                texts.append(_postman_url_text(request.get("url")))
        base, base_var = _observed_base_url(texts, variables)
    return _result(base, variables, base_var)


def derive_har_environment(doc: dict) -> dict | None:
    """A capture has no variables — only the origin its entries were sent to."""
    log = doc.get("log") if isinstance(doc.get("log"), dict) else {}
    texts = []
    for entry in log.get("entries") or []:
        if isinstance(entry, dict) and isinstance(entry.get("request"), dict):
            texts.append(str(entry["request"].get("url") or ""))
    base, _var = _observed_base_url(texts, {})
    return _result(base, {}, None)


def derive_insomnia_environment(doc: dict) -> dict | None:
    resources = [r for r in doc.get("resources") or [] if isinstance(r, dict)]
    variables = _insomnia_variables(resources)  # base environment first, first wins
    base, base_var = _named_base_url(variables)
    if not base:
        texts = [str(r.get("url") or "") for r in resources if r.get("_type") == "request"]
        base, base_var = _observed_base_url(texts, variables)
    return _result(base, variables, base_var)


def derive_openapi_environment(spec: dict, fmt: str) -> dict | None:
    """OpenAPI 3 `servers[0].url`, or Swagger 2 schemes+host+basePath.

    Both already exclude the path prefix from `paths`, so the prefix belongs in
    base_url — which is exactly what the invariant asks for. A relative
    servers[0].url ("/v1") has no host and is declined; a Swagger 2 document
    without `host` is declined too. `schemes` is honoured (https preferred when
    offered) and defaults to https only when the document states nothing.
    Server-variable defaults are substituted so no "{region}" reaches the field.
    """
    if fmt == "swagger2":
        host = str(spec.get("host") or "").strip()
        if not host:
            return None
        schemes = [str(s).strip().lower() for s in spec.get("schemes") or []
                   if isinstance(s, str) and str(s).strip()]
        scheme = "https" if "https" in schemes else (schemes[0] if schemes else "https")
        base_path = str(spec.get("basePath") or "").strip()
        if base_path == "/":
            base_path = ""
        return _result(_normalize_base(f"{scheme}://{host}{base_path}"), {}, None)

    servers = spec.get("servers")
    server = servers[0] if isinstance(servers, list) and servers else None
    if not isinstance(server, dict):
        return None
    url = str(server.get("url") or "").strip()
    for name, definition in (server.get("variables") or {}).items():
        if isinstance(definition, dict) and definition.get("default") is not None:
            url = url.replace("{" + str(name) + "}", str(definition["default"]))
    return _result(_normalize_base(url), {}, None)


_DERIVERS = {"postman2": derive_postman_environment, "har": derive_har_environment,
             "insomnia4": derive_insomnia_environment}


def derive_environment(doc: object, fmt: str) -> dict | None:
    """{"base_url": str, "variables": dict} for any supported format, or None.

    None means "this document does not state where the API lives" — the caller
    must then create nothing rather than guess.
    """
    if not isinstance(doc, dict):
        return None
    try:
        if fmt in ("openapi3", "swagger2"):
            return derive_openapi_environment(doc, fmt)
        deriver = _DERIVERS.get(fmt)
        return deriver(doc) if deriver else None
    except Exception:  # noqa: BLE001 — a convenience must never sink the import
        return None
