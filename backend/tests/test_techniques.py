"""Acceptance criteria that are easy to claim and hard to keep honest.

FR-012 AC4 Hijri dates normalised alongside Gregorian
FR-024 AC2 coverage counts what is EXERCISED — parameters and response branches
FR-032 AC3 pairwise reduction past a ceiling, and it is disclosed
FR-053 AC3 coverage delta at requirement AND endpoint level
"""
from datetime import datetime, timezone
from itertools import combinations

from conftest import (add_requirement, confirm_requirement, import_spec, items_of,
                      poll_job, small_openapi_spec)

from app.db import SessionLocal
from app.models import Run, TestResult
from app.modules.generation import pairwise_combinations
from app.modules.ingestion import (annotate_hijri_dates, hijri_to_gregorian,
                                   normalize_digits)


# ---------------------------------------------------------------- FR-012 AC4

def test_hijri_conversion_matches_umm_al_qura_within_a_day():
    # Published Umm al-Qura equivalents. The tabular calendar this uses can differ by
    # one day around a month boundary because Umm al-Qura follows observation.
    for hijri, gregorian in [((1443, 1, 1), "2021-08-10"),
                             ((1445, 9, 1), "2024-03-11"),
                             ((1446, 9, 15), "2025-03-15"),
                             ((1447, 1, 1), "2025-06-26")]:
        y, m, d = hijri_to_gregorian(*hijri)
        got = datetime(y, m, d, tzinfo=timezone.utc)
        expected = datetime.fromisoformat(gregorian).replace(tzinfo=timezone.utc)
        assert abs((got - expected).days) <= 1, f"{hijri} -> {got.date()} vs {gregorian}"

    assert hijri_to_gregorian(1447, 13, 1) is None   # no thirteenth month
    assert hijri_to_gregorian(1447, 1, 31) is None   # no 31-day Hijri month


def test_hijri_dates_are_annotated_not_replaced():
    """The original must survive verbatim — a reviewer checks the contract wording."""
    text = "يبدأ سريان الغرامة في 1447/03/15هـ ويُراجع العقد في 15 رمضان 1446."
    annotated = annotate_hijri_dates(text)

    assert "1447/03/15هـ" in annotated, "the original date must not be rewritten"
    assert "15 رمضان 1446" in annotated
    assert annotated.count("(≈") == 2, f"both dates should be annotated: {annotated}"
    assert "2025-09" in annotated

    # Arabic-Indic digits reach the same patterns after normalisation.
    arabic = annotate_hijri_dates(normalize_digits("الموعد ١٤٤٧/٠٣/١٥هـ"))
    assert "(≈" in arabic

    # A Gregorian date is left alone.
    plain = "التسليم في 2025-01-01 بإذن الله"
    assert annotate_hijri_dates(plain) == plain

    # Idempotent: re-parsing a document must not stack annotations, which would
    # change the content hash and mark every requirement as changed.
    assert annotate_hijri_dates(annotated) == annotated


def test_hijri_annotation_survives_the_ingestion_pipeline(client, register_org,
                                                          create_project, tmp_path):
    headers = register_org("Hijri Org")
    pid = create_project(headers, name="عقود", language="ar")
    doc = tmp_path / "reqs.md"
    doc.write_text(
        "REQ-001: يجب أن يرفض النظام طلباً بعد انتهاء المهلة في 1447/03/15هـ.\n"
        "- رفض الطلب بعد التاريخ برمز 422\n",
        encoding="utf-8")
    with doc.open("rb") as fh:
        r = client.post(f"/v1/projects/{pid}/documents",
                        files={"file": (doc.name, fh, "text/markdown")}, headers=headers)
    poll_job(client, headers, r.json()["job_id"])

    reqs = items_of(client.get(f"/v1/projects/{pid}/requirements", headers=headers).json())
    blob = " ".join((q.get("source_text") or "") + (q.get("description") or "") for q in reqs)
    assert "(≈" in blob, f"the Gregorian equivalent should reach the requirement: {blob[:300]}"


# ---------------------------------------------------------------- FR-032 AC3

def test_pairwise_covers_every_pair_at_a_fraction_of_the_cost():
    for n in range(2, 11):
        tests = pairwise_combinations(n)
        required = {(i, j, a, b) for i, j in combinations(range(n), 2)
                    for a in (True, False) for b in (True, False)}
        seen = {(i, j, t[i], t[j]) for t in tests for i, j in combinations(range(n), 2)}
        assert required <= seen, f"n={n} leaves pairs uncovered"
        if n >= 4:
            assert len(tests) < 2 ** n, f"n={n} gained nothing over exhaustive"
    # Deterministic — the same endpoint must always yield the same suite.
    assert pairwise_combinations(7) == pairwise_combinations(7)


def test_decision_table_discloses_pairwise_reduction(client, register_org, create_project,
                                                     monkeypatch):
    from app.config import settings

    # Force the ceiling low so the 4 constrained inputs of /customers trip it.
    monkeypatch.setattr(settings, "DECISION_TABLE_MAX_COMBOS", 4)

    headers = register_org("Pairwise Org")
    pid = create_project(headers, name="Decisions", language="en")
    import_spec(client, headers, pid)
    rid = add_requirement(client, headers, pid, "REQ-001",
                          "A customer is created only when phone, age and name are valid",
                          criteria=["Invalid combinations are rejected"], priority="high")
    confirm_requirement(client, headers, rid)
    poll_job(client, headers, client.post(f"/v1/projects/{pid}/generate",
                                          json={"depth": "exhaustive"},
                                          headers=headers).json()["job_id"])

    cases = items_of(client.get(f"/v1/projects/{pid}/test-cases", headers=headers).json())
    table = [c for c in cases if c.get("technique") == "decision_table"]
    assert table, "no decision-table cases were generated"

    detail = client.get(f"/v1/test-cases/{table[0]['id']}", headers=headers).json()
    assert "Pairwise reduction applied" in (detail.get("description") or ""), \
        f"AC3 requires the reduction to be disclosed: {detail.get('description')}"
    assert "covering every pair" in detail["description"]


# ---------------------------------------------------------------- FR-024 AC2

def test_endpoint_coverage_counts_response_branches_not_requests(
        client, register_org, create_project):
    headers = register_org("Coverage Org")
    pid = create_project(headers, name="Surface", language="en")
    import_spec(client, headers, pid)  # POST /customers declares 201 and 422
    rid = add_requirement(client, headers, pid, "REQ-001", "Customers can be created",
                          criteria=["A valid customer is created"])
    confirm_requirement(client, headers, rid)

    def add_case(title, expected):
        r = client.post(f"/v1/projects/{pid}/test-cases", json={
            "title": title, "type": "positive", "priority": "medium",
            "steps": [{"method": "POST", "path": "/customers",
                       "request": {"body": {"name": "A", "phone": "0512345678", "age": 30}},
                       "assertions": [{"type": "status_code", "expected": expected}]}],
            "requirement_ids": [rid],
        }, headers=headers)
        assert r.status_code in (200, 201), r.text
        client.post(f"/v1/test-cases/{r.json()['id']}/approve", headers=headers)

    # Three cases, all asserting the happy branch — request count says "well covered".
    for i in range(3):
        add_case(f"Create customer {i}", 201)

    endpoints = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    post = next(e for e in endpoints if e["method"] == "POST" and e["path"] == "/customers")
    assert post["test_count"] == 3
    assert post["covered_responses_pct"] == 50.0, \
        "one of two declared branches is asserted, however many requests are sent"
    assert post["uncovered_statuses"] == [422]
    assert post["coverage_pct"] < 100

    # Cover the rejection branch and the number moves for the right reason.
    add_case("Reject invalid customer", 422)
    endpoints = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    post = next(e for e in endpoints if e["method"] == "POST" and e["path"] == "/customers")
    assert post["covered_responses_pct"] == 100.0
    assert post["uncovered_statuses"] == []
    assert sorted(post["covered_statuses"]) == [201, 422]


# ---------------------------------------------------------------- FR-053 AC3

def _seed_run(pid, org_id, env_id, outcomes, created_at=None):
    db = SessionLocal()
    try:
        run = Run(organisation_id=org_id, project_id=pid, environment_id=env_id,
                  state="completed", initiated_by="seed",
                  counts={"total": len(outcomes),
                          "passed": sum(1 for o in outcomes.values() if o == "passed"),
                          "failed": sum(1 for o in outcomes.values() if o != "passed"),
                          "errored": 0},
                  started_at=created_at or datetime.now(timezone.utc),
                  finished_at=created_at or datetime.now(timezone.utc))
        if created_at:
            run.created_at = created_at
        db.add(run)
        db.flush()
        for case_id, outcome in outcomes.items():
            db.add(TestResult(run_id=run.id, test_case_id=case_id, test_case_version=1,
                              outcome=outcome, duration_ms=3, evidence=[]))
        db.commit()
        return run.id
    finally:
        db.close()


def test_run_comparison_names_the_requirement_and_endpoint_that_moved(
        client, register_org, create_project):
    headers = register_org("Delta Org")
    pid = create_project(headers, name="Delta", language="en")
    import_spec(client, headers, pid)
    org_id = client.get("/v1/me", headers=headers).json()["organisation_id"]
    env_id = client.post(f"/v1/projects/{pid}/environments",
                         json={"name": "stg", "base_url": "http://127.0.0.1:9/"},
                         headers=headers).json()["id"]

    endpoints = items_of(client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())
    post_ep = next(e for e in endpoints if e["method"] == "POST")

    rid = add_requirement(client, headers, pid, "REQ-042", "Customers can be created",
                          criteria=["A valid customer is created"], priority="high")
    confirm_requirement(client, headers, rid)
    case = client.post(f"/v1/projects/{pid}/test-cases", json={
        "title": "Create customer", "type": "positive", "priority": "high",
        "steps": [{"method": post_ep["method"], "path": post_ep["path"],
                   "endpoint_id": post_ep["id"],
                   "request": {"body": {"name": "A", "phone": "0512345678", "age": 30}},
                   "assertions": [{"type": "status_code", "expected": 201}]}],
        "requirement_ids": [rid],
    }, headers=headers).json()
    client.post(f"/v1/test-cases/{case['id']}/approve", headers=headers)

    baseline = _seed_run(pid, org_id, env_id, {case["id"]: "passed"})
    latest = _seed_run(pid, org_id, env_id, {case["id"]: "failed"})

    diff = client.get(f"/v1/runs/{latest}/compare/{baseline}", headers=headers).json()

    assert len(diff["newly_failing"]) == 1
    req_delta = diff["requirement_delta"]
    assert len(req_delta) == 1, f"expected one requirement to move: {req_delta}"
    assert req_delta[0]["external_id"] == "REQ-042"
    assert req_delta[0]["direction"] == "regressed"
    assert req_delta[0]["previous_verdict"] == "passing"
    assert req_delta[0]["verdict"] == "failing"

    ep_delta = diff["endpoint_delta"]
    assert len(ep_delta) == 1, f"expected one endpoint to move: {ep_delta}"
    assert ep_delta[0]["path"] == post_ep["path"]
    assert ep_delta[0]["direction"] == "regressed"

    # Comparing a run with itself must report no movement at all.
    same = client.get(f"/v1/runs/{latest}/compare/{latest}", headers=headers).json()
    assert same["requirement_delta"] == [] and same["endpoint_delta"] == []
