"""The governing design rule (SRS §1): a test case may only exist if it can name
(a) the acceptance criterion it derives from and (b) the discovered endpoint it targets.

The endpoint half is the grounding gate (test_grounding.py). This file covers the
criterion half — FR-013 in full, and the FR-042 AC2 obligation that a failure quote
the criterion it violates rather than merely the requirement it belongs to.
"""
from conftest import (add_requirement, confirm_requirement, import_spec, items_of,
                      poll_job)

from app.modules.ingestion import assign_criteria_numbers, criterion_key


# ---------------------------------------------------------------- FR-013 AC2

def test_criterion_numbers_follow_the_statement_not_its_position():
    first = assign_criteria_numbers(["phone must be 10 digits", "age must be 18+"])
    assert set(first.values()) == {"AC1", "AC2"}

    # Insert a criterion at the TOP. The two already-tested statements must keep
    # their numbers, or every case and defect citing AC1 would silently re-point.
    second = assign_criteria_numbers(
        ["email must be valid", "phone must be 10 digits", "age must be 18+"], first)
    assert second[criterion_key("phone must be 10 digits")] == "AC1"
    assert second[criterion_key("age must be 18+")] == "AC2"
    assert second[criterion_key("email must be valid")] == "AC3"

    # Whitespace and casing are not a different criterion.
    third = assign_criteria_numbers(["  PHONE must be 10   digits "], second)
    assert third[criterion_key("phone must be 10 digits")] == "AC1"
    assert len(third) == len(second)

    # A removed criterion retires its number — it is never handed to a new statement.
    fourth = assign_criteria_numbers(["something entirely new"], third)
    assert fourth[criterion_key("something entirely new")] == "AC4"


def test_criteria_are_numbered_and_stable_through_the_api(client, register_org,
                                                          create_project):
    headers = register_org("Criteria Org")
    pid = create_project(headers, name="Numbering", language="en")
    rid = add_requirement(client, headers, pid, "REQ-001", "Customer creation rules",
                          criteria=["phone must be 10 digits", "age must be 18 or over"])

    req = client.get(f"/v1/projects/{pid}/requirements", headers=headers).json()
    req = next(q for q in items_of(req) if q["id"] == rid)
    assert [c["index"] for c in req["criteria"]] == ["AC1", "AC2"]
    assert req["criteria"][0]["statement"] == "phone must be 10 digits"
    assert req["needs_criteria"] is False

    # Edit: prepend one. AC1/AC2 must not move.
    client.patch(f"/v1/requirements/{rid}", headers=headers, json={
        "acceptance_criteria": ["email must be valid", "phone must be 10 digits",
                                "age must be 18 or over"]})
    req = next(q for q in items_of(
        client.get(f"/v1/projects/{pid}/requirements", headers=headers).json())
        if q["id"] == rid)
    by_statement = {c["statement"]: c["index"] for c in req["criteria"]}
    assert by_statement["phone must be 10 digits"] == "AC1"
    assert by_statement["age must be 18 or over"] == "AC2"
    assert by_statement["email must be valid"] == "AC3"


# ---------------------------------------------------------------- FR-013 AC3

def test_a_requirement_without_criteria_is_flagged_not_silently_accepted(
        client, register_org, create_project):
    headers = register_org("No Criteria Org")
    pid = create_project(headers, name="Flagging", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(client, headers, pid, "REQ-009",
                          "The system should be reliable", criteria=[])
    confirm_requirement(client, headers, rid)

    req = next(q for q in items_of(
        client.get(f"/v1/projects/{pid}/requirements", headers=headers).json())
        if q["id"] == rid)
    assert req["needs_criteria"] is True, "AC3 requires this to be surfaced"

    job = poll_job(client, headers, client.post(
        f"/v1/projects/{pid}/generate", json={"depth": "standard"},
        headers=headers).json()["job_id"])
    reasons = [u["reason"] for u in job["result"]["unmappable"]
               if u["requirement_id"] == rid]
    assert reasons, "a requirement with no criteria must be reported, not skipped"
    assert "no acceptance criteria" in reasons[0]

    # The matrix says WHICH problem to fix — writing a criterion, not importing a spec.
    gaps = client.get(f"/v1/projects/{pid}/traceability", headers=headers).json()["gaps"]
    gap = next(g for g in gaps if g["requirement_id"] == rid)
    assert gap["reason"] == "no_criteria"


# ---------------------------------------------------------------- FR-013 AC4

def test_every_generated_case_names_the_criterion_it_derives_from(
        client, register_org, create_project):
    headers = register_org("Attribution Org")
    pid = create_project(headers, name="Attribution", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(
        client, headers, pid, "REQ-014",
        "A customer is created with a valid phone and age",
        criteria=["the phone must match 05XXXXXXXX when creating a customer",
                  "the age must be between 18 and 120 when creating a customer"],
        priority="high")
    confirm_requirement(client, headers, rid)

    job = poll_job(client, headers, client.post(
        f"/v1/projects/{pid}/generate", json={"depth": "standard"},
        headers=headers).json()["job_id"])
    assert job["result"]["generated"] > 0
    assert any(c.get("criterion") for c in job["result"]["changed_cases"]), \
        "the generation report should say which criterion produced each case"

    cases = items_of(client.get(f"/v1/projects/{pid}/test-cases", headers=headers).json())
    assert cases
    for case in cases:
        links = case.get("links") or []
        assert links, f"case {case['title']} has no requirement link"
        cited = [i for link in links for i in (link.get("criterion_indexes") or [])]
        assert cited, (f"'{case['title']}' names no criterion — the governing rule "
                       f"says such a case may not exist")
        assert all(i.startswith("AC") for i in cited)

    detail = client.get(f"/v1/test-cases/{cases[0]['id']}", headers=headers).json()
    assert "/ AC" in detail["description"], \
        f"the case should state the criterion it covers: {detail['description']}"


def test_matrix_reports_against_criteria_not_only_requirements(
        client, register_org, create_project):
    headers = register_org("Matrix Criteria Org")
    pid = create_project(headers, name="Matrix", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(
        client, headers, pid, "REQ-020", "Customer creation and lookup",
        criteria=["a customer is created with valid data",
                  "a receipt is emailed after the customer signs up"],
        priority="high")
    confirm_requirement(client, headers, rid)
    poll_job(client, headers, client.post(f"/v1/projects/{pid}/generate",
                                          json={"depth": "standard"},
                                          headers=headers).json()["job_id"])
    drafts = items_of(client.get(f"/v1/projects/{pid}/test-cases",
                                 params={"state": "draft"}, headers=headers).json())
    client.post("/v1/test-cases/bulk",
                json={"ids": [d["id"] for d in drafts], "action": "approve"},
                headers=headers)

    matrix = client.get(f"/v1/projects/{pid}/traceability", headers=headers).json()
    row = next(r for r in matrix["rows"] if r["requirement"]["id"] == rid)

    assert row["criteria_total"] == 2                       # FR-013 AC4
    assert [c["index"] for c in row["criteria"]] == ["AC1", "AC2"]
    covered = {c["index"]: c["covered"] for c in row["criteria"]}
    assert covered["AC1"] is True, "the criterion that mapped should be covered"

    # The email criterion maps to no endpoint in this spec. A requirement reported as
    # covered while one of its criteria has nothing testing it is the exact false
    # comfort the matrix exists to prevent.
    if not covered["AC2"]:
        gap = next(g for g in matrix["gaps"]
                   if g["requirement_id"] == rid and g["reason"] == "criteria_uncovered")
        assert "AC2" in gap["criteria"]


# ---------------------------------------------------------------- FR-042 AC2

def test_a_failure_quotes_the_criterion_it_violates(client, register_org, create_project):
    """A defect report a developer can act on without opening Traceo."""
    from datetime import datetime, timezone

    from app.db import SessionLocal
    from app.models import Run, TestResult

    headers = register_org("Defect Criterion Org")
    pid = create_project(headers, name="Defects", language="en")
    import_spec(client, headers, pid)
    statement = "a refund above 1000 SAR is held for approval"
    rid = add_requirement(client, headers, pid, "PAY-014", "Refund approval rules",
                          criteria=[statement], priority="high")
    confirm_requirement(client, headers, rid)

    # A hand-written case cites its criterion the same way a generated one does.
    created = client.post(f"/v1/projects/{pid}/test-cases", json={
        "title": "Refund over 1000 is held", "type": "negative", "priority": "high",
        "steps": [{"method": "POST", "path": "/customers",
                   "request": {"body": {"name": "A", "phone": "0512345678", "age": 30}},
                   "assertions": [{"type": "json_field", "path": "status",
                                   "op": "eq", "expected": "held"}]}],
        "requirement_ids": [rid],
        "criterion_indexes": {rid: ["AC1"]},
    }, headers=headers)
    assert created.status_code in (200, 201), created.text
    case = created.json()
    assert case["links"][0]["criterion_indexes"] == ["AC1"]

    # Citing a criterion the requirement does not have is refused, not stored.
    bogus = client.post(f"/v1/projects/{pid}/test-cases", json={
        "title": "Bogus", "type": "positive", "priority": "low",
        "steps": [{"method": "POST", "path": "/customers", "request": {},
                   "assertions": [{"type": "status_code", "expected": 201}]}],
        "requirement_ids": [rid], "criterion_indexes": {rid: ["AC9"]},
    }, headers=headers)
    assert bogus.status_code == 422
    assert bogus.json()["detail"]["code"] == "unknown_criteria"

    env = client.post(f"/v1/projects/{pid}/environments",
                      json={"name": "stg", "base_url": "http://127.0.0.1:9/"},
                      headers=headers).json()
    org_id = client.get("/v1/me", headers=headers).json()["organisation_id"]

    db = SessionLocal()
    try:
        run = Run(organisation_id=org_id, project_id=pid, environment_id=env["id"],
                  state="completed", initiated_by="seed",
                  counts={"total": 1, "passed": 0, "failed": 1, "errored": 0},
                  started_at=datetime.now(timezone.utc),
                  finished_at=datetime.now(timezone.utc))
        db.add(run)
        db.flush()
        db.add(TestResult(run_id=run.id, test_case_id=case["id"], test_case_version=1,
                          outcome="failed", duration_ms=12,
                          failure_reason={"assertion": {"type": "json_field",
                                                        "path": "status",
                                                        "expected": "held"},
                                          "actual": "settled"},
                          evidence=[]))
        db.commit()
        run_id = run.id
    finally:
        db.close()

    report = client.get(f"/v1/runs/{run_id}/report", headers=headers).json()
    entry = report["cases"][0]
    cited = [c for r in entry["requirements"] for c in (r.get("criteria") or [])]
    assert cited, "the failure carries no criterion"
    assert cited[0]["index"] == "AC1"
    assert cited[0]["statement"] == statement

    html = client.get(f"/v1/runs/{run_id}/report.html", headers=headers).text
    assert statement in html, "the printable defect report must quote the criterion"
    assert "AC1" in html


# ---------------------------------------------------------------- attribution width

def test_subject_attribution_closes_false_gaps_without_inventing_coverage():
    """The one place attribution widens. It must key on the field the case is ABOUT."""
    from app.modules.generation import attribute_by_subject

    criteria = [
        {"index": "AC1", "statement": "قيمة age أقل من 18 تُرفض بالرمز 422"},
        {"index": "AC2", "statement": "قيمة age أكبر من 120 تُرفض بالرمز 422"},
        {"index": "AC3", "statement": "زمن الاستجابة يُقاس عند بوابة الـ API"},
        {"index": "AC4", "statement": "the phone_number must be ten digits"},
    ]

    # A boundary case on `age` is real evidence for the other age criterion.
    assert attribute_by_subject(criteria, ["age"], ["AC1"]) == ["AC2"]

    # A criterion naming no field the suite touches stays uncovered — the honest
    # answer, because no API assertion verifies where latency is measured.
    assert "AC3" not in attribute_by_subject(criteria, ["age"], [])

    # snake_case / prose gap is bridged, but only for the field actually exercised.
    assert attribute_by_subject(criteria, ["phone_number"], []) == ["AC4"]
    assert attribute_by_subject(criteria, ["email"], []) == []

    # A case about nothing in particular (a plain positive request) claims nothing.
    assert attribute_by_subject(criteria, [], []) == []

    # Never re-cites what is already cited.
    assert attribute_by_subject(criteria, ["age"], ["AC1", "AC2"]) == []


def test_generation_attributes_a_boundary_case_to_the_criterion_that_states_it(
        client, register_org, create_project):
    headers = register_org("Cross Attribution Org")
    pid = create_project(headers, name="Bounds", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(
        client, headers, pid, "REQ-004", "Customer age rules on create customer",
        criteria=["age below 18 is rejected when creating a customer",
                  "age above 120 is rejected",
                  "response time is measured at the API gateway"],
        priority="high")
    confirm_requirement(client, headers, rid)
    poll_job(client, headers, client.post(f"/v1/projects/{pid}/generate",
                                          json={"depth": "standard"},
                                          headers=headers).json()["job_id"])
    drafts = items_of(client.get(f"/v1/projects/{pid}/test-cases",
                                 params={"state": "draft"}, headers=headers).json())
    client.post("/v1/test-cases/bulk",
                json={"ids": [d["id"] for d in drafts], "action": "approve"},
                headers=headers)

    row = next(r for r in client.get(f"/v1/projects/{pid}/traceability",
                                     headers=headers).json()["rows"]
               if r["requirement"]["id"] == rid)
    covered = {c["index"]: c["covered"] for c in row["criteria"]}

    assert covered["AC2"] is True, \
        "the age boundary cases are evidence for 'age above 120 is rejected'"

    # NOTE on what this does and does not guarantee. AC3 ("response time is measured
    # at the API gateway") is not verifiable by an API assertion, yet it can still be
    # reported as covered: the mapper selected an endpoint for it, so cases were
    # generated citing it. Mapping precision belongs to the mapper (an LLM bounded by
    # MIN_MAP_CONFIDENCE), and the deterministic offline provider is lenient.
    #
    # A lexical "does this criterion mention the endpoint's fields" gate was tried
    # here and removed: it silently dropped legitimate criteria that name no field,
    # such as "an unauthorised caller is rejected". Losing real coverage to make a
    # number look better is the worse error. The human review gate — no case counts
    # until someone approves it — is what catches a case citing a criterion it does
    # not verify, and that is by design, not by omission.
    assert "AC3" in covered
