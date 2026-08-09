"""Autopilot contract tests.

Covers: nullable project.language + automation defaults, deterministic offline
language detection (Arabic-block ratio >= 0.25), the auto chain
(parse -> auto.language.detect -> auto.requirements.confirm_all -> auto.generate)
from both directions (doc-then-spec and spec-then-doc), the manual-mode gate,
the double-trigger guard, and the auto.* audit trail attribution.
"""
import threading
import time

from conftest import import_spec, items_of, poll_job

from app import jobs as jobstore
from app.db import SessionLocal
from app.models import AuditEntry, Project, User
from app.modules.generation import try_autopilot_generation
from app.modules.ingestion import detect_language

ARABIC_MD = """# المتطلبات

REQ-001: يجب أن يبدأ رقم الجوال بـ 05 وأن يتكوّن من 10 أرقام فقط عند إنشاء العميل عبر POST /customers.
- رفض أي رقم لا يطابق الصيغة 05XXXXXXXX بالرمز 422 (invalid phone rejected)
- قبول رقم صحيح مثل 0512345678 (valid phone accepted for customers)

REQ-002: يجب أن يكون عمر العميل بين 18 و120 عاماً عند إنشاء customer جديد.
- رفض age أقل من 18 بالرمز 422 (customers age minimum)
- رفض age أكبر من 120 بالرمز 422 (age maximum accepted boundary)
"""

ENGLISH_MD = """# Requirements

REQ-001: The system must validate the customer phone number on POST /customers.
- reject any phone that does not match 05XXXXXXXX with a 422 (invalid phone rejected)
- accept a valid phone such as 0512345678 (valid phone accepted for customers)

REQ-002: The customer age must be between 18 and 120 when creating a customer.
- reject age below 18 with 422 (customers age minimum)
- reject age above 120 with 422 (age maximum boundary)
"""


# ------------------------------------------------------------------ helpers

def _upload_md(client, headers, project_id, tmp_path, content, name="reqs.md"):
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    with path.open("rb") as fh:
        r = client.post(f"/v1/projects/{project_id}/documents",
                        files={"file": (path.name, fh, "text/markdown")},
                        headers=headers)
    assert r.status_code in (200, 201, 202), f"upload failed: {r.status_code} {r.text}"
    return r.json()


def _project(client, headers, project_id):
    r = client.get(f"/v1/projects/{project_id}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _requirement_states(client, headers, project_id):
    r = client.get(f"/v1/projects/{project_id}/requirements", headers=headers)
    assert r.status_code == 200, r.text
    return [q.get("state") for q in items_of(r.json())]


def _draft_cases(client, headers, project_id):
    r = client.get(f"/v1/projects/{project_id}/test-cases",
                   params={"state": "draft"}, headers=headers)
    assert r.status_code == 200, r.text
    return items_of(r.json())


def _wait_for_drafts(client, headers, project_id, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        drafts = _draft_cases(client, headers, project_id)
        if drafts:
            return drafts
        time.sleep(0.2)
    raise AssertionError("autopilot never produced draft test cases")


def _audit_rows(project_id, action=None):
    db = SessionLocal()
    try:
        q = db.query(AuditEntry).filter(AuditEntry.object_id == project_id)
        if action:
            q = q.filter(AuditEntry.action == action)
        return [(a.action, a.actor_id, dict(a.detail or {})) for a in q.all()]
    finally:
        db.close()


# ------------------------------------------------------------------ unit: detection

def test_detect_language_arabic():
    assert detect_language("يجب أن يعرض النظام قائمة الطلبات للمستخدم") == "ar"


def test_detect_language_english():
    assert detect_language("The system shall display the list of orders.") == "en"


def test_detect_language_mixed_threshold():
    # 3 Arabic letters out of 12 alphabetic = exactly 0.25 -> "ar" (>= threshold)
    assert detect_language("abcdefghi يجب") == "ar"
    # 3 Arabic letters out of 13 alphabetic < 0.25 -> "en"
    assert detect_language("abcdefghij يجب") == "en"


def test_detect_language_no_alphabetic_defaults_to_en():
    assert detect_language("") == "en"
    assert detect_language("1234 5678 --- !!") == "en"


# ------------------------------------------------------------------ project schema

def test_create_project_without_language_defaults(client, register_org):
    headers = register_org()
    r = client.post("/v1/projects", json={"name": "بدون لغة"}, headers=headers)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["language"] is None
    assert data["automation"] == "auto"


def test_create_project_explicit_language_and_manual(client, register_org):
    headers = register_org()
    r = client.post("/v1/projects",
                    json={"name": "P", "language": "en", "automation": "manual"},
                    headers=headers)
    assert r.status_code == 201, r.text
    data = r.json()
    assert data["language"] == "en"
    assert data["automation"] == "manual"


def test_create_project_rejects_bad_values(client, register_org):
    headers = register_org()
    r = client.post("/v1/projects", json={"name": "P", "language": "fr"}, headers=headers)
    assert r.status_code == 422
    r = client.post("/v1/projects", json={"name": "P", "automation": "sometimes"},
                    headers=headers)
    assert r.status_code == 422


def test_update_project_automation_and_language(client, register_org):
    headers = register_org()
    r = client.post("/v1/projects", json={"name": "P"}, headers=headers)
    pid = r.json()["id"]
    r = client.patch(f"/v1/projects/{pid}",
                     json={"automation": "manual", "language": "ar"}, headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["automation"] == "manual"
    assert r.json()["language"] == "ar"
    r = client.patch(f"/v1/projects/{pid}", json={"automation": "bogus"}, headers=headers)
    assert r.status_code == 422


def test_legacy_create_with_language_still_works(client, register_org, create_project):
    # the conftest fixture sends {"name", "language": "ar"} exactly like old clients
    headers = register_org()
    pid = create_project(headers)
    p = _project(client, headers, pid)
    assert p["language"] == "ar"
    assert p["automation"] == "auto"


# ------------------------------------------------------------------ autopilot flow

def test_autopilot_spec_then_doc_full_chain(client, register_org, tmp_path):
    """Spec imported first; the doc parse job then runs the whole 4a chain and
    its 4b trigger produces draft cases — with NO manual confirm_all/generate."""
    headers = register_org()
    pid = client.post("/v1/projects", json={"name": "منصة الطلبات"},
                      headers=headers).json()["id"]
    import_spec(client, headers, pid)  # no confirmed requirements yet => no trigger
    assert _draft_cases(client, headers, pid) == []

    upload = _upload_md(client, headers, pid, tmp_path, ARABIC_MD)
    job = poll_job(client, headers, upload["job_id"])
    result = job.get("result") or {}

    # language detected and persisted on the project
    assert result.get("language_detected") == "ar"
    assert _project(client, headers, pid)["language"] == "ar"

    # all extracted requirements auto-confirmed
    assert result.get("auto_confirmed", 0) >= 2
    states = _requirement_states(client, headers, pid)
    assert states and all(s == "confirmed" for s in states)

    # generation auto-triggered; draft cases appear, and stay drafts (BO-07)
    gen_job_id = result.get("generation_job_id")
    assert gen_job_id, f"autopilot did not enqueue generation: {result}"
    gen = poll_job(client, headers, gen_job_id)
    assert (gen.get("result") or {}).get("generated", 0) > 0
    drafts = _draft_cases(client, headers, pid)
    assert drafts
    assert all(c.get("state") == "draft" for c in drafts)
    r = client.get(f"/v1/projects/{pid}/test-cases",
                   params={"state": "approved"}, headers=headers)
    assert items_of(r.json()) == []  # approval stays manual

    # audit trail: every auto step present, attributed to the uploading user
    actions = _audit_rows(pid)
    by_action = {a: (actor, detail) for a, actor, detail in actions}
    for expected in ("auto.language.detect", "auto.requirements.confirm_all",
                     "auto.generate"):
        assert expected in by_action, f"missing audit '{expected}': {sorted(by_action)}"
        assert by_action[expected][0], f"audit '{expected}' has no actor"
    assert by_action["auto.language.detect"][1].get("language") == "ar"
    assert by_action["auto.generate"][1].get("depth") == "standard"


def test_autopilot_doc_then_spec_triggers_on_import(client, register_org, tmp_path):
    """Doc parsed first (confirms requirements; no endpoints yet, so no trigger);
    the spec import then fires the 4b trigger and draft cases appear."""
    headers = register_org()
    pid = client.post("/v1/projects", json={"name": "P"}, headers=headers).json()["id"]

    upload = _upload_md(client, headers, pid, tmp_path, ENGLISH_MD)
    job = poll_job(client, headers, upload["job_id"])
    result = job.get("result") or {}
    assert result.get("language_detected") == "en"
    assert result.get("auto_confirmed", 0) >= 2
    assert "generation_job_id" not in result  # endpoint inventory still empty
    assert _draft_cases(client, headers, pid) == []

    import_spec(client, headers, pid)
    drafts = _wait_for_drafts(client, headers, pid)
    assert all(c.get("state") == "draft" for c in drafts)
    assert _audit_rows(pid, "auto.generate"), "spec import did not audit auto.generate"


def test_manual_mode_nothing_auto_happens(client, register_org, tmp_path):
    headers = register_org()
    pid = client.post("/v1/projects", json={"name": "P", "automation": "manual"},
                      headers=headers).json()["id"]
    import_spec(client, headers, pid)
    upload = _upload_md(client, headers, pid, tmp_path, ARABIC_MD)
    poll_job(client, headers, upload["job_id"])

    # requirements extracted but NOT confirmed; no generation; no cases
    states = _requirement_states(client, headers, pid)
    assert states and all(s == "extracted" for s in states)
    time.sleep(0.5)  # give a wrongly-fired generation job time to betray itself
    assert _draft_cases(client, headers, pid) == []
    assert _audit_rows(pid, "auto.requirements.confirm_all") == []
    assert _audit_rows(pid, "auto.generate") == []
    # language detection (contract item 3) is not gated by automation:
    # it fills the still-null language even in manual mode
    assert _project(client, headers, pid)["language"] == "ar"


def test_explicit_language_never_overwritten(client, register_org, tmp_path):
    headers = register_org()
    pid = client.post("/v1/projects", json={"name": "P", "language": "en"},
                      headers=headers).json()["id"]
    upload = _upload_md(client, headers, pid, tmp_path, ARABIC_MD)
    poll_job(client, headers, upload["job_id"])
    assert _project(client, headers, pid)["language"] == "en"
    assert _audit_rows(pid, "auto.language.detect") == []


def test_generation_double_trigger_guard(client, register_org, tmp_path):
    """With a generation job already queued/running for the project, the
    autopilot trigger declines to enqueue a second one."""
    headers = register_org()
    pid = client.post("/v1/projects", json={"name": "P"}, headers=headers).json()["id"]
    import_spec(client, headers, pid)
    upload = _upload_md(client, headers, pid, tmp_path, ENGLISH_MD)
    result = poll_job(client, headers, upload["job_id"]).get("result") or {}
    first_job = result.get("generation_job_id")
    assert first_job
    poll_job(client, headers, first_job)  # let the real one finish

    db = SessionLocal()
    try:
        project = db.get(Project, pid)
        actor = db.query(User).filter(
            User.organisation_id == project.organisation_id).first()
        release = threading.Event()
        blocker = jobstore.submit("generate", lambda j: release.wait(10),
                                  project_id=pid)
        try:
            assert jobstore.has_active("generate", pid)
            assert try_autopilot_generation(
                db, project.organisation_id, actor.id, pid) is None
        finally:
            release.set()
        deadline = time.time() + 5
        while jobstore.get(blocker.id).status in ("queued", "running"):
            assert time.time() < deadline, "blocker job never finished"
            time.sleep(0.05)
        # guard lifted once no generation job is active any more
        new_job = try_autopilot_generation(db, project.organisation_id, actor.id, pid)
        assert new_job, "trigger should fire again once the active job is gone"
        poll_job(client, headers, new_job)
    finally:
        db.close()
