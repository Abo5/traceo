from sqlalchemy import create_engine, event
from sqlalchemy.pool import NullPool
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import settings

_is_sqlite = settings.DATABASE_URL.startswith("sqlite")
connect_args = {"check_same_thread": False} if _is_sqlite else {}

# The execution engine fans a run out over RUN_CONCURRENCY threads, each opening
# its own session, and several runs can be in flight at once. QueuePool's default
# ceiling (5 + 10 overflow) is reached well before that, and once it is every
# request blocks for pool_timeout — including /health, so the whole node looks
# dead. SQLite connections are cheap file handles, so pool nothing there; on a
# real server keep a pool but size it for the run fan-out and fail fast rather
# than hanging if it is ever exhausted.
if _is_sqlite:
    engine = create_engine(settings.DATABASE_URL, connect_args=connect_args, poolclass=NullPool)
else:
    engine = create_engine(
        settings.DATABASE_URL,
        connect_args=connect_args,
        pool_size=max(10, settings.RUN_CONCURRENCY * 2),
        max_overflow=max(20, settings.RUN_CONCURRENCY * 4),
        pool_timeout=10,
        pool_pre_ping=True,
    )

if settings.DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _):
        # busy_timeout FIRST: it is what every statement below, and every
        # statement on this connection afterwards, waits with. Set second, the
        # journal_mode switch itself runs with SQLite's default zero timeout and
        # raises "database is locked" the moment another connection holds the
        # write lock — which, on a NullPool where every session opens a fresh
        # connection, is a failure on an ordinary request rather than a rare one.
        dbapi_conn.execute("PRAGMA busy_timeout=30000")
        dbapi_conn.execute("PRAGMA foreign_keys=ON")
        # The default rollback journal makes a writer block every reader, so a
        # long ingest/execute transaction turns concurrent reads — including the
        # job polling the UI does — into "database is locked". WAL lets readers
        # through while a write is open; the timeout above covers the
        # writer-writer contention the run fan-out still creates.
        # journal_mode is a PERSISTENT property of the database file, not of the
        # connection: setting it here on EVERY connect asks for the exclusive
        # lock that switching it needs, which is itself what raised "database is
        # locked" while another job held the file open (TR-019). Set it once at
        # open time instead — the pragma below is a no-op when it already holds.
        pass


def _enable_wal_once() -> None:
    """Switch the database to WAL exactly once, tolerating a busy moment."""
    if not settings.DATABASE_URL.startswith("sqlite"):
        return
    try:
        with engine.connect() as conn:
            conn.exec_driver_sql("PRAGMA journal_mode=WAL")
    except Exception:  # noqa: BLE001 — a rollback journal still works, just slower
        pass

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# Columns added after the baseline that an existing SQLite file will not have.
# `Base.metadata.create_all` creates missing TABLES but never missing COLUMNS,
# so without this an upgraded install raises OperationalError on first write.
# Kept declarative and idempotent: name -> DDL, applied only when absent.
_ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "test_results": {
        "assertions_evaluated": "INTEGER NOT NULL DEFAULT 0",
        "assertions_skipped": "INTEGER NOT NULL DEFAULT 0",
    },
    "test_cases": {
        "test_type": "VARCHAR(20)",
        "mutates": "BOOLEAN NOT NULL DEFAULT 0",
    },
}


def sync_schema() -> None:
    """Add columns this build needs that the open database does not have."""
    from sqlalchemy import inspect as _inspect

    inspector = _inspect(engine)
    existing_tables = set(inspector.get_table_names())
    for table, columns in _ADDED_COLUMNS.items():
        if table not in existing_tables:
            continue
        present = {c["name"] for c in inspector.get_columns(table)}
        for name, ddl in columns.items():
            if name in present:
                continue
            with engine.begin() as conn:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
