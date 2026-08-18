"""Central configuration — everything overridable via environment variables (NFR-POR-03)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Published in source, so it is a valid signing key for anyone reading this repo.
DEV_SECRET_KEY = "dev-secret-change-in-production-0000"


class ConfigError(RuntimeError):
    """A production deployment is configured unsafely; the process must not start."""


class Settings:
    APP_NAME = "Traceo (TADQEEQ)"
    API_V1_PREFIX = "/v1"

    ENV = os.getenv("TRACEO_ENV", "development")  # development | production

    DATABASE_URL = os.getenv("TRACEO_DATABASE_URL", f"sqlite:///{BASE_DIR / 'traceo.db'}")
    SECRET_KEY = os.getenv("TRACEO_SECRET_KEY", DEV_SECRET_KEY)
    TOKEN_TTL_HOURS = int(os.getenv("TRACEO_TOKEN_TTL_HOURS", "12"))  # NFR-SEC-07 / NFR-S3

    STORAGE_DIR = Path(os.getenv("TRACEO_STORAGE_DIR", str(BASE_DIR / "storage")))
    MAX_UPLOAD_MB = int(os.getenv("TRACEO_MAX_UPLOAD_MB", "50"))  # FR-REQ-01

    # LLM abstraction layer (CON-02): "mock" runs fully offline, "anthropic" needs ANTHROPIC_API_KEY
    LLM_PROVIDER = os.getenv("TRACEO_LLM_PROVIDER", "auto")  # auto | mock | anthropic
    LLM_MODEL = os.getenv("TRACEO_LLM_MODEL", "claude-opus-5")
    PROMPT_VERSION = "v1.0"

    # Execution engine
    REQUEST_TIMEOUT_S = float(os.getenv("TRACEO_REQUEST_TIMEOUT_S", "30"))
    RUN_TIMEOUT_S = float(os.getenv("TRACEO_RUN_TIMEOUT_S", "600"))
    RUN_CONCURRENCY = int(os.getenv("TRACEO_RUN_CONCURRENCY", "8"))
    EVIDENCE_MAX_BYTES = int(os.getenv("TRACEO_EVIDENCE_MAX_BYTES", "16384"))

    # --- Web target discovery (browser sidecar) --------------------------------
    # The target page is rendered by a Node/Playwright sidecar shared by both
    # backends; a plain HTTP GET of a SPA returns a shell with zero forms, so
    # server-side HTML parsing would discover nothing at all.
    WEB_DISCOVERY_SCRIPT = os.getenv(
        "TRACEO_WEB_DISCOVERY_SCRIPT",
        str(BASE_DIR.parent / "tools" / "web-discovery" / "discover.mjs"))
    NODE_BIN = os.getenv("TRACEO_NODE_BIN", "node")
    WEB_DISCOVERY_TIMEOUT_S = float(os.getenv("TRACEO_WEB_DISCOVERY_TIMEOUT_S", "30"))
    # Same SSRF rule the spec fetcher applies; "1" allows private/loopback hosts
    # so the stack can be pointed at a local application under test.
    ALLOW_PRIVATE_TARGETS = os.getenv("TRACEO_ALLOW_PRIVATE_TARGETS", "0") == "1"
    # The stated page-load budget the performance track asserts. The observed
    # elapsed_ms is recorded as the baseline beside it; when the baseline is
    # already over budget the case fails on its first run, which is the honest
    # outcome — the page is the defect, not the assertion.
    PAGE_LOAD_BUDGET_MS = int(os.getenv("TRACEO_PAGE_LOAD_BUDGET_MS", "3000"))
    # Design extraction is exact integer arithmetic over every pixel, so its cost
    # is linear in the raster. A full-page screenshot can be several megapixels;
    # above this budget the analysed raster is subsampled by an integer step
    # (nearest neighbour, so every analysed colour is still a colour the page
    # actually painted) and the step is reported with the facts.
    DESIGN_MAX_PIXELS = int(os.getenv("TRACEO_DESIGN_MAX_PIXELS", "1200000"))

    CORS_ORIGINS = os.getenv("TRACEO_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")

    SEED_DEMO = os.getenv("TRACEO_SEED_DEMO", "1") == "1"

    # Development convenience: hand out a session for the seeded demo user without
    # a login form. Off by default and refused in production (see below).
    DEV_AUTOLOGIN = os.getenv("TRACEO_DEV_AUTOLOGIN", "0") == "1"
    DEV_AUTOLOGIN_EMAIL = os.getenv("TRACEO_DEV_AUTOLOGIN_EMAIL", "demo@traceo.sa")

def assert_production_safe(s: Settings) -> None:
    """Refuse to boot a production node that would silently be wide open.

    Both defaults below are safe in development and catastrophic in production:
    the dev signing key is published in this file, so anyone could mint a valid
    JWT for any user in any organisation — collapsing the tenant isolation that
    AC-11 guards — and the demo accounts ship with a password printed in the
    docs. Neither is detectable at runtime, so the only safe failure is loud and
    immediate (NFR-S3).
    """
    if s.ENV != "production":
        return
    problems = []
    if s.SECRET_KEY == DEV_SECRET_KEY:
        problems.append(
            "TRACEO_SECRET_KEY is unset or still the built-in dev key — set a unique "
            "random value (e.g. `openssl rand -hex 32`)")
    if s.SEED_DEMO:
        problems.append(
            "TRACEO_SEED_DEMO must be 0 in production — the seeded demo accounts use "
            "a password published in the documentation")
    if s.DEV_AUTOLOGIN:
        problems.append(
            "TRACEO_DEV_AUTOLOGIN must be 0 in production — it hands a full session "
            "to any caller without credentials")
    if problems:
        raise ConfigError(
            "refusing to start with TRACEO_ENV=production:\n  - " + "\n  - ".join(problems))


settings = Settings()
assert_production_safe(settings)
settings.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
