"""Claude provider via the official Anthropic SDK. Structured output enforced with
output_config.format (json_schema); one retry on validation failure (TRD §4.9)."""
import jsonschema
from anthropic import Anthropic

from ..config import settings
from .base import LLMResult


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, model: str = "claude-opus-5"):
        self.model = model
        self.client = Anthropic()  # ANTHROPIC_API_KEY / ant auth profile from env

    def complete_json(self, prompt_id: str, prompt: str, schema: dict) -> LLMResult:
        last_err = None
        for _ in range(2):  # exactly one retry
            response = self.client.messages.create(
                model=self.model,
                max_tokens=4096,
                output_config={"format": {"type": "json_schema", "schema": schema}},
                messages=[{"role": "user", "content": prompt}],
            )
            if response.stop_reason == "refusal":
                raise RuntimeError("Model declined the request")
            text = next((b.text for b in response.content if b.type == "text"), "{}")
            import json
            try:
                data = json.loads(text)
                jsonschema.validate(data, schema)
                return LLMResult(
                    data=data, model=self.model, prompt_version=settings.PROMPT_VERSION,
                    input_tokens=response.usage.input_tokens, output_tokens=response.usage.output_tokens,
                )
            except Exception as e:  # noqa: BLE001
                last_err = e
                prompt = prompt + f"\n\nPrevious output failed validation: {e}. Return ONLY valid JSON per the schema."
        raise RuntimeError(f"Schema validation failed after retry: {last_err}")
