"""RELEASE GATE — the migration history must build the schema the models declare.

Migration tooling only helps if it is actually kept in step with the models. The
common failure is silent: someone edits `models.py`, `create_all` happily builds
the new shape in development and every test passes, but no migration exists — so
the next real deployment upgrades to a schema that is missing the column and
breaks at runtime, on a database that already holds customer data.

These two tests close that gap:
  1. the history applies to an empty database and reverses cleanly;
  2. after upgrading to head, Alembic detects NO difference against the models.
"""
import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

from app.config import BASE_DIR
from app.models import Base


def _alembic_config(db_url: str) -> Config:
    cfg = Config(str(BASE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", db_url)
    return cfg


@pytest.fixture
def db_url(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path / 'migrate.db'}"
    # migrations/env.py reads the URL from app settings, so point those at the
    # throwaway database too — otherwise the migration would hit the real file.
    monkeypatch.setattr("app.config.settings.DATABASE_URL", url, raising=False)
    return url


def test_history_upgrades_and_downgrades_cleanly(db_url):
    cfg = _alembic_config(db_url)
    engine = create_engine(db_url)

    command.upgrade(cfg, "head")
    tables = set(inspect(engine).get_table_names()) - {"alembic_version"}
    assert tables, "upgrade to head produced no tables"
    # Every table the models declare must exist after the history is applied.
    missing = set(Base.metadata.tables) - tables
    assert not missing, f"migrations never create: {sorted(missing)}"

    command.downgrade(cfg, "base")
    left = set(inspect(engine).get_table_names()) - {"alembic_version"}
    assert not left, f"downgrade left tables behind: {sorted(left)}"


def test_models_have_no_unmigrated_changes(db_url):
    """The gate: models and migration head must describe the same schema."""
    cfg = _alembic_config(db_url)
    command.upgrade(cfg, "head")

    engine = create_engine(db_url)
    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        diff = compare_metadata(context, Base.metadata)

    assert not diff, (
        "models.py has changes with no matching migration — run:\n"
        "  cd backend && alembic revision --autogenerate -m '<what changed>'\n"
        "then review the generated file (autogenerate omits server defaults, so a "
        "new NOT NULL column will fail on a populated table).\n"
        f"Detected: {diff}")
