#!/bin/sh
# Bring the schema to head before serving, so an image upgrade and its schema
# change land together instead of leaving the app running against an old shape.
set -e

echo "traceo: checking schema..."
# Handles databases created before migrations existed; refuses to guess when the
# right revision cannot be proven (see db_adopt.py).
python db_adopt.py

alembic upgrade head

echo "traceo: schema up to date; starting $*"
exec "$@"
