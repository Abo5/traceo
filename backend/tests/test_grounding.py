"""RELEASE GATE — grounding (FR-GEN-06, BR-09, BO-07).

The grounding validator is the hard gate between the generator and persistence:
a single fabricated endpoint, method, parameter, body field or missing
requirement link must yield violations so the case is DISCARDED — never
repaired, never shown.

Part 1: adversarial unit tests against `generation.grounding_validate` directly.
Part 2: end-to-end — everything the pipeline persists must be grounded in the
        imported endpoint inventory.
"""
import copy

from conftest import (add_requirement, confirm_requirement, import_spec,
                      items_of, poll_job)

from app.modules.generation import grounding_validate


# ---------------------------------------------------------------------------
# Unit fixtures — an inventory of two endpoints, keyed by (METHOD, path)
# ---------------------------------------------------------------------------

def make_inventory():
    post_customers = {
        "id": "ep-post-customers",
        "method": "POST",
        "path": "/customers",
        "parameters": [],
        "request_schema": {
            "type": "object",
            "required": ["name", "phone", "age"],
            "properties": {
                "name": {"type": "string", "minLength": 1, "maxLength": 100},
                "phone": {"type": "string", "pattern": "^05[0-9]{8}$"},
                "email": {"type": "string", "format": "email"},
                "age": {"type": "integer", "minimum": 18, "maximum": 120},
            },
        },
        "response_schemas": {
            "201": {"type": "object", "properties": {
                "id": {"type": "string"}, "name": {"type": "string"}}},
        },
        "security": [{"bearerAuth": []}],
        "tags": [],
    }
    get_customer = {
        "id": "ep-get-customer",
        "method": "GET",
        "path": "/customers/{id}",
        "parameters": [{"name": "id", "location": "path", "type": "string",
                        "required": True, "constraints": {}}],
        "request_schema": None,
        "response_schemas": {
            "200": {"type": "object", "properties": {
                "id": {"type": "string"}, "name": {"type": "string"},
                "phone": {"type": "string"}}},
        },
        "security": [{"bearerAuth": []}],
        "tags": [],
    }
    return {("POST", "/customers"): post_customers,
            ("GET", "/customers/{id}"): get_customer}


def make_grounded_case():
    return {
        "title": "Positive: valid request — POST /customers",
        "requirement_ids": ["req-1"],
        "steps": [{
            "order": 0,
            "method": "POST",
            "path": "/customers",
            "request": {
                "headers": {"Content-Type": "application/json",
                            "Authorization": "Bearer {{token}}"},
                "params": {},
                "body": {"name": "سارة القحطاني", "phone": "0512345678",
                         "email": "sara@example.sa", "age": 30},
            },
            "assertions": [{"type": "status_code", "expected": 201}],
            "extractions": [],
        }],
    }


# ---------------------------------------------------------------------------
# Unit tests — adversarial fixtures
# ---------------------------------------------------------------------------

def test_grounded_case_has_no_violations():
    assert grounding_validate(make_grounded_case(), make_inventory()) == []


def test_fabricated_path_yields_violation():
    case = make_grounded_case()
    case["steps"][0]["path"] = "/ghost-endpoint"
    violations = grounding_validate(case, make_inventory())
    assert violations
    assert any("does not exist" in v for v in violations)


def test_fabricated_method_yields_violation():
    case = make_grounded_case()
    case["steps"][0]["method"] = "DELETE"  # only POST /customers exists
    violations = grounding_validate(case, make_inventory())
    assert violations
    assert any("does not exist" in v for v in violations)


def test_fabricated_query_param_yields_violation():
    case = make_grounded_case()
    case["steps"][0] = {
        "order": 0, "method": "GET", "path": "/customers/{id}",
        "request": {"headers": {"Authorization": "Bearer {{token}}"},
                    "params": {"id": "CUST-001", "sort": "asc"}},  # 'sort' fabricated
        "assertions": [{"type": "status_code", "expected": 200}],
        "extractions": [],
    }
    violations = grounding_validate(case, make_inventory())
    assert violations
    assert any("'sort'" in v and "not defined" in v for v in violations)


def test_fabricated_body_field_yields_violation():
    case = make_grounded_case()
    case["steps"][0]["request"]["body"]["nickname"] = "أبو فهد"  # not in schema
    violations = grounding_validate(case, make_inventory())
    assert violations
    assert any("'nickname'" in v and "does not exist" in v for v in violations)


def test_missing_requirement_link_yields_violation():
    case = make_grounded_case()
    case["requirement_ids"] = []
    violations = grounding_validate(case, make_inventory())
    assert violations
    assert any("requirement" in v for v in violations)


def test_fabricated_json_field_assertion_target_yields_violation():
    case = make_grounded_case()
    case["steps"][0]["assertions"].append(
        {"type": "json_field", "path": "balance.total", "op": "exists"})  # not in 201 schema
    violations = grounding_validate(case, make_inventory())
    assert violations
    assert any("json_field" in v for v in violations)


def test_violations_are_independent_per_step():
    """A grounded step plus a fabricated one — only the fabricated step trips."""
    case = make_grounded_case()
    bad_step = copy.deepcopy(case["steps"][0])
    bad_step["path"] = "/refunds"
    case["steps"].append(bad_step)
    violations = grounding_validate(case, make_inventory())
    assert len(violations) == 1
    assert "step 1" in violations[0]


# ---------------------------------------------------------------------------
# End-to-end — everything persisted by the pipeline is grounded
# ---------------------------------------------------------------------------

def _steps_of(detail: dict) -> list:
    if isinstance(detail.get("steps"), list):
        return detail["steps"]
    tc = detail.get("test_case")
    if isinstance(tc, dict) and isinstance(tc.get("steps"), list):
        return tc["steps"]
    return []


def _assert_body_grounded(body: dict, schema: dict, ctx: str):
    props = schema.get("properties") or {}
    for key, val in body.items():
        assert key in props, f"{ctx}: body field '{key}' not in the endpoint schema"
        sub = props[key]
        if (isinstance(val, dict) and isinstance(sub, dict)
                and isinstance(sub.get("properties"), dict)):
            _assert_body_grounded(val, sub, f"{ctx}.{key}")


def test_generated_cases_are_grounded_in_imported_inventory(
        client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers)

    import_spec(client, headers, pid)  # POST /customers + GET /customers/{id}
    rid = add_requirement(
        client, headers, pid, "REQ-100",
        "Create a customer via POST /customers with a valid phone number and age",
        criteria=["phone must match the pattern 05XXXXXXXX (10 digits)",
                  "age must be between 18 and 120",
                  "invalid customer input returns 422"])
    confirm_requirement(client, headers, rid)

    r = client.post(f"/v1/projects/{pid}/generate",
                    json={"depth": "standard"}, headers=headers)
    assert r.status_code in (200, 202), f"generate failed: {r.status_code} {r.text}"
    job = poll_job(client, headers, r.json()["job_id"])
    result = job.get("result") or {}
    assert result.get("generated", 0) > 0, f"nothing generated: {result}"

    # Ground truth: the imported endpoint inventory
    r = client.get(f"/v1/projects/{pid}/endpoints", headers=headers)
    assert r.status_code == 200
    inventory = {(e["method"].upper(), e["path"]): e for e in items_of(r.json())}
    assert inventory, "endpoint inventory is empty"

    r = client.get(f"/v1/projects/{pid}/test-cases", headers=headers)
    assert r.status_code == 200
    cases = items_of(r.json())
    assert cases, "no persisted test cases returned"

    for case in cases:
        r = client.get(f"/v1/test-cases/{case['id']}", headers=headers)
        assert r.status_code == 200, f"detail failed: {r.status_code} {r.text}"
        steps = _steps_of(r.json())
        assert steps, f"case {case['id']} has no steps"
        for step in steps:
            key = (str(step["method"]).upper(), step["path"])
            assert key in inventory, f"fabricated endpoint persisted: {key}"
            ep = inventory[key]
            request = step.get("request") or {}

            param_names = {p["name"] for p in (ep.get("parameters") or [])
                           if isinstance(p, dict) and p.get("name")}
            for pname in (request.get("params") or {}):
                assert pname in param_names, \
                    f"fabricated parameter '{pname}' persisted on {key}"

            body = request.get("body")
            schema = ep.get("request_schema") or {}
            if isinstance(body, dict) and isinstance(schema.get("properties"), dict):
                _assert_body_grounded(body, schema, f"{key}")
