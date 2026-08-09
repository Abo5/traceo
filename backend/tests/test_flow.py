"""End-to-end in-process flow (NFR-MNT-04, API_CONTRACT quality gates).

register -> Arabic project -> upload .md requirements doc -> parse job ->
requirements extracted -> confirm_all -> import OpenAPI spec -> generate
(standard) -> approve all drafts -> traceability shows coverage -> xlsx export.
"""
from conftest import import_spec, items_of, poll_job

REQUIREMENTS_MD = """# المتطلبات

REQ-001: يجب أن يبدأ رقم الجوال بـ 05 وأن يتكوّن من 10 أرقام فقط عند إنشاء العميل عبر POST /customers.
- رفض أي رقم لا يطابق الصيغة 05XXXXXXXX بالرمز 422 (invalid phone rejected)
- قبول رقم صحيح مثل 0512345678 (valid phone accepted for customers)

REQ-002: يجب أن يكون عمر العميل بين 18 و120 عاماً عند إنشاء customer جديد.
- رفض age أقل من 18 بالرمز 422 (customers age minimum)
- رفض age أكبر من 120 بالرمز 422 (age maximum accepted boundary)
"""


def test_full_flow_from_document_to_export(client, register_org, create_project,
                                           tmp_path):
    headers = register_org("شركة الجودة")
    # automation=manual: this test walks the MANUAL path end to end — the
    # autopilot default would auto-confirm/auto-generate ahead of the steps below
    pid = create_project(headers, name="منصة الطلبات", language="ar",
                         automation="manual")

    # -- 1. upload the requirements document (multipart .md) and wait for the parse job
    doc_path = tmp_path / "requirements_ar.md"
    doc_path.write_text(REQUIREMENTS_MD, encoding="utf-8")
    with doc_path.open("rb") as fh:
        r = client.post(f"/v1/projects/{pid}/documents",
                        files={"file": (doc_path.name, fh, "text/markdown")},
                        headers=headers)
    assert r.status_code in (200, 201, 202), f"upload failed: {r.status_code} {r.text}"
    upload = r.json()
    assert upload.get("document_id")
    poll_job(client, headers, upload.get("job_id"))

    # -- 2. at least the two authored requirements were extracted, ids preserved
    r = client.get(f"/v1/projects/{pid}/requirements", headers=headers)
    assert r.status_code == 200
    reqs = items_of(r.json())
    assert len(reqs) >= 2, f"expected >=2 extracted requirements, got {len(reqs)}"
    external_ids = {q.get("external_id") for q in reqs}
    assert {"REQ-001", "REQ-002"} <= external_ids, f"missing ids: {external_ids}"
    assert all(q.get("state") == "extracted" for q in reqs)

    # -- 3. confirm all extracted requirements
    r = client.post(f"/v1/projects/{pid}/requirements/confirm_all", headers=headers)
    assert r.status_code in (200, 201, 204), f"confirm_all failed: {r.status_code} {r.text}"
    r = client.get(f"/v1/projects/{pid}/requirements",
                   params={"state": "confirmed"}, headers=headers)
    confirmed = items_of(r.json())
    assert len(confirmed) >= 2

    # -- 4. import the OpenAPI spec (POST /customers: phone pattern, age 18..120,
    #       201 + 422 responses; GET /customers/{id})
    spec_result = import_spec(client, headers, pid)
    assert spec_result.get("endpoints_count", 0) >= 2 or items_of(
        client.get(f"/v1/projects/{pid}/endpoints", headers=headers).json())

    # -- 5. generate test cases at standard depth
    r = client.post(f"/v1/projects/{pid}/generate",
                    json={"depth": "standard"}, headers=headers)
    assert r.status_code in (200, 202), f"generate failed: {r.status_code} {r.text}"
    job = poll_job(client, headers, r.json()["job_id"])
    result = job.get("result") or {}
    assert result.get("generated", 0) > 0, f"generation produced nothing: {result}"
    assert "discarded" in result, f"grounding gate count missing from result: {result}"
    assert isinstance(result["discarded"], int)

    # -- 6. bulk approve every draft
    r = client.get(f"/v1/projects/{pid}/test-cases",
                   params={"state": "draft"}, headers=headers)
    assert r.status_code == 200
    drafts = items_of(r.json())
    assert drafts, "no draft test cases after generation"
    draft_ids = [t["id"] for t in drafts if t.get("id")]
    r = client.post("/v1/test-cases/bulk",
                    json={"ids": draft_ids, "action": "approve"}, headers=headers)
    assert r.status_code in (200, 201, 204), f"bulk approve failed: {r.status_code} {r.text}"
    approved = items_of(client.get(f"/v1/projects/{pid}/test-cases",
                                   params={"state": "approved"},
                                   headers=headers).json())
    assert len(approved) == len(draft_ids)

    # -- 7. traceability: coverage present, approved-but-not-run rows flagged
    r = client.get(f"/v1/projects/{pid}/traceability", headers=headers)
    assert r.status_code == 200, f"traceability failed: {r.status_code} {r.text}"
    trace = r.json()
    assert trace.get("coverage_pct", 0) > 0, f"coverage is zero: {trace}"
    rows = trace.get("rows") or []
    assert rows, "traceability returned no rows"
    statuses = {row.get("status") for row in rows}
    assert "covered_not_run" in statuses, f"expected covered_not_run rows: {statuses}"

    # -- 8. export the traceability matrix as xlsx
    r = client.get(f"/v1/projects/{pid}/exports/matrix.xlsx", headers=headers)
    assert r.status_code == 200, f"xlsx export failed: {r.status_code} {r.text[:300]}"
    content_type = r.headers.get("content-type", "")
    assert "openxml" in content_type, f"unexpected content type: {content_type}"
    assert len(r.content) > 1000, f"xlsx suspiciously small: {len(r.content)} bytes"
