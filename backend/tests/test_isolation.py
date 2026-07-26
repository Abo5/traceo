"""RELEASE GATE — multi-tenant isolation (org isolation, API_CONTRACT).

Two organisations A and B. A builds a full world (project, requirement, spec,
manual test case); B must see NOTHING of it: project-scoped reads return 404,
object reads return 404, and B's own listings stay empty.
"""
import pytest

from conftest import add_requirement, import_spec, items_of

PROJECT_SCOPED_GETS = [
    "/v1/projects/{pid}",
    "/v1/projects/{pid}/requirements",
    "/v1/projects/{pid}/documents",
    "/v1/projects/{pid}/endpoints",
    "/v1/projects/{pid}/test-cases",
    "/v1/projects/{pid}/traceability",
    "/v1/projects/{pid}/runs",
    "/v1/projects/{pid}/environments",
    "/v1/projects/{pid}/dashboard",
    "/v1/projects/{pid}/exports/matrix.xlsx",
]


def _setup_world(client, register_org, create_project, with_test_case=False):
    """Org A with a project, one confirmed requirement and an imported spec.
    Returns (headers_a, headers_b, project_id, requirement_id, test_case_id|None)."""
    a = register_org("Org A")
    b = register_org("Org B")
    pid = create_project(a, name="مشروع المنظمة أ")
    rid = add_requirement(
        client, a, pid, "REQ-ISO-1",
        "Create a customer via POST /customers with valid phone and age")
    import_spec(client, a, pid)

    tcid = None
    if with_test_case:
        r = client.post(f"/v1/projects/{pid}/test-cases", json={
            "title": "Manual: create customer with valid data",
            "description": "Manually authored case for isolation testing",
            "preconditions": "Authenticated session",
            "type": "positive",
            "priority": "high",
            "requirement_ids": [rid],
            "steps": [{
                "order": 0, "method": "POST", "path": "/customers",
                "request": {
                    "headers": {"Content-Type": "application/json"},
                    "params": {},
                    "body": {"name": "أحمد", "phone": "0512345678", "age": 30},
                },
                "assertions": [{"type": "status_code", "expected": 201}],
                "extractions": [],
            }],
        }, headers=a)
        assert r.status_code in (200, 201), \
            f"manual test case creation failed: {r.status_code} {r.text}"
        data = r.json()
        tcid = data.get("id") or (data.get("test_case") or {}).get("id")
        assert tcid, f"no test case id in response: {data}"
    return a, b, pid, rid, tcid


@pytest.mark.parametrize("template", PROJECT_SCOPED_GETS)
def test_project_scoped_reads_are_404_across_orgs(
        client, register_org, create_project, template):
    a, b, pid, _rid, _ = _setup_world(client, register_org, create_project)
    url = template.format(pid=pid)

    # sanity: the owner org CAN read it
    r_owner = client.get(url, headers=a)
    assert r_owner.status_code == 200, \
        f"owner should access {url}: {r_owner.status_code} {r_owner.text[:300]}"

    # the other org gets 404 — never a leak, never a 403 oracle with data
    r = client.get(url, headers=b)
    assert r.status_code == 404, \
        f"cross-org read of {url} must 404, got {r.status_code}: {r.text[:300]}"


def test_cross_org_test_case_detail_is_404(client, register_org, create_project):
    a, b, _pid, _rid, tcid = _setup_world(
        client, register_org, create_project, with_test_case=True)

    assert client.get(f"/v1/test-cases/{tcid}", headers=a).status_code == 200
    assert client.get(f"/v1/test-cases/{tcid}", headers=b).status_code == 404
    # mutations are blocked with the same 404 (no existence oracle)
    assert client.post(f"/v1/test-cases/{tcid}/approve", headers=b).status_code == 404


def test_cross_org_requirement_access_is_404(client, register_org, create_project):
    a, b, _pid, rid, _ = _setup_world(client, register_org, create_project)

    assert client.patch(f"/v1/requirements/{rid}",
                        json={"priority": "low"}, headers=a).status_code == 200
    assert client.patch(f"/v1/requirements/{rid}",
                        json={"priority": "low"}, headers=b).status_code == 404
    assert client.delete(f"/v1/requirements/{rid}", headers=b).status_code == 404


def test_org_b_listings_do_not_leak_org_a_objects(
        client, register_org, create_project):
    a, b, pid, rid, tcid = _setup_world(
        client, register_org, create_project, with_test_case=True)

    # B's project list is entirely empty — A's project never appears
    r = client.get("/v1/projects", headers=b)
    assert r.status_code == 200
    assert items_of(r.json()) == [], f"org B project list leaked: {r.text[:300]}"

    # B creates its own project: its scoped listings stay empty of A's data
    pid_b = create_project(b, name="مشروع المنظمة ب")
    for suffix in ("requirements", "endpoints", "test-cases", "documents", "runs"):
        r = client.get(f"/v1/projects/{pid_b}/{suffix}", headers=b)
        assert r.status_code == 200, f"{suffix}: {r.status_code} {r.text[:300]}"
        rows = items_of(r.json())
        assert rows == [], f"org B saw rows in fresh project {suffix}: {rows}"

    # and A still sees its own data (isolation is not deletion)
    assert client.get(f"/v1/projects/{pid}", headers=a).status_code == 200
    assert client.get(f"/v1/test-cases/{tcid}", headers=a).status_code == 200
