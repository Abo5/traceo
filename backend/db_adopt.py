"""Adopt a pre-Alembic database into the migration history, or refuse to guess.

Traceo created schemas with `create_all` before migrations existed, so real
deployments have databases that hold the right tables but no `alembic_version`
row. `alembic upgrade head` fails on those with "table already exists", which
looks like corruption but only means the schema is unversioned.

The revision such a database corresponds to cannot be inferred in general — so
this script infers only the one case it can prove, and otherwise stops:

* `alembic_version` already present  -> nothing to do.
* no tables at all                   -> nothing to do; `upgrade head` builds it.
* schema matches the models exactly  -> it was built by `create_all` from the
                                        current models, which the migration gate
                                        keeps equal to head, so stamp head.
* schema differs from the models      -> an older build. Refuse, and tell the
                                        operator to stamp the matching revision
                                        themselves. Silently stamping the wrong
                                        revision would skip a real migration and
                                        corrupt data later.

Run before `alembic upgrade head`. Exit 0 means it is safe to upgrade.
"""
import sys

from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect

from app.config import BASE_DIR, settings
from app.models import Base


def main() -> int:
    engine = create_engine(settings.DATABASE_URL)
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())

    if "alembic_version" in tables:
        print("db_adopt: already versioned")
        return 0
    if not tables:
        print("db_adopt: empty database — upgrade will create it")
        return 0

    with engine.connect() as connection:
        context = MigrationContext.configure(connection)
        diff = compare_metadata(context, Base.metadata)

    if diff:
        print(
            "db_adopt: REFUSING to adopt this database.\n"
            "  It has tables but no alembic_version, and its schema does not match\n"
            "  the current models, so it was built by an older version of Traceo.\n"
            "  Which revision it matches cannot be determined automatically.\n"
            "  Inspect it, then stamp the matching revision by hand:\n"
            "      alembic history\n"
            "      alembic stamp <revision>\n"
            f"  Differences found: {diff}",
            file=sys.stderr)
        return 1

    cfg = Config(str(BASE_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BASE_DIR / "migrations"))
    cfg.set_main_option("sqlalchemy.url", settings.DATABASE_URL)
    command.stamp(cfg, "head")
    print("db_adopt: schema matches the models — stamped head")
    return 0


if __name__ == "__main__":
    sys.exit(main())
