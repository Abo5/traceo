"""RELEASE GATE — a production node must never boot wide open.

Two config defaults are correct for development and catastrophic in production:
the dev signing key is published in `app/config.py` (so anyone could mint a valid
JWT for any user in any organisation, collapsing the tenant isolation AC-11
guards), and the seeded demo accounts use a password printed in the docs. Neither
is detectable at runtime, so `assert_production_safe` must fail loudly at boot.
"""
import pytest

from app.config import DEV_SECRET_KEY, ConfigError, Settings, assert_production_safe


def _settings(**overrides) -> Settings:
    """A Settings-shaped object; attributes are overridden per test rather than
    via the environment, so the checks are exercised directly."""
    s = Settings()
    s.ENV = "production"
    s.SECRET_KEY = "a-real-unique-secret"
    s.SEED_DEMO = False
    for key, value in overrides.items():
        setattr(s, key, value)
    return s


def test_development_is_never_blocked():
    # The insecure defaults are exactly what development wants.
    assert_production_safe(_settings(
        ENV="development", SECRET_KEY=DEV_SECRET_KEY, SEED_DEMO=True))


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


def test_both_problems_are_reported_together():
    # Otherwise an operator needs two failed deploys to learn about both.
    with pytest.raises(ConfigError) as exc:
        assert_production_safe(_settings(SECRET_KEY=DEV_SECRET_KEY, SEED_DEMO=True))
    message = str(exc.value)
    assert "TRACEO_SECRET_KEY" in message and "TRACEO_SEED_DEMO" in message
