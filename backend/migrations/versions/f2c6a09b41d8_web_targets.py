"""web_targets: the URL a project points Traceo at (web target contract §2)

One row per (project, url, viewport). The unique constraint is what makes
re-running discovery on the same page a REFRESH rather than a second target:
the requirements and cases derived from a target key off its id, so a duplicate
row would silently fork them.

``inventory`` holds what the render found — the counts, the form/control/request
digests and the design summary. It is stored rather than recomputed because
analysing a full-page raster costs seconds, and because the detail route must
answer from what THIS discovery saw; a re-render would be answering about a
different page.

``last_error`` records why a target is ``failed``. A failed target with no
reason is indistinguishable from one nobody ever looked at.

Revision ID: f2c6a09b41d8
Revises: e5a91c3d7b60
Create Date: 2026-08-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f2c6a09b41d8"
down_revision: Union[str, Sequence[str], None] = "e5a91c3d7b60"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "web_targets",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("organisation_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("url", sa.String(length=1000), nullable=False),
        sa.Column("viewport", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("final_url", sa.String(length=1000), nullable=False),
        sa.Column("last_discovered_at", sa.DateTime(), nullable=True),
        sa.Column("screenshot_key", sa.String(length=300), nullable=False),
        sa.Column("inventory", sa.JSON(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["organisation_id"], ["organisations.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "url", "viewport",
                            name="uq_web_targets_project_url_viewport"),
    )
    op.create_index(op.f("ix_web_targets_organisation_id"), "web_targets",
                    ["organisation_id"], unique=False)
    op.create_index(op.f("ix_web_targets_project_id"), "web_targets",
                    ["project_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_web_targets_project_id"), table_name="web_targets")
    op.drop_index(op.f("ix_web_targets_organisation_id"), table_name="web_targets")
    op.drop_table("web_targets")
