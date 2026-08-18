"""projects: nullable language + automation column (autopilot)

Two schema changes behind the autopilot contract:

* ``language`` becomes NULLABLE — a project may now be created without a
  language; it stays NULL until the first successful document parse runs the
  deterministic Arabic-ratio detector (or the user sets it explicitly).
* ``automation`` ("auto"|"manual", NOT NULL) selects whether the parse ->
  detect -> confirm_all -> generate chain runs automatically. Added WITH a
  server default of 'auto' so the column can be added to a populated SQLite
  table, and because 'auto' is the contract default for existing projects.

batch_alter_table is required: SQLite cannot ALTER a column's NULL-ness in
place, so Alembic must emit the copy-table-and-rename dance.

Revision ID: 9c4d1e0aa713
Revises: 62ef2f5bd2af
Create Date: 2026-08-09
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "9c4d1e0aa713"
down_revision: Union[str, Sequence[str], None] = "62ef2f5bd2af"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "automation", sa.String(length=10), nullable=False, server_default="auto"))
        batch_op.alter_column(
            "language", existing_type=sa.VARCHAR(length=5), nullable=True)


def downgrade() -> None:
    # Restoring NOT NULL needs every row populated; projects whose language was
    # never detected fall back to 'en' — the column's pre-migration default.
    op.execute("UPDATE projects SET language = 'en' WHERE language IS NULL")
    with op.batch_alter_table("projects", schema=None) as batch_op:
        batch_op.alter_column(
            "language", existing_type=sa.VARCHAR(length=5), nullable=False)
        batch_op.drop_column("automation")
