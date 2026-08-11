"""RELEASE GATE — a production node must never boot wide open.

Three config settings are correct for development and catastrophic in production:
the dev signing key is published in `app/config.py` (so anyone could mint a valid
JWT for any user in any organisation, collapsing the tenant isolation AC-11
guards), the seeded demo accounts use a password printed in the docs, and
TRACEO_DEV_AUTOLOGIN hands a full session to any caller with no credentials at
all (POST /v1/auth/dev-session — see tests/test_dev_session.py). None of the
three is detectable at runtime, so `assert_production_safe` must fail loudly at
boot.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from app.config import DEV_SECRET_KEY, ConfigError, Settings, assert_production_safe

BACKEND_DIR = Path(__file__).resolve().parents[1]


def _settings(**overrides) -> Settings:
    """A Settings-shaped object; attributes are overridden per test rather than
    via the environment, so the checks are exercised directly."""
    s = Settings()
    s.ENV = "production"
    s.SECRET_KEY = "a-real-unique-secret"
    s.SEED_DEMO = False
    s.DEV_AUTOLOGIN = False
    for key, value in overrides.items():
        setattr(s, key, value)
    return s


def test_development_is_never_blocked():
    # The insecure defaults are exactly what development wants.
    assert_production_safe(_settings(
        ENV="development", SECRET_KEY=DEV_SECRET_KEY, SEED_DEMO=True,
        DEV_AUTOLOGIN=True))


def test_properly_configured_production_boots():
    assert_production_safe(_settings())


def test_production_rejects_the_dev_secret():
    with pytest.raises(ConfigError) as exc:
        assert_production_safe(_settings(SECRET_KEY=DEV_SECRET_KEY))
    assert "TRACEO_SECRET_KEY" in str(exc.value)


def test_production_rejects_demo_seeding():
    with pytest.raises(ConfigError) as exc:
        assert_production_safe(_settings(SEED_DEMO=True))
    assert "TRACEO_SEED_DEMO" in str(exc.value)


def test_production_rejects_dev_autologin():
    # POST /v1/auth/dev-session issues a session to anyone who asks; on a
    # production node that is an unauthenticated takeover of the demo user's org.
    with pytest.raises(ConfigError) as exc:
        assert_production_safe(_settings(DEV_AUTOLOGIN=True))
    message = str(exc.value)
    assert "TRACEO_DEV_AUTOLOGIN" in message
    assert "credentials" in message  # the operator is told WHY, not just which flag


def _settings_in_a_fresh_process(dev_autologin: str | None) -> tuple[bool, str]:
    """Import app.config in a subprocess with a chosen TRACEO_DEV_AUTOLOGIN.

    The flag is read once at import time, so the environment must be set before
    the process starts — and reloading the module in-process would rebind
    ConfigError under the other tests' feet.
    """
    env = {k: v for k, v in os.environ.items()
           if k not in ("TRACEO_DEV_AUTOLOGIN", "TRACEO_DEV_AUTOLOGIN_EMAIL")}
    if dev_autologin is not None:
        env["TRACEO_DEV_AUTOLOGIN"] = dev_autologin
    proc = subprocess.run(
        [sys.executable, "-c",
         "import json; from app.config import settings; "
         "print(json.dumps([settings.DEV_AUTOLOGIN, settings.DEV_AUTOLOGIN_EMAIL]))"],
        cwd=str(BACKEND_DIR), env=env, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    flag, email = json.loads(proc.stdout.strip().splitlines()[-1])
    return flag, email


@pytest.mark.parametrize("raw", [None, "", "0", "false", "true", "yes", "on", "1"])
def test_dev_autologin_needs_an_explicit_1(raw):
    # Unset (the shipped default), empty, or anything other than "1" leaves the
    # credential bypass off: an operator has to opt in, never opt out.
    flag, email = _settings_in_a_fresh_process(raw)
    assert flag is (raw == "1")
    assert email == "demo@traceo.sa"


def test_all_problems_are_reported_together():
    # Otherwise an operator needs three failed deploys to learn about all three.
    with pytest.raises(ConfigError) as exc:
        assert_production_safe(_settings(SECRET_KEY=DEV_SECRET_KEY, SEED_DEMO=True,
                                         DEV_AUTOLOGIN=True))
    message = str(exc.value)
    assert "TRACEO_SECRET_KEY" in message
    assert "TRACEO_SEED_DEMO" in message
    assert "TRACEO_DEV_AUTOLOGIN" in message
