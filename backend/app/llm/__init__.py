"""LLM abstraction layer (TRD §4.9, CON-02, NFR-POR-04).

Single entry point: complete_json(prompt_id, prompt, schema) -> (validated dict, usage meta).
Provider selected by config alone; callers never see provider-specific types.
"""
import logging
import os

from ..config import settings
from .base import (UNTRUSTED_CLOSE, UNTRUSTED_NOTE, UNTRUSTED_OPEN, LLMProvider,
                   LLMResult, frame_untrusted, strip_untrusted_frame)
from .mock import MockProvider

log = logging.getLogger("traceo.llm")

_provider: LLMProvider | None = None
_status: dict = {"provider": None, "model": None, "state": "unchecked", "detail": ""}


def provider_status() -> dict:
    """What the model layer is actually doing, for the UI and for job results.

    G4/G5: a deployment must be able to see that it is running degraded. The old
    behaviour picked `anthropic` because an env var merely EXISTED, failed every
    call with 401, and told nobody — every requirement in a document came back
    as its own raw text at confidence 0.3 under a job that said `completed`.
    """
    return dict(_status)


def _select() -> str:
    """Which provider this deployment asked for."""
    choice = settings.LLM_PROVIDER
    if choice != "auto":
        return choice
    # Order is precedence, not preference: a deployment that sets both keys gets
    # the one it configured a model for, and never a silent swap.
    if os.getenv("ANTHROPIC_API_KEY"):
        return "anthropic"
    if settings.GEMINI_API_KEY:
        return "gemini"
    return "mock"


def get_provider() -> LLMProvider:
    global _provider
    if _provider is not None:
        return _provider
    choice = _select()
    if choice == "anthropic":
        try:
            from .anthropic_provider import AnthropicProvider
            _provider = AnthropicProvider(model=settings.LLM_MODEL)
        except Exception as exc:  # noqa: BLE001
            log.warning("anthropic provider unavailable (%s) — falling back to mock",
                        type(exc).__name__)
            _provider = MockProvider()
    elif choice == "gemini":
        try:
            from .gemini_provider import GeminiProvider
            _provider = GeminiProvider(model=settings.GEMINI_MODEL)
        except Exception as exc:  # noqa: BLE001
            log.warning("gemini provider unavailable (%s) — falling back to mock",
                        type(exc).__name__)
            _provider = MockProvider()
    else:
        _provider = MockProvider()
    _status.update(provider=_provider.name, model=getattr(_provider, "model", None),
                   state="selected" if _provider.name == choice else "fell_back_to_mock")
    return _provider


def verify_provider() -> dict:
    """Prove at boot that the selected provider can answer, and record the answer.

    Constructing a client proves nothing — an invalid key only fails when a call
    is made. This makes one cheap, schema-constrained call so a deployment
    running on a dead key learns it at startup instead of discovering it as
    plausible-looking nonsense in its requirements (TR-007).
    """
    provider = get_provider()
    _status.update(provider=provider.name, model=getattr(provider, "model", None))
    if provider.name == "mock":
        _status.update(state="mock",
                       detail="deterministic offline provider — no model is involved")
        return provider_status()
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}},
              "required": ["ok"]}
    try:
        provider.complete_json("provider_probe", "Answer with {\"ok\": true}.", schema)
    except Exception as exc:  # noqa: BLE001
        _status.update(state="unreachable", detail=f"{type(exc).__name__}: {exc}"[:300])
        log.error("LLM provider %s is configured but cannot answer: %s",
                  provider.name, _status["detail"])
        return provider_status()
    _status.update(state="ok", detail="")
    log.info("LLM provider %s (%s) answered the boot probe", provider.name,
             _status["model"])
    return provider_status()


def reset_provider() -> None:
    """Drop the cached provider — used by tests that swap configuration."""
    global _provider
    _provider = None
    _status.update(provider=None, model=None, state="unchecked", detail="")
