"""Deriving a runnable environment from the document that was just imported.

THE BUG THIS SUITE PINS
-----------------------
"I only added a Postman collection for the API connection" — and the New run
screen showed an EMPTY environment picker, so nothing could be executed. The
base URL was sitting in the uploaded file the whole time.

Four things are defended here.

1. DERIVATION is deterministic and format-aware (Postman, HAR, Insomnia,
   OpenAPI/Swagger). No LLM, no network, and above all no invented host: a
   document that does not say where the API lives yields nothing.
2. THE RECONSTRUCTION INVARIANT — base_url + stored endpoint path == the
   original URL, exactly. The real Google Calendar collection is the hard case:
   its {{baseUrl}} carries a /calendar/v3 path prefix that the converter strips
   off every path, so a base_url of "https://www.googleapis.com" would produce
   404s on every request while looking perfectly reasonable in the UI.
3. CREDENTIALS ARE NEVER COPIED. A variable whose NAME looks like a secret is
   carried as an empty string so the user fills it in; its value never reaches
   the environment, the response, or the audit entry.
4. AUTO-CREATION ONLY FILLS A VOID. Zero environments + a derived base URL is
   the only case that writes. An existing environment is never touched, and the
   response key is null whenever nothing was created.
"""
import json
from pathlib import Path

from conftest import items_of, small_openapi_spec

from app.modules.collections import (convert, derive_environment, imported_environment_name,
                                     is_credential_name)

FIXTURE = Path(__file__).parent / "fixtures" / "calendar-api.postman_collection.json"


def postman_collection() -> dict:
    with FIXTURE.open(encoding="utf-8") as fh:
        return json.load(fh)


def upload(client, headers, project_id, doc, filename="doc.json"):
    r = client.post(f"/v1/projects/{project_id}/api-specs",
                    files={"file": (filename, json.dumps(doc).encode("utf-8"),
                                    "application/json")},
                    headers=headers)
    assert r.status_code in (200, 201), f"import failed: {r.status_code} {r.text}"
    return r.json()


def har_document(host="https://api.example.com") -> dict:
    return {"log": {"version": "1.2", "creator": {"name": "Chrome DevTools"},
                    "entries": [
                        {"request": {"method": "GET", "url": f"{host}/v1/orders/12345",
                                     "queryString": [], "headers": []},
                         "response": {"status": 200, "content": {}}},
                        {"request": {"method": "GET", "url": f"{host}/v1/orders",
                                     "queryString": [], "headers": []},
                         "response": {"status": 200, "content": {}}},
                        {"request": {"method": "GET", "url": "https://cdn.other.com/logo.png",
                                     "queryString": [], "headers": []},
                         "response": {"status": 200, "content": {}}},
                    ]}}


def insomnia_export() -> dict:
    return {
        "_type": "export", "__export_format": 4,
        "resources": [
            {"_id": "wrk_1", "_type": "workspace", "name": "Billing"},
            {"_id": "env_1", "_type": "environment", "parentId": "wrk_1",
             "data": {"base_url": "https://api.example.com/v2", "tenant": "acme",
                      "api_token": "live-secret-value"}},
            {"_id": "req_1", "_type": "request", "parentId": "wrk_1",
             "name": "Get invoice", "method": "GET",
             "url": "{{ _.base_url }}/invoices/:invoiceId"},
        ],
    }


# ------------------------------------------------- 1. the real Postman collection

def test_fixture_base_url_keeps_the_stripped_path_prefix():
    """The whole point: /calendar/v3 was stripped off every path, so it MUST come
    back in base_url — otherwise every reconstructed request 404s."""
    derived = derive_environment(postman_collection(), "postman2")
    assert derived is not None
    assert derived["base_url"] == "https://www.googleapis.com/calendar/v3"
    assert derived["base_url"].endswith("/calendar/v3")


def test_fixture_carries_calendar_id_as_a_variable_not_the_base_url():
    derived = derive_environment(postman_collection(), "postman2")
    assert derived["variables"] == {"calendarId": "testCalendarID"}
    assert "baseUrl" not in derived["variables"]  # the base-url variable is not duplicated


def test_fixture_base_url_plus_stored_path_reconstructs_the_original_url():
    """The invariant, checked against the converter rather than asserted by hand."""
    doc = postman_collection()
    derived = derive_environment(doc, "postman2")
    ops, _warnings, _title, _source = convert(doc, "postman2")
    op = next(o for o in ops if o["path"] == "/calendars/{calendarId}/acl/{ruleId}")
    assert derived["base_url"] + op["path"] == \
        "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/acl/{ruleId}"
    # and no path smuggled a piece of the base URL back in
    assert all(not p["path"].startswith("/calendar/v3") for p in ops)


def test_fixture_environment_name_is_the_document_title():
    _ops, _w, title, _s = convert(postman_collection(), "postman2")
    assert imported_environment_name(title).endswith(" (imported)")
    assert "Calendar API" in imported_environment_name(title)


# ------------------------------------------------- 2. the other three format families

def test_har_derives_the_most_frequent_origin_and_no_variables():
    derived = derive_environment(har_document(), "har")
    assert derived == {"base_url": "https://api.example.com", "variables": {}}


def test_har_base_url_is_the_bare_origin_because_nothing_else_was_stripped():
    """HAR paths keep their /v1 prefix, so base_url must NOT repeat it."""
    ops, *_ = convert(har_document(), "har")
    derived = derive_environment(har_document(), "har")
    assert "/v1/orders" in {o["path"] for o in ops}
    assert derived["base_url"] + "/v1/orders" == "https://api.example.com/v1/orders"


def test_insomnia_derives_from_the_environment_data():
    derived = derive_environment(insomnia_export(), "insomnia4")
    assert derived["base_url"] == "https://api.example.com/v2"
    assert derived["variables"] == {"tenant": "acme", "api_token": ""}


def test_openapi3_uses_the_first_server_including_its_path_prefix():
    spec = dict(small_openapi_spec(), servers=[{"url": "https://api.example.com/v1/"},
                                               {"url": "https://staging.example.com"}])
    assert derive_environment(spec, "openapi3") == {
        "base_url": "https://api.example.com/v1", "variables": {}}


def test_openapi3_substitutes_server_variable_defaults():
    spec = {"openapi": "3.0.3", "paths": {},
            "servers": [{"url": "https://{region}.example.com/v1",
                         "variables": {"region": {"default": "eu"}}}]}
    assert derive_environment(spec, "openapi3")["base_url"] == "https://eu.example.com/v1"


def test_swagger2_composes_scheme_host_and_base_path():
    spec = {"swagger": "2.0", "host": "api.example.com", "basePath": "/v2",
            "schemes": ["http", "https"], "paths": {}}
    assert derive_environment(spec, "swagger2")["base_url"] == "https://api.example.com/v2"
    # basePath "/" contributes nothing, and an absent scheme list defaults to https
    bare = {"swagger": "2.0", "host": "api.example.com", "basePath": "/", "paths": {}}
    assert derive_environment(bare, "swagger2")["base_url"] == "https://api.example.com"


def test_postman_falls_back_to_the_most_frequent_request_origin():
    """No baseUrl variable at all — the origin is read off the requests."""
    doc = {"info": {"name": "Ops",
                    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
           "item": [
               {"name": "a", "request": {"method": "GET",
                                         "url": "https://api.example.com/v1/orders"}},
               {"name": "b", "request": {"method": "POST",
                                         "url": "https://api.example.com/v1/orders"}},
               {"name": "c", "request": {"method": "GET",
                                         "url": "https://docs.example.com/readme"}},
           ]}
    assert derive_environment(doc, "postman2")["base_url"] == "https://api.example.com"


# ------------------------------------------------- 3. nothing is invented

def test_no_base_url_means_no_derivation():
    """A host is never invented — not from a relative server, not from a
    scheme-less variable, not from a document with no URLs at all."""
    assert derive_environment({"openapi": "3.0.3", "paths": {},
                               "servers": [{"url": "/v1"}]}, "openapi3") is None
    assert derive_environment({"openapi": "3.0.3", "paths": {}}, "openapi3") is None
    assert derive_environment({"swagger": "2.0", "basePath": "/v2", "paths": {}},
                              "swagger2") is None
    assert derive_environment({"log": {"entries": []}}, "har") is None
    assert derive_environment(
        {"info": {"name": "x",
                  "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
         "variable": [{"key": "baseUrl", "value": "api.example.com"}],  # no scheme
         "item": [{"name": "a", "request": {"method": "GET", "url": "{{baseUrl}}/orders"}}]},
        "postman2") is None
    assert derive_environment(None, "postman2") is None


def test_credential_looking_variables_are_carried_with_empty_values():
    doc = {"info": {"name": "Secrets",
                    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
           "variable": [
               {"key": "baseUrl", "value": "https://api.example.com"},
               {"key": "tenant", "value": "acme"},
               {"key": "authToken", "value": "live-token-value"},
               {"key": "CLIENT_SECRET", "value": "live-secret-value"},
               {"key": "X-Api-Key", "value": "live-key-value"},
               {"key": "userPassword", "value": "hunter2"},
               {"key": "bearerValue", "value": "live-bearer-value"},
               {"key": "apikeyAlt", "value": "live-apikey-value"},
           ],
           "item": []}
    variables = derive_environment(doc, "postman2")["variables"]
    assert variables == {"tenant": "acme", "authToken": "", "CLIENT_SECRET": "",
                         "X-Api-Key": "", "userPassword": "", "bearerValue": "",
                         "apikeyAlt": ""}
    assert "live-" not in json.dumps(variables)
    assert is_credential_name("SESSION_TOKEN") and not is_credential_name("calendarId")


# ------------------------------------------------- 4. auto-creation through the route

def test_postman_import_creates_the_environment_and_reports_it(client, register_org,
                                                               create_project):
    headers = register_org()
    pid = create_project(headers)
    assert items_of(client.get(f"/v1/projects/{pid}/environments",
                               headers=headers).json()) == []

    body = upload(client, headers, pid, postman_collection(), "calendar.postman_collection.json")

    created = body["environment_created"]
    assert created is not None, "the picker stays empty — the import did not derive anything"
    assert created["base_url"] == "https://www.googleapis.com/calendar/v3"
    assert created["name"].endswith(" (imported)")
    assert set(created) == {"id", "name", "base_url"}

    envs = items_of(client.get(f"/v1/projects/{pid}/environments", headers=headers).json())
    assert len(envs) == 1
    env = envs[0]
    assert env["id"] == created["id"]
    assert env["base_url"] == "https://www.googleapis.com/calendar/v3"
    assert env["auth_type"] == "none"
    assert env["tls_strict"] is True
    assert env["variables"] == {"calendarId": "testCalendarID"}
    assert env["auth_config_masked"] is False


def test_every_pre_existing_response_key_survives(client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers)
    body = upload(client, headers, pid, postman_collection())
    for key in ("spec_id", "version", "endpoints_count", "warnings", "diff", "format",
                "added", "updated", "removed", "total", "enriched", "enrichment_discarded"):
        assert key in body, f"import response lost '{key}'"
    assert body["format"] == "postman2"
    assert body["endpoints_count"] == 37


def test_audit_records_the_autocreation_with_the_source_format(client, register_org,
                                                               create_project):
    headers = register_org()
    pid = create_project(headers)
    upload(client, headers, pid, postman_collection())
    entries = client.get("/v1/audit?limit=200", headers=headers).json()["items"]
    entry = next(e for e in entries if e["action"] == "environment.autocreated")
    assert entry["object_type"] == "environment"
    assert entry["detail"]["format"] == "postman2"
    assert entry["detail"]["base_url"] == "https://www.googleapis.com/calendar/v3"
    assert entry["detail"]["variables"] == ["calendarId"]
    assert "testCalendarID" not in json.dumps(entry["detail"])  # names only, no values


def test_openapi_import_also_gets_an_environment(client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers)
    spec = dict(small_openapi_spec(), servers=[{"url": "https://api.example.com/v1"}])
    body = upload(client, headers, pid, spec, "spec.json")
    assert body["environment_created"]["base_url"] == "https://api.example.com/v1"
    assert body["environment_created"]["name"] == "Customers API (imported)"


def test_no_environment_is_created_when_the_project_already_has_one(client, register_org,
                                                                   create_project):
    """The rule that protects the owner's own configuration: this only ever fills
    a genuine void, and never touches what is already there."""
    headers = register_org()
    pid = create_project(headers)
    existing = client.post(f"/v1/projects/{pid}/environments",
                           json={"name": "Staging", "base_url": "https://staging.internal",
                                 "auth_type": "bearer", "auth_config": {"token": "t"},
                                 "variables": {"kept": "yes"}},
                           headers=headers).json()

    body = upload(client, headers, pid, postman_collection())
    assert body["environment_created"] is None

    envs = items_of(client.get(f"/v1/projects/{pid}/environments", headers=headers).json())
    assert len(envs) == 1
    assert envs[0]["id"] == existing["id"]
    assert envs[0]["base_url"] == "https://staging.internal"
    assert envs[0]["variables"] == {"kept": "yes"}
    assert envs[0]["auth_type"] == "bearer"
    entries = client.get("/v1/audit?limit=200", headers=headers).json()["items"]
    assert not any(e["action"] == "environment.autocreated" for e in entries)


def test_no_environment_when_no_base_url_can_be_derived(client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers)
    spec = small_openapi_spec()  # no `servers` block at all
    body = upload(client, headers, pid, spec, "spec.json")
    assert body["environment_created"] is None
    assert items_of(client.get(f"/v1/projects/{pid}/environments",
                               headers=headers).json()) == []
    entries = client.get("/v1/audit?limit=200", headers=headers).json()["items"]
    assert not any(e["action"] == "environment.autocreated" for e in entries)


def test_re_import_does_not_create_a_second_environment(client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers)
    first = upload(client, headers, pid, postman_collection())
    second = upload(client, headers, pid, postman_collection())
    assert first["environment_created"] is not None
    assert second["environment_created"] is None
    assert len(items_of(client.get(f"/v1/projects/{pid}/environments",
                                   headers=headers).json())) == 1


def test_har_and_insomnia_imports_create_their_environment(client, register_org,
                                                           create_project):
    headers = register_org()
    pid_har = create_project(headers, name="HAR project")
    assert upload(client, headers, pid_har, har_document(), "traffic.har")[
        "environment_created"]["base_url"] == "https://api.example.com"

    pid_ins = create_project(headers, name="Insomnia project")
    created = upload(client, headers, pid_ins, insomnia_export(), "insomnia.json")[
        "environment_created"]
    assert created["base_url"] == "https://api.example.com/v2"
    env = items_of(client.get(f"/v1/projects/{pid_ins}/environments",
                              headers=headers).json())[0]
    assert env["variables"] == {"tenant": "acme", "api_token": ""}
    assert "live-secret-value" not in json.dumps(env)
