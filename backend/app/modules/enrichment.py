"""AI enrichment of an imported endpoint inventory — model proposes, system verifies.

A Postman/HAR/Insomnia collection carries no prose: request names are things like
"Get Access Control Rule" and there is no `summary`, no `tags`, no notion of which
endpoints matter. This layer asks the model for exactly three annotations per
endpoint — a one-line description, a resource group, and a criticality hint — and
then throws away anything it cannot verify.

THE GATE (inviolable, mirrors generation.grounding_validate):
  * The model is given the DETERMINISTIC inventory only: methods, paths, parameter
    names, inferred body field names. Never the uploaded file's raw text.
  * Every returned item must match an inventory row by EXACT method + path.
    Anything else is discarded and counted.
  * Enrichment may not create, rename or delete an endpoint, nor touch a path, a
    parameter or a field name. It writes to three annotation columns and nothing
    else, as plain text.
  * A model failure is never an import failure — the caller keeps the deterministic
    import and reports zero enrichment.
"""
from __future__ import annotations

import json
import re

from ..llm import UNTRUSTED_NOTE, get_provider

CRITICALITIES = ("high", "medium", "low")

# Endpoints per model call. The inventory is chunked in path order so a 400-route
# collection cannot blow the context window; counts are summed across chunks.
BATCH_SIZE = 50

MAX_DESCRIPTION = 500
MAX_GROUP = 100

ENRICH_INSTRUCTIONS = (
    "You are annotating an API endpoint inventory that was extracted "
    "deterministically from an API collection. For EVERY endpoint in the payload "
    "return one object with:\n"
    "  method, path      — copied VERBATIM from the payload (your only way to be "
    "matched; anything else is discarded)\n"
    "  description       — one short plain-English sentence describing what the "
    "endpoint does\n"
    "  group             — the resource group it belongs to (1-2 words)\n"
    "  criticality       — exactly one of: high, medium, low\n"
    "Do NOT invent endpoints, paths, parameters or fields. Do NOT rename anything. "
    "Return only endpoints that appear in the payload.\n"
    + UNTRUSTED_NOTE
)

ENRICH_SCHEMA = {
    "type": "object",
    "properties": {
        "endpoints": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "method": {"type": "string"},
                    "path": {"type": "string"},
                    "description": {"type": "string"},
                    "group": {"type": "string"},
                    "criticality": {"type": "string", "enum": list(CRITICALITIES)},
                },
                "required": ["method", "path", "description", "group", "criticality"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["endpoints"],
    "additionalProperties": False,
}

_WS_RE = re.compile(r"\s+")


def _body_fields(schema: object) -> list[str]:
    """Top-level inferred body field names — enough context for a one-liner without
    shipping the example values (which may contain customer data)."""
    if isinstance(schema, dict) and isinstance(schema.get("properties"), dict):
        return [str(k) for k in schema["properties"]]
    return []


def build_payload(operations: list[dict]) -> list[dict]:
    """The ONLY thing the model ever sees: derived structure, never file text."""
    payload = []
    for op in operations:
        payload.append({
            "method": str(op.get("method", "")).upper(),
            "path": str(op.get("path", "")),
            "params": [str(p.get("name", "")) for p in (op.get("parameters") or [])
                       if isinstance(p, dict) and p.get("name")],
            "body_fields": _body_fields(op.get("request_schema")),
        })
    return payload


def _clean_text(value: object, limit: int) -> str:
    """Plain text only: collapse whitespace, drop control characters, truncate."""
    text = _WS_RE.sub(" ", str(value or "")).strip()
    text = "".join(ch for ch in text if ch == " " or ch.isprintable())
    return text[:limit]


def _known_names(op: dict) -> set[str]:
    """Every parameter and top-level body field name this endpoint actually has,
    lowercased — the vocabulary an annotation is allowed to mention."""
    names = {str(p.get("name", "")).lower()
             for p in (op.get("parameters") or [])
             if isinstance(p, dict) and p.get("name")}
    names.update(n.lower() for n in _body_fields(op.get("request_schema")))
    return names


def _references_unknown_name(item: dict, known: set[str]) -> bool:
    """True when the model echoed back a parameter or field the inventory never
    produced. Such an item is discarded whole: an annotation that has invented a
    field name is not evidence about the endpoint it claims to describe."""
    for key in ("params", "parameters", "fields", "body_fields"):
        for entry in (item.get(key) if isinstance(item.get(key), list) else []):
            name = entry.get("name") if isinstance(entry, dict) else entry
            name = str(name or "").strip().lower()
            if name and name not in known:
                return True
    return False


def validate_enrichment(items: object, operations: list[dict]) -> tuple[dict, int]:
    """THE GATE. Returns ({(METHOD, path): annotation}, discarded_count).

    An item survives only if method+path match an inventory row EXACTLY, it
    mentions no parameter or field the inventory does not have, the criticality is
    one of high|medium|low, and the description is non-empty text. The first item
    for a key wins; duplicates are discarded like any other unusable item, so the
    model cannot overwrite its own verified answer.
    """
    known = {(str(op.get("method", "")).upper(), str(op.get("path", ""))): _known_names(op)
             for op in operations}
    accepted: dict[tuple[str, str], dict] = {}
    discarded = 0
    for item in (items if isinstance(items, list) else []):
        if not isinstance(item, dict):
            discarded += 1
            continue
        key = (str(item.get("method", "")).upper(), str(item.get("path", "")))
        criticality = str(item.get("criticality", "")).strip().lower()
        description = _clean_text(item.get("description"), MAX_DESCRIPTION)
        if key not in known or key in accepted or criticality not in CRITICALITIES \
                or not description \
                or _references_unknown_name(item, known[key]):
            discarded += 1
            continue
        accepted[key] = {
            "ai_description": description,
            "ai_group": _clean_text(item.get("group"), MAX_GROUP),
            "ai_criticality": criticality,
        }
    return accepted, discarded


def enrich(operations: list[dict], provider=None) -> tuple[dict, int]:
    """Annotate the inventory. Returns ({(METHOD, path): annotation}, discarded).

    Never raises: a provider that errors, times out or returns nonsense yields
    ({}, discarded-so-far) and the import proceeds unenriched.
    """
    if not operations:
        return {}, 0
    provider = provider or get_provider()
    payload = build_payload(operations)
    accepted: dict[tuple[str, str], dict] = {}
    discarded = 0
    for start in range(0, len(payload), BATCH_SIZE):
        batch = payload[start:start + BATCH_SIZE]
        try:
            result = provider.complete_json(
                "enrich_endpoints",
                ENRICH_INSTRUCTIONS + "PAYLOAD:\n" + json.dumps(
                    {"endpoints": batch}, ensure_ascii=False),
                ENRICH_SCHEMA)
            items = (result.data or {}).get("endpoints")
        except Exception:  # noqa: BLE001 — the model never fails an import
            continue
        batch_accepted, batch_discarded = validate_enrichment(items, operations)
        discarded += batch_discarded
        for key, annotation in batch_accepted.items():
            if key in accepted:
                discarded += 1  # a later batch re-proposing a verified key
                continue
            accepted[key] = annotation
    return accepted, discarded
