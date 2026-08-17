"""web_targets: sealed sign-in credentials and the crawl page budget

Signing in is the one thing that lets discovery see the product a user actually
bought — every page behind the login is invisible without it. Two columns carry
that:

``auth_config_encrypted`` holds {username, password} sealed by
``app.security.encrypt_secret``, the SAME envelope environment secrets already
use, so there is one key custody story rather than two. It is nullable because
most targets are public, and it is never read back over the API: the payload
answers ``auth_configured`` true/false only.

``max_pages`` is the page budget for one crawl (1..50). It is NOT NULL with a
server default of 25, which is also the value the rows that already exist take:
a user who hands Traceo a URL expects the product behind it to be examined, and
a budget of 1 would mean the tool explores nothing until someone finds the knob.
50 is the ceiling, not the default, because a crawl is somebody else's server.

Revision ID: 4f1c2ab90d63
Revises: 146fb82583d7
Create Date: 2026-08-17
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "4f1c2ab90d63"
down_revision: Union[str, Sequence[str], None] = "146fb82583d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # batch_alter_table because SQLite cannot ALTER a column in place; on
    # PostgreSQL this compiles to plain ADD COLUMN.
    with op.batch_alter_table("web_targets") as batch:
        batch.add_column(sa.Column("auth_config_encrypted", sa.LargeBinary(), nullable=True))
        # server_default, not a Python default: a NOT NULL column added to a
        # populated table has to state the value the existing rows take.
        batch.add_column(sa.Column("max_pages", sa.Integer(), nullable=False,
                                   server_default="25"))


def downgrade() -> None:
    with op.batch_alter_table("web_targets") as batch:
        batch.drop_column("max_pages")
        batch.drop_column("auth_config_encrypted")
