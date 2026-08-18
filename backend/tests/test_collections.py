"""API collection import (Postman v2.x / HAR 1.2 / Insomnia v4) + AI enrichment.

The bug this suite pins: a real 300KB Postman collection used to come back as
422 invalid_spec even though Endpoint.source already documented "postman".

Three things are being defended here.

1. DETECTION is deterministic and the rejection message is actionable — an
   unsupported document must say which formats WOULD work.
2. CONVERSION is the grounding source of truth. The fixture is a genuine
   Google Calendar collection (37 requests, ":param" segments, {{baseUrl}} and
   {{calendarId}} variables, 35 query parameters, 19 raw JSON bodies), copied
   into tests/fixtures/ so the suite is self-contained. Everything asserted here
   is derived from the file — no LLM is involved at any point.
3. ENRICHMENT may only ANNOTATE. The adversarial test feeds a provider that
   returns invented endpoints, renamed parameters, an illegal criticality and a
   duplicate, and proves every one is discarded, counted, and that the endpoint
   inventory is byte-identical to the un-enriched import.
"""
import copy
import json
from pathlib import Path

import pytest
from conftest import import_spec, items_of

from app.llm.base import LLMResult
from app.modules import enrichment
from app.modules.collections import convert, detect_format, infer_json_schema, merge_schema

FIXTURE = Path(__file__).parent / "fixtures" / "calendar-api.postman_collection.json"


def postman_collection() -> dict:
    with FIXTURE.open(encoding="utf-8") as fh:
        return json.load(fh)


def har_document() -> dict:
    """A minimal HAR 1.2 log: two hits on the same route with different concrete
    ids, one hit on a UUID route, and a JSON POST."""
    return {
        "log": {
            "version": "1.2",
            "creator": {"name": "Chrome DevTools", "version": "1.0"},
            "entries": [
                {"request": {"method": "GET",
                             "url": "https://api.example.com/v1/orders/12345?expand=items",
                             "queryString": [{"name": "expand", "value": "items"}],
                             "headers": [{"name": "Accept", "value": "application/json"},
                                         {"name": "X-Tenant", "value": "acme"}]},
                 "response": {"status": 200,
                              "content": {"mimeType": "application/json",
                                          "text": '{"id": 12345, "total": 9.5, "paid": true}'}}},
                {"request": {"method": "GET",
                             "url": "https://api.example.com/v1/orders/67890",
                             "queryString": [], "headers": []},
                 "response": {"status": 404, "content": {"mimeType": "application/json",
                                                         "text": '{"error": "missing"}'}}},
                {"request": {"method": "DELETE",
                             "url": "https://api.example.com/v1/orders/"
                                    "3f2504e0-4f89-11d3-9a0c-0305e82c3301/items/7",
                             "queryString": [], "headers": []},
                 "response": {"status": 204, "content": {}}},
                {"request": {"method": "POST", "url": "https://api.example.com/v1/orders",
                             "queryString": [], "headers": [],
                             "postData": {"mimeType": "application/json",
                                          "text": '{"sku": "A1", "qty": 2, '
                                                  '"tags": ["x", "y"]}'}},
                 "response": {"status": 201, "content": {"mimeType": "application/json",
                                                         "text": '{"id": 1}'}}},
            ],
        },
    }


def insomnia_export() -> dict:
    return {
        "_type": "export",
        "__export_format": 4,
        "resources": [
            {"_id": "wrk_1", "_type": "workspace", "name": "Billing"},
            {"_id": "env_1", "_type": "environment", "parentId": "wrk_1",
             "data": {"base_url": "https://api.example.com/v2"}},
            {"_id": "fld_1", "_type": "request_group", "parentId": "wrk_1",
             "name": "Invoices"},
            {"_id": "req_1", "_type": "request", "parentId": "fld_1",
             "name": "Get invoice", "method": "GET",
             "url": "{{ _.base_url }}/invoices/:invoiceId",
             "parameters": [{"name": "include", "value": "lines"}],
             "headers": [{"name": "Authorization", "value": "Bearer x"},
                         {"name": "Accept", "value": "application/json"}]},
            {"_id": "req_2", "_type": "request", "parentId": "fld_1",
             "name": "Pay invoice", "method": "POST",
             "url": "{{ _.base_url }}/invoices/99/pay",
             "body": {"mimeType": "application/json",
                      "text": '{"amount": 12.5, "method": "card"}'}},
        ],
    }


# ------------------------------------------------------------------ 1. detection

def test_detects_every_supported_format():
    assert detect_format(postman_collection()) == "postman2"
    assert detect_format(har_document()) == "har"
    assert detect_format(insomnia_export()) == "insomnia4"
    # the pre-existing formats keep their identity, and win over any other marker
    assert detect_format({"openapi": "3.0.3", "paths": {}}) == "openapi3"
    assert detect_format({"swagger": "2.0", "paths": {}}) == "swagger2"


def test_detects_postman_v2_0_as_well_as_v2_1():
    """Both minor versions share the collection/v2 schema prefix."""
    for minor in ("2.0.0", "2.1.0"):
        doc = {"info": {"name": "x",
                        "schema": f"https://schema.getpostman.com/json/collection/v{minor}/collection.json"},
               "item": []}
        assert detect_format(doc) == "postman2"


def test_unknown_document_is_not_detected():
    assert detect_format({"hello": "world"}) is None
    assert detect_format([1, 2, 3]) is None
    assert detect_format("nope") is None


def test_unsupported_upload_422_names_the_supported_formats(client, register_org,
                                                            create_project):
    """The actionable-error requirement: a rejected upload must say what WOULD work."""
    headers = register_org()
    pid = create_project(headers)
    r = client.post(f"/v1/projects/{pid}/api-specs",
                    files={"file": ("thing.json", b'{"hello": "world"}', "application/json")},
                    headers=headers)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_spec"
    joined = " ".join(detail["errors"])
    for expected in ("OpenAPI 3.x", "Swagger 2.0", "Postman Collection v2.0/v2.1",
                     "HAR 1.2", "Insomnia v4"):
        assert expected in joined, f"422 does not mention {expected}: {joined}"


# ------------------------------------------------- 2. Postman conversion (the fixture)

def test_fixture_converts_to_37_endpoints_with_expected_method_mix():
    ops, warnings, title, source = convert(postman_collection(), "postman2")
    assert warnings == [], f"the real collection must convert cleanly: {warnings}"
    assert source == "postman"
    assert "Calendar API" in title
    assert len(ops) == 37
    by_method = {}
    for op in ops:
        by_method[op["method"]] = by_method.get(op["method"], 0) + 1
    assert by_method == {"POST": 14, "GET": 11, "DELETE": 4, "PATCH": 4, "PUT": 4}
    # method+path is unique — dedupe happened and lost nothing
    assert len({(op["method"], op["path"]) for op in ops}) == 37


def test_fixture_templates_colon_params_and_strips_the_base_url_variable():
    ops, *_ = convert(postman_collection(), "postman2")
    paths = {op["path"] for op in ops}
    assert "/calendars/{calendarId}/acl/{ruleId}" in paths
    assert "/calendars/{calendarId}/events/{eventId}" in paths
    assert "/calendars/{calendarId}/events/{eventId}/instances" in paths
    assert "/users/{userId}/calendarList" in paths
    assert "/users/me/settings/{setting}" in paths
    # ":param" never survives, and {{baseUrl}} (https://www.googleapis.com/calendar/v3)
    # is stripped so paths are server-relative like the OpenAPI importer's
    assert not any(":" in p for p in paths)
    assert all(p.startswith("/") for p in paths)
    assert not any("googleapis" in p or "calendar/v3" in p for p in paths)


def test_fixture_path_parameters_are_declared_required_with_examples():
    ops, *_ = convert(postman_collection(), "postman2")
    op = next(o for o in ops if o["method"] == "DELETE"
              and o["path"] == "/calendars/{calendarId}/acl/{ruleId}")
    path_params = [p for p in op["parameters"] if p["location"] == "path"]
    assert [p["name"] for p in path_params] == ["calendarId", "ruleId"]
    assert all(p["required"] for p in path_params)
    # url.variable examples are carried through (keys arrive as "{{calendarId}}")
    assert all(p["constraints"].get("example") for p in path_params)


def test_fixture_captures_all_35_query_parameters():
    ops, *_ = convert(postman_collection(), "postman2")
    names = {p["name"] for o in ops for p in o["parameters"] if p["location"] == "query"}
    assert len(names) == 35, sorted(names)
    assert {"alt", "maxResults", "timeMin", "timeMax", "syncToken",
            # these three appear ONLY as Postman-disabled (= optional) params
            "colorRgbFormat", "minAccessRole", "showHidden"} <= names
    # query values become typed examples, never path or header params
    pretty = next(p for o in ops for p in o["parameters"] if p["name"] == "prettyPrint")
    assert pretty["location"] == "query" and pretty["type"] == "boolean"


def test_fixture_infers_body_schemas_from_raw_json_examples():
    ops, *_ = convert(postman_collection(), "postman2")
    with_body = [o for o in ops if o["request_schema"]]
    assert len(with_body) == 19, "the collection has 19 raw JSON bodies"
    patch_calendar = next(o for o in ops if o["method"] == "PATCH"
                          and o["path"] == "/calendars/{calendarId}")
    schema = patch_calendar["request_schema"]
    assert schema["type"] == "object"
    props = schema["properties"]
    # types come from the example values; nested objects and arrays recurse
    assert props["summary"] == {"type": "string"}
    assert props["conferenceProperties"]["properties"][
        "allowedConferenceSolutionTypes"] == {"type": "array", "items": {"type": "string"}}
    # nothing is invented: only keys present in the example body appear
    assert set(props) == {"conferenceProperties", "description", "etag", "id", "kind",
                          "location", "summary", "timeZone"}
    assert "required" not in schema


def test_fixture_records_saved_response_status_codes():
    ops, *_ = convert(postman_collection(), "postman2")
    codes = {}
    for op in ops:
        for status in op["response_schemas"]:
            codes[status] = codes.get(status, 0) + 1
    assert codes == {"200": 31, "204": 6}
    delete_rule = next(o for o in ops if o["method"] == "DELETE"
                       and o["path"] == "/calendars/{calendarId}/acl/{ruleId}")
    assert list(delete_rule["response_schemas"]) == ["204"]


def test_fixture_folders_become_tags_and_names_become_summaries():
    ops, *_ = convert(postman_collection(), "postman2")
    op = next(o for o in ops if o["method"] == "PATCH"
              and o["path"] == "/calendars/{calendarId}/acl/{ruleId}")
    assert op["summary"] == "Patch Access Control Rule"
    assert op["operation_id"] == "patch_access_control_rule"
    assert op["tags"][0] == "calendars"


def test_conversion_is_deterministic():
    """Same bytes in, same inventory out — this is the grounding source of truth."""
    first, _, _, _ = convert(postman_collection(), "postman2")
    second, _, _, _ = convert(postman_collection(), "postman2")
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_duplicate_requests_merge_instead_of_duplicating():
    doc = {"info": {"name": "dup",
                    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
           "item": [
               {"name": "A", "request": {"method": "GET", "url": {
                   "path": ["things"], "query": [{"key": "a", "value": "1"}]}}},
               {"name": "B", "request": {"method": "GET", "url": {
                   "path": ["things"], "query": [{"key": "b", "value": "2"}]}}},
           ]}
    ops, *_ = convert(doc, "postman2")
    assert len(ops) == 1
    assert {p["name"] for p in ops[0]["parameters"]} == {"a", "b"}
    assert ops[0]["summary"] == "A"  # first request wins the prose


def test_string_form_urls_and_unresolved_base_url_variables():
    """Older exports write url as a bare string, and often ship without the
    environment that defines {{baseUrl}} — the paths must still be right."""
    doc = {"info": {"name": "strings",
                    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
           "item": [
               {"name": "One", "request": {
                   "method": "GET", "url": "{{baseUrl}}/things/:thingId?page=2"}},
               {"name": "Two", "request": {
                   "method": "GET", "url": "https://api.example.com/v1/things"}},
           ]}
    ops, *_ = convert(doc, "postman2")
    by_path = {o["path"]: o for o in ops}
    assert set(by_path) == {"/things/{thingId}", "/v1/things"}
    page = next(p for p in by_path["/things/{thingId}"]["parameters"]
                if p["location"] == "query")
    assert page["name"] == "page" and page["type"] == "integer"


def test_non_json_bodies_record_media_type_and_field_names_only():
    doc = {"info": {"name": "forms",
                    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
           "item": [{"name": "Upload", "request": {
               "method": "POST", "url": {"path": ["upload"]},
               "body": {"mode": "formdata", "formdata": [
                   {"key": "file", "type": "file"}, {"key": "caption", "type": "text"}]}}}]}
    ops, *_ = convert(doc, "postman2")
    schema = ops[0]["request_schema"]
    assert schema["x-media-type"] == "multipart/form-data"
    assert set(schema["properties"]) == {"file", "caption"}
    assert schema["properties"]["file"]["format"] == "binary"


# --------------------------------------------------------------- 3. HAR conversion

def test_har_templates_concrete_ids_and_counts_observations():
    ops, warnings, title, source = convert(har_document(), "har")
    assert warnings == [] and source == "traffic" and title == "Chrome DevTools"
    paths = {(o["method"], o["path"]) for o in ops}
    # /orders/12345 and /orders/67890 collapse onto one templated route
    assert ("GET", "/v1/orders/{id}") in paths
    # a UUID is an id too, and the second id in one path is numbered
    assert ("DELETE", "/v1/orders/{id}/items/{id2}") in paths
    assert ("POST", "/v1/orders") in paths
    assert len(ops) == 3

    orders = next(o for o in ops if o["method"] == "GET")
    assert orders["observed_count"] == 2, "traffic capture counts observations (FR-021 AC-3)"
    assert set(orders["response_schemas"]) == {"200", "404"}
    assert orders["response_schemas"]["200"]["properties"]["paid"] == {"type": "boolean"}
    assert {p["name"] for p in orders["parameters"] if p["location"] == "query"} == {"expand"}
    # headers are captured as header params — never as query params — and
    # transport headers (Accept) are dropped as noise
    assert {p["name"] for p in orders["parameters"] if p["location"] == "header"} == {"X-Tenant"}

    create = next(o for o in ops if o["method"] == "POST")
    assert create["request_schema"]["properties"]["qty"] == {"type": "integer"}
    assert create["request_schema"]["properties"]["tags"] == {"type": "array",
                                                             "items": {"type": "string"}}


# ---------------------------------------------------------- 4. Insomnia conversion

def test_insomnia_resolves_environment_vars_folders_and_ids():
    ops, warnings, title, source = convert(insomnia_export(), "insomnia4")
    assert warnings == [] and source == "postman" and title == "Billing"
    by_key = {(o["method"], o["path"]): o for o in ops}
    assert set(by_key) == {("GET", "/invoices/{invoiceId}"), ("POST", "/invoices/{id}/pay")}
    get_invoice = by_key[("GET", "/invoices/{invoiceId}")]
    assert get_invoice["tags"] == ["Invoices"]
    assert {p["name"] for p in get_invoice["parameters"] if p["location"] == "query"} == {"include"}
    assert {p["name"] for p in get_invoice["parameters"] if p["location"] == "header"} == {"Authorization"}
    # A credential header is captured by NAME only: that the endpoint needs
    # authorisation is part of the API surface, the live token never is.
    authorization = next(p for p in get_invoice["parameters"] if p["name"] == "Authorization")
    assert authorization["constraints"] == {}, "a credential header VALUE was recorded"
    pay = by_key[("POST", "/invoices/{id}/pay")]
    assert pay["request_schema"]["properties"]["amount"] == {"type": "number"}


# ------------------------------------------------------------- 5. schema inference

@pytest.mark.parametrize("value,expected", [
    ("x", {"type": "string"}),
    (3, {"type": "integer"}),
    (3.5, {"type": "number"}),
    (True, {"type": "boolean"}),
    (None, {"type": "null"}),
    ([], {"type": "array", "items": {}}),
    ([1, 2], {"type": "array", "items": {"type": "integer"}}),
    ([1, 2.5], {"type": "array", "items": {"type": "number"}}),
    ([1, "a"], {"type": "array", "items": {}}),
])
def test_infer_json_schema_types_come_from_values(value, expected):
    assert infer_json_schema(value) == expected


def test_merge_schema_unions_object_properties():
    a = {"type": "object", "properties": {"a": {"type": "string"}}}
    b = {"type": "object", "properties": {"b": {"type": "integer"}}}
    assert merge_schema(a, b) == {"type": "object", "properties": {
        "a": {"type": "string"}, "b": {"type": "integer"}}}
    assert merge_schema({"type": "string"}, {"type": "null"}) == {"type": "string"}


# ------------------------------------------------------------------- 6. import route

def upload_collection(client, headers, pid, doc, filename="collection.json"):
    r = client.post(f"/v1/projects/{pid}/api-specs",
                    files={"file": (filename, json.dumps(doc).encode("utf-8"),
                                    "application/json")},
                    headers=headers)
    assert r.status_code in (200, 201), f"collection import failed: {r.status_code} {r.text}"
    return r.json()


def test_import_route_accepts_the_real_postman_collection(client, register_org,
                                                          create_project):
    headers = register_org()
    pid = create_project(headers, automation="manual")  # no enrichment on this path
    result = upload_collection(client, headers, pid, postman_collection())

    assert result["format"] == "postman2"
    assert result["endpoints_count"] == 37
    assert result["added"] == 37 and result["updated"] == 0 and result["removed"] == 0
    assert result["total"] == 37
    assert result["enriched"] == 0 and result["enrichment_discarded"] == 0
    # the pre-existing keys keep their names and meanings
    assert result["spec_id"] and result["version"] == 1
    assert result["warnings"] == [] and len(result["diff"]["added"]) == 37

    rows = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    assert len(rows) == 37
    assert {row["source"] for row in rows} == {"postman"}
    # the enrichment columns exist on the payload and are null without enrichment
    assert all(row["ai_description"] is None and row["ai_group"] is None
               and row["ai_criticality"] is None for row in rows)


def test_import_route_accepts_har_and_insomnia(client, register_org, create_project):
    headers = register_org()
    har_pid = create_project(headers, name="HAR", automation="manual")
    har = upload_collection(client, headers, har_pid, har_document(), "capture.har")
    assert har["format"] == "har" and har["endpoints_count"] == 3
    rows = items_of(client.get(f"/v1/projects/{har_pid}/endpoints", headers=headers).json())
    assert {r["source"] for r in rows} == {"traffic"}

    ins_pid = create_project(headers, name="Insomnia", automation="manual")
    ins = upload_collection(client, headers, ins_pid, insomnia_export(), "insomnia.json")
    assert ins["format"] == "insomnia4" and ins["endpoints_count"] == 2
    rows = items_of(client.get(f"/v1/projects/{ins_pid}/endpoints", headers=headers).json())
    assert {r["source"] for r in rows} == {"postman"}


def test_openapi_import_is_unchanged(client, register_org, create_project):
    """Regression guard: the OpenAPI path must behave exactly as before, with the
    new response keys layered on top."""
    headers = register_org()
    pid = create_project(headers, automation="manual")
    result = import_spec(client, headers, pid)
    assert result["format"] == "openapi3"
    assert result["endpoints_count"] == 2
    assert result["enriched"] == 0, "enrichment never runs on a spec import"
    rows = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    assert {r["source"] for r in rows} == {"spec"}


# --------------------------------------------------------- 7. fidelity precedence

OVERLAP_SPEC = {
    "openapi": "3.0.3",
    "info": {"title": "Calendar (authoritative)", "version": "1.0.0"},
    "paths": {
        "/calendars/{calendarId}": {
            "get": {"operationId": "getCalendarAuthoritative",
                    "summary": "Authoritative calendar read",
                    "parameters": [{"name": "calendarId", "in": "path", "required": True,
                                    "schema": {"type": "string"}}],
                    "responses": {"200": {"description": "OK"}}},
        },
        "/health": {"get": {"operationId": "health", "summary": "Health probe",
                            "responses": {"200": {"description": "OK"}}}},
    },
}


def test_spec_import_wins_over_collection_data_and_deletes_nothing(
        client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers, automation="manual")
    upload_collection(client, headers, pid, postman_collection())

    result = import_spec(client, headers, pid, OVERLAP_SPEC)
    assert result["format"] == "openapi3"
    # one overlapping route was upgraded, one new route added, NOTHING removed
    assert result["updated"] == 1 and result["added"] == 1
    assert result["removed"] == 0 and result["diff"]["removed"] == []
    assert result["total"] == 38, "36 collection routes survive + 2 spec routes"

    rows = {(r["method"], r["path"]): r for r in items_of(
        client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())}
    assert len(rows) == 38
    overlap = rows[("GET", "/calendars/{calendarId}")]
    assert overlap["source"] == "spec", "spec outranks postman on the same route"
    assert overlap["operation_id"] == "getCalendarAuthoritative"
    assert overlap["summary"] == "Authoritative calendar read"
    # every non-overlapping collection endpoint is still there, untouched
    assert rows[("DELETE", "/calendars/{calendarId}/acl/{ruleId}")]["source"] == "postman"
    assert sum(1 for r in rows.values() if r["source"] == "postman") == 36


def test_collection_import_never_downgrades_a_spec_endpoint(client, register_org,
                                                            create_project):
    headers = register_org()
    pid = create_project(headers, automation="manual")
    import_spec(client, headers, pid, OVERLAP_SPEC)

    result = upload_collection(client, headers, pid, postman_collection())
    assert result["endpoints_count"] == 37
    assert result["updated"] == 0, "the overlapping route belongs to the spec"
    assert result["added"] == 36 and result["removed"] == 0
    assert result["total"] == 38

    rows = {(r["method"], r["path"]): r for r in items_of(
        client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())}
    overlap = rows[("GET", "/calendars/{calendarId}")]
    assert overlap["source"] == "spec"
    assert overlap["operation_id"] == "getCalendarAuthoritative"
    assert rows[("GET", "/health")]["source"] == "spec"


def test_reimporting_the_same_collection_replaces_its_own_rows(client, register_org,
                                                               create_project):
    headers = register_org()
    pid = create_project(headers, automation="manual")
    upload_collection(client, headers, pid, postman_collection())

    trimmed = postman_collection()
    trimmed["item"] = trimmed["item"][:1]
    result = upload_collection(client, headers, pid, trimmed)
    assert result["removed"] > 0, "a re-import of the SAME mode replaces its inventory"
    assert result["total"] == result["endpoints_count"]


# --------------------------------------------------------------- 8. AI enrichment

class StubProvider:
    """Records what it was asked and returns whatever the test dictates."""

    name = "stub"

    def __init__(self, payload, raises=False):
        self.payload = payload
        self.raises = raises
        self.prompts = []

    def complete_json(self, prompt_id, prompt, schema):
        self.prompts.append((prompt_id, prompt))
        if self.raises:
            raise RuntimeError("model unavailable")
        return LLMResult(data=self.payload, model="stub", prompt_version="test")


@pytest.fixture()
def stub_provider(monkeypatch):
    def _install(payload, raises=False):
        provider = StubProvider(payload, raises=raises)
        monkeypatch.setattr(enrichment, "get_provider", lambda: provider)
        return provider
    return _install


def test_mock_provider_enriches_the_whole_collection_offline(client, register_org,
                                                             create_project):
    """NFR-D1: the deterministic mock keeps the flow hermetic — no network, no key."""
    headers = register_org()
    pid = create_project(headers, automation="auto")
    result = upload_collection(client, headers, pid, postman_collection())

    assert result["enriched"] == 37
    assert result["enrichment_discarded"] == 0

    rows = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    assert len(rows) == 37
    assert all(r["ai_description"] and r["ai_group"] for r in rows)
    assert {r["ai_criticality"] for r in rows} <= {"high", "medium", "low"}
    acl = next(r for r in rows if r["method"] == "DELETE"
               and r["path"] == "/calendars/{calendarId}/acl/{ruleId}")
    assert acl["ai_description"] == (
        "Delete the acl resource via DELETE /calendars/{calendarId}/acl/{ruleId}.")
    assert acl["ai_group"] == "calendars"
    assert acl["ai_criticality"] == "high"


def test_enrichment_is_not_run_when_automation_is_manual(client, register_org,
                                                         create_project):
    headers = register_org()
    pid = create_project(headers, automation="manual")
    result = upload_collection(client, headers, pid, postman_collection())
    assert result["enriched"] == 0 and result["enrichment_discarded"] == 0


def test_the_model_never_sees_the_uploaded_file(client, register_org, create_project,
                                                stub_provider):
    """Only the derived inventory is sent — never raw file text (values could be
    customer data, and raw text is an injection surface)."""
    provider = stub_provider({"endpoints": []})
    headers = register_org()
    pid = create_project(headers, automation="auto")
    upload_collection(client, headers, pid, postman_collection())

    assert provider.prompts, "enrichment must have called the provider"
    for prompt_id, prompt in provider.prompts:
        assert prompt_id == "enrich_endpoints"
        assert "googleapis.com" not in prompt, "the raw collection leaked into the prompt"
        assert "_postman_id" not in prompt
        assert "amet in" not in prompt, "example values are not part of the payload"
        assert "/calendars/{calendarId}/acl/{ruleId}" in prompt


ADVERSARIAL = [
    # 1. an endpoint that simply does not exist
    {"method": "GET", "path": "/totally/made/up", "description": "Ghost route",
     "group": "ghosts", "criticality": "high"},
    # 2. a real path with a method the collection never declares
    {"method": "TRACE", "path": "/colors", "description": "Trace colors",
     "group": "colors", "criticality": "low"},
    # 3. a RENAMED path parameter ({calendarId} -> {calId})
    {"method": "GET", "path": "/calendars/{calId}", "description": "Renamed param",
     "group": "calendars", "criticality": "high"},
    # 4. an illegal criticality
    {"method": "GET", "path": "/colors", "description": "Bad criticality",
     "group": "colors", "criticality": "critical"},
    # 5. an empty description
    {"method": "GET", "path": "/freeBusy", "description": "   ",
     "group": "freebusy", "criticality": "low"},
    # 6. not even an object
    "DROP TABLE endpoints",
    # 7. the one legitimate annotation
    {"method": "GET", "path": "/colors", "description": "Lists calendar colors.",
     "group": "colors", "criticality": "low"},
    # 8. a duplicate of the legitimate one — must not overwrite the verified answer
    {"method": "GET", "path": "/colors", "description": "Second opinion.",
     "group": "other", "criticality": "high"},
]


def test_adversarial_enrichment_is_discarded_counted_and_changes_nothing(
        client, register_org, create_project, stub_provider):
    headers = register_org()
    pid = create_project(headers, automation="manual")

    # baseline: the deterministic import, with enrichment switched off
    upload_collection(client, headers, pid, postman_collection())
    baseline = items_of(client.get(f"/v1/projects/{pid}/endpoints",
                                   headers=headers).json())
    baseline_inventory = sorted(
        (r["method"], r["path"], json.dumps(r["parameters"], sort_keys=True),
         json.dumps(r["request_schema"], sort_keys=True), r["source"])
        for r in baseline)

    # now re-import with automation=auto and a hostile provider
    assert client.patch(f"/v1/projects/{pid}", json={"automation": "auto"},
                        headers=headers).status_code == 200
    stub_provider({"endpoints": copy.deepcopy(ADVERSARIAL)})
    result = upload_collection(client, headers, pid, postman_collection())

    assert result["enriched"] == 1, "only the one verifiable annotation survives"
    assert result["enrichment_discarded"] == 7, "every other item is discarded and counted"

    rows = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    # NOTHING was created, renamed or deleted by the model
    assert len(rows) == 37
    after_inventory = sorted(
        (r["method"], r["path"], json.dumps(r["parameters"], sort_keys=True),
         json.dumps(r["request_schema"], sort_keys=True), r["source"])
        for r in rows)
    assert after_inventory == baseline_inventory
    paths = {r["path"] for r in rows}
    assert "/totally/made/up" not in paths
    assert "/calendars/{calId}" not in paths
    assert "TRACE" not in {r["method"] for r in rows}

    # the single verified annotation landed, and only on its own row
    colors = next(r for r in rows if r["method"] == "GET" and r["path"] == "/colors")
    assert colors["ai_description"] == "Lists calendar colors."
    assert colors["ai_group"] == "colors" and colors["ai_criticality"] == "low"
    assert sum(1 for r in rows if r["ai_description"]) == 1


def test_validate_enrichment_gate_in_isolation():
    operations = [{"method": "GET", "path": "/a"}, {"method": "POST", "path": "/b"}]
    accepted, discarded = enrichment.validate_enrichment(
        copy.deepcopy(ADVERSARIAL) + [
            {"method": "get", "path": "/a", "description": "Reads A.",
             "group": "a", "criticality": "HIGH"}],
        operations)
    # case is normalised on method and criticality; everything else is unknown here
    assert list(accepted) == [("GET", "/a")]
    assert accepted[("GET", "/a")]["ai_criticality"] == "high"
    assert discarded == len(ADVERSARIAL)
    # the gate cannot be handed a non-list either
    assert enrichment.validate_enrichment("nope", operations) == ({}, 0)


def test_gate_discards_items_that_reference_names_the_inventory_never_produced():
    """An annotation that echoes back a parameter or body field we never extracted
    has stopped describing our endpoint and started inventing one, so the whole
    item is discarded — matching the Go gate exactly."""
    operations = [{
        "method": "GET", "path": "/customers/{id}",
        "parameters": [{"name": "id", "location": "path"}],
        "request_schema": {"type": "object", "properties": {"name": {"type": "string"}}},
    }]
    good = {"method": "GET", "path": "/customers/{id}", "description": "Read one.",
            "group": "customers", "criticality": "low"}

    # the same item is accepted when it only mentions names we really extracted
    accepted, discarded = enrichment.validate_enrichment(
        [{**good, "params": ["id"], "body_fields": ["name"]}], operations)
    assert list(accepted) == [("GET", "/customers/{id}")] and discarded == 0

    for leak in ({"params": ["id", "ssn"]},
                 {"body_fields": ["name", "credit_card"]},
                 {"parameters": [{"name": "api_key"}]},
                 {"fields": ["password"]}):
        accepted, discarded = enrichment.validate_enrichment([{**good, **leak}], operations)
        assert accepted == {} and discarded == 1, f"{leak} slipped through the gate"

    # an incomplete item is unverified, not partially usable
    for broken in ({"criticality": "nuclear"}, {"description": "   "}):
        accepted, discarded = enrichment.validate_enrichment([{**good, **broken}], operations)
        assert accepted == {} and discarded == 1, f"{broken} slipped through the gate"


def test_import_still_succeeds_when_the_model_fails(client, register_org,
                                                    create_project, stub_provider):
    """An import is deterministic work. The model failing costs annotations only."""
    stub_provider(None, raises=True)
    headers = register_org()
    pid = create_project(headers, automation="auto")
    result = upload_collection(client, headers, pid, postman_collection())

    assert result["endpoints_count"] == 37 and result["total"] == 37
    assert result["enriched"] == 0 and result["enrichment_discarded"] == 0
    rows = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    assert len(rows) == 37
    assert all(r["ai_description"] is None for r in rows)


def test_import_still_succeeds_when_the_model_returns_junk(client, register_org,
                                                           create_project, stub_provider):
    stub_provider({"endpoints": "not a list"})
    headers = register_org()
    pid = create_project(headers, automation="auto")
    result = upload_collection(client, headers, pid, postman_collection())
    assert result["endpoints_count"] == 37 and result["enriched"] == 0


def test_annotations_survive_a_re_import(client, register_org, create_project):
    """ai_* is carried across a re-import exactly like the `excluded` flag."""
    headers = register_org()
    pid = create_project(headers, automation="auto")
    upload_collection(client, headers, pid, postman_collection())

    assert client.patch(f"/v1/projects/{pid}", json={"automation": "manual"},
                        headers=headers).status_code == 200
    upload_collection(client, headers, pid, postman_collection())
    rows = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    assert all(r["ai_description"] for r in rows), "annotations must not be lost"
