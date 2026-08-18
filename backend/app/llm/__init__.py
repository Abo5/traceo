"""LLM abstraction layer (TRD §4.9, CON-02, NFR-POR-04).

Single entry point: complete_json(prompt_id, prompt, schema) -> (validated dict, usage meta).
Provider selected by config alone; callers never see provider-specific types.
"""
from ..config import settings
from .base import (UNTRUSTED_CLOSE, UNTRUSTED_NOTE, UNTRUSTED_OPEN, LLMProvider,
                   LLMResult, frame_untrusted, strip_untrusted_frame)
from .mock import MockProvider

_provider: LLMProvider | None = None


def get_provider() -> LLMProvider:
    global _provider
    if _provider is not None:
        return _provider
    choice = settings.LLM_PROVIDER
    if choice == "auto":
        import os
        choice = "anthropic" if os.getenv("ANTHROPIC_API_KEY") else "mock"
    if choice == "anthropic":
        try:
            from .anthropic_provider import AnthropicProvider
            _provider = AnthropicProvider(model=settings.LLM_MODEL)
        except Exception:
            _provider = MockProvider()  # degrade, never crash (NFR-REL-03)
    else:
        _provider = MockProvider()
    return _provider
