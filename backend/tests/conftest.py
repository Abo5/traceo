"""Shared pytest fixtures for the Traceo backend quality gates.

IMPORTANT: environment variables are set BEFORE importing the app so that the
engine binds to a temp sqlite FILE (job threads open their own sessions and
must see the same database — :memory: would not work) and demo seeding is off.
"""
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

_fd, _DB_PATH = tempfile.mkstemp(prefix="traceo_test_", suffix=".sqlite3")
os.close(_fd)
os.environ["TRACEO_DATABASE_URL"] = f"sqlite:///{_DB_PATH}"
os.environ["TRACEO_SEED_DEMO"] = "0"
os.environ.setdefault("TRACEO_LLM_PROVIDER", "mock")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402


# ------------------------------------------------------------------ fixtures
@pytest.fixture(autouse=True)
def _fresh_db():
    """Each test starts from empty tables (same temp file, shared with job threads)."""
    Base.metadata.create_all(bind=engine)
    yield
    Base.metadata.drop_all(bind=engine)


@pytest.fixture()
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def register_org(client):
    """Returns a callable: register a fresh org + admin user -> auth headers."""
    def _register(org_name="Test Org"):
        email = f"u{uuid.uuid4().hex[:10]}@example.sa"
        r = client.post("/v1/auth/register", json={
            "org_name": org_name, "name": "Tester",
            "email": email, "password": "Passw0rd!",
        })
        assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
        data = r.json()
        token = data.get("token") or data.get("access_token")
        assert token, f"no token in register response: {data}"
        return {"Authorization": f"Bearer {token}"}
    return _register


@pytest.fixture()
def create_project(client):
    """Returns a callable: create a project for the given auth headers -> project id."""
    def _create(headers, name="مشروع اختبار", language="ar"):
        r = client.post("/v1/projects", json={"name": name, "language": language},
                        headers=headers)
        assert r.status_code in (200, 201), f"create project failed: {r.status_code} {r.text}"
        data = r.json()
        pid = data.get("id") or (data.get("project") or {}).get("id")
        assert pid, f"no project id in response: {data}"
        return pid
    return _create


# ------------------------------------------------------------------ helpers
# (plain module functions — import from tests via `from conftest import ...`)
def items_of(payload):
    """Normalize list endpoints that may return a bare list or a wrapped object."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "rows", "results", "data", "test_cases", "requirements",
                    "endpoints", "runs", "environments", "documents", "cases"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


def poll_job(client, headers, job_id, timeout=30.0, interval=0.2):
    """Poll GET /v1/jobs/{id} until completed; fail the test on failure/timeout."""
    assert job_id, "poll_job called without a job id"
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert r.status_code == 200, f"job poll failed: {r.status_code} {r.text}"
        job = r.json()
        if job.get("status") == "completed":
            return job
        if job.get("status") == "failed":
            raise AssertionError(f"job {job_id} failed: {job.get('error')}")
        time.sleep(interval)
    raise AssertionError(f"job {job_id} did not finish within {timeout}s")


def small_openapi_spec():
    """A minimal 2-endpoint OpenAPI 3 spec (POST /customers, GET /customers/{id})."""
    return {
        "openapi": "3.0.3",
        "info": {"title": "Customers API", "version": "1.0.0"},
        "paths": {
            "/customers": {
                "post": {
                    "operationId": "createCustomer",
                    "summary": "Create a customer with phone and age validation",
                    "requestBody": {
                        "required": True,
                        "content": {"application/json": {"schema": {
                            "type": "object",
                            "required": ["name", "phone", "age"],
                            "properties": {
                                "name": {"type": "string", "minLength": 1, "maxLength": 100},
                                "phone": {"type": "string", "pattern": "^05[0-9]{8}$"},
                                "email": {"type": "string", "format": "email"},
                                "age": {"type": "integer", "minimum": 18, "maximum": 120},
                            },
                        }}},
                    },
                    "responses": {
                        "201": {"description": "Created", "content": {"application/json": {
                            "schema": {"type": "object", "properties": {
                                "id": {"type": "string"}, "name": {"type": "string"},
                            }}}}},
                        "422": {"description": "Validation error"},
                    },
                },
            },
            "/customers/{id}": {
                "get": {
                    "operationId": "getCustomer",
                    "summary": "Get a customer by id",
                    "parameters": [{"name": "id", "in": "path", "required": True,
                                    "schema": {"type": "string"}}],
                    "responses": {
                        "200": {"description": "OK", "content": {"application/json": {
                            "schema": {"type": "object", "properties": {
                                "id": {"type": "string"}, "name": {"type": "string"},
                                "phone": {"type": "string"},
                            }}}}},
                        "404": {"description": "Not found"},
                    },
                },
            },
        },
    }


def import_spec(client, headers, project_id, spec_dict=None):
    """Upload an inline OpenAPI spec (multipart) and return the parsed response."""
    spec = spec_dict or small_openapi_spec()
    r = client.post(
        f"/v1/projects/{project_id}/api-specs",
        files={"file": ("spec.json", json.dumps(spec).encode("utf-8"), "application/json")},
        headers=headers,
    )
    assert r.status_code in (200, 201), f"spec import failed: {r.status_code} {r.text}"
    return r.json() if r.content else {}


def add_requirement(client, headers, project_id, external_id, description,
                    criteria=None, req_type="functional", priority="high"):
    """Manually add a requirement -> requirement id."""
    r = client.post("/v1/requirements", json={
        "project_id": project_id, "external_id": external_id,
        "description": description, "acceptance_criteria": criteria or [],
        "type": req_type, "priority": priority,
    }, headers=headers)
    assert r.status_code in (200, 201), f"add requirement failed: {r.status_code} {r.text}"
    data = r.json()
    rid = data.get("id") or (data.get("requirement") or {}).get("id")
    assert rid, f"no requirement id in response: {data}"
    return rid


def confirm_requirement(client, headers, requirement_id):
    r = client.patch(f"/v1/requirements/{requirement_id}",
                     json={"state": "confirmed"}, headers=headers)
    assert r.status_code == 200, f"confirm requirement failed: {r.status_code} {r.text}"
