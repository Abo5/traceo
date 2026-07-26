from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class LLMResult:
    data: Any  # schema-validated object
    model: str
    prompt_version: str
    input_tokens: int = 0
    output_tokens: int = 0
    meta: dict = field(default_factory=dict)


class LLMProvider(Protocol):
    name: str

    def complete_json(self, prompt_id: str, prompt: str, schema: dict) -> LLMResult:
        """Return an object conforming to `schema`. Implementations must validate before
        returning; one retry on validation failure, then raise (TRD §4.9)."""
        ...
