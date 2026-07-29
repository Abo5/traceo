"""Tests for adopting pre-Alembic databases (see db_adopt.py).

The dangerous case is the third one: a database from an older build must NOT be
stamped, because stamping the wrong revision makes Alembic skip a real migration
and the schema silently diverges from the code that queries it.
"""
import sqlite3

import pytest
from sqlalchemy import create_engine, inspect

import db_adopt
from app.models import Base


@pytest.fixture
def db(tmp_path, monkeypatch):
    """A throwaway database, with app settings pointed at it."""
    path = tmp_path / "adopt.db"
    url = f"sqlite:///{path}"
    monkeypatch.setattr("app.config.settings.DATABASE_URL", url, raising=False)
    monkeypatch.setattr(db_adopt.settings, "DATABASE_URL", url, raising=False)
    return path, url


def _create_all(url: str) -> None:
    Base.metadata.create_all(bind=create_engine(url))


def _is_versioned(url: str) -> bool:
    return "alembic_version" in inspect(create_engine(url)).get_table_names()


def test_empty_database_is_left_for_upgrade_to_build(db):
    _path, url = db
    assert db_adopt.main() == 0
    assert not _is_versioned(url), "an empty database must not be stamped"


def test_create_all_database_is_adopted_at_head(db):
    # create_all builds the current models' shape, and the migration gate keeps
    # the models equal to head — so this database really is at head.
    _path, url = db
    _create_all(url)
    assert db_adopt.main() == 0
    assert _is_versioned(url)


def test_already_versioned_database_is_untouched(db):
    _path, url = db
    _create_all(url)
    assert db_adopt.main() == 0
    # Running again must be a no-op rather than a second stamp.
    assert db_adopt.main() == 0


def test_older_schema_is_refused_rather_than_guessed(db, capsys):
    path, url = db
    _create_all(url)
    connection = sqlite3.connect(path)
    connection.execute("ALTER TABLE endpoints DROP COLUMN source")
    connection.commit()
    connection.close()

    assert db_adopt.main() == 1, "an older schema must not be adopted"
    assert not _is_versioned(url), "refusing must leave the database unstamped"
    assert "REFUSING" in capsys.readouterr().err
