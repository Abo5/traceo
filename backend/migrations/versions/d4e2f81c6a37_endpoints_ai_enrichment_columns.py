"""endpoints: AI enrichment annotations (ai_description, ai_group, ai_criticality)

Collection imports (Postman v2.x, HAR 1.2, Insomnia v4) carry no prose: no
`summary`, no `tags`, no sense of which routes matter. The optional enrichment
step (app/modules/enrichment.py) asks the model for a one-line description, a
resource group and a criticality hint per endpoint, and stores the results here.

All three columns are NULLABLE by design:

* enrichment is gated on automation=auto and only runs after a collection import,
  so most rows legitimately have nothing to store;
* every annotation must survive the validation gate (exact method+path match
  against the deterministic inventory) — a discarded item leaves NULL rather than
  a guess.

NULL therefore means "not annotated", which is why no server default is set: a
default would turn "the model never spoke about this endpoint" into "the model
said nothing", and those are different facts.

These columns are commentary. Nothing in generation, grounding or execution reads
them, so a downgrade loses annotations only.

Revision ID: d4e2f81c6a37
Revises: a1b7c9d3e05f
Create Date: 2026-08-11 00:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d4e2f81c6a37"
down_revision: Union[str, Sequence[str], None] = "a1b7c9d3e05f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table("endpoints", schema=None) as batch_op:
        batch_op.add_column(sa.Column("ai_description", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("ai_group", sa.String(length=100), nullable=True))
        batch_op.add_column(sa.Column("ai_criticality", sa.String(length=10), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table("endpoints", schema=None) as batch_op:
        batch_op.drop_column("ai_criticality")
        batch_op.drop_column("ai_group")
        batch_op.drop_column("ai_description")
