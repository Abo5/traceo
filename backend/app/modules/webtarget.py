"""Web targets — point Traceo at a URL and pick what to test (web target contract).

The measured constraint this module is built around: the example target
(https://opensource-demo.orangehrmlive.com/web/index.php/auth/login) is a Vue
SPA whose plain HTTP GET returns 3453 bytes with ZERO forms, inputs and buttons.
Everything is client-rendered, so server-side HTML parsing discovers nothing at
all and browser rendering is not an optimisation here — it is the only way the
page states anything. Rendering happens in a Node/Playwright sidecar
(tools/web-discovery/discover.mjs) shared by both backends; this module runs it,
persists what it found, and derives cases per selected test type:

    api          Endpoint rows with source="dom" from the captured XHR/fetch
                 inventory, paths templated exactly the way the collections
                 importer templates concrete ids, under the same fidelity
                 precedence spec > traffic > dom > postman (SRS §L2).
    functional   one Requirement per discovered FORM (state "extracted",
                 awaiting confirmation) plus cases that carry the form's own
                 selectors verbatim.
    ui           design facts from the screenshot via design.design_facts, and
                 UI cases via design.ui_cases.
    security     the S0 builders (modules/security.py) over the endpoints the
                 api track discovered.
    performance  a requirement and a case asserting page load under a stated
                 budget, with the observed elapsed_ms as the baseline.

GROUNDING is unchanged and non-negotiable. Every case emitted here references an
artefact the discovery ACTUALLY found — a form field selector, a captured
request, or a design fact id — and is discarded otherwise. The api/security
tracks additionally go through generation.grounding_validate, the same hard gate
the functional and security generators use; the ui track goes through
design.ui_cases' fact-id rule. Nothing is invented, including when the page is
empty: a track with no artefact to stand on is reported as skipped WITH ITS
REASON rather than quietly producing zero.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..jobs import JobError
from ..models import (Endpoint, Requirement, RequirementTestCase, TestCase, TestStep, User,
                      WebTarget)
from . import design, security as securitymod
from . import generation
from .collections import _param, _path_params, template_segment
from .discovery import FIDELITY, _assert_public_host
from .imageio import PngError, read_png
from .visual import Image, nearest_accessible

router = APIRouter()

# The five test types the owner asked for, in the order the UI shows them.
TEST_TYPES: tuple[str, ...] = ("functional", "api", "ui", "performance", "security")
DEFAULT_TEST_TYPES: tuple[str, ...] = ("functional", "ui")
DEFAULT_VIEWPORT = "1280x800"
_VIEWPORT_RE = re.compile(r"^(\d{3,5})x(\d{3,5})$")
_MIN_VIEWPORT = (320, 240)
_MAX_VIEWPORT = (3840, 4320)

MODEL_NAME = "browser-discovery"
SCREENSHOT_DIR = "webtargets"

# The XHR/fetch inventory IS the API surface a page exposes; the other resource
# types (document, stylesheet, image, font, script, media) are how the page is
# delivered, not what it calls.
API_RESOURCE_TYPES = frozenset({"xhr", "fetch"})

BROWSER_UNAVAILABLE = "browser_discovery_unavailable"
# Substrings that mean the sidecar could not run at all, as opposed to running
# and failing on the page. Matched case-insensitively against stderr.
_UNAVAILABLE_MARKERS = (
    "cannot find module 'playwright",
    'cannot find module "playwright',
    "cannot find package 'playwright",
    "playwright is not installed",
    "executable doesn't exist",
    "please run the following command to download new browsers",
    "err_module_not_found",
)
_UNAVAILABLE_CODES = frozenset({
    BROWSER_UNAVAILABLE, "playwright_missing", "browser_missing", "node_missing",
    "sidecar_missing",
})


def _install_hint(reason: str) -> str:
    return (
        f"{reason} Browser discovery needs Node.js and Playwright: install Node 18+, then "
        f"run `npm install` in {Path(settings.WEB_DISCOVERY_SCRIPT).parent} (or in "
        "e2e/, which already has Playwright) and `npx playwright install chromium`. "
        "Point TRACEO_NODE_BIN / TRACEO_WEB_DISCOVERY_SCRIPT at them if they live elsewhere."
    )


# ---------------------------------------------------------------------------
# Request validation
# ---------------------------------------------------------------------------

class WebTargetCreate(BaseModel):
    url: str
    viewport: str | None = None
    test_types: list[str] | None = None


def validate_test_types(requested: list[str] | None) -> list[str]:
    """Normalise the requested types, or raise 422 naming the legal list.

    An unknown type is rejected rather than ignored: silently dropping
    "perfomance" would run four tracks and report success for five."""
    values = [str(t).strip().lower() for t in (requested or []) if str(t).strip()]
    unknown = [t for t in values if t not in TEST_TYPES]
    if unknown:
        raise HTTPException(422, detail={
            "code": "invalid_test_type",
            "message": f"Unknown test type(s): {', '.join(sorted(set(unknown)))}.",
            "errors": list(TEST_TYPES)})
    if not values:
        raise HTTPException(422, detail={
            "code": "invalid_test_type",
            "message": "Select at least one test type.",
            "errors": list(TEST_TYPES)})
    # de-duplicate, keep the canonical order so the job runs the tracks in a
    # stable sequence whatever order the client listed them in
    return [t for t in TEST_TYPES if t in set(values)]


def validate_viewport(raw: str | None) -> str:
    viewport = (raw or DEFAULT_VIEWPORT).strip().lower().replace(" ", "")
    match = _VIEWPORT_RE.match(viewport)
    if match:
        w, h = int(match.group(1)), int(match.group(2))
        if _MIN_VIEWPORT[0] <= w <= _MAX_VIEWPORT[0] and _MIN_VIEWPORT[1] <= h <= _MAX_VIEWPORT[1]:
            return f"{w}x{h}"
    raise HTTPException(422, detail={
        "code": "invalid_viewport",
        "message": (f"viewport must be WIDTHxHEIGHT within "
                    f"{_MIN_VIEWPORT[0]}x{_MIN_VIEWPORT[1]}–{_MAX_VIEWPORT[0]}x{_MAX_VIEWPORT[1]} "
                    f"(e.g. {DEFAULT_VIEWPORT})."),
        "errors": [DEFAULT_VIEWPORT, "1440x900", "390x844"]})


def validate_target_url(raw: str) -> str:
    """http/https only, and the same SSRF rule the spec fetcher applies.

    The sidecar enforces this too — it is the process that actually opens the
    socket — but a guard that only lives in the child would be bypassed by every
    other caller of this module."""
    url = (raw or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(422, detail={
            "code": "invalid_url", "message": "Only absolute http/https URLs are allowed."})
    if not settings.ALLOW_PRIVATE_TARGETS:
        _assert_public_host(parts.hostname)  # raises 422 ssrf_blocked / unresolvable_host
    return url


# ---------------------------------------------------------------------------
# The sidecar
# ---------------------------------------------------------------------------

def sidecar_command(url: str, viewport: str, out_dir: str, timeout_ms: int) -> list[str]:
    return [settings.NODE_BIN, str(settings.WEB_DISCOVERY_SCRIPT),
            "--url", url, "--out", out_dir,
            "--viewport", viewport, "--timeout", str(timeout_ms)]


def _first_json_object(text: str) -> dict | None:
    """The sidecar's JSON document, even when something printed noise first.

    Node writes warnings to stdout more often than anyone would like, so the
    document is located rather than assumed to be the whole stream."""
    stripped = (text or "").strip()
    if not stripped:
        return None
    try:
        doc = json.loads(stripped)
        return doc if isinstance(doc, dict) else None
    except ValueError:
        pass
    start = stripped.find("{")
    while start != -1:
        try:
            doc = json.loads(stripped[start:])
        except ValueError:
            start = stripped.find("{", start + 1)
            continue
        return doc if isinstance(doc, dict) else None
    return None


def _payload_error(doc: dict) -> tuple[str, str] | None:
    """(code, message) when the sidecar reported an error object, else None."""
    err = doc.get("error")
    if isinstance(err, dict):
        return (str(err.get("code") or "discovery_failed"),
                str(err.get("message") or "The page could not be discovered."))
    if isinstance(err, str) and err.strip():
        return str(doc.get("code") or "discovery_failed"), err.strip()
    if doc.get("ok") is False:
        return (str(doc.get("code") or "discovery_failed"),
                str(doc.get("message") or "The page could not be discovered."))
    return None


def run_sidecar(url: str, viewport: str, out_dir: str,
                timeout_s: float | None = None) -> dict:
    """Render the page and return the sidecar's JSON document.

    Raises JobError. The one failure that must never be silent is the sidecar
    being absent: an empty result there looks exactly like "the page has
    nothing on it", which is the difference between a broken install and a true
    finding."""
    script = Path(settings.WEB_DISCOVERY_SCRIPT)
    if not script.is_file():
        raise JobError(BROWSER_UNAVAILABLE,
                       _install_hint(f"The discovery sidecar is missing at {script}."))
    timeout_s = float(timeout_s if timeout_s is not None else settings.WEB_DISCOVERY_TIMEOUT_S)
    env = dict(os.environ)
    if settings.ALLOW_PRIVATE_TARGETS:
        env["TRACEO_ALLOW_PRIVATE_TARGETS"] = "1"
    cmd = sidecar_command(url, viewport, out_dir, int(timeout_s * 1000))
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout_s + 30.0, env=env, cwd=str(script.parent))
    except FileNotFoundError:
        raise JobError(BROWSER_UNAVAILABLE, _install_hint(
            f"Node.js was not found (tried '{settings.NODE_BIN}')."))
    except subprocess.TimeoutExpired:
        raise JobError("discovery_timeout",
                       f"The browser did not finish within {timeout_s + 30:.0f}s — "
                       "raise TRACEO_WEB_DISCOVERY_TIMEOUT_S or check the URL.")
    except OSError as exc:
        raise JobError(BROWSER_UNAVAILABLE, _install_hint(
            f"The discovery sidecar could not be started ({exc.__class__.__name__})."))

    stderr = (proc.stderr or "").strip()
    doc = _first_json_object(proc.stdout or "")
    lowered = stderr.lower()
    if any(marker in lowered for marker in _UNAVAILABLE_MARKERS):
        raise JobError(BROWSER_UNAVAILABLE, _install_hint(
            "The discovery sidecar could not start Playwright."))
    if doc is None:
        if proc.returncode != 0:
            raise JobError("discovery_failed",
                           f"The discovery sidecar exited with code {proc.returncode}: "
                           f"{stderr[:500] or 'no output'}")
        raise JobError("discovery_failed",
                       "The discovery sidecar produced no JSON document.")
    reported = _payload_error(doc)
    if reported is not None:
        code, message = reported
        if code in _UNAVAILABLE_CODES:
            raise JobError(BROWSER_UNAVAILABLE, _install_hint(message))
        raise JobError(code, message)
    return doc


# ---------------------------------------------------------------------------
# Payload normalisation — tolerant of extra keys, strict about what it trusts
# ---------------------------------------------------------------------------

def _s(value, limit: int = 500) -> str:
    if value is None or isinstance(value, (dict, list)):
        return ""
    return str(value)[:limit]


def _int_or_none(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _field(raw: dict) -> dict | None:
    """One form field. A field with no selector is DROPPED: a case that cannot
    name the element it acts on is not grounded, and inventing a selector for it
    is exactly the fabrication the grounding gate exists to stop."""
    selector = _s(raw.get("selector"), 300).strip()
    if not selector:
        return None
    return {
        "selector": selector,
        "name": _s(raw.get("name"), 200),
        "id": _s(raw.get("id"), 200),
        "type": _s(raw.get("type"), 40) or "text",
        "required": bool(raw.get("required")),
        "placeholder": _s(raw.get("placeholder"), 300),
        "label": _s(raw.get("label"), 300),
        "maxlength": _int_or_none(raw.get("maxlength") if "maxlength" in raw
                                  else raw.get("maxLength")),
        "pattern": _s(raw.get("pattern"), 300),
        # The constraints the sidecar already reads off the element. They were
        # being dropped here, which meant a field that declares min=1 max=5 was
        # tested for nothing but presence — the rule was measured and thrown
        # away. Kept verbatim: a case may only assert what the page declared.
        "minlength": _int_or_none(raw.get("minlength") if "minlength" in raw
                                  else raw.get("minLength")),
        "min": _s(raw.get("min"), 100),
        "max": _s(raw.get("max"), 100),
        "step": _s(raw.get("step"), 40),
        # Shape and state, for the cases that assert what the page DOES rather
        # than what one field accepts.
        "tag": _s(raw.get("tag"), 20).lower() or "input",
        "disabled": bool(raw.get("disabled")),
        "visible": raw.get("visible") is not False,
        "options": [
            {"value": _s(o.get("value"), 200), "label": _s(o.get("label"), 200)}
            for o in (raw.get("options") or []) if isinstance(o, dict)
        ] or None,
        "value": _s(raw.get("value"), 300) if raw.get("value") is not None else None,
        "checked": bool(raw["checked"]) if raw.get("checked") is not None else None,
    }


def _form(raw: dict, index: int) -> dict | None:
    selector = _s(raw.get("selector"), 300).strip()
    if not selector:
        return None
    fields = [f for f in (_field(x) for x in raw.get("fields") or []
                          if isinstance(x, dict)) if f]
    # The sidecar reports every submit-capable control in `submits`; the first
    # one is the form's primary action. A bare <button> inside a form submits it
    # by the HTML spec, so `type` is already resolved sidecar-side. Older
    # payloads carried a single `submit` selector — both are accepted.
    submits = [s for s in raw.get("submits") or [] if isinstance(s, dict)]
    submit = _s(raw.get("submit"), 300)
    submit_name = ""
    if not submit and submits:
        submit = _s(submits[0].get("selector"), 300)
    for s in submits:
        name = _s(s.get("name"), 300)
        if name:
            submit_name = name
            break
    return {
        "index": index,
        "selector": selector,
        "name": _s(raw.get("name"), 200),
        "id": _s(raw.get("id"), 200),
        "action": _s(raw.get("action"), 500),
        "method": (_s(raw.get("method"), 10) or "GET").upper(),
        # A form that turns the browser's validation off has taken the rules on
        # itself; the cases below say so when it then fails to keep them.
        "novalidate": bool(raw.get("novalidate")),
        "fields": fields,
        "submit": submit,
        "submit_name": submit_name,
        # What a human calls this form. The sidecar reads the nearest heading;
        # without it the form is nameless and every case title would repeat the
        # whole CSS path instead.
        "heading": _s(raw.get("heading"), 200),
    }


def _control(raw: dict) -> dict | None:
    selector = _s(raw.get("selector"), 300).strip()
    if not selector:
        return None
    return {
        "selector": selector,
        "role": _s(raw.get("role"), 40),
        "name": _s(raw.get("name") or raw.get("accessible_name")
                   or raw.get("accessibleName"), 300),
        "href": _s(raw.get("href"), 500),
    }


def _request(raw: dict) -> dict | None:
    url = _s(raw.get("url"), 1000).strip()
    if not url:
        return None
    return {
        "method": (_s(raw.get("method"), 10) or "GET").upper(),
        # A form that turns the browser's validation off has taken the rules on
        # itself; the cases below say so when it then fails to keep them.
        "novalidate": bool(raw.get("novalidate")),
        "url": url,
        "resource_type": _s(raw.get("resourceType") or raw.get("resource_type"), 40).lower(),
        "status": _int_or_none(raw.get("status")),
    }


def normalise_payload(doc: dict) -> dict:
    """The sidecar document reduced to what this module will act on.

    Deliberately tolerant of extra keys — the sidecar is free to report more
    than we consume — and deliberately intolerant of missing selectors, which
    are the only thing that makes a DOM case checkable."""
    forms = []
    for i, raw in enumerate(doc.get("forms") or []):
        if isinstance(raw, dict):
            form = _form(raw, len(forms))
            if form:
                forms.append(form)
    controls = [c for c in (_control(x) for x in doc.get("controls") or []
                            if isinstance(x, dict)) if c]
    requests = [r for r in (_request(x) for x in doc.get("requests") or []
                            if isinstance(x, dict)) if r]
    return {
        "url": _s(doc.get("url"), 1000),
        "final_url": _s(doc.get("final_url") or doc.get("finalUrl") or doc.get("url"), 1000),
        "title": _s(doc.get("title"), 500),
        "viewport": _s(doc.get("viewport"), 20),
        "elapsed_ms": _int_or_none(doc.get("elapsed_ms") or doc.get("elapsedMs")),
        "screenshot": _s(doc.get("screenshot"), 1000),
        "forms": forms,
        "controls": controls,
        "requests": requests,
        "console_errors": [_s(e, 500) for e in (doc.get("console_errors")
                                                or doc.get("consoleErrors") or [])][:50],
    }


def page_path(inv: dict) -> str:
    path = urlsplit(inv.get("final_url") or inv.get("url") or "").path or "/"
    return path[:500]


# ---------------------------------------------------------------------------
# Grounding — one artefact set, checked by every track
# ---------------------------------------------------------------------------

def artefact_ids(inv: dict, fact_ids: list[str] | None = None) -> set[str]:
    """Everything this discovery actually found, as reference ids.

    A case may only cite ids from this set. It is built from the normalised
    payload, so an artefact that never survived normalisation (a field with no
    selector) cannot be cited either."""
    out: set[str] = set()
    for form in inv.get("forms") or []:
        out.add(f"selector:{form['selector']}")
        if form.get("submit"):
            out.add(f"selector:{form['submit']}")
        for field in form.get("fields") or []:
            out.add(f"selector:{field['selector']}")
    for control in inv.get("controls") or []:
        out.add(f"selector:{control['selector']}")
    for req in inv.get("requests") or []:
        out.add(f"request:{req['method']} {req['url']}")
    if inv.get("final_url"):
        out.add(f"page:{inv['final_url']}")
    for fid in fact_ids or []:
        out.add(f"fact:{fid}")
    return out


def grounding_violations(case: dict, artefacts: set[str]) -> list[str]:
    """The universal rule: a case cites at least one discovered artefact, and
    every artefact it cites was discovered."""
    refs = list(case.get("grounds") or [])
    if not refs:
        return ["case references no discovered artefact"]
    return [f"'{ref}' was not found by the discovery" for ref in refs
            if ref not in artefacts]


# ---------------------------------------------------------------------------
# api track — the captured XHR/fetch inventory
# ---------------------------------------------------------------------------

def endpoints_from_requests(requests: list[dict]) -> list[dict]:
    """Captured XHR/fetch requests as inventory operations.

    Paths are templated by the SAME function the HAR/Insomnia importers use
    (collections.template_segment with template_ids=True), because these are
    real captured URLs carrying concrete ids — so /api/v2/employees/7 becomes
    /api/v2/employees/{id} here exactly as it would from a HAR file.

    Query values become `constraints.example` on a query parameter, which is
    what the generator later needs to build a request that addresses a real
    resource. Nothing is invented: a request with no query string yields no
    query parameters."""
    by_key: dict[tuple[str, str], dict] = {}
    for req in requests:
        if req.get("resource_type") not in API_RESOURCE_TYPES:
            continue
        parts = urlsplit(req["url"])
        if parts.scheme not in ("http", "https"):
            continue
        seen_ids: list[str] = []
        segments = [s for s in parts.path.split("/") if s]
        path = "/" + "/".join(
            template_segment(s, template_ids=True, seen_ids=seen_ids) for s in segments)
        method = req["method"].upper()
        key = (method, path)
        origin = f"{parts.scheme}://{parts.netloc}"
        op = by_key.get(key)
        if op is None:
            op = {
                "method": method, "path": path, "operation_id": "", "summary": "",
                "parameters": list(_path_params(path, {})),
                "request_schema": None, "response_schemas": {}, "security": [],
                "tags": [], "source": "dom", "observed_count": 0,
                "origins": [], "statuses": [], "urls": [],
            }
            by_key[key] = op
        op["observed_count"] += 1
        if origin not in op["origins"]:
            op["origins"].append(origin)
        status = req.get("status")
        if status is not None and status not in op["statuses"]:
            op["statuses"].append(status)
        if req["url"] not in op["urls"]:
            op["urls"].append(req["url"])
        known = {p["name"] for p in op["parameters"]}
        for name, value in parse_qsl(parts.query, keep_blank_values=True):
            if name and name not in known:
                known.add(name)
                op["parameters"].append(_param(name, "query", value, required=False))

    out = []
    for (_method, _path), op in sorted(by_key.items()):
        op["origins"].sort()
        op["statuses"].sort()
        op["summary"] = (f"Observed in the browser: {op['observed_count']} "
                         f"{'request' if op['observed_count'] == 1 else 'requests'} to "
                         f"{', '.join(op['origins'])}")[:500]
        out.append(op)
    return out


def persist_endpoints(db: Session, org_id: str, project_id: str,
                      ops: list[dict]) -> tuple[int, list[dict]]:
    """Write the DOM-discovered operations under the fidelity precedence.

    "dom" outranks only "postman" (SRS §L2), so an endpoint already known from a
    spec or from captured traffic is LEFT ALONE — a crawl must never downgrade a
    declared contract. Nothing is ever deleted here: this mode observes a page,
    it does not enumerate the API, so its silence about an endpoint says nothing.
    Returns (written, superseded)."""
    existing = {(e.method.upper(), e.path): e for e in db.scalars(select(Endpoint).where(
        Endpoint.project_id == project_id, Endpoint.organisation_id == org_id)).all()}
    written, superseded = 0, []
    dom_rank = FIDELITY["dom"]
    for op in ops:
        key = (op["method"], op["path"])
        prior = existing.get(key)
        if prior is not None and FIDELITY.get(prior.source or "spec", 0) > dom_rank:
            superseded.append({"method": op["method"], "path": op["path"],
                               "source": prior.source})
            continue
        if prior is None:
            prior = Endpoint(organisation_id=org_id, project_id=project_id,
                             api_spec_id=None, method=op["method"], path=op["path"])
            db.add(prior)
            existing[key] = prior
        prior.operation_id = op["operation_id"]
        prior.summary = op["summary"]
        prior.parameters = op["parameters"]
        prior.request_schema = op["request_schema"]
        prior.response_schemas = op["response_schemas"]
        prior.security = op["security"]
        prior.tags = op["tags"]
        prior.source = "dom"
        prior.observed_count = op["observed_count"]
        written += 1
    db.flush()
    return written, superseded


# ---------------------------------------------------------------------------
# functional track — one requirement per form, cases carrying its selectors
# ---------------------------------------------------------------------------

def form_label(form: dict) -> str:
    """What a human calls this form, in descending order of authority.

    A page that names its form is believed first; otherwise the heading above it
    and then its submit control are what a reader would use. The raw selector is
    the last resort — it is unambiguous but unreadable, and a title built from it
    repeats a whole CSS path."""
    return (form.get("name") or form.get("id") or form.get("heading")
            or form.get("submit_name") or form["selector"])


def field_label(field: dict) -> str:
    return field.get("label") or field.get("name") or field.get("id") or field["selector"]


def form_requirement_text(form: dict, inv: dict) -> tuple[str, list[str], str]:
    """(description, acceptance_criteria, source_text) for one discovered form.

    Every sentence names something the render produced. The required fields are
    the form's own `required` flags — not a guess from the field names."""
    required = [f for f in form["fields"] if f["required"]]
    label = form_label(form)
    where = inv.get("final_url") or inv.get("url") or ""
    if form["fields"]:
        listed = ", ".join(f"{field_label(f)} ({f['selector']})" for f in form["fields"])
    else:
        listed = "no input fields"
    description = (
        f"The '{label}' form ({form['selector']}) on {where} accepts {listed}. "
        + (f"Required: {', '.join(field_label(f) for f in required)}."
           if required else "No field is marked required by the page.")
    )[:2000]
    criteria = [f"The field {field_label(f)} ({f['selector']}) is present on the "
                f"'{label}' form" for f in form["fields"]]
    criteria += [f"Submitting the '{label}' form without {field_label(f)} "
                 f"({f['selector']}) is rejected" for f in required]
    source_text = json.dumps({"selector": form["selector"], "name": form.get("name"),
                              "method": form.get("method"), "action": form.get("action"),
                              "fields": form["fields"]}, sort_keys=True)
    return description, criteria, source_text


# ---------------------------------------------------------------------------
# validation probes — the VALUES a case types into a field
#
# Every probe is derived from a constraint the page itself declared. Nothing is
# invented: a field with no `type`, no length, no range and no pattern gets no
# validation case, because there is no stated rule to violate. That is the
# grounding gate applied to values rather than to selectors — a case asserting
# "rejects 'abc'" on a field that never said what it accepts would be testing
# our opinion, not the product's.
# ---------------------------------------------------------------------------

#: A value of the wrong shape for each input type, and one of the right shape.
#: The invalid value must be wrong for THAT type specifically.
TYPE_PROBES: dict[str, tuple[str, str, str]] = {
    # type: (invalid value, valid value, what the type means in words)
    "email": ("not-an-email", "traceo.check@example.com", "an email address"),
    "url": ("not a url", "https://example.com", "a URL"),
    "number": ("abc", "7", "a number"),
    "tel": ("", "0500000000", "a telephone number"),
    "date": ("not-a-date", "2026-01-01", "a date"),
}


def _num(value) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


#: Controls that cannot hold an arbitrary typed value. A range slider clamps to
#: its own bounds, a colour picker only holds colours, a checkbox has no text at
#: all — so "type this and see if it is refused" is not a question they can be
#: asked, and a case that asks it fails for a reason the product is not
#: responsible for.
UNTYPEABLE = frozenset({
    "range", "color", "checkbox", "radio", "file", "hidden", "submit",
    "button", "image", "reset",
})


def _filler(field: dict, length: int) -> str | None:
    """A string of exactly `length` characters that satisfies the field's OTHER
    declarations.

    The boundary probe asks "is the longest legal value accepted?", so the value
    has to be legal in every other respect. Padding an `type=email` field with
    "aaa…" asks a different question and gets a deserved refusal — that was a
    false positive, not a finding. When no such string can be constructed (an
    arbitrary `pattern`), the probe is skipped rather than guessed.
    """
    if field.get("pattern"):
        return None                      # cannot synthesise a match for a regex
    ftype = (field.get("type") or "text").lower()
    if ftype == "email":
        tail = "@example.com"
        return ("a" * (length - len(tail)) + tail) if length > len(tail) else None
    if ftype == "url":
        head = "https://example.com/"
        return (head + "a" * (length - len(head))) if length > len(head) else None
    if ftype in ("tel", "number"):
        return "1" * length
    if ftype in ("date", "time", "datetime-local", "month", "week"):
        return None                      # fixed-format; length is not the rule
    return "a" * length


def _accepted_number(field: dict) -> str | None:
    """A number this field's own min/max/step all allow."""
    lo, hi, step = _num(field.get("min")), _num(field.get("max")), _num(field.get("step"))
    if lo is not None:
        value = lo
    elif hi is not None:
        value = hi
    else:
        value = 7.0
    if step and step > 0:
        base = lo if lo is not None else 0.0
        # snap up to the first step-aligned value at or above `value`
        steps = max(0, round((value - base) / step))
        value = base + steps * step
    if hi is not None and value > hi:
        return None
    if lo is not None and value < lo:
        return None
    return _fmt_num(value)


def field_probes(field: dict) -> list[dict]:
    """Every validation case this field's own declarations justify.

    Each entry is {check, label, value, expect} where `expect` is "rejected" or
    "accepted". The caller turns them into cases; keeping the derivation here
    makes it testable without a browser.
    """
    out: list[dict] = []
    ftype = (field.get("type") or "text").lower()
    label = field_label(field)
    if ftype in UNTYPEABLE:
        return out

    # --- shape of the declared input type ---------------------------------
    probe = TYPE_PROBES.get(ftype)
    if probe and probe[0]:
        invalid, valid, words = probe
        if ftype == "number":
            valid = _accepted_number(field) or valid
        out.append({"check": "value_rejected", "value": invalid, "expect": "rejected",
                    "title": f"{label} rejects a value that is not {words}",
                    "technique": "negative", "reason": f"type=\"{ftype}\""})
        out.append({"check": "value_accepted", "value": valid, "expect": "accepted",
                    "title": f"{label} accepts {words}",
                    "technique": "ep", "reason": f"type=\"{ftype}\""})

    # --- length ------------------------------------------------------------
    minlength = field.get("minlength")
    if isinstance(minlength, int) and minlength > 1:
        short = _filler(field, minlength - 1)
        if short is not None:
            out.append({"check": "value_rejected", "value": short, "expect": "rejected",
                        "title": f"{label} rejects {minlength - 1} characters "
                                 f"(one short of its {minlength} minimum)",
                        "technique": "bva", "reason": f"minlength={minlength}"})
    maxlength = field.get("maxlength")
    if isinstance(maxlength, int) and 0 < maxlength <= 400:
        # The boundary itself must be ACCEPTED — an off-by-one that rejects the
        # longest legal value is a real defect and the mirror of maxlength_enforced.
        exact = _filler(field, maxlength)
        if exact is not None:
            out.append({"check": "value_accepted", "value": exact, "expect": "accepted",
                        "title": f"{label} accepts exactly {maxlength} characters",
                        "technique": "bva", "reason": f"maxlength={maxlength}"})

    # --- numeric / date range ---------------------------------------------
    lo, hi = _num(field.get("min")), _num(field.get("max"))
    if lo is not None:
        out.append({"check": "value_rejected", "value": _fmt_num(lo - 1), "expect": "rejected",
                    "title": f"{label} rejects a value below its {field['min']} minimum",
                    "technique": "bva", "reason": f"min={field['min']}"})
        out.append({"check": "value_accepted", "value": _fmt_num(lo), "expect": "accepted",
                    "title": f"{label} accepts its {field['min']} minimum",
                    "technique": "bva", "reason": f"min={field['min']}"})
    if hi is not None:
        out.append({"check": "value_rejected", "value": _fmt_num(hi + 1), "expect": "rejected",
                    "title": f"{label} rejects a value above its {field['max']} maximum",
                    "technique": "bva", "reason": f"max={field['max']}"})

    # --- whitespace is not a value ----------------------------------------
    if field.get("required"):
        out.append({"check": "whitespace_rejected", "value": "   ", "expect": "rejected",
                    "title": f"{label} does not accept spaces as a value",
                    "technique": "negative", "reason": "required"})
    return out


def _fmt_num(value: float) -> str:
    """Integers stay integers: min=1 must probe with "0", never "0.0"."""
    return str(int(value)) if float(value).is_integer() else str(value)


# ---------------------------------------------------------------------------
# Functionality cases — what the form DOES, not what one field accepts
#
# The validation probes above ask "is this value refused?". These ask the
# question a person actually has: does the feature work? That means filling a
# form correctly and watching the outcome, recovering from a rejection,
# honouring a gate, revealing a conditional field, loading with its documented
# defaults, and having links that go somewhere.
#
# Every one of them is skipped rather than guessed when the page did not give
# enough to construct it — a form with a `pattern` field whose value cannot be
# synthesised gets no happy path, because a "correct" submission we cannot
# actually make correct would fail for our reason, not the product's.
# ---------------------------------------------------------------------------

#: Controls we can put a meaningful value into when filling a form correctly.
FILLABLE = frozenset({
    "text", "search", "email", "url", "tel", "password", "number", "date",
    "time", "datetime-local", "month", "week", "textarea", "select", "checkbox",
    "radio",
})


def valid_value_for(field: dict) -> str | None:
    """A value that satisfies EVERY rule this field declares, or None.

    None is a real answer: an arbitrary `pattern` cannot be satisfied by
    construction, and a happy path built on a value we cannot vouch for would be
    testing the probe rather than the product.
    """
    ftype = (field.get("type") or "text").lower()
    if field.get("pattern"):
        return None
    if ftype == "select":
        options = field.get("options") or []
        real = [o for o in options if (o.get("value") or "").strip()]
        return real[0]["value"] if real else None
    if ftype in ("checkbox", "radio"):
        return "on"
    if ftype == "number":
        return _accepted_number(field)
    minlength = field.get("minlength") if isinstance(field.get("minlength"), int) else 0
    maxlength = field.get("maxlength") if isinstance(field.get("maxlength"), int) else 0
    probe = TYPE_PROBES.get(ftype)
    if probe:
        candidate = probe[1]
        if maxlength and len(candidate) > maxlength:
            candidate = _filler(field, maxlength)
        if candidate and minlength and len(candidate) < minlength:
            candidate = _filler(field, max(minlength, len(candidate)))
        return candidate
    length = max(minlength, 8)
    if maxlength:
        length = min(length, maxlength)
        if minlength and length < minlength:
            return None            # the field declares an impossible range
    return _filler(field, length)


def fill_plan(form: dict) -> list[dict] | None:
    """A value for every fillable field, or None when one cannot be constructed.

    All-or-nothing on purpose: a "correct" submission missing one required field
    is not a happy path, it is the required-field case wearing a disguise.
    """
    plan = []
    for field in form["fields"]:
        ftype = (field.get("type") or "text").lower()
        if field.get("disabled") or ftype not in FILLABLE:
            continue
        if field.get("visible") is False:
            continue          # hidden on load; conditional_fields owns it
        value = valid_value_for(field)
        if value is None:
            if field.get("required"):
                return None
            continue
        plan.append({"selector": field["selector"], "type": ftype, "value": value})
    required = [f for f in form["fields"] if f.get("required") and not f.get("disabled")]
    covered = {p["selector"] for p in plan}
    if any(f["selector"] not in covered for f in required):
        return None
    return plan or None


def functional_cases(form: dict, inv: dict) -> list[dict]:
    """Happy path, error recovery, gating, conditional fields and defaults."""
    path = page_path(inv)
    url = inv.get("final_url") or inv.get("url") or ""
    label = form_label(form)
    cases: list[dict] = []

    def mk(title, ctype, technique, check, request, assertions, grounds,
           priority="high"):
        return {
            "title": title[:500],
            "description": (f"Derived from the '{label}' form ({form['selector']}) "
                            f"rendered at {url}."),
            "preconditions": f"The page {url} is loaded in a browser",
            "type": ctype, "priority": priority, "technique": technique,
            "steps": [{"order": 0, "method": "GET", "path": path,
                       "request": {"url": url, "screen": label, "check": check,
                                   "form": form["selector"], **request},
                       "assertions": assertions, "extractions": []}],
            "grounds": grounds,
        }

    form_ground = [f"selector:{form['selector']}"]
    plan = fill_plan(form)

    # --- 1. happy path -----------------------------------------------------
    if plan:
        cases.append(mk(
            f"Form: '{label}' submits when every field is filled correctly",
            "positive", "ep", "happy_path",
            {"fill": plan, "action": form.get("action") or "", "method": form.get("method") or "GET"},
            [{"type": "happy_path", "expected": "the form submits"}],
            form_ground + [f"selector:{p['selector']}" for p in plan]))

    # --- 2. error recovery -------------------------------------------------
    required = [f for f in form["fields"]
                if f.get("required") and not f.get("disabled")
                and (f.get("type") or "text").lower() in FILLABLE
                and (f.get("type") or "text").lower() not in ("checkbox", "radio")]
    if plan and required:
        target = required[0]
        cases.append(mk(
            f"Form: '{label}' recovers after {field_label(target)} is corrected, "
            f"without losing the other fields",
            "positive", "ep", "error_recovery",
            {"fill": plan, "empty": target["selector"],
             "action": form.get("action") or "", "method": form.get("method") or "GET"},
            [{"type": "error_recovery", "selector": target["selector"],
              "expected": "refused, then accepted, with the other values intact"}],
            form_ground + [f"selector:{target['selector']}"]))

    # --- 3. the submit gate -------------------------------------------------
    for field in form["fields"]:
        if (field.get("type") or "").lower() != "checkbox" or not field.get("required"):
            continue
        if not form.get("submit"):
            continue
        cases.append(mk(
            f"Form: '{label}' does not submit until {field_label(field)} is ticked",
            "negative", "negative", "submit_gated",
            {"gate": field["selector"], "fill": plan or [],
             "action": form.get("action") or ""},
            [{"type": "submit_gated", "selector": field["selector"],
              "expected": "blocked while unticked"}],
            form_ground + [f"selector:{field['selector']}"]))

    # --- 4. conditional visibility -----------------------------------------
    for field in form["fields"]:
        options = field.get("options") or []
        real = [o for o in options if (o.get("value") or "").strip()]
        if (field.get("type") or "").lower() != "select" or len(real) < 2:
            continue
        cases.append(mk(
            f"Form: choosing each {field_label(field)} option shows a consistent set of fields",
            "positive", "ep", "conditional_fields",
            {"selector": field["selector"],
             "options": [o["value"] for o in real][:12],
             "watch": [f["selector"] for f in form["fields"]
                       if f["selector"] != field["selector"]][:40]},
            [{"type": "conditional_fields", "selector": field["selector"],
              "expected": "the same fields for the same option"}],
            form_ground + [f"selector:{field['selector']}"],
            priority="medium"))

    # --- 5. defaults --------------------------------------------------------
    defaults = [
        {"selector": f["selector"],
         "value": f.get("value"),
         "checked": f.get("checked"),
         "label": field_label(f)}
        for f in form["fields"]
        if (f.get("value") or f.get("checked") is not None)
    ]
    defaults = [d for d in defaults if d["value"] or d["checked"] is not None]
    if defaults:
        cases.append(mk(
            f"Form: '{label}' loads with the values it shipped with",
            "positive", "ep", "initial_state",
            {"defaults": defaults},
            [{"type": "initial_state", "expected": "the recorded initial state"}],
            form_ground + [f"selector:{d['selector']}" for d in defaults],
            priority="medium"))
    return cases


def navigation_cases(inv: dict) -> list[dict]:
    """Every discovered link must resolve. One case for the whole page: a list
    of 40 links is one question ("do the links work"), not 40 requirements."""
    url = inv.get("final_url") or inv.get("url") or ""
    links = []
    seen = set()
    for control in inv.get("controls") or []:
        href = (control.get("href") or "").strip()
        if not href or not href.lower().startswith(("http://", "https://")):
            continue
        if href in seen:
            continue
        seen.add(href)
        links.append({"href": href, "name": control.get("name") or ""})
    if not links:
        return []
    return [{
        "title": f"Navigation: every link on {url} resolves"[:500],
        "description": f"Derived from the {len(links)} link(s) discovery found at {url}.",
        "preconditions": f"The page {url} is reachable",
        "type": "positive", "priority": "medium", "technique": "ep",
        "steps": [{"order": 0, "method": "GET", "path": page_path(inv),
                   "request": {"url": url, "check": "links_resolve",
                               "links": links[:40]},
                   "assertions": [{"type": "links_resolve",
                                   "expected": "no 4xx or 5xx"}],
                   "extractions": []}],
        "grounds": [f"page:{url}"],
    }]


def form_cases(form: dict, inv: dict) -> list[dict]:
    """Deterministic functional cases for one form.

    The selectors travel VERBATIM into the step request — that is what makes the
    case runnable against the page and auditable back to the render."""
    path = page_path(inv)
    label = form_label(form)
    url = inv.get("final_url") or inv.get("url") or ""
    cases: list[dict] = []

    def mk(title: str, ctype: str, technique: str, check: str, request: dict,
           assertions: list[dict], grounds: list[str], priority: str = "medium") -> dict:
        return {
            "title": title[:500],
            "description": (f"Derived from the '{label}' form ({form['selector']}) "
                            f"rendered at {url}."),
            "preconditions": f"The page {url} is loaded in a browser",
            "type": ctype, "priority": priority, "technique": technique,
            "steps": [{"order": 0, "method": "GET", "path": path,
                       "request": {"url": url, "screen": label, "check": check,
                                   "form": form["selector"], **request},
                       "assertions": assertions, "extractions": []}],
            "grounds": grounds,
        }

    # Only the fields the render actually showed. A conditionally-revealed field
    # is SUPPOSED to be hidden on load, so demanding it be visible would fail
    # every form that has one — the conditional_fields case is what covers it.
    visible_fields = [f for f in form["fields"] if f.get("visible") is not False]
    if visible_fields:
        selectors = [f["selector"] for f in visible_fields]
        cases.append(mk(
            f"Form: '{label}' renders every discovered field",
            "positive", "ep", "elements_present",
            {"selectors": selectors},
            [{"type": "elements_present", "selectors": selectors}],
            [f"selector:{form['selector']}"] + [f"selector:{s}" for s in selectors]))

    for field in form["fields"]:
        if not field["required"]:
            continue
        others = [f["selector"] for f in form["fields"] if f["selector"] != field["selector"]]
        cases.append(mk(
            f"Form: '{label}' rejects submission with {field_label(field)} empty",
            "negative", "negative", "required_field_enforced",
            {"empty": field["selector"], "filled": others},
            [{"type": "validation_error", "selector": field["selector"]},
             {"type": "no_navigation"}],
            [f"selector:{form['selector']}", f"selector:{field['selector']}"],
            priority="high"))

    for field in form["fields"]:
        maxlength = field.get("maxlength")
        if isinstance(maxlength, int) and maxlength > 0:
            cases.append(mk(
                f"Form: {field_label(field)} accepts at most {maxlength} characters",
                "boundary", "bva", "maxlength_enforced",
                {"selector": field["selector"], "maxlength": maxlength},
                [{"type": "value_length_at_most", "selector": field["selector"],
                  "expected": maxlength}],
                [f"selector:{form['selector']}", f"selector:{field['selector']}"]))
        if field.get("pattern"):
            cases.append(mk(
                f"Form: {field_label(field)} enforces its declared pattern",
                "negative", "negative", "pattern_enforced",
                {"selector": field["selector"], "pattern": field["pattern"]},
                [{"type": "pattern_enforced", "selector": field["selector"],
                  "expected": field["pattern"]}],
                [f"selector:{form['selector']}", f"selector:{field['selector']}"]))

    # --- input validation: one case per rule the field itself declares ------
    # These carry a concrete VALUE to type, so the check is not "does the
    # attribute exist" but "does the page act on it". Every value is derived
    # from the declaration (see field_probes), so a field that declares nothing
    # yields nothing rather than an invented expectation.
    for field in form["fields"]:
        for probe in field_probes(field):
            rejected = probe["expect"] == "rejected"
            cases.append(mk(
                f"Form: {probe['title']}",
                "negative" if rejected else "positive",
                probe["technique"],
                probe["check"],
                {"selector": field["selector"], "value": probe["value"],
                 "expect": probe["expect"], "declared": probe["reason"],
                 "form": form["selector"]},
                [{"type": probe["check"], "selector": field["selector"],
                  "expected": probe["expect"], "value": probe["value"],
                  "declared": probe["reason"]}],
                [f"selector:{form['selector']}", f"selector:{field['selector']}"],
                priority="high" if rejected else "medium"))
    return cases


# ---------------------------------------------------------------------------
# performance track
# ---------------------------------------------------------------------------

def performance_case(inv: dict, budget_ms: int) -> dict:
    url = inv.get("final_url") or inv.get("url") or ""
    observed = inv.get("elapsed_ms")
    return {
        "title": f"Performance: {url} loads within {budget_ms}ms"[:500],
        "description": (f"The page load budget is {budget_ms}ms. The observed baseline from "
                        f"the discovery render was {observed}ms."),
        "preconditions": "A cold browser context at the discovery viewport",
        "type": "positive" if (observed is None or observed <= budget_ms) else "negative",
        "priority": "high" if (observed is not None and observed > budget_ms) else "medium",
        "technique": "performance",
        "steps": [{"order": 0, "method": "GET", "path": page_path(inv),
                   "request": {"url": url, "check": "page_load_ms",
                               "observed_baseline_ms": observed},
                   "assertions": [{"type": "page_load_ms", "expected_max": budget_ms,
                                   "observed_baseline_ms": observed}],
                   "extractions": []}],
        "grounds": [f"page:{url}"],
    }


# ---------------------------------------------------------------------------
# ui track — design facts from the screenshot
# ---------------------------------------------------------------------------

def fit_for_analysis(img: Image, viewport: str,
                     max_pixels: int | None = None) -> tuple[Image, dict]:
    """The raster the design engine analyses, and how it was derived.

    Two reductions, both stated rather than hidden:
      * the full-page screenshot is CROPPED to the viewport — the design facts
        are statements about the screen, and a 6000px-tall page would otherwise
        report the footer's palette share as the screen's;
      * if that is still over the pixel budget it is SUBSAMPLED by an integer
        step with nearest neighbour, never averaged, so every analysed colour is
        still a colour the page actually painted. Averaging would invent
        colours, and the palette would then be a claim about the resampler.
    """
    budget = max_pixels if max_pixels is not None else settings.DESIGN_MAX_PIXELS
    note = {"source_width": img.width, "source_height": img.height,
            "cropped": False, "sample_step": 1}
    match = _VIEWPORT_RE.match(viewport or "")
    height = img.height
    if match:
        vh = int(match.group(2))
        if img.height > vh:
            height = vh
            note["cropped"] = True
    width = img.width
    pixels = tuple(img.pixels[y * img.width + x]
                   for y in range(height) for x in range(width)) \
        if note["cropped"] else img.pixels

    step = 1
    while budget > 0 and (width // step) * (height // step) > budget:
        step += 1
    if step > 1:
        sw, sh = width // step, height // step
        pixels = tuple(pixels[(y * step) * width + (x * step)]
                       for y in range(sh) for x in range(sw))
        width, height = sw, sh
        note["sample_step"] = step
    note["analysed_width"], note["analysed_height"] = width, height
    return Image(width, height, pixels), note


_HEX_PAIR_RE = re.compile(r"^(#[0-9A-F]{6})_on_(#[0-9A-F]{6})$")


def _rgb(hex_colour: str) -> tuple[int, int, int]:
    return (int(hex_colour[1:3], 16), int(hex_colour[3:5], 16), int(hex_colour[5:7], 16))


def design_summary(facts: list[design.Fact], note: dict) -> dict:
    """The design box the owner asked for: the palette with each colour's share,
    and every contrast finding with the colour that would pass.

    Derived from the FACTS rather than from a second pass over the raster, so
    what the UI shows and what the cases assert cannot drift apart. The
    suggestion comes from visual.nearest_accessible — same hue and chroma, only
    lightness moves — so it is recognisably the same colour, not a different one
    that happens to pass."""
    palette = [{"hex": f.subject, "rgb": list(f.value["colour"]),
                "share": round(f.value["share"], 6), "role": "surface"}
               for f in facts if f.kind == "surface"]
    contrast = []
    for f in facts:
        if f.kind != "contrast":
            continue
        match = _HEX_PAIR_RE.match(f.subject)
        if not match:
            continue
        ink_hex, surface_hex = match.group(1), match.group(2)
        remedy = nearest_accessible(_rgb(ink_hex), _rgb(surface_hex))
        contrast.append({
            "fact_id": f.id,
            "ink": ink_hex, "surface": surface_hex,
            "ratio": round(f.value["ratio"], 3),
            "passes_aa": f.value.get("passes_aa"),
            "passes_aa_large": f.value.get("passes_aa_large"),
            "suggested": remedy.hex,
            "ratio_after": round(remedy.ratio_after, 3),
            "delta_e": round(remedy.delta_e, 3),
            "achievable": remedy.achievable,
        })
    return {
        "raster": note,
        "palette": palette,
        "contrast": contrast,
        "facts": [{"id": f.id, "kind": f.kind, "statement": f.statement} for f in facts],
        "fact_count": len(facts),
        "failing_contrast": sum(1 for c in contrast if c["passes_aa"] is False),
    }


def ui_cases_from_facts(facts: list[design.Fact], inv: dict) -> list[dict]:
    """design.ui_cases translated into this module's case shape.

    The fact id travels into `grounds` unchanged — design.ui_cases' own rule is
    that a case exists only for a fact in the inventory, and carrying the id
    through is what lets the same gate be re-checked here."""
    screen = inv.get("title") or page_path(inv)
    path = page_path(inv)
    url = inv.get("final_url") or inv.get("url") or ""
    out = []
    for case in design.ui_cases(facts, screen=screen):
        step = case["steps"][0]
        fact_ids = [str(fid) for fid in case.get("design_fact_ids") or []]
        out.append({
            "title": case["title"], "description": case["description"],
            "preconditions": case["preconditions"], "type": case["type"],
            "priority": case["priority"], "technique": case["technique"],
            "steps": [{"order": 0, "method": "GET", "path": path,
                       "request": {"url": url, "screen": step.get("screen"),
                                   "check": step.get("check"), "fact": step.get("fact"),
                                   "expected": step.get("expected"),
                                   "evidence": step.get("evidence")},
                       "assertions": step.get("assertions") or [], "extractions": []}],
            "grounds": [f"fact:{fid}" for fid in fact_ids],
        })
    return out


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(timezone.utc)


def upsert_requirement(db: Session, org_id: str, project_id: str, external_id: str,
                       description: str, criteria: list[str], req_type: str,
                       source_location: dict, source_text: str,
                       priority: str = "medium") -> tuple[Requirement, bool]:
    """Create or refresh the requirement this discovery states.

    Re-discovering a target must not fork its requirements, so the row is keyed
    on the external id this module derives from the target. A requirement the
    user already CONFIRMED keeps its state — re-running a crawl is not a reason
    to un-confirm a human decision — but its text is refreshed and its version
    bumped when the page changed, which is what drives staleness (FR-TRC-04)."""
    row = db.scalars(select(Requirement).where(
        Requirement.project_id == project_id,
        Requirement.organisation_id == org_id,
        Requirement.external_id == external_id)).first()
    content_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()
    if row is None:
        row = Requirement(
            organisation_id=org_id, project_id=project_id, external_id=external_id,
            description=description, acceptance_criteria=criteria, type=req_type,
            priority=priority, state="extracted", source_location=source_location,
            source_text=source_text[:8000], content_hash=content_hash, confidence=1.0)
        db.add(row)
        db.flush()
        return row, True
    if row.content_hash != content_hash:
        row.description = description
        row.acceptance_criteria = criteria
        row.source_location = source_location
        row.source_text = source_text[:8000]
        row.content_hash = content_hash
        row.version += 1
        if row.state == "confirmed":
            row.state = "changed"  # the page moved under a confirmed statement
    db.flush()
    return row, False


def persist_case(db: Session, org_id: str, project_id: str, req: Requirement,
                 case: dict, model_name: str = MODEL_NAME) -> TestCase:
    """One grounded case as a draft, plus its requirement link. Mirrors
    generation._persist_case; steps here carry a DOM/design payload instead of
    an endpoint id, which is why it does not reuse it."""
    tc = TestCase(
        organisation_id=org_id, project_id=project_id,
        title=case["title"][:500], description=case["description"],
        preconditions=case["preconditions"], type=case["type"],
        priority=case["priority"], state="draft", generated=True, model=model_name,
        prompt_version=settings.PROMPT_VERSION, technique=case["technique"])
    db.add(tc)
    db.flush()
    for i, step in enumerate(case["steps"]):
        db.add(TestStep(test_case_id=tc.id, order=i, endpoint_id=step.get("endpoint_id"),
                        method=step.get("method", "GET"), path=step.get("path", ""),
                        request=step.get("request") or {},
                        assertions=step.get("assertions") or [],
                        extractions=step.get("extractions") or []))
    db.add(RequirementTestCase(requirement_id=req.id, test_case_id=tc.id,
                               link_source="generated",
                               requirement_version_at_link=req.version))
    return tc


def _existing_case_keys(db: Session, org_id: str, project_id: str) -> set[tuple[str, str]]:
    """(technique, title) of every live case — the duplicate key for a re-run."""
    rows = db.query(TestCase.technique, TestCase.title).filter(
        TestCase.project_id == project_id,
        TestCase.organisation_id == org_id,
        TestCase.state != "archived").all()
    return {(t or "", title or "") for t, title in rows}


# ---------------------------------------------------------------------------
# The job
# ---------------------------------------------------------------------------

def _mark_failed(db: Session, target_id: str, code: str, message: str) -> None:
    target = db.get(WebTarget, target_id)
    if target is not None:
        target.status = "failed"
        target.last_error = f"{code}: {message}"[:4000]
        db.commit()


def _store_screenshot(target_id: str, inv: dict, out_dir: str) -> str:
    """Copy the sidecar's PNG into storage; returns the key, or "" when absent."""
    raw = inv.get("screenshot") or ""
    if not raw:
        return ""
    src = Path(raw)
    if not src.is_absolute():
        src = Path(out_dir) / raw
    if not src.is_file():
        return ""
    dest_dir = settings.STORAGE_DIR / SCREENSHOT_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    key = f"{SCREENSHOT_DIR}/{target_id}.png"
    shutil.copyfile(src, settings.STORAGE_DIR / key)
    return key


def run_discovery_job(job, org_id: str, user_id: str, project_id: str, target_id: str,
                      url: str, viewport: str, test_types: list[str]) -> dict:
    """Render, persist, generate — the job body behind POST /web-targets."""
    db = SessionLocal()
    out_dir = tempfile.mkdtemp(prefix="traceo-webdisc-")
    try:
        try:
            job.progress, job.message = 0.05, f"Rendering {url}"
            payload = run_sidecar(url, viewport, out_dir)
        except JobError as exc:
            _mark_failed(db, target_id, exc.code, exc.message)
            audit(db, org_id, user_id, "web_target.failed", "web_target", target_id,
                  {"url": url, "code": exc.code})
            db.commit()
            raise

        inv = normalise_payload(payload)
        job.progress, job.message = 0.35, "Reading the rendered page"
        screenshot_key = _store_screenshot(target_id, inv, out_dir)

        skipped: list[dict] = []
        cases_by_type = {t: 0 for t in test_types}
        requirement_count = 0
        endpoint_count = 0
        discarded = 0
        duplicates = 0
        existing_keys = _existing_case_keys(db, org_id, project_id)
        short = target_id[:8]

        def emit(req: Requirement, case: dict, kind: str, artefacts: set[str]) -> None:
            """One case through the grounding gate and the duplicate index, or
            not at all. A discarded case is counted, never repaired, never shown
            (BO-07)."""
            nonlocal discarded, duplicates
            if grounding_violations(case, artefacts):
                discarded += 1
                return
            key = (case["technique"], case["title"][:500])
            if key in existing_keys:
                duplicates += 1
                return
            persist_case(db, org_id, project_id, req, case)
            existing_keys.add(key)
            cases_by_type[kind] += 1

        # --- api / security: the captured request inventory ---------------------
        ops: list[dict] = []
        dom_endpoints: list[Endpoint] = []
        if "api" in test_types or "security" in test_types:
            job.progress, job.message = 0.45, "Recording the captured requests"
            ops = endpoints_from_requests(inv["requests"])
            if not ops:
                reason = ("the page made no XHR/fetch request while it was rendered, so "
                          "there is no API surface to record")
                for t in ("api", "security"):
                    if t in test_types:
                        skipped.append({"type": t, "reason": reason})
            else:
                endpoint_count, superseded = persist_endpoints(db, org_id, project_id, ops)
                db.commit()
                if superseded:
                    skipped.append({
                        "type": "api",
                        "reason": ("higher-fidelity sources already own "
                                   f"{len(superseded)} of the observed endpoints "
                                   "(spec/traffic beat dom — SRS §L2)")})
                keys = {(op["method"], op["path"]) for op in ops}
                dom_endpoints = [e for e in db.scalars(select(Endpoint).where(
                    Endpoint.project_id == project_id,
                    Endpoint.organisation_id == org_id,
                    Endpoint.excluded == False)).all()  # noqa: E712
                    if (e.method.upper(), e.path) in keys]

        artefacts = artefact_ids(inv)
        # The artefact an endpoint-derived case stands on is the REQUEST the
        # browser was seen to make; the Endpoint row is a derivation of it, so
        # citing the capture keeps the chain back to observed evidence.
        captured_by_key = {(op["method"], op["path"]): op["urls"][0]
                           for op in ops if op.get("urls")}
        endpoints_by_key = {(e.method.upper(), e.path): e for e in dom_endpoints}

        # --- api: the generator's builders over the observed endpoints ---------
        if "api" in test_types:
            job.progress, job.message = 0.50, "Generating API cases"
            if not dom_endpoints:
                if not any(s["type"] == "api" for s in skipped):
                    skipped.append({"type": "api",
                                    "reason": "no observed request survived as an "
                                              "endpoint to generate against"})
            else:
                api_req, _created = upsert_requirement(
                    db, org_id, project_id, f"WEB-{short}-API",
                    (f"The {len(dom_endpoints)} backend endpoints called by "
                     f"{inv.get('final_url')} must answer as they were observed to."),
                    [f"{e.method.upper()} {e.path} responds within its observed "
                     f"status class" for e in dom_endpoints],
                    "interface",
                    {"url": inv.get("final_url")},
                    json.dumps(sorted(f"{e.method.upper()} {e.path}"
                                      for e in dom_endpoints)),
                    priority="high")
                requirement_count += 1
                for ep in dom_endpoints:
                    captured = captured_by_key.get((ep.method.upper(), ep.path))
                    if captured is None:
                        continue
                    ground = f"request:{ep.method.upper()} {captured}"
                    for case in generation._generate_cases(api_req, ep, "standard"):
                        case = dict(case)
                        case["grounds"] = [ground]
                        # Same second gate the API generator applies: a case may
                        # not cite a parameter or status the endpoint never
                        # declared (BO-07).
                        if generation.grounding_validate(case, endpoints_by_key):
                            discarded += 1
                            continue
                        emit(api_req, case, "api", artefacts)
                db.commit()

        # --- functional: one requirement per form ------------------------------
        if "functional" in test_types:
            job.progress, job.message = 0.55, "Extracting the forms"
            if not inv["forms"]:
                skipped.append({"type": "functional",
                                "reason": "the rendered page contains no form"})
            for form in inv["forms"]:
                description, criteria, source_text = form_requirement_text(form, inv)
                req, created = upsert_requirement(
                    db, org_id, project_id, f"WEB-{short}-F{form['index'] + 1}",
                    description, criteria, "functional",
                    {"url": inv.get("final_url"), "selector": form["selector"]},
                    source_text, priority="high")
                requirement_count += 1
                for case in form_cases(form, inv):
                    emit(req, case, "functional", artefacts)
                # What the form DOES, beside what its fields accept.
                for case in functional_cases(form, inv):
                    emit(req, case, "functional", artefacts)

            # Links belong to the page, not to any one form, so they get their
            # own requirement rather than being attached to an arbitrary form.
            nav = navigation_cases(inv)
            if nav:
                nav_req, _created = upsert_requirement(
                    db, org_id, project_id, f"WEB-{short}-NAV",
                    f"Every link on {inv.get('final_url') or inv.get('url')} must resolve.",
                    ["No link answers 4xx or 5xx."], "functional",
                    {"url": inv.get("final_url")},
                    "", priority="medium")
                requirement_count += 1
                for case in nav:
                    emit(nav_req, case, "functional", artefacts)
            db.commit()

        # --- performance -------------------------------------------------------
        if "performance" in test_types:
            job.progress, job.message = 0.62, "Recording the load baseline"
            if inv.get("elapsed_ms") is None:
                skipped.append({"type": "performance",
                                "reason": "the sidecar reported no elapsed_ms baseline"})
            else:
                budget = settings.PAGE_LOAD_BUDGET_MS
                observed = inv["elapsed_ms"]
                req, _created = upsert_requirement(
                    db, org_id, project_id, f"WEB-{short}-PERF",
                    (f"The page {inv.get('final_url')} must finish loading within "
                     f"{budget}ms. The observed baseline at discovery was {observed}ms."),
                    [f"Page load completes in {budget}ms or less"],
                    "non_functional",
                    {"url": inv.get("final_url")},
                    json.dumps({"budget_ms": budget, "observed_ms": observed},
                               sort_keys=True),
                    priority="high" if observed > budget else "medium")
                requirement_count += 1
                emit(req, performance_case(inv, budget), "performance", artefacts)
            db.commit()

        # --- ui: design facts from the screenshot ------------------------------
        design_payload: dict = {}
        if "ui" in test_types:
            job.progress, job.message = 0.70, "Extracting design facts"
            if not screenshot_key:
                skipped.append({"type": "ui",
                                "reason": "the sidecar produced no screenshot"})
            else:
                try:
                    img = read_png(settings.STORAGE_DIR / screenshot_key)
                except (PngError, OSError, ValueError) as exc:
                    skipped.append({"type": "ui",
                                    "reason": f"the screenshot could not be decoded: {exc}"})
                else:
                    analysed, note = fit_for_analysis(img, viewport)
                    facts = (design.design_facts(analysed)
                             if analysed.width and analysed.height else [])
                    design_payload = design_summary(facts, note)
                    fact_ids = [f.id for f in facts]
                    ui_artefacts = artefact_ids(inv, fact_ids)
                    if not facts:
                        skipped.append({"type": "ui",
                                        "reason": "the screenshot states no extractable "
                                                  "design fact"})
                    else:
                        req, _created = upsert_requirement(
                            db, org_id, project_id, f"WEB-{short}-UI",
                            (f"The screen '{inv.get('title') or url}' conforms to the "
                             f"{len(facts)} design facts extracted from its rendering at "
                             f"{viewport}."),
                            [f.statement for f in facts][:200],
                            "interface",
                            {"url": inv.get("final_url"), "viewport": viewport},
                            json.dumps(sorted(fact_ids), sort_keys=True))
                        requirement_count += 1
                        for case in ui_cases_from_facts(facts, inv):
                            emit(req, case, "ui", ui_artefacts)
                    db.commit()

        # --- security: the S0 builders over the discovered endpoints -----------
        if "security" in test_types and dom_endpoints:
            job.progress, job.message = 0.85, "Building the security plan"
            req, _created = upsert_requirement(
                db, org_id, project_id, f"WEB-{short}-SEC",
                (f"The {len(dom_endpoints)} backend endpoints called by "
                 f"{inv.get('final_url')} must not exhibit the weakness classes in the "
                 f"shipped catalogue (version {securitymod.catalogue_version()})."),
                [f"{e.method.upper()} {e.path} is free of catalogued weaknesses"
                 for e in dom_endpoints],
                "interface",
                {"url": inv.get("final_url")},
                json.dumps(sorted(f"{e.method} {e.path}" for e in dom_endpoints)),
                priority="high")
            requirement_count += 1
            catalogue = securitymod.weaknesses()
            reasons: set[str] = set()
            for ep in dom_endpoints:
                captured = captured_by_key.get((ep.method.upper(), ep.path))
                if captured is None:
                    continue
                ground = f"request:{ep.method.upper()} {captured}"
                for weakness in catalogue:
                    ok, reason = securitymod.applicable(ep, weakness)
                    if not ok:
                        reasons.add(reason)
                        continue
                    for case in securitymod.build_cases(req, ep, weakness):
                        case = dict(case)
                        case["grounds"] = [ground]
                        if grounding_violations(case, artefacts):
                            discarded += 1
                            continue
                        if generation.grounding_validate(case, endpoints_by_key):
                            discarded += 1
                            continue
                        key = (case["technique"], case["title"][:500])
                        if key in existing_keys:
                            duplicates += 1
                            continue
                        securitymod._persist_case(db, org_id, project_id, req, case)
                        existing_keys.add(key)
                        cases_by_type["security"] += 1
            if cases_by_type.get("security", 0) == 0 and reasons:
                skipped.append({"type": "security",
                                "reason": "no weakness class applies to the observed "
                                          "endpoints: " + "; ".join(sorted(reasons)[:3])})
            db.commit()

        # --- persist the target ------------------------------------------------
        job.progress, job.message = 0.95, "Recording the target"
        summary = {
            "test_types": list(test_types),
            "counts": {"forms": len(inv["forms"]), "controls": len(inv["controls"]),
                       "requests": len(inv["requests"]),
                       "api_requests": sum(1 for r in inv["requests"]
                                           if r["resource_type"] in API_RESOURCE_TYPES),
                       "endpoints": endpoint_count},
            "elapsed_ms": inv.get("elapsed_ms"),
            "forms": inv["forms"],
            "controls": inv["controls"][:200],
            "requests": inv["requests"][:300],
            "endpoints": [{"method": op["method"], "path": op["path"],
                           "observed_count": op["observed_count"],
                           "origins": op["origins"], "statuses": op["statuses"]}
                          for op in ops],
            "console_errors": inv["console_errors"],
            "design": design_payload,
            "skipped": skipped,
        }
        target = db.get(WebTarget, target_id)
        if target is not None:
            target.status = "discovered"
            target.title = inv.get("title") or ""
            target.final_url = inv.get("final_url") or url
            target.screenshot_key = screenshot_key
            target.last_discovered_at = _now()
            target.inventory = summary
            target.last_error = None

        result = {
            "target_id": target_id,
            "title": inv.get("title") or "",
            "forms": len(inv["forms"]),
            "controls": len(inv["controls"]),
            "requests": len(inv["requests"]),
            "endpoints": endpoint_count,
            "requirements": requirement_count,
            "cases_by_type": cases_by_type,
            "skipped": skipped,
            "discarded": discarded,
            "duplicates": duplicates,
        }
        audit(db, org_id, user_id, "web_target.discovered", "web_target", target_id,
              {"url": url, "viewport": viewport, "test_types": list(test_types),
               "endpoints": endpoint_count, "requirements": requirement_count,
               "cases": sum(cases_by_type.values()), "discarded": discarded})
        db.commit()
        job.progress, job.message = 0.99, (
            f"{sum(cases_by_type.values())} cases from {len(inv['forms'])} forms, "
            f"{endpoint_count} endpoints")
        return result
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)
        db.close()


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

def web_target_dict(target: WebTarget, *, detail: bool = False) -> dict:
    inventory = target.inventory or {}
    out = {
        "id": target.id, "project_id": target.project_id, "url": target.url,
        "viewport": target.viewport, "status": target.status, "title": target.title,
        "final_url": target.final_url,
        "last_discovered_at": (target.last_discovered_at.isoformat()
                               if target.last_discovered_at else None),
        "has_screenshot": bool(target.screenshot_key),
        "error": target.last_error,
        "test_types": inventory.get("test_types") or [],
        "counts": inventory.get("counts") or {},
        "created_at": target.created_at.isoformat() if target.created_at else None,
    }
    if detail:
        out["inventory"] = {
            "forms": inventory.get("forms") or [],
            "controls": inventory.get("controls") or [],
            "requests": inventory.get("requests") or [],
            "endpoints": inventory.get("endpoints") or [],
            "console_errors": inventory.get("console_errors") or [],
            "elapsed_ms": inventory.get("elapsed_ms"),
            "skipped": inventory.get("skipped") or [],
        }
        out["design"] = inventory.get("design") or {}
    return out


def _target_scoped(target_id: str, user: User, db: Session) -> WebTarget:
    target = db.get(WebTarget, target_id)
    if not target or target.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={"code": "not_found", "message": "Web target not found"})
    return target


@router.post("/projects/{project_id}/web-targets", status_code=202)
def create_web_target(project_id: str, body: WebTargetCreate,
                      user: User = Depends(require("import_spec")),
                      db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    url = validate_target_url(body.url)
    viewport = validate_viewport(body.viewport)
    test_types = validate_test_types(body.test_types)

    target = db.scalars(select(WebTarget).where(
        WebTarget.project_id == project_id,
        WebTarget.organisation_id == user.organisation_id,
        WebTarget.url == url, WebTarget.viewport == viewport)).first()
    if target is None:
        target = WebTarget(organisation_id=user.organisation_id, project_id=project_id,
                           url=url, viewport=viewport, status="pending")
        db.add(target)
    else:
        target.status = "pending"
        target.last_error = None
    audit(db, user.organisation_id, user.id, "web_target.requested", "web_target", target.id,
          {"url": url, "viewport": viewport, "test_types": test_types})
    db.commit()

    org_id, user_id, target_id = user.organisation_id, user.id, target.id
    job = jobstore.submit(
        "discover",
        lambda job: run_discovery_job(job, org_id, user_id, project_id, target_id,
                                      url, viewport, test_types),
        project_id=project_id)
    return {"job_id": job.id, "target_id": target_id, "test_types": test_types}


@router.get("/projects/{project_id}/web-targets")
def list_web_targets(project_id: str, user: User = Depends(require("view")),
                     db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    rows = db.scalars(select(WebTarget).where(
        WebTarget.project_id == project_id,
        WebTarget.organisation_id == user.organisation_id,
    ).order_by(WebTarget.created_at.desc())).all()
    return {"web_targets": [web_target_dict(t) for t in rows]}


@router.get("/web-targets/{target_id}")
def get_web_target(target_id: str, user: User = Depends(require("view")),
                   db: Session = Depends(get_db)):
    return web_target_dict(_target_scoped(target_id, user, db), detail=True)


@router.get("/web-targets/{target_id}/screenshot")
def get_web_target_screenshot(target_id: str, user: User = Depends(require("view")),
                              db: Session = Depends(get_db)):
    target = _target_scoped(target_id, user, db)
    if not target.screenshot_key:
        raise HTTPException(404, detail={
            "code": "no_screenshot", "message": "This target has no screenshot."})
    path = settings.STORAGE_DIR / target.screenshot_key
    if not path.is_file():
        raise HTTPException(404, detail={
            "code": "no_screenshot", "message": "The screenshot file is missing from storage."})
    return Response(content=path.read_bytes(), media_type="image/png",
                    headers={"Cache-Control": "no-store"})
