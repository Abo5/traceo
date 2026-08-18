"""RELEASE GATE — security generation, phase S0 (docs/SECURITY_TESTING_PLAN.md).

What these tests defend, in the order the design cares about:

1. The catalogue is a shipped DATA file, so it is checked like one: every entry
   validates against its own schema, ids are unique, and every precondition term
   comes from the closed vocabulary the builder can actually evaluate.
2. `applicable()` never says False without a reason. A skipped pair with no
   reason is worse than no report at all — it converts an unknown into an
   invisible.
3. An endpoint no requirement maps to produces NO cases and is reported with
   that specific reason (BO-07 through a new door).
4. Everything persisted passes the SAME grounding gate functional generation
   uses, carries a non-empty requirement link and a weakness_id.
5. covered + not_applicable + gap == total pairs, always. If that arithmetic can
   drift, the matrix is decoration.
6. Determinism: identical inputs produce byte-identical titles.
"""
import json

import pytest
from conftest import (add_requirement, confirm_requirement, import_spec,
                      items_of, poll_job, small_openapi_spec)

from app.models import TECHNIQUES, RUN_KINDS, is_legal_technique
from app.modules import security
from app.modules.generation import grounding_validate

REQUIRED_CLASSES = {
    "missing-authn", "broken-object-level-authz", "broken-function-level-authz",
    "mass-assignment", "injection-surface", "input-validation", "error-leakage",
    "security-headers", "token-handling", "rate-limiting",
}


# ---------------------------------------------------------------------------
# Fixtures — a spec with something for every class to bite on
# ---------------------------------------------------------------------------

def security_spec():
    """Adds a secured POST /accounts carrying a privileged 'role' property to the
    shared 2-endpoint fixture, so mass-assignment has a declared field to test
    (fabricating one would be discarded by the grounding gate, correctly)."""
    spec = small_openapi_spec()
    spec["components"] = {"securitySchemes": {
        "bearerAuth": {"type": "http", "scheme": "bearer"}}}
    spec["paths"]["/accounts"] = {
        "post": {
            "operationId": "createAccount",
            "summary": "Create an account for a customer with a role and a note",
            "security": [{"bearerAuth": []}],
            "requestBody": {
                "required": True,
                "content": {"application/json": {"schema": {
                    "type": "object",
                    "required": ["owner_id"],
                    "properties": {
                        "owner_id": {"type": "string"},
                        "role": {"type": "string", "enum": ["member", "admin"]},
                        "note": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    },
                }}},
            },
            "responses": {
                "201": {"description": "Created", "content": {"application/json": {
                    "schema": {"type": "object", "properties": {
                        "id": {"type": "string"}, "role": {"type": "string"}}}}}},
                "422": {"description": "Validation error"},
            },
        },
    }
    spec["paths"]["/accounts/{account_id}"] = {
        "get": {
            "operationId": "getAccount",
            "summary": "Get an account by id",
            "security": [{"bearerAuth": []}],
            "parameters": [{"name": "account_id", "in": "path", "required": True,
                            "schema": {"type": "string"}}],
            "responses": {
                "200": {"description": "OK", "content": {"application/json": {
                    "schema": {"type": "object", "properties": {
                        "id": {"type": "string"}, "owner_id": {"type": "string"}}}}}},
                "404": {"description": "Not found"},
            },
        },
    }
    return spec


@pytest.fixture()
def security_project(client, register_org, create_project):
    """A project with the spec imported and a confirmed requirement that maps to
    the account endpoints — returns (headers, project_id)."""
    headers = register_org()
    pid = create_project(headers)
    import_spec(client, headers, pid, security_spec())
    rid = add_requirement(
        client, headers, pid, "REQ-SEC-1",
        "Create and read an account for a customer with an owner_id, a role and a note",
        criteria=["only the owner may read an account",
                  "the role is assigned by the server, never by the client"])
    confirm_requirement(client, headers, rid)
    rid2 = add_requirement(
        client, headers, pid, "REQ-SEC-2",
        "Create a customer with a valid phone number and age",
        criteria=["phone must match 05XXXXXXXX", "age must be between 18 and 120"])
    confirm_requirement(client, headers, rid2)
    return headers, pid


def _endpoints(client, headers, pid):
    r = client.get(f"/v1/projects/{pid}/endpoints", headers=headers)
    assert r.status_code == 200
    return items_of(r.json())


# ---------------------------------------------------------------------------
# 1. The catalogue is a data file, validated like one
# ---------------------------------------------------------------------------

def test_catalogue_file_loads_and_is_valid():
    doc = json.loads(security.CATALOGUE_PATH.read_text(encoding="utf-8"))
    assert security.validate_catalogue(doc) == []
    assert doc["version"]
    assert security.load_catalogue()["version"] == doc["version"]


def test_catalogue_ships_the_ten_required_classes():
    ids = [w["id"] for w in security.weaknesses()]
    assert len(ids) == len(set(ids)), "duplicate weakness id in the catalogue"
    assert REQUIRED_CLASSES <= set(ids), f"missing: {sorted(REQUIRED_CLASSES - set(ids))}"


def test_every_entry_validates_against_its_own_schema():
    for i, entry in enumerate(security.weaknesses()):
        assert security.validate_entry(entry, i) == [], f"invalid entry: {entry.get('id')}"
        assert entry["severity"] in security.SEVERITIES
        assert entry["activity"] in security.ACTIVITIES
        for term in entry["precondition"]:
            assert term in security.PRECONDITIONS, \
                f"{entry['id']}: precondition '{term}' is outside the closed vocabulary"


def test_rate_limiting_and_writes_are_marked_active():
    """S0 GENERATES the active classes; S1's flag is what may run them."""
    by_id = {w["id"]: w for w in security.weaknesses()}
    assert by_id["rate-limiting"]["activity"] == "active"
    assert by_id["mass-assignment"]["activity"] == "active"


def test_validate_entry_rejects_a_malformed_entry():
    bad = {"id": "", "title": "", "refs": {"cwe": [], "asvs": []},
           "severity": "catastrophic", "activity": "aggressive",
           "precondition": {"endpoint_is_interesting": True}, "checks": []}
    problems = security.validate_entry(bad, 0)
    assert problems
    joined = " ".join(problems)
    for expected in ("'id'", "severity", "activity", "unknown precondition", "checks"):
        assert expected in joined, f"validator missed {expected}: {problems}"


def test_catalogue_route_returns_version_and_entries(client, register_org):
    headers = register_org()
    r = client.get("/v1/weaknesses", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["version"] == security.catalogue_version()
    assert {w["id"] for w in body["weaknesses"]} >= REQUIRED_CLASSES
    first = body["weaknesses"][0]
    assert {"id", "title", "refs", "severity", "activity", "precondition",
            "checks"} <= set(first)
    assert {"owasp_api", "cwe", "asvs"} <= set(first["refs"])


def test_catalogue_route_requires_authentication(client):
    assert client.get("/v1/weaknesses").status_code == 401


# ---------------------------------------------------------------------------
# 2. applicable() always answers with a reason when it says no
# ---------------------------------------------------------------------------

class _Ep:
    """Minimal endpoint record — applicable() reads the record, not the ORM."""

    def __init__(self, **kw):
        self.id = kw.get("id", "ep-1")
        self.method = kw.get("method", "GET")
        self.path = kw.get("path", "/things")
        self.parameters = kw.get("parameters", [])
        self.request_schema = kw.get("request_schema")
        self.response_schemas = kw.get("response_schemas", {})
        self.security = kw.get("security", [])
        self.tags = []


def test_applicable_returns_a_reason_on_every_false():
    bare = _Ep()  # no security, no path param, no body, no constrained input
    for w in security.weaknesses():
        ok, reason = security.applicable(bare, w)
        if not ok:
            assert reason, f"{w['id']} was skipped with no reason"
            assert isinstance(reason, str) and len(reason) > 10
        else:
            assert reason == ""


def test_applicable_reasons_are_specific_per_precondition():
    bare = _Ep()
    by_id = {w["id"]: w for w in security.weaknesses()}

    ok, reason = security.applicable(bare, by_id["missing-authn"])
    assert not ok and "security scheme" in reason

    ok, reason = security.applicable(bare, by_id["broken-object-level-authz"])
    assert not ok and "identifier parameter" in reason

    ok, reason = security.applicable(bare, by_id["mass-assignment"])
    assert not ok and "server-owned property" in reason

    # "always" classes apply to the barest endpoint there is
    ok, reason = security.applicable(bare, by_id["security-headers"])
    assert ok and reason == ""


def test_applicable_is_positive_when_the_precondition_holds():
    secured = _Ep(security=[{"bearerAuth": []}], path="/things/{id}",
                  parameters=[{"name": "id", "location": "path", "type": "string",
                               "required": True, "constraints": {}}])
    by_id = {w["id"]: w for w in security.weaknesses()}
    for wid in ("missing-authn", "broken-object-level-authz",
                "broken-function-level-authz", "token-handling"):
        ok, reason = security.applicable(secured, by_id[wid])
        assert ok, f"{wid} should apply to a secured endpoint with an id: {reason}"


def test_unknown_precondition_term_is_refused_with_a_reason():
    ok, reason = security.applicable(_Ep(), {"id": "ghost",
                                             "precondition": {"vibes": True}})
    assert not ok
    assert "unknown precondition term 'vibes'" in reason


# ---------------------------------------------------------------------------
# 3/4. Generation: traceability, grounding, weakness_id
# ---------------------------------------------------------------------------

def _generate(client, headers, pid, body=None):
    r = client.post(f"/v1/projects/{pid}/security/generate",
                    json=body or {}, headers=headers)
    assert r.status_code == 202, f"generate failed: {r.status_code} {r.text}"
    return poll_job(client, headers, r.json()["job_id"])


def test_generation_produces_grounded_traceable_security_cases(client, security_project):
    headers, pid = security_project
    job = _generate(client, headers, pid)
    result = job["result"]
    assert result["generated"] > 0, f"nothing generated: {result}"
    assert result["discarded"] == 0, "a deterministic builder produced an ungrounded case"

    inventory = {(e["method"].upper(), e["path"]): e for e in _endpoints(client, headers, pid)}
    r = client.get(f"/v1/projects/{pid}/test-cases", headers=headers)
    assert r.status_code == 200
    cases = items_of(r.json())
    security_cases = [c for c in cases if c.get("technique") == "security"]
    assert security_cases, "no security-technique cases persisted"
    assert len(security_cases) == result["generated"]

    for case in security_cases:
        detail = client.get(f"/v1/test-cases/{case['id']}", headers=headers).json()
        links = detail.get("links") or detail.get("requirements") or []
        assert links, f"security case {case['id']} carries no requirement link"
        steps = detail["steps"]
        assert steps
        for step in steps:
            key = (str(step["method"]).upper(), step["path"])
            assert key in inventory, f"fabricated endpoint persisted: {key}"
        # the same gate, re-run over what was actually stored
        rebuilt = {"requirement_ids": [ln["id"] for ln in links],
                   "steps": [{"method": s["method"], "path": s["path"],
                              "request": s["request"], "assertions": s["assertions"]}
                             for s in steps]}
        assert grounding_validate(rebuilt, inventory) == [], \
            f"persisted case {case['id']} does not pass grounding"


def test_every_built_case_carries_requirement_ids_and_a_weakness_id(client, security_project):
    headers, pid = security_project
    _generate(client, headers, pid)
    r = client.get(f"/v1/projects/{pid}/security/coverage", headers=headers)
    assert r.status_code == 200
    # weakness_id is checked at the source (the builder output) and through the DB
    from app.db import SessionLocal
    from app.models import TestCase
    db = SessionLocal()
    try:
        rows = db.query(TestCase).filter(TestCase.project_id == pid,
                                         TestCase.technique == "security").all()
        assert rows
        for tc in rows:
            assert tc.weakness_id, f"security case {tc.id} has no weakness_id"
            assert security.weakness_by_id(tc.weakness_id) is not None
            assert tc.state == "draft" and tc.generated is True
            assert tc.priority in security.SEVERITIES
    finally:
        db.close()


def test_endpoint_with_no_mapped_requirement_yields_no_cases_and_a_reason(
        client, register_org, create_project):
    """BO-07 through a new door: no requirement, no case — and the report says so."""
    headers = register_org()
    pid = create_project(headers)
    import_spec(client, headers, pid, security_spec())
    # NO requirements at all
    job = _generate(client, headers, pid)
    result = job["result"]
    assert result["generated"] == 0
    reasons = {s["reason"] for s in result["skipped"]}
    assert security.NO_REQUIREMENT_REASON in reasons, reasons
    assert all({"endpoint", "weakness", "reason"} == set(s) for s in result["skipped"])

    r = client.get(f"/v1/projects/{pid}/test-cases", headers=headers)
    assert [c for c in items_of(r.json()) if c.get("technique") == "security"] == []

    cov = client.get(f"/v1/projects/{pid}/security/coverage", headers=headers).json()
    assert cov["pairs"]["covered"] == 0
    assert cov["pairs"]["gap"] > 0
    assert security.NO_REQUIREMENT_REASON in {s["reason"] for s in cov["skipped"]}


def test_unknown_weakness_id_is_refused(client, security_project):
    headers, pid = security_project
    r = client.post(f"/v1/projects/{pid}/security/generate",
                    json={"weakness_ids": ["bola", "missing-authn"]}, headers=headers)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "unknown_weakness"
    assert "bola" in detail["message"]
    assert "missing-authn" in detail["errors"]


def test_weakness_id_filter_restricts_the_corpus(client, security_project):
    headers, pid = security_project
    _generate(client, headers, pid, {"weakness_ids": ["security-headers"]})
    from app.db import SessionLocal
    from app.models import TestCase
    db = SessionLocal()
    try:
        ids = {tc.weakness_id for tc in db.query(TestCase).filter(
            TestCase.project_id == pid, TestCase.technique == "security").all()}
        assert ids == {"security-headers"}
    finally:
        db.close()


def test_a_class_may_emit_several_cases_for_one_pair(client, security_project):
    """Token handling verifies an expired AND an unsigned token. The duplicate
    guard is keyed on the title, not the pair, so the second case is not eaten."""
    headers, pid = security_project
    _generate(client, headers, pid)
    r = client.get(f"/v1/projects/{pid}/test-cases", headers=headers)
    titles = [c["title"] for c in items_of(r.json()) if c.get("technique") == "security"]
    assert any("expired bearer token" in t for t in titles)
    assert any("stripped signature" in t for t in titles)


def test_regenerating_does_not_duplicate_a_covered_pair(client, security_project):
    headers, pid = security_project
    first = _generate(client, headers, pid)["result"]
    second = _generate(client, headers, pid)["result"]
    assert first["generated"] > 0
    assert second["generated"] == 0
    assert security.EXISTING_CASE_REASON in {s["reason"] for s in second["skipped"]}


def test_active_classes_are_generated_and_marked(client, security_project):
    headers, pid = security_project
    _generate(client, headers, pid)
    from app.db import SessionLocal
    from app.models import TestCase
    db = SessionLocal()
    try:
        produced = {tc.weakness_id for tc in db.query(TestCase).filter(
            TestCase.project_id == pid, TestCase.technique == "security").all()}
    finally:
        db.close()
    assert "rate-limiting" in produced, "S0 generates active classes; S1 gates running them"
    by_id = {w["id"]: w for w in security.weaknesses()}
    assert by_id["rate-limiting"]["activity"] == "active"


# ---------------------------------------------------------------------------
# 5. The matrix arithmetic
# ---------------------------------------------------------------------------

def test_coverage_matrix_arithmetic_holds(client, security_project):
    headers, pid = security_project
    corpus = security.weaknesses()
    endpoints = _endpoints(client, headers, pid)

    for _phase in ("before", "after"):
        r = client.get(f"/v1/projects/{pid}/security/coverage", headers=headers)
        assert r.status_code == 200, r.text
        cov = r.json()
        pairs = cov["pairs"]
        assert cov["corpus_version"] == security.catalogue_version()
        assert pairs["total"] == len(endpoints) * len(corpus)
        assert pairs["covered"] + pairs["not_applicable"] + pairs["gap"] == pairs["total"]

        assert [row["weakness_id"] for row in cov["by_weakness"]] == [w["id"] for w in corpus]
        for key in ("covered", "not_applicable", "gap"):
            assert sum(row[key] for row in cov["by_weakness"]) == pairs[key]
        for row in cov["by_weakness"]:
            assert row["covered"] + row["not_applicable"] + row["gap"] == len(endpoints)

        for entry in cov["skipped"]:
            assert set(entry) == {"endpoint_id", "method", "path", "weakness_id", "reason"}
            assert entry["reason"]
        _generate(client, headers, pid)


def test_coverage_gap_shrinks_after_generation(client, security_project):
    headers, pid = security_project
    before = client.get(f"/v1/projects/{pid}/security/coverage", headers=headers).json()
    assert before["pairs"]["covered"] == 0
    _generate(client, headers, pid)
    after = client.get(f"/v1/projects/{pid}/security/coverage", headers=headers).json()
    assert after["pairs"]["covered"] > 0
    assert after["pairs"]["gap"] < before["pairs"]["gap"]
    assert after["pairs"]["not_applicable"] == before["pairs"]["not_applicable"]


def test_coverage_on_an_empty_project_is_zero_not_an_error(client, register_org,
                                                           create_project):
    headers = register_org()
    pid = create_project(headers)
    cov = client.get(f"/v1/projects/{pid}/security/coverage", headers=headers).json()
    assert cov["pairs"] == {"total": 0, "covered": 0, "not_applicable": 0, "gap": 0}
    assert cov["skipped"] == []
    assert len(cov["by_weakness"]) == len(security.weaknesses())


# ---------------------------------------------------------------------------
# 6. Determinism, capability guards, audit, schema
# ---------------------------------------------------------------------------

def test_same_inputs_produce_identical_titles(client, security_project):
    """The builders are pure: the plan is byte-identical when re-planned."""
    headers, pid = security_project
    from app.db import SessionLocal
    from app.models import Project
    db = SessionLocal()
    try:
        org_id = db.get(Project, pid).organisation_id
        first, _keys, skipped_a = security.build_plan(db, org_id, pid)
        second, _keys2, skipped_b = security.build_plan(db, org_id, pid)
    finally:
        db.close()

    assert first, "the plan is empty"
    assert [c["title"] for c in first] == [c["title"] for c in second]
    assert json.dumps(first, sort_keys=True, default=str) == \
        json.dumps(second, sort_keys=True, default=str)
    assert [s["reason"] for s in skipped_a] == [s["reason"] for s in skipped_b]


def test_generated_titles_are_stable_across_projects(client, register_org,
                                                     create_project):
    """Two identical projects produce the same security case titles — the titles
    are a function of the endpoint and the class, nothing else."""
    titles = []
    for _ in range(2):
        headers = register_org()
        pid = create_project(headers)
        import_spec(client, headers, pid, security_spec())
        rid = add_requirement(
            client, headers, pid, "REQ-SEC-1",
            "Create and read an account for a customer with an owner_id, a role and a note")
        confirm_requirement(client, headers, rid)
        _generate(client, headers, pid)
        r = client.get(f"/v1/projects/{pid}/test-cases", headers=headers)
        titles.append(sorted(c["title"] for c in items_of(r.json())
                             if c.get("technique") == "security"))
    assert titles[0] == titles[1]
    assert titles[0]


def test_viewer_cannot_generate_but_can_read(client, register_org, create_project):
    headers = register_org()
    pid = create_project(headers)
    email = f"viewer-{pid[:8]}@example.sa"
    r = client.post("/v1/members/invite", json={
        "email": email, "name": "Viewer",
        "password": "Passw0rd!", "role": "viewer"}, headers=headers)
    assert r.status_code in (200, 201), r.text
    login = client.post("/v1/auth/login", json={"email": email, "password": "Passw0rd!"})
    assert login.status_code == 200, login.text
    token = login.json().get("token") or login.json().get("access_token")
    vheaders = {"Authorization": f"Bearer {token}"}

    r = client.post(f"/v1/projects/{pid}/security/generate", json={}, headers=vheaders)
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"

    assert client.get("/v1/weaknesses", headers=vheaders).status_code == 200
    assert client.get(f"/v1/projects/{pid}/security/coverage",
                      headers=vheaders).status_code == 200


def test_generation_writes_the_audit_entry(client, security_project):
    headers, pid = security_project
    _generate(client, headers, pid)
    r = client.get("/v1/audit", headers=headers)
    assert r.status_code == 200, r.text
    entries = items_of(r.json())
    actions = [e.get("action") for e in entries]
    assert "security.generate" in actions, actions
    entry = next(e for e in entries if e.get("action") == "security.generate")
    assert entry.get("object_id") == pid
    detail = entry.get("detail") or {}
    assert detail.get("corpus_version") == security.catalogue_version()
    assert detail.get("generated", 0) > 0


def test_security_is_a_legal_technique_and_run_kinds_are_declared():
    assert is_legal_technique("security")
    assert "security" in TECHNIQUES
    assert RUN_KINDS == ("functional", "security", "performance")


def test_test_case_and_run_carry_the_new_columns():
    from app.models import Run, TestCase
    assert TestCase.__table__.c.weakness_id.nullable is True
    assert TestCase.__table__.c.weakness_id.type.length == 64
    assert TestCase.__table__.c.weakness_id.index is True
    kind = Run.__table__.c.kind
    assert kind.nullable is False
    assert kind.server_default is not None


def test_project_isolation_on_the_security_routes(client, register_org, create_project):
    a = register_org("Org A")
    b = register_org("Org B")
    pid = create_project(a)
    assert client.get(f"/v1/projects/{pid}/security/coverage",
                      headers=b).status_code == 404
    assert client.post(f"/v1/projects/{pid}/security/generate", json={},
                       headers=b).status_code == 404
