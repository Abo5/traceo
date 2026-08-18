"""Deterministic offline provider — exercises the full pipeline without model cost (TRD §10.1).
English heuristics for requirement structuring and endpoint mapping."""
import json
import re

import jsonschema

from .base import LLMResult, strip_untrusted_frame

EN_MUST = ("shall", "must", "required to", "has to")

ID_RE = re.compile(r"\b((?:REQ|FR|BR|NFR|UC)[-_ ]?\d+(?:[-.]\d+)?)\b", re.IGNORECASE)
BULLET_RE = re.compile(r"^\s*(?:[-*•▪]|\d+[.)]|[a-h][.)])\s+(.*)$")


class MockProvider:
    name = "mock"

    def complete_json(self, prompt_id: str, prompt: str, schema: dict) -> LLMResult:
        if prompt_id.startswith("extract_requirement"):
            data = self._extract(prompt)
        elif prompt_id.startswith("map_requirement"):
            data = self._map(prompt)
        elif prompt_id.startswith("enrich_endpoints"):
            data = self._enrich(prompt)
        elif prompt_id.startswith("pageintel"):
            data = self._page_behaviours(prompt)
        else:
            data = {}
        jsonschema.validate(data, schema)
        return LLMResult(data=data, model="mock-deterministic", prompt_version="v1.0")

    # --- requirement structuring ---
    def _extract(self, segment: str) -> dict:
        # SENTINEL CONTRACT: ingestion.EXTRACT_PROMPT ends with "SEGMENT:\n" and the
        # segment itself is wrapped by llm.base.frame_untrusted. Stripping the frame
        # here keeps this deterministic parse byte-identical to the pre-hardening
        # behaviour — if either sentinel moves, it moves in both files at once.
        text = strip_untrusted_frame(segment.split("SEGMENT:\n", 1)[-1])
        lines = [ln.rstrip() for ln in text.splitlines() if ln.strip()]
        m = ID_RE.search(text)
        external_id = m.group(1).upper().replace(" ", "-").replace("_", "-") if m else ""

        criteria, body = [], []
        for ln in lines:
            b = BULLET_RE.match(ln)
            if b and len(b.group(1)) > 3:
                criteria.append(b.group(1).strip())
            else:
                body.append(ln.strip())
        description = " ".join(body) if body else (lines[0] if lines else text[:200])
        if external_id:
            description = re.sub(r"^\W*" + re.escape(m.group(1)) + r"\W*", "", description).strip() or description

        lowered = text.lower()
        if any(w in lowered for w in EN_MUST):
            rtype = "functional"
        elif re.search(r"(performance|second|latency|throughput)", lowered):
            rtype = "non_functional"
        elif re.search(r"(data|field|record)", lowered):
            rtype = "data"
        else:
            rtype = "functional"

        priority = "high" if re.search(r"(critical|must)", lowered) else "medium"
        confidence = 0.92 if external_id else (0.75 if criteria else 0.6)
        return {
            "external_id": external_id,
            "description": description[:2000],
            "acceptance_criteria": criteria[:12],
            "type": rtype,
            "priority": priority,
            "confidence": confidence,
        }

    # --- requirement -> endpoint mapping (closed candidate list; returns indices) ---
    def _map(self, prompt: str) -> dict:
        try:
            payload = json.loads(prompt.split("PAYLOAD:\n", 1)[-1])
        except Exception:
            return {"selected": [], "confidence": 0.0}
        # the requirement text arrives framed as untrusted data — unwrap before scoring
        req_text = strip_untrusted_frame(payload.get("requirement") or "").lower()
        tokens = set(re.findall(r"[a-z]{3,}", req_text))
        scored = []
        for i, cand in enumerate(payload.get("candidates", [])):
            cand_text = " ".join(str(cand.get(k, "")) for k in ("method", "path", "summary", "operation_id", "tags")).lower()
            cand_tokens = set(re.findall(r"[a-z]{3,}", cand_text))
            # path segments count double — they carry the resource name
            path_tokens = set(re.findall(r"[a-z]{3,}", str(cand.get("path", "")).lower()))
            score = len(tokens & cand_tokens) + len(tokens & path_tokens)
            if score > 0:
                scored.append((score, i))
        scored.sort(reverse=True)
        top = [i for s, i in scored[:3] if s >= max(1, (scored[0][0] // 2 if scored else 1))]
        confidence = min(0.95, 0.35 + 0.15 * (scored[0][0] if scored else 0))
        return {"selected": top, "confidence": round(confidence, 2)}

    # --- endpoint inventory enrichment (annotations only; the caller's gate still
    #     re-verifies every method+path against the deterministic inventory) ---
    def _enrich(self, prompt: str) -> dict:
        # SENTINEL CONTRACT: enrichment.ENRICH_INSTRUCTIONS ends with "PAYLOAD:\n"
        # — same convention as map_requirement above.
        try:
            payload = json.loads(prompt.split("PAYLOAD:\n", 1)[-1])
        except Exception:
            return {"endpoints": []}
        out = []
        for ep in payload.get("endpoints", []):
            if not isinstance(ep, dict):
                continue
            method = str(ep.get("method", "")).upper()
            path = str(ep.get("path", ""))
            if not method or not path:
                continue
            # Deterministic English: verb from the method, subject from the last
            # literal (non-templated) path segment.
            verb = MOCK_VERBS.get(method, "Call")
            literals = [s for s in path.split("/") if s and not s.startswith("{")]
            resource = literals[-1] if literals else "root"
            group = literals[0] if literals else "root"
            out.append({
                "method": method,
                "path": path,
                "description": f"{verb} the {resource} resource via {method} {path}.",
                "group": group,
                "criticality": MOCK_CRITICALITY.get(method, "low"),
            })
        return {"endpoints": out}


    # --- behaviours for one crawled screen -----------------------------------
    #
    # The real value of this track is a model's reading of a screen, which a mock
    # cannot have. What it CAN do is exercise the whole path honestly: propose
    # cases that cite real ids from the payload, so the caller's grounding gate,
    # the persistence and the tests all run against the shape they will see in
    # production — and produce them deterministically, so an offline suite is
    # reproducible. The behaviours below are the ones that follow from the page's
    # own declarations; nothing here pretends to understand the domain.
    def _page_behaviours(self, prompt: str) -> dict:
        # SENTINEL CONTRACT: pageintel.INSTRUCTIONS ends with "PAYLOAD:\n" and the
        # payload is wrapped by llm.base.frame_untrusted.
        try:
            payload = json.loads(strip_untrusted_frame(prompt.split("PAYLOAD:\n", 1)[-1]))
        except Exception:
            return {"cases": []}

        cases = []
        for form in payload.get("forms", []):
            fields = [f for f in form.get("fields", []) if isinstance(f, dict) and f.get("id")]
            # A hidden field is not something a person fills in, so a behaviour
            # written about one would be noise on every screen that carries a CSRF
            # token.
            usable = [f for f in fields if f.get("type") != "hidden"]
            if not usable:
                continue
            name = form.get("name") or "the form"
            label = lambda f: f.get("label") or f.get("placeholder") or f["id"]

            # Required flags are the page's own statement, and plenty of real
            # forms carry none: the OrangeHRM demo marks nothing required and
            # still refuses an empty submission. So the empty-submission case is
            # written from the FIELDS, not from the flags, and the per-field ones
            # only when the page actually claims the field is required.
            cases.append({
                "title": f"Submitting {name} with every field empty is refused",
                "expected": ("The submission does not succeed and the screen says what "
                             "is missing."),
                "type": "negative", "priority": "high",
                "field_ids": [f["id"] for f in usable],
                "control_ids": [],
            })
            cases.append({
                "title": f"Submitting {name} with a valid value in every field is accepted",
                "expected": ("The submission is accepted and the screen moves on rather "
                             "than reporting an error."),
                "type": "positive", "priority": "high",
                "field_ids": [f["id"] for f in usable],
                "control_ids": [],
            })
            for field in [f for f in usable if f.get("required")][:4]:
                cases.append({
                    "title": f"Submitting {name} without {label(field)} is refused",
                    "expected": f"The submission is refused and {label(field)} is reported "
                                "as required.",
                    "type": "negative", "priority": "medium",
                    "field_ids": [field["id"]], "control_ids": [],
                })
            for field in usable:
                if field.get("maxlength"):
                    cases.append({
                        "title": f"{label(field)} refuses more than "
                                 f"{field['maxlength']} characters",
                        "expected": f"Input longer than {field['maxlength']} characters is "
                                    "refused or truncated, never stored whole.",
                        "type": "negative", "priority": "low",
                        "field_ids": [field["id"]], "control_ids": [],
                    })
                    break
            for field in usable:
                if field.get("pattern"):
                    cases.append({
                        "title": f"{label(field)} refuses a value its format rule forbids",
                        "expected": f"A value not matching {field['pattern']} is refused "
                                    "with a message naming the field.",
                        "type": "negative", "priority": "medium",
                        "field_ids": [field["id"]], "control_ids": [],
                    })
                    break

        # A screen with no form still has actions, and whether they lead anywhere
        # is a real behaviour. Only named controls are described, so only named
        # ones can be cited.
        if not cases:
            for control in payload.get("controls", [])[:5]:
                cases.append({
                    "title": f"'{control['name']}' leads somewhere and reports failure "
                             "when it cannot",
                    "expected": f"Activating '{control['name']}' reaches its destination, or "
                                "says why it could not — it never fails silently.",
                    "type": "positive", "priority": "low",
                    "field_ids": [], "control_ids": [control["id"]],
                })

        return {"cases": cases[:12]}


# Deterministic enrichment vocabulary — kept module level so the Go mock can
# mirror it exactly (parity: same file in, same annotations out).
MOCK_VERBS = {
    "GET": "Read", "POST": "Create", "PUT": "Replace", "PATCH": "Update",
    "DELETE": "Delete", "HEAD": "Check", "OPTIONS": "Describe",
}
MOCK_CRITICALITY = {
    "DELETE": "high", "PUT": "high", "POST": "medium", "PATCH": "medium",
    "GET": "low", "HEAD": "low", "OPTIONS": "low",
}
