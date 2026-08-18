"""Model-assisted test cases for a crawled page — "the model proposes, the system verifies".

WHY THIS EXISTS. The crawl already reads a page exactly: every form, field, label,
control and captured request. What it cannot do is understand what the screen is
FOR. Measured on a 22-page crawl of the OrangeHRM demo, the deterministic tracks
produced 1649 cases of which 987 read "Design: surface #FFFFFF is present" and 15
were functional — structurally true, and nearly silent about the product. Nothing
said "adding an employee without a first name must be rejected", because nothing
in the pipeline knows what an employee is.

That is the one job a model is actually better at than a rule: reading a rendered
screen and saying what a person would try on it. So it is given the page — and
ONLY the page — and asked for behaviours.

WHAT THE MODEL MAY AND MAY NOT DECIDE. It may decide intent: which flows matter,
what a sensible value looks like, what the product should do in response. It may
NOT decide what exists. Every case it proposes must address artefacts by the ids
in a CLOSED list built from the crawl; a case naming anything else is discarded,
never repaired (BO-07). So a hallucinated "#email-2fa" field cannot reach a test
plan, while a hallucinated *expectation* is exactly what a human reviewer is
there to judge — which is why these land as drafts like everything else.

The model never sees a credential: the payload is built from the inventory, and
the inventory never carried one.
"""
from __future__ import annotations

import json

from ..config import settings
from ..llm import UNTRUSTED_NOTE, frame_untrusted, get_provider

# Enough of a page to reason about, small enough that a 25-page crawl does not
# blow the context window. A page with more fields than this is truncated rather
# than dropped: half a form still yields real cases, and the cap is reported.
MAX_FIELDS_PER_FORM = 25
MAX_FORMS_PER_PAGE = 6
MAX_CONTROLS = 30
MAX_ENDPOINTS = 15
MAX_CASES_PER_PAGE = 12

PROMPT_ID = "pageintel.v1"

INSTRUCTIONS = (
    "You are writing functional test cases for ONE screen of a web application. "
    "The payload describes what a browser actually rendered: the screen's URL and "
    "title, its forms with every field, the controls a user can activate, and the "
    "requests the page issued.\n\n"
    "Write the cases a competent tester would write for THIS screen — the "
    "behaviours that matter, not a description of the markup. Prefer: required "
    "and format rules a user will hit, the outcome of a successful submission, "
    "what must happen when a value is wrong or absent, and state the screen "
    "implies (an empty list, an item that already exists).\n\n"
    "RULES THAT DECIDE WHETHER YOUR CASE IS KEPT:\n"
    "  * `field_ids` and `control_ids` may ONLY contain ids that appear in the "
    "payload. An id you invent means the whole case is discarded — an empty list "
    "is a valid answer, a guessed id is not.\n"
    "  * `title` is one line naming the behaviour, not the element. Write "
    "\"Submitting with no username is rejected\", never \"the username input "
    "exists\" — the deterministic tracks already assert what is present.\n"
    "  * `expected` is what the PRODUCT must do, in one sentence, observable on "
    "this screen.\n"
    "  * `type` is positive when the flow should succeed, negative when the "
    "product must refuse.\n"
    "  * Do not invent screens, URLs, endpoints, roles or data that the payload "
    "does not contain. Do not write cases about pages other than this one.\n"
    f"  * At most {MAX_CASES_PER_PAGE} cases. Fewer good ones beat more thin ones.\n"
    + UNTRUSTED_NOTE
)

SCHEMA = {
    "type": "object",
    "properties": {
        "cases": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "expected": {"type": "string"},
                    "type": {"type": "string", "enum": ["positive", "negative"]},
                    "priority": {"type": "string", "enum": ["high", "medium", "low"]},
                    "field_ids": {"type": "array", "items": {"type": "string"}},
                    "control_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["title", "expected", "type", "field_ids"],
            },
        }
    },
    "required": ["cases"],
}


def page_payload(page: dict) -> dict:
    """The closed description of one page, and the only thing the model sees.

    Ids are positional (`f0.2` = form 0, field 2) rather than CSS selectors: a
    selector is a 200-character path that wastes context and invites the model to
    edit it, while a short id it cannot plausibly guess makes fabrication obvious
    at the gate.
    """
    forms = []
    for fi, form in enumerate((page.get("forms") or [])[:MAX_FORMS_PER_PAGE]):
        fields = []
        for xi, field in enumerate((form.get("fields") or [])[:MAX_FIELDS_PER_FORM]):
            entry = {
                "id": f"f{fi}.{xi}",
                "label": field.get("label") or field.get("name") or field.get("id") or "",
                "type": field.get("type") or "text",
                "required": bool(field.get("required")),
            }
            if field.get("placeholder"):
                entry["placeholder"] = field["placeholder"]
            if field.get("pattern"):
                entry["pattern"] = field["pattern"]
            if field.get("maxlength") is not None:
                entry["maxlength"] = field["maxlength"]
            fields.append(entry)
        forms.append({
            "id": f"f{fi}",
            "name": form.get("name") or form.get("heading") or form.get("submit_name") or "",
            "method": form.get("method") or "GET",
            "submits_to": form.get("action") or "",
            "fields": fields,
        })

    controls = []
    for ci, control in enumerate((page.get("controls") or [])[:MAX_CONTROLS]):
        name = (control.get("name") or "").strip()
        if not name:
            continue  # an unnamed control cannot be described, so it cannot be cited
        controls.append({"id": f"c{ci}", "name": name[:120],
                         "role": control.get("role") or "button"})

    calls = []
    seen: set[tuple[str, str]] = set()
    for req in page.get("requests") or []:
        if req.get("resource_type") not in ("xhr", "fetch"):
            continue
        key = (req.get("method") or "GET", (req.get("url") or "").split("?")[0])
        if key in seen:
            continue
        seen.add(key)
        calls.append({"method": key[0], "url": key[1]})
        if len(calls) >= MAX_ENDPOINTS:
            break

    return {
        "url": page.get("final_url") or page.get("url") or "",
        "title": page.get("title") or "",
        "forms": forms,
        "controls": controls,
        "requests_the_page_made": calls,
    }


def artefact_index(payload: dict) -> tuple[dict[str, dict], dict[str, dict]]:
    """(field id -> field, control id -> control) — the closed list the gate uses."""
    fields = {f["id"]: f for form in payload["forms"] for f in form["fields"]}
    controls = {c["id"]: c for c in payload["controls"]}
    return fields, controls


def violations(case: dict, fields: dict, controls: dict) -> list[str]:
    """Why this proposal is not admissible, or [] if it is.

    Separate from the caller so the rule can be tested directly and shown to
    reject a fabricated case before it is trusted to accept a real one.
    """
    problems: list[str] = []
    if not str(case.get("title") or "").strip():
        problems.append("case has no title")
    if not str(case.get("expected") or "").strip():
        problems.append("case states no expected outcome")
    cited = list(case.get("field_ids") or []) + list(case.get("control_ids") or [])
    if not cited:
        problems.append("case cites no field or control from this page")
    for fid in case.get("field_ids") or []:
        if fid not in fields:
            problems.append(f"field '{fid}' is not on this page")
    for cid in case.get("control_ids") or []:
        if cid not in controls:
            problems.append(f"control '{cid}' is not on this page")
    return problems


def build_case(proposal: dict, payload: dict, page: dict,
               fields: dict, controls: dict) -> dict:
    """One admissible proposal as a persistable case.

    The step carries the page's own selectors — resolved here from the ids the
    model cited, never from anything it wrote — so the case is runnable against
    the screen and auditable back to the render.
    """
    selectors: list[str] = []
    for fi, form in enumerate((page.get("forms") or [])[:MAX_FORMS_PER_PAGE]):
        for xi, field in enumerate((form.get("fields") or [])[:MAX_FIELDS_PER_FORM]):
            if f"f{fi}.{xi}" in set(proposal.get("field_ids") or []):
                selectors.append(field["selector"])
    control_selectors: list[str] = []
    for ci, control in enumerate((page.get("controls") or [])[:MAX_CONTROLS]):
        if f"c{ci}" in set(proposal.get("control_ids") or []):
            control_selectors.append(control["selector"])

    url = payload["url"]
    labels = [fields[fid]["label"] for fid in (proposal.get("field_ids") or [])
              if fid in fields]
    grounds = ([f"selector:{s}" for s in selectors + control_selectors]
               + ([f"page:{url}"] if url else []))
    return {
        "title": str(proposal["title"])[:500],
        "description": (f"Behaviour proposed for the screen '{payload['title'] or url}' "
                        f"from what the crawl found there"
                        + (f": {', '.join(labels[:6])}." if labels else ".")),
        "preconditions": f"The page {url} is loaded in a browser",
        "type": proposal.get("type") or "positive",
        "priority": proposal.get("priority") or "medium",
        "technique": "scenario",
        "steps": [{
            "order": 0, "method": "GET", "path": payload.get("path") or "/",
            "request": {"url": url, "screen": payload["title"] or url,
                        "check": "behaviour",
                        "fields": selectors, "controls": control_selectors},
            "assertions": [{"type": "expected_outcome",
                            "statement": str(proposal["expected"])[:500]}],
            "extractions": [],
        }],
        "grounds": grounds,
    }


def propose(page: dict, path: str, provider=None) -> tuple[list[dict], int, list[str]]:
    """(cases, discarded, notes) for one crawled page.

    A provider failure is not a job failure: this track is an addition to the
    deterministic ones, and a page that yields no proposals is reported, not
    fatal (NFR-REL-03).
    """
    payload = page_payload(page)
    payload["path"] = path
    if not payload["forms"] and not payload["controls"]:
        return [], 0, ["the page has no form or named control to write behaviour about"]

    provider = provider or get_provider()
    try:
        result = provider.complete_json(
            PROMPT_ID,
            INSTRUCTIONS + "PAYLOAD:\n" + frame_untrusted(
                json.dumps(payload, ensure_ascii=False, sort_keys=True)),
            SCHEMA)
    except Exception as exc:  # noqa: BLE001 — any provider error degrades the track
        return [], 0, [f"the model could not be consulted: {type(exc).__name__}"]

    fields, controls = artefact_index(payload)
    cases: list[dict] = []
    discarded = 0
    notes: list[str] = []
    for proposal in (result.data.get("cases") or [])[:MAX_CASES_PER_PAGE]:
        if not isinstance(proposal, dict):
            discarded += 1
            continue
        problems = violations(proposal, fields, controls)
        if problems:
            discarded += 1
            if problems[0] not in notes:
                notes.append(problems[0])
            continue
        cases.append(build_case(proposal, payload, page, fields, controls))
    return cases, discarded, notes


MODEL_NAME_FALLBACK = "mock-deterministic"


def model_name(provider=None) -> str:
    provider = provider or get_provider()
    return getattr(provider, "model", None) or settings.LLM_MODEL or MODEL_NAME_FALLBACK
