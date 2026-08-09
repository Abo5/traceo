"""test_cases: nullable edge_category (Insight engine taxonomy)

The sixth engine (QA Insight Agent) classifies test cases into nine edge-case
families: boundary_surprise, exotic_input, control_chars, idempotency,
state_corruption, permission_edge, timing_dst, resource_exhaustion,
downstream_failure.

``edge_category`` is NULLABLE on purpose: every case that already exists — and
every case the other five engines will ever produce — belongs to no family, and
NULL is the honest value for that. A NOT NULL column with a sentinel default
would force the report to distinguish "no family" from "the family literally
named 'none'".

batch_alter_table is used per this repository's SQLite convention: SQLite adds
columns in place but Alembic's batch mode keeps the operation reversible on
every backend, and the downgrade (a DROP COLUMN) genuinely needs the
copy-table-and-rename dance on older SQLite builds.

Revision ID: c31f7a4b98d2
Revises: 9c4d1e0aa713
Create Date: 2026-08-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c31f7a4b98d2"
down_revision: Union[str, Sequence[str], None] = "9c4d1e0aa713"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("test_cases", schema=None) as batch_op:
        batch_op.add_column(sa.Column("edge_category", sa.String(length=30), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("test_cases", schema=None) as batch_op:
        batch_op.drop_column("edge_category")
