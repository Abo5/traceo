#!/usr/bin/env bash
# Start the Traceo backend with the local .env loaded. The file is sourced, never
# printed: no value from it reaches stdout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
# shellcheck disable=SC1091
source "$ROOT/.env"
set +a
unset ANTHROPIC_API_KEY          # the harness token is not a valid API key
export TRACEO_SEED_DEMO=1
cd "$ROOT/backend"
exec .venv/bin/python -m uvicorn app.main:app --port 8000 --host 127.0.0.1
