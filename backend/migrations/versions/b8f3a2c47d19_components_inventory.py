"""components: the project component inventory (security plan S2)

Creates the table that makes the CVE track possible: one row per declared
component of a project, populated from an SBOM (CycloneDX/SPDX) or a lockfile.

``version`` is NULLABLE on purpose. An unpinned dependency (``requests>=2.31``,
a bare ``uvicorn``) has no version, and NULL is the honest value for that — a
guessed version would produce confident CVE matches against software the target
may not run. ``unpinned_reason`` records why, so the import report can say so.

``cpe23`` is nullable for the same reason: no ecosystem offers a deterministic
package-name -> CPE mapping, so it is stored only when the source document
states one.

The unique index on (project_id, name, version, ecosystem) is what makes a
re-uploaded SBOM update the inventory instead of duplicating it. SQL treats
NULLs as distinct, so modules/components.py additionally does a NULL-aware
lookup before inserting; this index is the backstop, not the only guard.

Revision ID: b8f3a2c47d19
Revises: d4e2f81c6a37
Create Date: 2026-08-12
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b8f3a2c47d19"
down_revision: Union[str, Sequence[str], None] = "d4e2f81c6a37"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "components",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("organisation_id", sa.String(length=36), nullable=False),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=300), nullable=False),
        sa.Column("version", sa.String(length=100), nullable=True),
        sa.Column("ecosystem", sa.String(length=30), nullable=False),
        sa.Column("purl", sa.String(length=500), nullable=False),
        sa.Column("cpe23", sa.String(length=300), nullable=True),
        sa.Column("source", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("unpinned_reason", sa.String(length=200), nullable=True),
        sa.ForeignKeyConstraint(["organisation_id"], ["organisations.id"]),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("project_id", "name", "version", "ecosystem",
                            name="uq_components_project_name_version_ecosystem"),
    )
    op.create_index(op.f("ix_components_organisation_id"), "components",
                    ["organisation_id"], unique=False)
    op.create_index(op.f("ix_components_project_id"), "components",
                    ["project_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_components_project_id"), table_name="components")
    op.drop_index(op.f("ix_components_organisation_id"), table_name="components")
    op.drop_table("components")
