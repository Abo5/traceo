"""project_test_types: which of the five kinds of testing a project is for

Existing rows get an empty list, which app/testtypes.py::project_test_types
reads as all five. Backfilling the five names instead would be a lie about a
choice nobody made — and would make a project that genuinely wants all five
indistinguishable from one that was never asked.

Revision ID: 146fb82583d7
Revises: f2c6a09b41d8
Create Date: 2026-08-17 00:29:42.784602

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '146fb82583d7'
down_revision: Union[str, Sequence[str], None] = 'f2c6a09b41d8'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # NOT NULL with a server default, so the column is safe to add to a
    # populated table and no read path has to handle NULL as a third state
    # alongside "empty" and "chosen".
    op.add_column("projects", sa.Column("test_types", sa.JSON(), nullable=False,
                                        server_default="[]"))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("projects", "test_types")
