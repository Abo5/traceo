"""RELEASE GATE — POST /v1/auth/dev-session (development convenience, never production).

The owner asked for login to be disabled "until further notice", so a development
node can hand out a real session for a configured user without credentials. That
is a full authentication bypass, so the guarantees that matter are:

  * it does not exist unless TRACEO_DEV_AUTOLOGIN=1 — and when off it 404s like
    any unknown path, rather than announcing a disabled feature;
  * a production node refuses to BOOT with the flag on (tests/test_config_guard.py),
    so the route can never be reachable there;
  * when on it behaves exactly like /auth/login for the configured user, including
    the audit entry, so the trail never shows an unexplained session.
"""
import uuid

import pytest

from app.config import settings


def _register(client, email=None, org_name="Dev Org"):
    """Register an org + admin and return (email, login-style payload)."""
    email = email or f"u{uuid.uuid4().hex[:10]}@example.sa"
    r = client.post("/v1/auth/register", json={
        "org_name": org_name, "name": "Dev User",
        "email": email, "password": "Passw0rd!"})
    assert r.status_code in (200, 201), r.text
    return email, r.json()


@pytest.fixture()
def autologin(monkeypatch):
    """Turn the flag on for one test, for a chosen email."""
    def _enable(email):
        monkeypatch.setattr(settings, "DEV_AUTOLOGIN", True)
        monkeypatch.setattr(settings, "DEV_AUTOLOGIN_EMAIL", email)
    return _enable


# ------------------------------------------------------------------ flag is off

def test_the_route_is_absent_by_default(client):
    # The default is off (TRACEO_DEV_AUTOLOGIN unset), and the tests never set it.
    assert settings.DEV_AUTOLOGIN is False
    _register(client, "demo@traceo.sa")  # even the configured user must not help
    r = client.post("/v1/auth/dev-session")
    assert r.status_code == 404, r.text
    assert r.json()["detail"]["code"] == "not_found"


def test_the_disabled_route_leaks_nothing_about_the_feature(client):
    body = client.post("/v1/auth/dev-session").text
    assert "AUTOLOGIN" not in body.upper()
    assert "dev_session" not in body


# ------------------------------------------------------------------ flag is on

def test_it_returns_a_token_and_user_exactly_like_login(client, autologin):
    email, registered = _register(client, org_name="Traceo Demo")
    autologin(email)

    r = client.post("/v1/auth/dev-session")
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"token", "user"}
    assert body["token"]

    login = client.post("/v1/auth/login",
                        json={"email": email, "password": "Passw0rd!"}).json()
    assert body["user"] == login["user"]
    assert body["user"]["email"] == email
    assert body["user"]["id"] == registered["user"]["id"]
    assert body["user"]["org_name"] == "Traceo Demo"
    assert "password" not in r.text and "hash" not in r.text

    # the token is a real session, not a placeholder
    me = client.get("/v1/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200, me.text
    assert me.json()["email"] == email


def test_the_configured_email_is_matched_case_insensitively(client, autologin):
    email, _ = _register(client)
    autologin(f"  {email.upper()}  ")
    r = client.post("/v1/auth/dev-session")
    assert r.status_code == 200, r.text
    assert r.json()["user"]["email"] == email


def test_no_credentials_and_no_body_are_required(client, autologin):
    email, _ = _register(client)
    autologin(email)
    # no Authorization header, no JSON body at all
    assert client.post("/v1/auth/dev-session").status_code == 200


def test_it_writes_an_auth_dev_session_audit_entry(client, autologin):
    email, _ = _register(client)
    autologin(email)
    body = client.post("/v1/auth/dev-session").json()
    headers = {"Authorization": f"Bearer {body['token']}"}

    items = client.get("/v1/audit?limit=200", headers=headers).json()["items"]
    entry = next(e for e in items if e["action"] == "auth.dev_session")
    assert entry["object_type"] == "user"
    assert entry["object_id"] == body["user"]["id"]
    assert entry["actor_id"] == body["user"]["id"]
    assert entry["detail"]["email"] == email
    # one session issued, one entry — never silent, never doubled
    assert len([e for e in items if e["action"] == "auth.dev_session"]) == 1
    assert not [e for e in items if e["action"] == "auth.login"]


# ------------------------------------------------------------------ flag on, user missing

def test_it_is_503_dev_session_unavailable_when_the_user_does_not_exist(client, autologin):
    autologin("nobody@traceo.sa")
    r = client.post("/v1/auth/dev-session")
    assert r.status_code == 503, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "dev_session_unavailable"
    assert "nobody@traceo.sa" in detail["message"]


def test_a_different_user_existing_does_not_satisfy_the_configured_email(client, autologin):
    _register(client)  # some other user
    autologin("demo@traceo.sa")
    r = client.post("/v1/auth/dev-session")
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "dev_session_unavailable"
