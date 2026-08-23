"""test_results: assertions_evaluated/skipped; test_cases: test_type, mutates

The columns that make an honest result possible.

``test_results.assertions_evaluated`` and ``assertions_skipped`` exist so a case
can be told apart from one that merely finished. The engine used to start every
case at "passed" and change it only on an explicit failure, so a case whose every
assertion belonged to an unimplemented type reported PASSED having checked
nothing — 125 of them in a single measured run. With these counts the terminal
state is decidable: zero evaluated is `inconclusive`, and coverage counts only
what was actually checked (H1/H6, TR-001).

``test_cases.test_type`` records which of the five tracks the case belongs to. It
used to live in a counter inside the generator and nowhere else, so a run could
never be reported per type and the number on screen could not be reconciled with
what ran (TR-016).

``test_cases.mutates`` records that running the case changes state on the target.
Mutating cases run after read-only ones: a case that posted a 4000-character name
used to run mid-fan-out and fail three unrelated LISTING cases on schema
validation of a record they never created (TR-015).

All four are NOT NULL with a server default, which is what lets them be added to
a populated table with no backfill — except test_type, which is genuinely unknown
for rows written before it existed, and NULL is the honest value for that.

batch_alter_table follows this repository's SQLite convention.

Revision ID: a7f4c2e91b83
Revises: 4f1c2ab90d63
Create Date: 2026-08-22
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7f4c2e91b83"
down_revision: Union[str, Sequence[str], None] = "4f1c2ab90d63"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("test_results") as batch:
        batch.add_column(sa.Column("assertions_evaluated", sa.Integer(),
                                   nullable=False, server_default="0"))
        batch.add_column(sa.Column("assertions_skipped", sa.Integer(),
                                   nullable=False, server_default="0"))
    with op.batch_alter_table("test_cases") as batch:
        batch.add_column(sa.Column("test_type", sa.String(length=20), nullable=True))
        batch.add_column(sa.Column("mutates", sa.Boolean(),
                                   nullable=False, server_default=sa.false()))


def downgrade() -> None:
    with op.batch_alter_table("test_cases") as batch:
        batch.drop_column("mutates")
        batch.drop_column("test_type")
    with op.batch_alter_table("test_results") as batch:
        batch.drop_column("assertions_skipped")
        batch.drop_column("assertions_evaluated")
