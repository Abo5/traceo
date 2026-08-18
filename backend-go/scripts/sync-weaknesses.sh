#!/usr/bin/env sh
# sync-weaknesses.sh — copy the shared weakness corpus into the Go module.
#
# backend/app/data/weaknesses.json is the ONE source of truth for both backends.
# go:embed cannot reach outside the module, so the Go build embeds a copy; this
# script is the build-time copy step, and tests/weakness_catalogue_test.go fails
# the build if the two files ever differ.
#
# Usage: ./scripts/sync-weaknesses.sh   (run from anywhere)
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
src="$here/../../backend/app/data/weaknesses.json"
dst="$here/../internal/modules/security/data/weaknesses.json"

if [ ! -f "$src" ]; then
  echo "no Python corpus at $src — nothing to sync" >&2
  exit 1
fi

cp "$src" "$dst"
echo "synced $(basename "$dst") from the Python backend"
