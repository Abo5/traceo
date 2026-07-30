"""Discovery beyond the specification — FR-021 traffic, FR-022 DOM, FR-023 Postman.

The properties that matter: concrete paths generalise into templates, credentials
never reach the database, observations accumulate, and a lower-fidelity source can
add to the surface but never overwrite what a specification declared.
"""
from conftest import import_spec, items_of

from app.modules.capture import parse_har, parse_postman, templatize


# ---------------------------------------------------------------- unit level

def test_path_templating_names_parameters_after_their_collection():
    assert templatize("/orders/8812") == "/orders/{orderId}"
    assert templatize("/users/42/orders/8812") == "/users/{userId}/orders/{orderId}"
    assert templatize("/customers/3f0c9c62-5f1e-4a7a-9b0a-1d2e3f4a5b6c") == \
        "/customers/{customerId}"
    assert templatize("/companies/2024-01-31/report") == "/companies/{companyId}/report"
    # A word segment is content, not an identifier.
    assert templatize("/orders/summary") == "/orders/summary"
    assert templatize("/") == "/"


def test_har_parsing_counts_observations_and_never_stores_credentials():
    def entry(url, status=200, body='{"id": 1, "name": "Reem"}'):
        return {
            "request": {
                "method": "GET", "url": url,
                "headers": [{"name": "Authorization", "value": "Bearer sk-live-supersecret"},
                            {"name": "Cookie", "value": "session=abc123"}],
                "queryString": [{"name": "page", "value": "2"}],
                "postData": {"text": '{"password": "hunter2", "name": "Reem"}'},
            },
            "response": {"status": status,
                         "content": {"mimeType": "application/json", "text": body}},
        }

    har = {"log": {"entries": [entry("https://api.sa/v1/orders/8812"),
                               entry("https://api.sa/v1/orders/9001"),
                               entry("https://api.sa/v1/orders/9001")]}}
    records, _warnings = parse_har(har)

    assert len(records) == 1, "three observations of one template must collapse to one endpoint"
    record = records[0]
    assert record["path"] == "/v1/orders/{orderId}"
    assert record["times_seen"] == 3          # AC3
    assert record["security"] == [{"observed": "bearer"}]

    # AC4 — no captured value survives: bodies are reduced to field names + types,
    # and credential-shaped fields are blanked before even that.
    blob = repr(record)
    assert "sk-live-supersecret" not in blob
    assert "hunter2" not in blob
    assert "abc123" not in blob
    assert "Reem" not in blob
    assert record["request_schema"]["properties"]["password"] == {"type": "string"}

    names = {p["name"] for p in record["parameters"]}
    assert {"page", "orderId"} <= names


def test_har_skips_asset_traffic_unless_asked():
    def asset(url, mime):
        return {"request": {"method": "GET", "url": url},
                "response": {"status": 200, "content": {"mimeType": mime, "text": ""}}}

    har = {"log": {"entries": [asset("https://shop.sa/styles.css", "text/css"),
                               asset("https://shop.sa/logo.png", "image/png")]}}
    assert parse_har(har)[0] == []
    assert len(parse_har(har, include_all=True)[0]) == 2


def test_postman_maps_folders_to_tags_and_reports_unresolved_variables():
    collection = {
        "info": {"name": "Orders", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "variable": [{"key": "base", "value": "https://api.sa"}],
        "item": [{
            "name": "Checkout",
            "item": [{
                "name": "Create order",
                "request": {
                    "method": "POST",
                    "url": {"raw": "{{base}}/v1/orders?dryRun=true",
                            "query": [{"key": "dryRun", "value": "true"}]},
                    "body": {"mode": "raw", "raw": '{"total": 100, "token": "{{authToken}}"}'},
                },
            }],
        }],
    }
    records, warnings = parse_postman(collection)
    assert len(records) == 1
    assert records[0]["path"] == "/v1/orders"
    assert records[0]["tags"] == ["Checkout"]                       # AC1
    assert any("authToken" == w.get("variable") for w in warnings)  # AC2
    assert "«redacted»" not in str(records[0]["parameters"])
    # the credential-shaped body field is blanked before any storage
    assert "token" in (records[0]["request_schema"] or {}).get("properties", {})


def test_postman_rejects_a_non_collection():
    try:
        parse_postman({"info": {"schema": "something-else"}})
    except ValueError as e:
        assert "v2.1" in str(e)
    else:
        raise AssertionError("expected a ValueError for a non-v2.1 document")


# ---------------------------------------------------------------- API level

def test_traffic_import_merges_with_the_spec_surface(client, register_org, create_project):
    headers = register_org("Discovery Org")
    pid = create_project(headers, name="Surface", language="en")
    import_spec(client, headers, pid)

    har = {"log": {"entries": [
        # already declared by the spec — must not duplicate, only add observations
        {"request": {"method": "GET", "url": "https://api.sa/customers/551"},
         "response": {"status": 200, "content": {"mimeType": "application/json",
                                                 "text": '{"id":"551","loyaltyTier":"gold"}'}}},
        # never declared — traffic contributes a new endpoint
        {"request": {"method": "GET", "url": "https://api.sa/invoices"},
         "response": {"status": 200, "content": {"mimeType": "application/json",
                                                 "text": '[{"id":"1"}]'}}},
    ]}}
    r = client.post(f"/v1/projects/{pid}/discovery/traffic", json={"har": har},
                    headers=headers)
    assert r.status_code in (200, 201), r.text
    assert r.json()["added"] == 1

    endpoints = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    by_path = {(e["method"], e["path"]): e for e in endpoints}

    declared = by_path[("GET", "/customers/{id}")]
    assert declared["discovery_source"] == "openapi", \
        "traffic must not take ownership of a declared endpoint"
    assert declared["times_seen"] == 1
    assert declared["declared_never_seen"] is False

    observed = by_path[("GET", "/invoices")]
    assert observed["discovery_source"] == "traffic"
    assert observed["inferred"] is True
    assert observed["response_schemas"]["200"]["type"] == "array"

    # FR-020 AC3: declared, but never seen in the capture
    assert by_path[("POST", "/customers")]["declared_never_seen"] is True


def test_spec_reimport_keeps_observed_endpoints_and_their_counts(
        client, register_org, create_project):
    headers = register_org("Reimport Org")
    pid = create_project(headers, name="Surface", language="en")
    import_spec(client, headers, pid)

    har = {"log": {"entries": [
        {"request": {"method": "GET", "url": "https://api.sa/invoices"},
         "response": {"status": 200, "content": {"mimeType": "application/json", "text": "[]"}}},
        {"request": {"method": "GET", "url": "https://api.sa/customers/9"},
         "response": {"status": 200, "content": {"mimeType": "application/json", "text": "{}"}}},
    ]}}
    client.post(f"/v1/projects/{pid}/discovery/traffic", json={"har": har}, headers=headers)

    import_spec(client, headers, pid)  # re-import the same spec

    endpoints = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    by_path = {(e["method"], e["path"]): e for e in endpoints}
    assert ("GET", "/invoices") in by_path, "a spec re-import must not delete observed endpoints"
    assert by_path[("GET", "/invoices")]["times_seen"] == 1
    # the observation count survives even where the spec re-asserts ownership
    assert by_path[("GET", "/customers/{id}")]["times_seen"] == 1
    assert by_path[("GET", "/customers/{id}")]["discovery_source"] == "openapi"


def test_dom_crawl_attaches_validation_constraints(client, register_org, create_project):
    headers = register_org("DOM Org")
    pid = create_project(headers, name="Storefront", language="ar")
    forms = [{
        "id": "signup", "action": "/api/signup", "method": "POST", "dir": "rtl",
        "fields": [{"name": "phone", "type": "tel", "required": True,
                    "pattern": "^05[0-9]{8}$", "maxlength": 10},
                   {"name": "age", "type": "number", "required": False,
                    "min": 18, "max": 120}],
    }]
    r = client.post(f"/v1/projects/{pid}/discovery/dom", json={"forms": forms}, headers=headers)
    assert r.status_code in (200, 201), r.text
    assert any("RTL" in n["note"] for n in r.json()["notes"])  # AC3

    endpoint = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())[0]
    assert endpoint["discovery_source"] == "dom"
    fields = {f["name"]: f for f in endpoint["dom_fields"]}
    assert fields["phone"]["constraints"]["pattern"] == "^05[0-9]{8}$"   # AC1/AC2
    assert fields["age"]["constraints"] == {"minimum": 18, "maximum": 120}


def test_reset_removes_only_the_named_source(client, register_org, create_project):
    headers = register_org("Reset Org")
    pid = create_project(headers, name="Surface", language="en")
    import_spec(client, headers, pid)
    client.post(f"/v1/projects/{pid}/discovery/traffic", json={"har": {"log": {"entries": [
        {"request": {"method": "GET", "url": "https://api.sa/invoices"},
         "response": {"status": 200, "content": {"mimeType": "application/json", "text": "[]"}}},
    ]}}}, headers=headers)

    r = client.post(f"/v1/projects/{pid}/discovery/reset", json={"source": "traffic"},
                    headers=headers)
    assert r.status_code == 200 and r.json()["removed"] == 1
    paths = {e["path"] for e in items_of(
        client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())}
    assert "/invoices" not in paths
    assert "/customers" in paths, "specification endpoints must survive a source reset"
