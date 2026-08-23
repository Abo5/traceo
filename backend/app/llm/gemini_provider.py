"""Google Gemini provider via the Generative Language REST API.

Deliberately httpx rather than the google-genai SDK: httpx is already a
dependency of this backend, and the one call this provider makes
(`models/{model}:generateContent`) is a stable, documented POST. Adding an SDK
would buy nothing here and cost an install on every deployment.

Structured output is asked for twice over, because neither half is sufficient
alone. Gemini's `responseSchema` speaks an OpenAPI-3.0 subset, not JSON Schema:
it has no `additionalProperties`, and it requires an explicit `type` where JSON
Schema infers one from `enum` — both of which this codebase's schemas use. So
the schema is translated before it is sent (see `_to_gemini_schema`), and the
UNTRANSLATED schema is still validated locally on the way out. The local
validation is the real gate; `responseSchema` only makes the model likelier to
pass it first time.
"""
import json

import httpx
import jsonschema

from ..config import settings
from .base import LLMResult

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"

# Keys with no equivalent in Gemini's schema dialect. Sending them has been seen
# to 400 the whole request, so they are dropped rather than passed through —
# `additionalProperties: false` in particular is a constraint we still enforce
# locally, just not through the API.
_UNSUPPORTED = {"additionalProperties", "$schema", "$defs", "definitions",
                "patternProperties", "allOf", "oneOf", "not", "const"}


def _to_gemini_schema(node: object) -> object:
    """Translate a JSON Schema into the OpenAPI-3.0 subset Gemini accepts.

    Only ever loosens: anything it cannot express is dropped, never invented.
    A dropped constraint is still enforced by the local jsonschema pass.
    """
    if isinstance(node, list):
        return [_to_gemini_schema(n) for n in node]
    if not isinstance(node, dict):
        return node

    out: dict = {}
    for key, value in node.items():
        if key in _UNSUPPORTED:
            continue
        if key == "properties" and isinstance(value, dict):
            # A property NAME is not a schema keyword — recurse into the values only.
            out[key] = {k: _to_gemini_schema(v) for k, v in value.items()}
        elif key in ("items", "prefixItems"):
            out[key] = _to_gemini_schema(value)
        else:
            out[key] = value

    # `{"enum": [...]}` with no type is valid JSON Schema and invalid here.
    # Gemini only enumerates strings, so a mixed-type enum is dropped to a bare
    # type rather than sent as something the API would refuse.
    if "enum" in out and "type" not in out:
        if all(isinstance(v, str) for v in out["enum"]):
            out["type"] = "string"
        else:
            out.pop("enum")
    return out


class GeminiProvider:
    name = "gemini"

    def __init__(self, model: str = "gemini-3.5-flash", api_key: str | None = None):
        key = api_key or settings.GEMINI_API_KEY
        if not key:
            raise RuntimeError(
                "GEMINI_API_KEY (or GOOGLE_API_KEY) is not set — "
                "TRACEO_LLM_PROVIDER=gemini needs a key")
        self.model = model
        self._key = key
        # The key travels as a header, never in the URL: a URL is what ends up in
        # access logs, proxy logs and exception messages.
        self._client = httpx.Client(
            base_url=API_ROOT,
            timeout=settings.LLM_TIMEOUT_S,
            headers={"x-goog-api-key": key, "content-type": "application/json"},
        )

    def _call(self, prompt: str, schema: dict | None) -> dict:
        config: dict = {
            "responseMimeType": "application/json",
            "maxOutputTokens": settings.LLM_MAX_TOKENS,
            "temperature": 0,  # this is extraction, not writing; reruns should agree
        }
        if schema is not None:
            config["responseSchema"] = schema
        res = self._client.post(
            f"/models/{self.model}:generateContent",
            json={"contents": [{"role": "user", "parts": [{"text": prompt}]}],
                  "generationConfig": config},
        )
        if res.status_code >= 400:
            detail = ""
            try:
                detail = res.json().get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001 — the body may not be JSON at all
                detail = res.text[:300]
            raise httpx.HTTPStatusError(f"Gemini {res.status_code}: {detail}",
                                        request=res.request, response=res)
        return res.json()

    @staticmethod
    def _text_of(body: dict) -> str:
        """The answer parts, minus the model's own thinking.

        Gemini 3.x returns reasoning as parts flagged `thought: true` in the same
        list as the answer. Concatenating everything would hand the JSON parser a
        prose preamble and fail every call on a thinking model.
        """
        candidates = body.get("candidates") or []
        if not candidates:
            blocked = (body.get("promptFeedback") or {}).get("blockReason")
            raise RuntimeError(f"Gemini returned no candidate"
                               + (f" (prompt blocked: {blocked})" if blocked else ""))
        cand = candidates[0]
        reason = cand.get("finishReason")
        if reason in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"):
            raise RuntimeError(f"Model declined the request (finishReason={reason})")
        parts = ((cand.get("content") or {}).get("parts")) or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if reason == "MAX_TOKENS" and not text.strip():
            raise RuntimeError(
                "Gemini hit maxOutputTokens before emitting an answer — raise "
                "TRACEO_LLM_MAX_TOKENS (thinking models spend the budget first)")
        return text or "{}"

    def complete_json(self, prompt_id: str, prompt: str, schema: dict) -> LLMResult:
        gemini_schema: dict | None = _to_gemini_schema(schema)  # type: ignore[assignment]
        last_err = None
        for _ in range(2):  # exactly one retry, as the contract in base.py requires
            try:
                body = self._call(prompt, gemini_schema)
            except httpx.HTTPStatusError as e:
                # A 400 here is the schema translation being refused, not the
                # prompt. Drop responseSchema and let the local validation carry
                # it — a looser request that still passes the gate beats no answer.
                if e.response is not None and e.response.status_code == 400 and gemini_schema is not None:
                    gemini_schema = None
                    last_err = e
                    continue
                raise
            text = self._text_of(body)
            usage = body.get("usageMetadata") or {}
            try:
                data = json.loads(text)
                jsonschema.validate(data, schema)  # the ORIGINAL schema, not the translated one
                return LLMResult(
                    data=data, model=self.model, prompt_version=settings.PROMPT_VERSION,
                    input_tokens=int(usage.get("promptTokenCount") or 0),
                    output_tokens=int(usage.get("candidatesTokenCount") or 0),
                    meta={"provider": self.name,
                          "finish_reason": (body.get("candidates") or [{}])[0].get("finishReason")},
                )
            except Exception as e:  # noqa: BLE001
                last_err = e
                prompt = (prompt + f"\n\nPrevious output failed validation: {e}. "
                          "Return ONLY valid JSON per the schema.")
        raise RuntimeError(f"Schema validation failed after retry: {last_err}")
