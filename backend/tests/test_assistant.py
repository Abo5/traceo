"""The project assistant answers from this project's rows, or declines.

Three properties are worth a test, and they are the three that make the panel
safe to put in front of someone: it says nothing before there is anything to
say, it never crosses a project boundary, and it never answers a question the
project's data does not bear on.
"""
from __future__ import annotations

from app.db import SessionLocal
from app.models import (Environment, Requirement, RequirementTestCase, Run,
                        TestCase, TestResult)


def _claims(headers) -> dict:
    import base64, json
    payload = headers["Authorization"].split(" ", 1)[1].split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))


def _ids(headers) -> tuple[str, str]:
    """(organisation, user) as the token states them."""
    c = _claims(headers)
    return c["org"], c["sub"]


def _seed_run(org_id: str, user_id: str, project_id: str,
              *, outcome: str = "failed") -> dict:
    """One requirement, one case, one completed run holding one result."""
    with SessionLocal() as db:
        req = Requirement(organisation_id=org_id, project_id=project_id,
                          external_id="BRD-014", description="Email is mandatory",
                          acceptance_criteria=["refused when empty"], type="functional",
                          priority="high", source_text="", version=1)
        db.add(req)
        db.flush()
        case = TestCase(organisation_id=org_id, project_id=project_id,
                        title="Form: 'signup' rejects submission with Email empty",
                        description="Derived from the 'signup' form.", preconditions="",
                        type="negative", priority="high", state="draft", generated=True,
                        technique="ep", test_type="functional")
        db.add(case)
        db.flush()
        db.add(RequirementTestCase(requirement_id=req.id, test_case_id=case.id,
                                   link_source="generated", requirement_version_at_link=1))
        # A Run needs somewhere it ran; the assistant never reads it, but the
        # schema is right to insist a result came from a place.
        env = Environment(organisation_id=org_id, project_id=project_id,
                          name="test", base_url="http://127.0.0.1:9", auth_type="none",
                          variables={})
        db.add(env)
        db.flush()
        run = Run(organisation_id=org_id, project_id=project_id,
                  environment_id=env.id, initiated_by=user_id, state="completed",
                  counts={"total": 1, "passed": 0, "failed": 1, "errored": 0, "skipped": 0})
        db.add(run)
        db.flush()
        db.add(TestResult(
            run_id=run.id, test_case_id=case.id, test_case_version=1, outcome=outcome,
            duration_ms=120,
            failure_reason={"message": "The form accepted an empty #email and submitted."},
            evidence=[]))
        db.commit()
        return {"case_id": case.id, "run_id": run.id, "req": req.external_id}


def test_assistant_is_shut_until_a_run_has_completed(client, register_org, create_project):
    headers = register_org("Assistant Org")
    project = create_project(headers, "Quiet Project")

    state = client.get(f"/v1/projects/{project}/assistant", headers=headers)
    assert state.status_code == 200
    assert state.json()["available"] is False
    assert state.json()["reason"] == "no_completed_run"

    # And it refuses rather than inventing an answer from an empty project.
    r = client.post(f"/v1/projects/{project}/assistant",
                    json={"question": "what failed?"}, headers=headers)
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["code"] == "no_completed_run"


def test_it_answers_from_the_rows_and_cites_them(client, register_org, create_project):
    headers = register_org("Assistant Org 2")
    project = create_project(headers, "Answering Project")
    seeded = _seed_run(*_ids(headers), project)

    assert client.get(f"/v1/projects/{project}/assistant",
                      headers=headers).json()["available"] is True

    r = client.post(f"/v1/projects/{project}/assistant",
                    json={"question": "what failed?"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["intent"] == "failures"
    # The reason came from the recorded result, not from a paraphrase of it.
    assert "accepted an empty #email" in body["answer"]
    assert any(c["id"] == seeded["case_id"] for c in body["cites"])
    # Every reply says what produced it, so a reader can weigh it.
    assert body["engine"] == "deterministic"

    # Naming a case answers about that case, including what it traces to.
    named = client.post(f"/v1/projects/{project}/assistant",
                        json={"question": f"why did {seeded['case_id'][:8]} fail?"},
                        headers=headers).json()
    assert named["intent"] == "case"
    assert seeded["req"] in named["answer"]


def test_it_declines_questions_the_project_cannot_answer(client, register_org, create_project):
    headers = register_org("Assistant Org 3")
    project = create_project(headers, "Scoped Project")
    _seed_run(*_ids(headers), project)

    r = client.post(f"/v1/projects/{project}/assistant",
                    json={"question": "what is the capital of France?"},
                    headers=headers).json()
    # "What is …" opens a question about anything. Answering it with a list of
    # the project's defects would be confidently off-topic.
    assert r["intent"] == "unknown"
    assert "this project's own rows" in r["answer"]
    assert r["cites"] == []


def test_it_cannot_be_pointed_at_another_organisation(client, register_org, create_project):
    owner = register_org("Owner Org")
    project = create_project(owner, "Private Project")
    _seed_run(*_ids(owner), project)

    stranger = register_org("Stranger Org")
    assert client.get(f"/v1/projects/{project}/assistant",
                      headers=stranger).status_code == 404
    assert client.post(f"/v1/projects/{project}/assistant",
                       json={"question": "what failed?"},
                       headers=stranger).status_code == 404
