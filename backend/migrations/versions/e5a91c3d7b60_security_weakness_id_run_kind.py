"""test_cases: nullable weakness_id; runs: kind (functional|security|performance)

Phase S0 of docs/SECURITY_TESTING_PLAN.md. Security is a technique family inside
generation, not a parallel engine, so the schema change is deliberately small:
two columns, no new tables.

``test_cases.weakness_id`` is NULLABLE because every case that already exists —
and every case the functional, API, UI and Insight builders will ever produce —
belongs to no weakness class. NULL is the honest value for "this case verifies no
weakness class"; a sentinel default would force the coverage matrix to tell the
difference between that and a class literally named "none". It is INDEXED because
the §11 matrix counts cases per (endpoint, weakness) pair on every read.

``runs.kind`` is NOT NULL with a server default of "functional" — the opposite
choice, for the opposite reason. Every run that exists today IS a functional run;
that fact is known, so recording it as NULL would invent an unknown. The server
default is what lets the column be added to a populated table without a backfill
step, and it is why this migration is safe on a live database.

batch_alter_table follows this repository's SQLite convention: SQLite adds columns
in place, but batch mode keeps the downgrade (a DROP COLUMN) working on older
SQLite builds that need the copy-table-and-rename dance.

Revision ID: e5a91c3d7b60
Revises: b8f3a2c47d19
Create Date: 2026-08-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5a91c3d7b60"
down_revision: Union[str, Sequence[str], None] = "b8f3a2c47d19"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("test_cases", schema=None) as batch_op:
        batch_op.add_column(sa.Column("weakness_id", sa.String(length=64), nullable=True))
        batch_op.create_index(batch_op.f("ix_test_cases_weakness_id"),
                              ["weakness_id"], unique=False)
    with op.batch_alter_table("runs", schema=None) as batch_op:
        batch_op.add_column(sa.Column("kind", sa.String(length=20), nullable=False,
                                      server_default="functional"))


def downgrade() -> None:
    with op.batch_alter_table("runs", schema=None) as batch_op:
        batch_op.drop_column("kind")
    with op.batch_alter_table("test_cases", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_test_cases_weakness_id"))
        batch_op.drop_column("weakness_id")
