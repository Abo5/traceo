"""A project declares which of the five kinds of testing it is for.

The choice is made when the project is created and is editable afterwards, and
the engines that produce cases answer to it. What these tests hold onto is the
part that is easy to get wrong: a project that says nothing must keep working
(all five), a project that narrows itself must be believed, and asking for a
type outside that declaration must be refused rather than quietly dropped —
silently running four tracks and reporting five is the failure mode worth
paying for a test.
"""
import pytest

from app.testtypes import TEST_TYPES


ALL_FIVE = list(TEST_TYPES)


@pytest.fixture()
def headers(register_org):
    return register_org()


def create(client, headers, **body):
    return client.post("/v1/projects", json={"name": "TT", **body}, headers=headers)


def test_the_five_types_are_the_ones_the_ui_offers():
    # The vocabulary is shared, so a drift here is a drift everywhere.
    assert ALL_FIVE == ["functional", "api", "ui", "performance", "security"]


def test_a_project_created_without_a_choice_is_for_every_type(client, headers):
    r = create(client, headers)
    assert r.status_code == 201, r.text
    assert r.json()["test_types"] == ALL_FIVE


def test_a_project_can_declare_a_subset_and_it_is_returned_canonically(client, headers):
    # listed out of order and with a duplicate — neither may change what runs
    r = create(client, headers, test_types=["security", "functional", "security"])
    assert r.status_code == 201, r.text
    assert r.json()["test_types"] == ["functional", "security"]


def test_the_choice_survives_a_reread(client, headers):
    pid = create(client, headers, test_types=["api"]).json()["id"]
    assert client.get(f"/v1/projects/{pid}", headers=headers).json()["test_types"] == ["api"]
    listed = client.get("/v1/projects", headers=headers).json()
    assert [p["test_types"] for p in listed if p["id"] == pid] == [["api"]]


def test_an_unknown_type_is_refused_and_the_legal_list_is_named(client, headers):
    r = create(client, headers, test_types=["functional", "perfomance"])  # typo on purpose
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_test_type"
    assert "perfomance" in detail["message"]
    assert detail["errors"] == ALL_FIVE  # the caller is told what IS allowed


def test_an_empty_choice_is_refused_rather_than_stored(client, headers):
    # A project that tests nothing is not a project; storing [] would also be
    # indistinguishable from a row that predates the field.
    r = create(client, headers, test_types=[])
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "invalid_test_type"


def test_the_choice_can_be_changed_afterwards_and_is_audited(client, headers):
    pid = create(client, headers, test_types=ALL_FIVE).json()["id"]

    r = client.patch(f"/v1/projects/{pid}", json={"test_types": ["ui", "performance"]},
                     headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["test_types"] == ["ui", "performance"]

    entries = client.get("/v1/audit", headers=headers).json()
    rows = entries["items"] if isinstance(entries, dict) else entries
    updates = [e for e in rows if e.get("action") == "project.update"
               and (e.get("detail") or {}).get("test_types")]
    assert updates, "changing the test types must leave an audit entry"
    change = updates[0]["detail"]["test_types"]
    assert change["from"] == ALL_FIVE and change["to"] == ["ui", "performance"]


def test_patching_an_unknown_type_leaves_the_stored_choice_alone(client, headers):
    pid = create(client, headers, test_types=["api"]).json()["id"]
    r = client.patch(f"/v1/projects/{pid}", json={"test_types": ["api", "nope"]},
                     headers=headers)
    assert r.status_code == 422
    assert client.get(f"/v1/projects/{pid}", headers=headers).json()["test_types"] == ["api"]


def test_a_row_that_predates_the_field_reads_as_all_five(client, headers):
    """Rows created before the column existed hold [], which must not disable them."""
    from app.db import SessionLocal
    from app.models import Project

    pid = create(client, headers, test_types=["api"]).json()["id"]
    db = SessionLocal()
    try:
        db.get(Project, pid).test_types = []      # exactly what the migration leaves
        db.commit()
    finally:
        db.close()

    assert client.get(f"/v1/projects/{pid}", headers=headers).json()["test_types"] == ALL_FIVE


def test_a_web_target_defaults_to_what_the_project_declared(client, headers, monkeypatch):
    """Omitting the types on a discovery runs the project's declaration."""
    from app.modules import webtarget

    pid = create(client, headers, test_types=["ui", "security"]).json()["id"]
    seen = {}

    def _capture(*args, **kwargs):
        seen["test_types"] = kwargs.get("test_types") or args[-1]
        raise webtarget.JobError("stop", code="stopped")

    monkeypatch.setattr(webtarget, "run_discovery", _capture, raising=False)
    r = client.post(f"/v1/projects/{pid}/web-targets",
                    json={"url": "https://example.com/page"}, headers=headers)
    assert r.status_code == 202, r.text
    assert r.json()["test_types"] == ["ui", "security"]


def test_a_web_target_cannot_ask_for_a_type_the_project_excluded(client, headers):
    pid = create(client, headers, test_types=["ui"]).json()["id"]
    r = client.post(f"/v1/projects/{pid}/web-targets",
                    json={"url": "https://example.com/page",
                          "test_types": ["ui", "security"]},
                    headers=headers)
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "test_type_not_in_project"
    assert "security" in detail["message"]
    assert detail["errors"] == ["ui"]  # what this project IS set up for
