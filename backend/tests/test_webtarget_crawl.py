"""The authenticated crawl — signing in, following links, and refusing to lie.

The claims under test, each one a thing that would be a real incident if it
stopped holding:

  * a credential NEVER reaches the wire, the argv, the audit log or an error
    message. The password travels in the child's environment and nowhere else;
  * a crawl asked to sign in with the OPERATOR's credentials and unable to prove
    it did FAILS with login_failed, generically — never crawls the logged-out
    product and reports success;
  * a page that asks to be signed into and has no credentials to try is reported
    as login_required with the form's own selectors — an outcome, not an error;
  * credentials the login page publishes about ITSELF are a fact about the page
    and may be used and named; a credential the user supplied never is;
  * every page the crawl visited produces its own requirements and cases, keyed
    so a re-crawl refreshes them instead of forking them;
  * grounding still does not bend: a case may only cite artefacts from the page
    it is about. The oracle for that is shown failing before it is trusted.

Nothing here starts a browser. The sidecar seam is replaced with a recorded
multi-page document — a unit test that shells out to Chromium is a network test
wearing a costume.
"""
import copy
import json
import time
from pathlib import Path

import pytest

from app.config import settings
from app.db import SessionLocal
from app.models import Requirement, WebTarget
from app.modules import webtarget
from app.modules.webtarget import (CRAWL_PASSWORD_ENV, DEFAULT_MAX_PAGES, CrawlPlan,
                                   MAX_PAGES, MIN_PAGES, _sidecar_env, artefact_ids,
                                   crawl_requests, grounding_violations, login_outcome,
                                   normalise_login, normalise_pages, outcome_sentence,
                                   page_token, sidecar_command)

FIXTURES = Path(__file__).resolve().parent / "fixtures"
LOGIN_URL = "http://localhost:8017/web/index.php/auth/login"
USERNAME = "Admin"
PASSWORD = "admin123"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def crawl_payload():
    """A recorded three-page crawl behind a login, with the skip list the safety
    rule produced: a logout link, a delete control and an off-origin link."""
    doc = json.loads((FIXTURES / "webtarget_crawl.json").read_text())
    shot = str(FIXTURES / "webtarget_screen.png")
    doc["screenshot"] = shot
    for page in doc["pages"]:
        if page.get("screenshot"):
            page["screenshot"] = shot
    return doc


@pytest.fixture()
def login_page_payload():
    """The single page a crawl sees when it cannot get in: the login screen."""
    return {
        "url": LOGIN_URL, "final_url": LOGIN_URL, "title": "OrangeHRM",
        "viewport": "1280x800", "elapsed_ms": 900, "screenshot": "",
        "forms": [{
            "selector": "form.oxd-form",
            "heading": "Login",
            "submits": [{"selector": "form.oxd-form button[type=submit]", "name": "Login"}],
            "fields": [
                {"selector": "input[name=username]", "name": "username", "type": "text",
                 "required": True},
                {"selector": "input[name=password]", "name": "password", "type": "password",
                 "required": True},
            ],
        }],
        "controls": [], "requests": [], "console_errors": [],
    }


@pytest.fixture()
def project(client, register_org, create_project):
    """automation="manual": the autopilot chain would confirm these requirements
    out from under the assertions, and it has its own test."""
    headers = register_org("Crawl Org")
    return headers, create_project(headers, "Crawl Project", automation="manual")


@pytest.fixture(autouse=True)
def _allow_local_targets(monkeypatch):
    monkeypatch.setattr(settings, "ALLOW_PRIVATE_TARGETS", True)


@pytest.fixture()
def sidecar(monkeypatch):
    """Install a recorded document and capture what the job asked the browser
    for — including the crawl plan, so the password's route can be asserted."""
    calls = []

    def install(doc):
        def _fake(url, viewport, out_dir, timeout_s=None, crawl=None):
            calls.append({"url": url, "viewport": viewport, "crawl": crawl})
            return copy.deepcopy(doc)
        monkeypatch.setattr(webtarget, "run_sidecar", _fake)
        return calls

    return install


def poll(client, headers, job_id, timeout=60.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/v1/jobs/{job_id}", headers=headers)
        assert r.status_code == 200, r.text
        job = r.json()
        if job["status"] in ("completed", "failed"):
            return job
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} never finished")


def start(client, headers, project_id, **body):
    body.setdefault("url", LOGIN_URL)
    body.setdefault("test_types", ["functional", "performance"])
    return client.post(f"/v1/projects/{project_id}/web-targets", json=body, headers=headers)


def run(client, headers, project_id, **body):
    r = start(client, headers, project_id, **body)
    assert r.status_code == 202, r.text
    return poll(client, headers, r.json()["job_id"]), r.json()


# ---------------------------------------------------------------------------
# 1. The page budget
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("value", [0, 51, -1, "abc", 2.5, True])
def test_a_page_budget_outside_the_range_is_refused_with_the_range(client, project, value):
    headers, pid = project
    r = start(client, headers, pid, max_pages=value)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_max_pages"
    # The bounds travel with the refusal, so a caller can fix it without docs.
    assert detail["errors"] == [str(MIN_PAGES), str(MAX_PAGES)]
    # and a refused request leaves nothing behind
    assert client.get(f"/v1/projects/{pid}/web-targets",
                      headers=headers).json()["web_targets"] == []


def test_the_default_explores_rather_than_waiting_to_be_asked(client, project, sidecar,
                                                              login_page_payload):
    """The owner's complaint, encoded: a URL handed to Traceo means "look at the
    product", not "look at one screen"."""
    headers, pid = project
    calls = sidecar(login_page_payload)
    r = start(client, headers, pid)
    assert r.status_code == 202
    assert r.json()["max_pages"] == DEFAULT_MAX_PAGES == 25
    poll(client, headers, r.json()["job_id"])
    assert calls[0]["crawl"].max_pages == 25


def test_the_boundaries_themselves_are_accepted(client, project, sidecar, login_page_payload):
    headers, pid = project
    sidecar(login_page_payload)
    for value in (MIN_PAGES, MAX_PAGES):
        r = start(client, headers, pid, max_pages=value)
        assert r.status_code == 202, r.text
        assert r.json()["max_pages"] == value


def test_a_re_run_keeps_the_budget_the_target_was_configured_with(client, project, sidecar,
                                                                  login_page_payload):
    headers, pid = project
    sidecar(login_page_payload)
    assert start(client, headers, pid, max_pages=7).json()["max_pages"] == 7
    # omitting it is not "reset to the default"
    assert start(client, headers, pid).json()["max_pages"] == 7


# ---------------------------------------------------------------------------
# 2. Credentials — refused blank, and never on the wire
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("auth", [
    {"username": "", "password": PASSWORD},
    {"username": "   ", "password": PASSWORD},
    {"username": USERNAME, "password": ""},
    {"username": USERNAME, "password": "   "},
    {"username": USERNAME},
    {"password": PASSWORD},
    "Admin:admin123",
])
def test_half_a_credential_is_refused_without_naming_which_half(client, project, auth):
    headers, pid = project
    r = start(client, headers, pid, auth=auth)
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "invalid_credentials"
    # It must not say which of the two was blank, and must not echo either.
    assert USERNAME not in detail["message"] and PASSWORD not in detail["message"]
    assert client.get(f"/v1/projects/{pid}/web-targets",
                      headers=headers).json()["web_targets"] == []


def test_a_stored_credential_never_comes_back_out(client, project, sidecar, crawl_payload):
    headers, pid = project
    sidecar(crawl_payload)
    accepted = start(client, headers, pid,
                     auth={"username": USERNAME, "password": PASSWORD}).json()
    assert accepted["auth_configured"] is True
    poll(client, headers, accepted["job_id"])

    detail = client.get(f"/v1/web-targets/{accepted['target_id']}", headers=headers)
    body = detail.text
    assert detail.status_code == 200
    assert detail.json()["auth_configured"] is True
    # The whole serialised payload, not just the fields we thought to check.
    assert PASSWORD not in body
    assert '"username"' not in body or USERNAME not in body

    listed = client.get(f"/v1/projects/{pid}/web-targets", headers=headers)
    assert PASSWORD not in listed.text

    # and the row itself holds ciphertext, not a readable secret
    db = SessionLocal()
    try:
        row = db.get(WebTarget, accepted["target_id"])
        assert row.auth_config_encrypted
        assert PASSWORD.encode() not in row.auth_config_encrypted
    finally:
        db.close()


def test_the_password_travels_in_the_environment_and_never_in_argv():
    """`ps` is readable by every user on the host. A password in argv is an
    incident even when the job log is clean."""
    plan = CrawlPlan(max_pages=5, username=USERNAME, password=PASSWORD)
    argv = sidecar_command(LOGIN_URL, "1280x800", "/tmp/out", 30000, plan)
    assert PASSWORD not in " ".join(argv)
    assert "--max-pages" in argv and "5" in argv
    assert USERNAME in argv  # the username is not a secret; it identifies the run

    env = _sidecar_env(plan)
    assert env[CRAWL_PASSWORD_ENV] == PASSWORD


def test_an_inherited_password_cannot_leak_into_an_anonymous_crawl(monkeypatch):
    """A server process that happens to carry the variable must not make an
    unauthenticated crawl sign in as somebody else."""
    monkeypatch.setenv(CRAWL_PASSWORD_ENV, "somebody-elses-secret")
    assert CRAWL_PASSWORD_ENV not in _sidecar_env(None)
    assert CRAWL_PASSWORD_ENV not in _sidecar_env(CrawlPlan(max_pages=3))


def test_the_audit_trail_records_that_there_were_credentials_not_what_they_were(
        client, project, sidecar, crawl_payload):
    headers, pid = project
    sidecar(crawl_payload)
    accepted = start(client, headers, pid,
                     auth={"username": USERNAME, "password": PASSWORD}).json()
    poll(client, headers, accepted["job_id"])
    entries = client.get("/v1/audit", headers=headers)
    assert entries.status_code == 200, entries.text
    assert PASSWORD not in entries.text and USERNAME not in entries.text
    requested = [e for e in entries.json()["items"] if e["action"] == "web_target.requested"]
    assert requested and requested[0]["detail"]["auth_configured"] is True


# ---------------------------------------------------------------------------
# 3. A sign-in that fails is a failure, not a quieter success
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("login_block", [
    {"attempted": True, "succeeded": False, "strategy": "",
     "error": "invalid credentials for Admin / admin123"},
    None,  # the sidecar said nothing at all about signing in
])
def test_supplied_credentials_that_are_rejected_fail_the_job(client, project, sidecar,
                                                             login_page_payload, login_block):
    headers, pid = project
    doc = dict(login_page_payload)
    if login_block is not None:
        doc["login"] = login_block
    sidecar(doc)

    job, accepted = run(client, headers, pid,
                        auth={"username": USERNAME, "password": PASSWORD})
    assert job["status"] == "failed"
    assert job["error_code"] == "login_failed"
    message = job["error"]
    # Generic on purpose: naming the wrong half confirms the other half exists.
    assert USERNAME not in message and PASSWORD not in message
    assert "password" in message.lower() and "username" in message.lower()
    assert "wrong password" not in message.lower()
    # even though the sidecar's own message contained both, it was replaced
    assert "invalid credentials" not in message.lower()

    target = client.get(f"/v1/web-targets/{accepted['target_id']}", headers=headers).json()
    assert target["status"] == "failed"
    assert PASSWORD not in json.dumps(target)


def test_a_rejected_sign_in_persists_nothing_from_the_logged_out_page(client, project,
                                                                     sidecar,
                                                                     login_page_payload):
    """The failure mode this rule exists to stop: testing the logged-out product
    and calling it the product."""
    headers, pid = project
    doc = dict(login_page_payload)
    doc["login"] = {"attempted": True, "succeeded": False}
    sidecar(doc)
    job, _ = run(client, headers, pid, auth={"username": USERNAME, "password": PASSWORD})
    assert job["status"] == "failed"

    db = SessionLocal()
    try:
        assert db.query(Requirement).filter(Requirement.project_id == pid).count() == 0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 4. No credentials at all is an OUTCOME, not an error
# ---------------------------------------------------------------------------

def test_a_login_page_with_nothing_to_try_reports_login_required(client, project, sidecar,
                                                                 login_page_payload):
    headers, pid = project
    sidecar(login_page_payload)
    job, _ = run(client, headers, pid)

    assert job["status"] == "completed", job.get("error")
    result = job["result"]
    assert result["credentials_source"] is None
    assert result["login"]["succeeded"] is False
    assert result["login"]["required"] is True
    # the form's OWN selectors, so the UI points at what the page rendered
    assert result["login"]["form"]["selector"] == "form.oxd-form"
    assert "input[name=password]" in result["login"]["form"]["fields"]
    assert "username and password" in result["outcome"]
    # and the public surface it COULD see was still reported
    assert result["forms"] == 1


def test_the_public_surface_is_still_worth_something(client, project, sidecar,
                                                     login_page_payload):
    headers, pid = project
    sidecar(login_page_payload)
    job, _ = run(client, headers, pid)
    assert sum(job["result"]["cases_by_type"].values()) > 0


# ---------------------------------------------------------------------------
# 5. Where a credential came from is itself reported
# ---------------------------------------------------------------------------

def test_credentials_the_page_publishes_about_itself_are_named_as_such(client, project,
                                                                       sidecar,
                                                                       crawl_payload):
    headers, pid = project
    sidecar(crawl_payload)
    job, _ = run(client, headers, pid)
    result = job["result"]
    assert result["login"]["succeeded"] is True
    assert result["credentials_source"] == "page"
    assert "publishes about itself" in result["outcome"]


def test_a_supplied_credential_is_never_relabelled_as_a_page_fact(client, project, sidecar,
                                                                  crawl_payload):
    """The sidecar reports "page" in this document. When the operator supplied
    the credentials, only THIS process knows that — and it is what decides."""
    headers, pid = project
    sidecar(crawl_payload)
    job, _ = run(client, headers, pid, auth={"username": USERNAME, "password": PASSWORD})
    assert job["result"]["credentials_source"] == "user"
    assert "publishes about itself" not in job["result"]["outcome"]
    assert PASSWORD not in json.dumps(job["result"])


def test_normalise_login_keeps_the_code_and_drops_the_sentence():
    """The sidecar's login error is a {code, message} pair. The CODE is the
    outcome and must survive — login_required lives in it — while the message is
    free text about a failed sign-in, which is where a credential would hide."""
    doc = {"login": {"attempted": True, "succeeded": True, "strategy": "url_changed",
                     "credentials_source": "page",
                     "error": {"code": "login_required",
                               "message": f"tried {USERNAME} / {PASSWORD}"}}}
    login = normalise_login(doc, supplied=False)
    assert login["error"] == "login_required"
    assert PASSWORD not in json.dumps(login)
    assert USERNAME not in json.dumps(login)
    # an invented code is not passed through as though it were meaningful
    doc["login"]["error"] = {"code": "definitely_fine", "message": "x"}
    assert normalise_login(doc, supplied=False)["error"] is None
    # ...and neither is a bare sentence with no code at all
    doc["login"]["error"] = f"tried {USERNAME} / {PASSWORD}"
    assert normalise_login(doc, supplied=False)["error"] is None

    # an unknown provenance is not passed through either
    doc["login"]["credentials_source"] = "telepathy"
    assert normalise_login(doc, supplied=False)["credentials_source"] is None


def test_login_required_reaches_the_payload_from_the_sidecars_verdict(client, project,
                                                                     sidecar,
                                                                     login_page_payload):
    """The crawler's own verdict, not only our re-reading of the DOM: a page
    whose form we could not parse must still be reported as gated."""
    headers, pid = project
    doc = dict(login_page_payload)
    doc["login"] = {"attempted": False, "succeeded": False,
                    "error": {"code": "login_required",
                              "message": "no credentials were available"}}
    doc["forms"] = []  # nothing for login_form() to find
    sidecar(doc)
    job, accepted = run(client, headers, pid)

    assert job["status"] == "completed", job.get("error")
    login = job["result"]["login"]
    assert login["error"] == "login_required"
    assert login["required"] is True
    assert login["succeeded"] is False
    assert "username and password" in job["result"]["outcome"]

    detail = client.get(f"/v1/web-targets/{accepted['target_id']}", headers=headers).json()
    assert detail["inventory"]["login"]["error"] == "login_required"


# ---------------------------------------------------------------------------
# 6. Every page the crawl reached produces its own work
# ---------------------------------------------------------------------------

def test_the_result_accounts_for_every_page_visited_and_every_page_refused(client, project,
                                                                          sidecar,
                                                                          crawl_payload):
    headers, pid = project
    sidecar(crawl_payload)
    job, _ = run(client, headers, pid)
    result = job["result"]
    assert result["pages_visited"] == 3
    reasons = {s["url"]: s["reason"] for s in result["pages_skipped"]}
    assert len(reasons) == 4
    # the safety rule, visible in the report rather than only in the crawler
    assert any("Logout" in r for r in reasons.values())
    assert any("Delete" in r for r in reasons.values())
    assert any("origin" in r for r in reasons.values())


def test_each_page_states_its_own_requirements_under_its_own_id(client, project, sidecar,
                                                                crawl_payload):
    headers, pid = project
    sidecar(crawl_payload)
    job, _ = run(client, headers, pid, test_types=["functional", "performance"])
    assert job["status"] == "completed", job.get("error")

    db = SessionLocal()
    try:
        rows = db.query(Requirement).filter(Requirement.project_id == pid).all()
        ids = sorted(r.external_id for r in rows)
    finally:
        db.close()

    functional = [i for i in ids if "-F" in i]
    performance = [i for i in ids if i.endswith("-PERF")]
    # one requirement per form, and the three pages each carry one
    assert len(functional) == 3, ids
    # every page with a baseline gets its own performance statement
    assert len(performance) == 3, ids
    # the target page keeps the id scheme it has always had; the rest are keyed
    # on their own URL, not on their position in the crawl
    assert any(i.count("-") == 2 for i in functional), ids
    assert all(len(set(ids)) == len(ids) for _ in [0])


def test_re_crawling_refreshes_the_same_requirements_instead_of_forking_them(
        client, project, sidecar, crawl_payload):
    headers, pid = project
    sidecar(crawl_payload)
    run(client, headers, pid, test_types=["functional"])
    db = SessionLocal()
    try:
        first = sorted(r.external_id for r in
                       db.query(Requirement).filter(Requirement.project_id == pid).all())
    finally:
        db.close()

    run(client, headers, pid, test_types=["functional"])
    db = SessionLocal()
    try:
        second = sorted(r.external_id for r in
                        db.query(Requirement).filter(Requirement.project_id == pid).all())
    finally:
        db.close()
    assert first == second and first


def test_a_page_token_is_a_property_of_the_page_not_of_its_position():
    pages = [{"final_url": "http://x/a"}, {"final_url": "http://x/b"},
             {"final_url": "http://x/c"}]
    tokens = [page_token(p, i) for i, p in enumerate(pages)]
    assert tokens[0] == ""  # the target itself keeps the established scheme
    assert len(set(tokens)) == 3
    # the same page keeps its token when something ahead of it disappears
    assert page_token(pages[2], 1) == page_token(pages[2], 2)


def test_the_request_inventory_is_deduplicated_across_pages_but_not_within_one():
    shell = {"method": "GET", "url": "http://x/api/me", "resource_type": "xhr",
             "status": 200}
    pages = [
        {"requests": [dict(shell), dict(shell)]},   # called twice on one page
        {"requests": [dict(shell)]},                # the same call on the next page
    ]
    out = crawl_requests(pages)
    assert len(out) == 2, "a repeat within a page is a second observation"


# ---------------------------------------------------------------------------
# 7. Grounding — with an oracle shown failing before it is trusted
# ---------------------------------------------------------------------------

def test_the_grounding_oracle_can_fail(crawl_payload):
    """A gate that has never rejected anything is not evidence."""
    pages = normalise_pages(crawl_payload)
    page_one, page_two = artefact_ids(pages[0]), artefact_ids(pages[1])
    borrowed = pages[1]["forms"][0]["selector"]

    case = {"grounds": [f"selector:{borrowed}"]}
    # the oracle rejects it against the page that does NOT contain it ...
    assert grounding_violations(case, page_one), "the oracle accepted a foreign selector"
    # ... and accepts it against the page that does
    assert grounding_violations(case, page_two) == []


def test_no_case_may_cite_a_page_the_crawl_never_visited(crawl_payload):
    pages = normalise_pages(crawl_payload)
    ids = artefact_ids(pages[0])
    unvisited = {"grounds": ["page:http://localhost:8017/web/index.php/admin/secret"]}
    assert grounding_violations(unvisited, ids)


def test_every_case_from_a_page_cites_that_page(crawl_payload):
    pages = normalise_pages(crawl_payload)
    for page in pages:
        ids = artefact_ids(page)
        for form in page["forms"]:
            cases = webtarget.form_cases(form, page)
            assert cases
            for case in cases:
                assert grounding_violations(case, ids) == []
                assert any(g.startswith("page:") for g in case["grounds"])


# ---------------------------------------------------------------------------
# 8. The outcome reads like a report
# ---------------------------------------------------------------------------

def test_every_outcome_is_a_sentence_with_the_numbers_in_it():
    signed_in_by_page = login_outcome(
        {"attempted": True, "succeeded": True, "strategy": "url_changed",
         "credentials_source": "page", "reauthenticated": 0}, {"forms": []})
    sentence = outcome_sentence(signed_in_by_page, 12, 3, 8, 40)
    assert sentence.startswith("Signed in with the credentials the sign-in page publishes")
    assert "12 pages (3 skipped)" in sentence and "40 test cases" in sentence

    public = login_outcome(None, {"forms": [{"selector": "form", "fields": [
        {"selector": "#p", "type": "password"}]}]})
    assert "unlocks the pages behind the form" in outcome_sentence(public, 1, 0, 1, 2)

    plain = login_outcome(None, {"forms": []})
    assert outcome_sentence(plain, 1, 0, 1, 1) == \
        "Crawled 1 page, producing 1 requirement and 1 test case."
