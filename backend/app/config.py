"""Central configuration — everything overridable via environment variables (NFR-POR-03)."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

class Settings:
    APP_NAME = "Traceo (TADQEEQ)"
    API_V1_PREFIX = "/v1"

    DATABASE_URL = os.getenv("TRACEO_DATABASE_URL", f"sqlite:///{BASE_DIR / 'traceo.db'}")
    SECRET_KEY = os.getenv("TRACEO_SECRET_KEY", "dev-secret-change-in-production-0000")
    TOKEN_TTL_HOURS = int(os.getenv("TRACEO_TOKEN_TTL_HOURS", "12"))  # NFR-SEC-07

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

    RUN_CONCURRENCY_MAX = int(os.getenv("TRACEO_RUN_CONCURRENCY_MAX", "32"))  # FR-040 AC2

    CORS_ORIGINS = os.getenv("TRACEO_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")

    SEED_DEMO = os.getenv("TRACEO_SEED_DEMO", "1") == "1"

    # Governance & deployment posture
    AUDIT_RETENTION_DAYS = int(os.getenv("TRACEO_AUDIT_RETENTION_DAYS", "90"))  # FR-082 AC3
    # On-premise mode (FR-081): refuses every outbound call whose host is not
    # explicitly allow-listed, and forces the offline LLM provider.
    ON_PREMISE = os.getenv("TRACEO_ON_PREMISE", "0") == "1"
    EGRESS_ALLOWLIST = [h.strip() for h in os.getenv("TRACEO_EGRESS_ALLOWLIST", "").split(",") if h.strip()]
    TELEMETRY_ENABLED = os.getenv("TRACEO_TELEMETRY", "0") == "1"  # FR-081 AC4: off by default

    # Scheduler (FR-060)
    SCHEDULER_ENABLED = os.getenv("TRACEO_SCHEDULER", "1") == "1"
    SCHEDULER_TICK_S = float(os.getenv("TRACEO_SCHEDULER_TICK_S", "30"))

    # Integration HTTP (FR-070/011/072)
    INTEGRATION_TIMEOUT_S = float(os.getenv("TRACEO_INTEGRATION_TIMEOUT_S", "20"))

settings = Settings()
settings.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
