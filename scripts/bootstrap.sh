#!/usr/bin/env bash
# Bring a clean checkout to a state where every engine can actually run.
#
# The sidecar used to have no package.json, so a fresh clone resolved no
# `playwright` and every browser check failed with browser_discovery_unavailable
# — a first-run experience indistinguishable from a broken product (TR-020).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/4  Python backend"
[ -d backend/.venv ] || python3 -m venv backend/.venv
backend/.venv/bin/pip install -q -r backend/requirements.txt

say "2/4  Browser sidecar (its own dependency, not the e2e suite's)"
( cd tools/web-discovery && npm install --no-audit --no-fund )

say "3/4  Frontend"
( cd frontend && npm install --no-audit --no-fund )

say "4/4  Local configuration"
if [ ! -f .env ]; then
  cp env.example .env
  echo "   wrote .env from env.example — add your model key to it"
else
  echo "   .env already exists, left untouched"
fi

say "Ready."
cat <<'EOF'
  ./labs/start-backend.sh          backend on :8000 (reads .env, prints no secret)
  python3 labs/stage1/sut.py       a defective target on :9100
  python3 labs/stage2/sut.py       a subtler one on :9200
  python3 labs/measure.py          how much of what was generated was really checked

  Sign in with demo@traceo.sa / Demo1234!
EOF
