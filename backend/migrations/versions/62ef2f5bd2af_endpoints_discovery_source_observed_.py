"""endpoints: discovery source + observed_count, nullable api_spec_id

Prepares the endpoint inventory for the three non-spec discovery modes
(FR-021 traffic capture, FR-022 DOM crawl, FR-023 Postman import):

* ``source`` records which mode produced the row, so the merge rule
  spec > traffic > dom > postman (SRS §L2) can pick a winner per attribute.
* ``observed_count`` carries FR-021 AC-3 (how many times traffic saw it).
* ``api_spec_id`` becomes nullable, because only spec-imported endpoints belong
  to an ApiSpec document.

Both new columns are added WITH a server default. Autogenerate omitted that and
the result cannot run against a populated table — SQLite rejects
"add a NOT NULL column with default value NULL" — so every existing deployment
would have failed on upgrade. Existing rows all came from an OpenAPI import, so
backfilling ``source='spec'`` is correct rather than merely convenient.

Revision ID: 62ef2f5bd2af
Revises: 7adc805d4ac4
Create Date: 2026-07-30 02:36:23.841861
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "62ef2f5bd2af"
down_revision: Union[str, Sequence[str], None] = "7adc805d4ac4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("endpoints", schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            "source", sa.String(length=20), nullable=False, server_default="spec"))
        batch_op.add_column(sa.Column(
            "observed_count", sa.Integer(), nullable=False, server_default="0"))
        batch_op.alter_column(
            "api_spec_id", existing_type=sa.VARCHAR(length=36), nullable=True)


def downgrade() -> None:
    # Endpoints discovered without a spec cannot be represented once api_spec_id
    # is NOT NULL again, so they are dropped rather than left to break the
    # constraint. This loses traffic/DOM/Postman discoveries — which is the
    # honest consequence of reverting the feature that created them.
    op.execute("DELETE FROM endpoints WHERE api_spec_id IS NULL")
    with op.batch_alter_table("endpoints", schema=None) as batch_op:
        batch_op.alter_column(
            "api_spec_id", existing_type=sa.VARCHAR(length=36), nullable=False)
        batch_op.drop_column("observed_count")
        batch_op.drop_column("source")
