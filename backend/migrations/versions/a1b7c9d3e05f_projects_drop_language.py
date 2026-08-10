"""projects: drop the language column (Traceo is English-only)

The product pivoted to English-only: the bilingual mechanism is removed rather
than disabled, so ``projects.language`` — the per-project requirements language
that used to be set explicitly or auto-detected from the first parsed document —
has no meaning left and is dropped.

Nothing reads it any more: the autopilot no longer detects a language, the XLSX
and HTML report exports are unconditionally LTR, and the create/update payloads
of /v1/projects no longer accept or return the field.

The downgrade is real, not a stub: it re-adds the column in exactly the shape
this revision found it (VARCHAR(5), NULLABLE — the shape 9c4d1e0aa713 left
behind). Values cannot be recovered, so rows come back with NULL, which is the
legal "not known yet" value that shape was designed around; the older detector
would have refilled it on the next successful parse.

batch_alter_table per this repository's SQLite convention: SQLite cannot DROP a
column in place on older builds, so Alembic must emit the copy-table-and-rename
dance for the operation to be reversible on every backend.

Revision ID: a1b7c9d3e05f
Revises: c31f7a4b98d2
Create Date: 2026-08-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a1b7c9d3e05f"
down_revision: Union[str, Sequence[str], None] = "c31f7a4b98d2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.drop_column("language")


def downgrade() -> None:
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.add_column(sa.Column("language", sa.String(length=5), nullable=True))
