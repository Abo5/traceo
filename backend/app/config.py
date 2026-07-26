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

    CORS_ORIGINS = os.getenv("TRACEO_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")

    SEED_DEMO = os.getenv("TRACEO_SEED_DEMO", "1") == "1"

settings = Settings()
settings.STORAGE_DIR.mkdir(parents=True, exist_ok=True)
