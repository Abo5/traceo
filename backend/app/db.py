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
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

class Base(DeclarativeBase):
    pass

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def sync_schema() -> list[str]:
    """Create missing tables, then add missing columns to existing ones.

    Traceo ships without a migration tool by design (NFR-POR-03: one process, one
    file). New releases only ever ADD nullable/defaulted columns, so an additive
    ALTER pass keeps an existing database — including a customer's on-premise one —
    usable across upgrades. Returns the columns it added, for the startup log."""
    from sqlalchemy import inspect, text

    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    added: list[str] = []

    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if table.name not in existing_tables:
                continue
            present = {c["name"] for c in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in present:
                    continue
                ddl = f"{column.name} {column.type.compile(engine.dialect)}"
                default = column.default.arg if column.default is not None else None
                if default is not None and not callable(default):
                    literal = f"'{default}'" if isinstance(default, str) else (
                        str(int(default)) if isinstance(default, bool) else str(default))
                    ddl += f" DEFAULT {literal}"
                conn.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {ddl}"))
                added.append(f"{table.name}.{column.name}")
    return added
