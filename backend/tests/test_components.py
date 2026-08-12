"""Component inventory (security plan S2) — SBOM and lockfile import.

WHAT THIS GATE PROTECTS
-----------------------
The component inventory is the precondition for the whole CVE track: a CVE only
becomes actionable when it matches something the target actually runs. Two
properties therefore matter more than parser breadth:

  1. **Nothing is invented.** An unpinned dependency has NO version, and the
     inventory says so — a guessed version would produce confident CVE matches
     against software the project may not contain.
  2. **Re-import updates, never duplicates.** The inventory is a set, not a log;
     uploading the same SBOM twice must not double it.

Everything below is driven from small committed fixtures in
tests/fixtures/components/ so the parsers are checked against real file shapes
rather than strings built in the test.
"""
import json
from pathlib import Path

import pytest

from app.modules import components as comp
from conftest import poll_job

FIXTURES = Path(__file__).parent / "fixtures" / "components"


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def by_name(parsed: list[dict]) -> dict[str, dict]:
    return {c["name"]: c for c in parsed}


def upload(client, headers, project_id, filename, raw=None, content_type="application/json"):
    return client.post(
        f"/v1/projects/{project_id}/components",
        files={"file": (filename, raw if raw is not None else fixture_bytes(filename),
                        content_type)},
        headers=headers)


def import_fixture(client, headers, project_id, filename, content_type="application/json"):
    r = upload(client, headers, project_id, filename, content_type=content_type)
    assert r.status_code == 202, f"{filename}: {r.status_code} {r.text}"
    return poll_job(client, headers, r.json()["job_id"])["result"]


@pytest.fixture()
def project(client, register_org, create_project):
    headers = register_org()
    return headers, create_project(headers, "Components Project")


# ---------------------------------------------------------------------------
# 1. The six formats — pure parsers against committed fixtures
# ---------------------------------------------------------------------------

def test_cyclonedx_json_parses_names_versions_and_purls():
    fmt, parsed = comp.parse_components(fixture_bytes("sbom-cyclonedx.json"),
                                        "sbom-cyclonedx.json")
    assert fmt == "cyclonedx"
    rows = by_name(parsed)
    # the metadata.component (the application itself) is NOT a dependency
    assert "customers-api" not in rows
    assert rows["express"]["version"] == "4.18.2"
    assert rows["express"]["purl"] == "pkg:npm/express@4.18.2"
    assert rows["express"]["ecosystem"] == "npm"
    # group + name is the scoped npm name
    assert rows["@angular/core"]["version"] == "16.2.0"
    assert rows["@angular/core"]["cpe23"] == "cpe:2.3:a:angular:angular:16.2.0:*:*:*:*:*:*:*"
    # nested components[] are walked
    assert rows["starlette"]["version"] == "0.37.2"
    assert rows["starlette"]["ecosystem"] == "pypi"
    # a component with no version stays without one
    assert rows["vendored-blob"]["version"] is None
    assert rows["vendored-blob"]["unpinned_reason"]


def test_spdx_json_parses_packages_purls_and_cpes():
    fmt, parsed = comp.parse_components(fixture_bytes("sbom-spdx.json"), "sbom-spdx.json")
    assert fmt == "spdx"
    rows = by_name(parsed)
    assert rows["lodash"]["version"] == "4.17.21"
    assert rows["lodash"]["purl"] == "pkg:npm/lodash@4.17.21"
    assert rows["lodash"]["ecosystem"] == "npm"
    # a declared CPE is copied verbatim; it is never derived from the name
    assert rows["openssl"]["cpe23"] == "cpe:2.3:a:openssl:openssl:3.0.13:*:*:*:*:*:*:*"
    # NOASSERTION is not a version
    assert rows["internal-tool"]["version"] is None
    assert "NOASSERTION" in rows["internal-tool"]["unpinned_reason"]


def test_package_lock_v3_reads_the_packages_map():
    fmt, parsed = comp.parse_components(fixture_bytes("package-lock.json"),
                                        "package-lock.json")
    assert fmt == "package-lock.json"
    rows = by_name(parsed)
    assert "" not in rows and "customers-web" not in rows  # the root project is not a dep
    assert rows["axios"]["version"] == "1.6.8"
    assert rows["axios"]["purl"] == "pkg:npm/axios@1.6.8"
    assert rows["@babel/runtime"]["version"] == "7.24.5"   # scope survives the path split
    assert rows["follow-redirects"]["version"] == "1.15.6"
    # a workspace link declares no version — recorded, not guessed, not dropped
    assert rows["local-lib"]["version"] is None
    assert all(c["ecosystem"] == "npm" for c in parsed)


def test_package_lock_v1_reads_the_nested_dependency_tree():
    fmt, parsed = comp.parse_components(fixture_bytes("package-lock-v1.json"),
                                        "package-lock-v1.json")
    assert fmt == "package-lock.json"
    rows = by_name(parsed)
    assert rows["minimist"]["version"] == "1.2.8"
    assert rows["mkdirp"]["version"] == "0.5.6"
    assert rows["nested-dep"]["version"] == "2.0.1"  # nested dependencies are walked


def test_requirements_txt_pins_only_what_is_pinned():
    fmt, parsed = comp.parse_components(fixture_bytes("requirements.txt"), "requirements.txt")
    assert fmt == "requirements.txt"
    rows = by_name(parsed)
    assert rows["fastapi"]["version"] == "0.111.0"
    assert rows["sqlalchemy"]["version"] == "2.0.30"
    # extras and an environment marker do not defeat the pin
    assert rows["pyjwt"]["version"] == "2.8.0"
    assert rows["pyjwt"]["purl"] == "pkg:pypi/pyjwt@2.8.0"
    # -r / --index-url lines are options, not components
    assert "other-requirements.txt" not in rows
    assert not any(n.startswith("-") for n in rows)


def test_go_sum_dedups_the_go_mod_twin_of_every_module():
    fmt, parsed = comp.parse_components(fixture_bytes("go.sum"), "go.sum")
    assert fmt == "go.sum"
    rows = by_name(parsed)
    # six lines, three modules: the '/go.mod' hash line is the same module
    assert len(parsed) == 3
    assert rows["github.com/gin-gonic/gin"]["version"] == "v1.10.0"
    assert rows["golang.org/x/crypto"]["version"] == "v0.23.0"
    assert rows["github.com/stretchr/testify"]["purl"] == \
        "pkg:golang/github.com/stretchr/testify@v1.9.0"
    assert all(c["ecosystem"] == "golang" for c in parsed)


def test_poetry_lock_reads_package_blocks():
    fmt, parsed = comp.parse_components(fixture_bytes("poetry.lock"), "poetry.lock")
    assert fmt == "poetry.lock"
    rows = by_name(parsed)
    assert rows["anyio"]["version"] == "4.3.0"
    assert rows["click"]["version"] == "8.1.7"
    # the [metadata] table is not a package
    assert len(parsed) == 3
    # PEP 503 normalisation happens in the purl, not in the recorded name
    assert rows["Jinja2"]["purl"] == "pkg:pypi/jinja2@3.1.4"


def test_every_supported_format_is_detected_from_content_alone():
    """Detection must not depend on the uploaded filename."""
    cases = {
        "sbom-cyclonedx.json": "cyclonedx",
        "sbom-spdx.json": "spdx",
        "package-lock.json": "package-lock.json",
        "go.sum": "go.sum",
        "poetry.lock": "poetry.lock",
        "requirements.txt": "requirements.txt",
    }
    for filename, expected in cases.items():
        assert comp.detect_format(fixture_bytes(filename), "upload.bin") == expected, filename


# ---------------------------------------------------------------------------
# 2. A version is never guessed
# ---------------------------------------------------------------------------

def test_unpinned_requirement_lines_have_a_null_version_and_a_reason():
    _fmt, parsed = comp.parse_components(fixture_bytes("requirements.txt"),
                                         "requirements.txt")
    rows = by_name(parsed)
    for name, line in (("requests", ">=2.31.0"), ("uvicorn", "uvicorn")):
        assert rows[name]["version"] is None, f"{name} was given a version it never declared"
        assert rows[name]["unpinned_reason"], f"{name} has no reason recorded"
        assert line in rows[name]["unpinned_reason"]
        # the purl of an unpinned component carries no @version either
        assert rows[name]["purl"] == f"pkg:pypi/{name}"


def test_import_counts_unpinned_components_and_stores_them_null(client, project):
    headers, pid = project
    result = import_fixture(client, headers, pid, "requirements.txt", "text/plain")
    assert result["format"] == "requirements.txt"
    assert result["total"] == 5           # fastapi, sqlalchemy, requests, uvicorn, pyjwt
    assert result["added"] == 5
    assert result["unpinned"] == 2        # requests (range) + uvicorn (bare)

    rows = {c["name"]: c for c in
            client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]}
    assert rows["requests"]["version"] is None
    assert rows["uvicorn"]["version"] is None
    assert rows["fastapi"]["version"] == "0.111.0"


def test_a_cpe_is_only_ever_stored_when_the_document_declares_one(client, project):
    headers, pid = project
    import_fixture(client, headers, pid, "sbom-spdx.json")
    rows = {c["name"]: c for c in
            client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]}
    assert rows["openssl"]["cpe23"].startswith("cpe:2.3:a:openssl:openssl:3.0.13")
    assert rows["lodash"]["cpe23"] is None, "a CPE was invented from the package name"


# ---------------------------------------------------------------------------
# 3. Re-import updates instead of duplicating
# ---------------------------------------------------------------------------

def test_uploading_the_same_sbom_twice_updates_and_does_not_duplicate(client, project):
    headers, pid = project
    first = import_fixture(client, headers, pid, "sbom-cyclonedx.json")
    assert first["added"] == first["total"] and first["updated"] == 0

    second = import_fixture(client, headers, pid, "sbom-cyclonedx.json")
    assert second["added"] == 0
    assert second["updated"] == second["total"] == first["total"]

    listed = client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]
    assert len(listed) == first["total"]
    keys = [(c["name"], c["version"], c["ecosystem"]) for c in listed]
    assert len(set(keys)) == len(keys), f"duplicate inventory rows: {keys}"


def test_reimporting_an_unpinned_line_does_not_add_a_second_null_row(client, project):
    """SQL treats NULLs as distinct, so the unique index alone would not catch this."""
    headers, pid = project
    import_fixture(client, headers, pid, "requirements.txt", "text/plain")
    second = import_fixture(client, headers, pid, "requirements.txt", "text/plain")
    assert second["added"] == 0 and second["updated"] == 5

    listed = client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]
    assert [c["name"] for c in listed].count("uvicorn") == 1


def test_a_new_version_of_a_component_is_a_new_row(client, project):
    """Upgrading a dependency adds a row; the old one is not silently rewritten."""
    headers, pid = project
    import_fixture(client, headers, pid, "requirements.txt", "text/plain")
    bumped = fixture_bytes("requirements.txt").replace(b"fastapi==0.111.0",
                                                       b"fastapi==0.112.0")
    r = upload(client, headers, pid, "requirements.txt", bumped, "text/plain")
    result = poll_job(client, headers, r.json()["job_id"])["result"]
    assert result["added"] == 1

    versions = sorted(c["version"] for c in
                      client.get(f"/v1/projects/{pid}/components",
                                 headers=headers).json()["components"]
                      if c["name"] == "fastapi")
    assert versions == ["0.111.0", "0.112.0"]


def test_two_ecosystems_can_share_a_component_name(client, project):
    headers, pid = project
    import_fixture(client, headers, pid, "package-lock.json")
    import_fixture(client, headers, pid, "poetry.lock", "text/plain")
    listed = client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]
    assert {c["source"] for c in listed} == {"lockfile"}
    assert {c["ecosystem"] for c in listed} == {"npm", "pypi"}


# ---------------------------------------------------------------------------
# 4. An unrecognised file is refused, with the list of what would work
# ---------------------------------------------------------------------------

def test_unknown_format_is_422_with_the_supported_format_list(client, project):
    headers, pid = project
    r = upload(client, headers, pid, "unsupported.json")
    assert r.status_code == 422, r.text
    detail = r.json()["detail"]
    assert detail["code"] == "unsupported_component_format"
    assert detail["message"]
    assert detail["errors"] == list(comp.SUPPORTED_FORMATS)
    assert set(detail["errors"]) == {
        "cyclonedx", "spdx", "package-lock.json", "requirements.txt", "go.sum", "poetry.lock"}


def test_prose_and_empty_uploads_are_refused(client, project):
    headers, pid = project
    r = upload(client, headers, pid, "notes.txt", b"This is just a note about the project.\n",
               "text/plain")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "unsupported_component_format"

    r = upload(client, headers, pid, "empty.json", b"", "application/json")
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "empty_file"


def test_a_rejected_upload_leaves_the_inventory_untouched(client, project):
    headers, pid = project
    import_fixture(client, headers, pid, "go.sum", "text/plain")
    before = client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]
    upload(client, headers, pid, "unsupported.json")
    after = client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]
    assert len(after) == len(before) == 3


# ---------------------------------------------------------------------------
# 5. Delete
# ---------------------------------------------------------------------------

def test_a_component_can_be_deleted(client, project):
    headers, pid = project
    import_fixture(client, headers, pid, "go.sum", "text/plain")
    listed = client.get(f"/v1/projects/{pid}/components", headers=headers).json()["components"]
    victim = listed[0]

    r = client.delete(f"/v1/components/{victim['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["deleted"] is True

    remaining = client.get(f"/v1/projects/{pid}/components",
                           headers=headers).json()["components"]
    assert victim["id"] not in [c["id"] for c in remaining]
    assert len(remaining) == len(listed) - 1

    assert client.delete(f"/v1/components/{victim['id']}", headers=headers).status_code == 404


# ---------------------------------------------------------------------------
# 6. Capability guards and org isolation
# ---------------------------------------------------------------------------

@pytest.fixture()
def viewer_headers(client, project):
    headers, _pid = project
    email = "viewer.components@example.sa"
    r = client.post("/v1/members/invite", json={
        "email": email, "name": "Viewer", "role": "viewer", "password": "Passw0rd!"},
        headers=headers)
    assert r.status_code == 201, r.text
    r = client.post("/v1/auth/login", json={"email": email, "password": "Passw0rd!"})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_a_viewer_can_read_the_inventory_but_not_change_it(client, project, viewer_headers):
    headers, pid = project
    import_fixture(client, headers, pid, "go.sum", "text/plain")

    r = client.get(f"/v1/projects/{pid}/components", headers=viewer_headers)
    assert r.status_code == 200
    listed = r.json()["components"]
    assert len(listed) == 3

    r = upload(client, viewer_headers, pid, "go.sum", content_type="text/plain")
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"

    r = client.delete(f"/v1/components/{listed[0]['id']}", headers=viewer_headers)
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"


def test_unauthenticated_access_is_rejected(client, project):
    _headers, pid = project
    assert client.get(f"/v1/projects/{pid}/components").status_code == 401
    assert upload(client, {}, pid, "go.sum", content_type="text/plain").status_code == 401


def test_another_organisation_cannot_see_or_import_components(client, project,
                                                              register_org, create_project):
    headers, pid = project
    import_fixture(client, headers, pid, "go.sum", "text/plain")

    other = register_org("Other Org")
    assert client.get(f"/v1/projects/{pid}/components", headers=other).status_code == 404
    assert upload(client, other, pid, "go.sum", content_type="text/plain").status_code == 404

    other_pid = create_project(other, "Other Project")
    assert client.get(f"/v1/projects/{other_pid}/components",
                      headers=other).json()["components"] == []


# ---------------------------------------------------------------------------
# 7. Audit
# ---------------------------------------------------------------------------

def test_an_import_writes_a_components_import_audit_entry(client, project):
    headers, pid = project
    result = import_fixture(client, headers, pid, "sbom-cyclonedx.json")

    entries = client.get("/v1/audit?limit=200", headers=headers).json()["items"]
    imports = [e for e in entries if e["action"] == "components.import"]
    assert len(imports) == 1, f"expected one components.import: {[e['action'] for e in entries]}"
    entry = imports[0]
    assert entry["object_type"] == "project" and entry["object_id"] == pid
    assert entry["actor_id"], "the import is not attributed to anyone"
    assert entry["detail"]["format"] == "cyclonedx"
    assert entry["detail"]["filename"] == "sbom-cyclonedx.json"
    assert entry["detail"]["added"] == result["added"]
    assert entry["detail"]["total"] == result["total"]


# ---------------------------------------------------------------------------
# 8. Purity — the parsers touch nothing but their bytes
# ---------------------------------------------------------------------------

def test_parsers_are_pure_and_repeatable():
    """Same bytes in, identical inventory out — no clock, no network, no state."""
    for filename in ("sbom-cyclonedx.json", "sbom-spdx.json", "package-lock.json",
                     "requirements.txt", "go.sum", "poetry.lock"):
        raw = fixture_bytes(filename)
        first = comp.parse_components(raw, filename)
        second = comp.parse_components(raw, filename)
        assert first == second, filename
        # and the input is never mutated
        assert raw == fixture_bytes(filename)


def test_no_parser_opens_a_socket(monkeypatch):
    import socket

    def _forbidden(*_a, **_kw):
        raise AssertionError("a component parser attempted network access")

    monkeypatch.setattr(socket, "socket", _forbidden)
    monkeypatch.setattr(socket, "create_connection", _forbidden)
    for filename in ("sbom-cyclonedx.json", "package-lock.json", "go.sum", "poetry.lock"):
        comp.parse_components(fixture_bytes(filename), filename)


def test_the_fixtures_are_the_documents_they_claim_to_be():
    """A fixture that drifted into invalid JSON would make the parser tests lie."""
    for filename in ("sbom-cyclonedx.json", "sbom-spdx.json", "package-lock.json",
                     "package-lock-v1.json", "unsupported.json"):
        json.loads(fixture_bytes(filename))
