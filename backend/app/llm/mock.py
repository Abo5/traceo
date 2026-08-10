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
