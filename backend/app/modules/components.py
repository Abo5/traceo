"""Component inventory (security plan §2, phase S2) — SBOM and lockfile parsing.

WHY THIS MODULE EXISTS
----------------------
A CVE feed is a firehose about *other people's software*. It only becomes
actionable when it matches something the target actually runs, so the CVE track
needs a declared component set first. This module builds it from the files a
project already has on hand, in the fidelity order of §2:

    sbom (CycloneDX / SPDX)  >  lockfile  >  manual  >  fingerprint

DESIGN RULES
------------
* **Pure and deterministic.** Every parser below is a pure function of its bytes:
  no network, no database, no clock, no LLM. The same file always yields the same
  inventory, which is what makes the Go port checkable against this one.
* **NEVER invent a version.** ``requests>=2.31.0`` and a bare ``uvicorn`` are
  recorded with ``version = None`` and a reason. A guessed version would produce
  confident CVE matches against software the target may not run — the exact
  fabrication BO-07 exists to prevent, arriving through a new door.
* **cpe23 is copied, never derived.** No ecosystem offers a deterministic
  package-name -> CPE mapping (``lodash`` is not ``cpe:2.3:a:lodash:lodash``),
  so a CPE is stored only when the source document states one explicitly
  (CycloneDX ``component.cpe``, SPDX ``externalRefs`` of type ``cpe23Type``).
  A purl, by contrast, IS derivable from (ecosystem, name, version) and is
  derived when the document does not supply one.
* **Parity.** Every heuristic is spelled out rather than left to taste so the Go
  port produces byte-identical inventories.
"""
from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import jobs as jobstore
from ..db import SessionLocal, get_db
from ..deps import audit, get_project_scoped, require
from ..models import Component, User

router = APIRouter()

MAX_COMPONENT_FILE_BYTES = 10 * 1024 * 1024

# The formats this module owns, in the order detection tries them. Named in the
# 422 so a rejected upload tells the owner what WOULD have been accepted.
SUPPORTED_FORMATS: tuple[str, ...] = (
    "cyclonedx", "spdx", "package-lock.json", "requirements.txt", "go.sum", "poetry.lock",
)

# Which Component.source a parsed format implies (fidelity order, §2).
SOURCE_BY_FORMAT: dict[str, str] = {
    "cyclonedx": "sbom",
    "spdx": "sbom",
    "package-lock.json": "lockfile",
    "requirements.txt": "lockfile",
    "go.sum": "lockfile",
    "poetry.lock": "lockfile",
}


class UnsupportedComponentFormat(ValueError):
    """Raised by :func:`parse_components` when no parser recognises the file."""


# --- purl / naming helpers ------------------------------------------------------------

_PYPI_NORMALISE = re.compile(r"[-_.]+")


def normalise_pypi_name(name: str) -> str:
    """PEP 503 normalisation — 'Jinja2' and 'jinja-2' are the same distribution."""
    return _PYPI_NORMALISE.sub("-", name).lower()


def build_purl(ecosystem: str, name: str, version: str | None) -> str:
    """Derive a package URL. Scoped npm names keep their '@scope/' prefix verbatim
    (readable, and reversible) rather than percent-encoding the '@'."""
    if not name:
        return ""
    eco = ecosystem or "generic"
    ident = normalise_pypi_name(name) if eco == "pypi" else name
    return f"pkg:{eco}/{ident}" + (f"@{version}" if version else "")


def ecosystem_from_purl(purl: str) -> str:
    """'pkg:npm/@angular/core@16.2.0' -> 'npm'. Unparseable -> 'generic'."""
    if not purl.startswith("pkg:"):
        return "generic"
    rest = purl[4:]
    eco = rest.split("/", 1)[0].strip().lower()
    return eco or "generic"


def _component(name: str, version: str | None, ecosystem: str, *,
               purl: str = "", cpe23: str | None = None,
               unpinned_reason: str | None = None) -> dict:
    version = (version or "").strip() or None
    return {
        "name": name.strip(),
        "version": version,
        "ecosystem": ecosystem or "generic",
        "purl": purl or build_purl(ecosystem, name.strip(), version),
        "cpe23": cpe23 or None,
        "unpinned_reason": (unpinned_reason[:200] if unpinned_reason and version is None
                            else None),
    }


def _dedup(items: list[dict]) -> list[dict]:
    """Collapse identical (name, version, ecosystem) triples, keeping file order.
    go.sum lists every module twice (once for the zip, once for its go.mod); an
    SBOM can list a transitive dependency more than once."""
    seen: set[tuple[str, str | None, str]] = set()
    out: list[dict] = []
    for item in items:
        if not item["name"]:
            continue
        key = (item["name"], item["version"], item["ecosystem"])
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


# --- CycloneDX JSON --------------------------------------------------------------------

def parse_cyclonedx(doc: dict) -> list[dict]:
    """components[].name/version/purl, recursing into nested components[]."""
    out: list[dict] = []

    def walk(nodes: list) -> None:
        for node in nodes or []:
            if not isinstance(node, dict):
                continue
            name = str(node.get("name") or "").strip()
            group = str(node.get("group") or "").strip()
            if group:
                # npm scopes are 'group/name'; every other ecosystem CycloneDX
                # uses a group for (maven, nuget) is 'group:name'.
                name = f"{group}/{name}" if group.startswith("@") else f"{group}:{name}"
            purl = str(node.get("purl") or "").strip()
            version = str(node.get("version") or "").strip() or None
            eco = ecosystem_from_purl(purl) if purl else "generic"
            if name:
                out.append(_component(
                    name, version, eco, purl=purl,
                    cpe23=str(node.get("cpe") or "").strip() or None,
                    unpinned_reason="CycloneDX component declares no version"))
            walk(node.get("components") or [])

    walk(doc.get("components") or [])
    return _dedup(out)


# --- SPDX JSON -------------------------------------------------------------------------

_SPDX_NO_VERSION = {"NOASSERTION", "NONE", ""}


def parse_spdx(doc: dict) -> list[dict]:
    """packages[].name/versionInfo plus externalRefs purl and cpe23Type locators."""
    out: list[dict] = []
    for pkg in doc.get("packages") or []:
        if not isinstance(pkg, dict):
            continue
        name = str(pkg.get("name") or "").strip()
        if not name:
            continue
        raw_version = str(pkg.get("versionInfo") or "").strip()
        version = None if raw_version.upper() in _SPDX_NO_VERSION else raw_version
        purl, cpe23 = "", None
        for ref in pkg.get("externalRefs") or []:
            if not isinstance(ref, dict):
                continue
            ref_type = str(ref.get("referenceType") or "").strip().lower()
            locator = str(ref.get("referenceLocator") or "").strip()
            if ref_type == "purl" and not purl:
                purl = locator
            elif ref_type in ("cpe23type", "cpe23") and not cpe23:
                cpe23 = locator or None
        eco = ecosystem_from_purl(purl) if purl else "generic"
        out.append(_component(
            name, version, eco, purl=purl, cpe23=cpe23,
            unpinned_reason=f"SPDX versionInfo is {raw_version or 'absent'}"))
    return _dedup(out)


# --- package-lock.json (v1 and v2/v3) ----------------------------------------------------

def parse_package_lock(doc: dict) -> list[dict]:
    """v2/v3 use the flat 'packages' map keyed by install path; v1 uses the nested
    'dependencies' tree. Both are read — a v2 lockfile carries both for
    compatibility, and 'packages' is the authoritative one."""
    out: list[dict] = []

    packages = doc.get("packages")
    if isinstance(packages, dict) and packages:
        for install_path, meta in packages.items():
            if not install_path or not isinstance(meta, dict):
                continue  # "" is the root project, not a dependency
            marker = "node_modules/"
            name = install_path.rsplit(marker, 1)[-1] if marker in install_path else install_path
            version = str(meta.get("version") or "").strip() or None
            out.append(_component(
                name, version, "npm",
                unpinned_reason="package-lock entry declares no version "
                                "(workspace link or file reference)"))
        return _dedup(out)

    def walk(tree: dict) -> None:
        for name, meta in (tree or {}).items():
            if not isinstance(meta, dict):
                continue
            version = str(meta.get("version") or "").strip() or None
            out.append(_component(
                str(name), version, "npm",
                unpinned_reason="package-lock entry declares no version"))
            walk(meta.get("dependencies") or {})

    walk(doc.get("dependencies") or {})
    return _dedup(out)


# --- requirements.txt --------------------------------------------------------------------

# name[extras] == version  — the ONLY form that yields a version. Anything else is
# a range, a marker-only line or a bare name, and is recorded unpinned.
_REQ_PINNED = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*(?P<version>[^\s;#\\]+)\s*$")
_REQ_ANY = re.compile(
    r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*"
    r"(?:(?:===|==|>=|<=|~=|!=|<|>)\s*[^\s;#]+\s*(?:,\s*(?:===|==|>=|<=|~=|!=|<|>)\s*[^\s;#]+\s*)*)?$")


def _requirement_lines(text: str) -> list[str]:
    """Strip comments, blank lines, option lines (-r/-e/--flag) and env markers."""
    lines: list[str] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or line.startswith("-"):
            continue
        line = line.split(";", 1)[0].strip()  # environment marker: not part of the pin
        if line:
            lines.append(line)
    return lines


def parse_requirements_txt(text: str) -> list[dict]:
    out: list[dict] = []
    for line in _requirement_lines(text):
        pinned = _REQ_PINNED.match(line)
        if pinned:
            out.append(_component(pinned.group("name"), pinned.group("version"), "pypi"))
            continue
        loose = _REQ_ANY.match(line)
        if loose:
            # A range or a bare name. The version is UNKNOWN, and unknown is what
            # gets stored — resolving '>=2.31.0' to a number would be a guess.
            out.append(_component(
                loose.group("name"), None, "pypi",
                unpinned_reason=f"requirement line is not pinned with '==': '{line}'"))
    return _dedup(out)


# --- go.sum ------------------------------------------------------------------------------

_GO_SUM_LINE = re.compile(r"^(?P<module>\S+)\s+(?P<version>v\S+?)(?P<gomod>/go\.mod)?\s+h1:\S+=?\s*$")


def parse_go_sum(text: str) -> list[dict]:
    """'module version h1:hash' plus a '/go.mod' twin per module — deduplicated."""
    out: list[dict] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _GO_SUM_LINE.match(line)
        if not m:
            continue
        out.append(_component(m.group("module"), m.group("version"), "golang"))
    return _dedup(out)


# --- poetry.lock -------------------------------------------------------------------------

def parse_poetry_lock(text: str) -> list[dict]:
    """[[package]] blocks. poetry.lock is valid TOML, so it is parsed as TOML
    rather than scraped with a regex."""
    try:
        doc = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise UnsupportedComponentFormat(f"poetry.lock is not valid TOML: {exc}") from exc
    out: list[dict] = []
    for pkg in doc.get("package") or []:
        if not isinstance(pkg, dict):
            continue
        name = str(pkg.get("name") or "").strip()
        if not name:
            continue
        out.append(_component(
            name, str(pkg.get("version") or "").strip() or None, "pypi",
            unpinned_reason="poetry.lock package declares no version"))
    return _dedup(out)


# --- detection + dispatch ------------------------------------------------------------------

def _looks_like_go_sum(text: str) -> bool:
    lines = [ln for ln in (l.strip() for l in text.splitlines()) if ln]
    return bool(lines) and any(_GO_SUM_LINE.match(ln) for ln in lines)


def _looks_like_requirements(text: str, filename_hint: bool) -> bool:
    """Every meaningful line must be a requirement, AND the file must carry a
    positive signal — a version operator, or a name that says what it is.
    Without that second half a one-word text file would parse as a dependency."""
    candidates = _requirement_lines(text)
    if not candidates or not all(_REQ_ANY.match(ln) for ln in candidates):
        return False
    return filename_hint or any(op in ln for ln in candidates
                                for op in ("==", ">=", "<=", "~=", "!=", "<", ">"))


def detect_format(raw: bytes, filename: str = "") -> str | None:
    """Content sniffing first, filename only as a tie-breaker. Returns None when
    nothing recognises the file — the caller turns that into the 422."""
    text = raw.decode("utf-8", errors="replace")
    base = Path(filename or "").name.lower()

    try:
        doc = json.loads(text)
    except ValueError:
        doc = None

    if isinstance(doc, dict):
        if str(doc.get("bomFormat") or "").strip().lower() == "cyclonedx":
            return "cyclonedx"
        if doc.get("spdxVersion"):
            return "spdx"
        if "lockfileVersion" in doc or base == "package-lock.json" or base == "npm-shrinkwrap.json":
            return "package-lock.json"
        return None
    if doc is not None:
        return None  # valid JSON, but not an object: no format takes that shape

    if "[[package]]" in text:
        return "poetry.lock"
    if _looks_like_go_sum(text):
        return "go.sum"
    if _looks_like_requirements(text, base.startswith("requirements")):
        return "requirements.txt"
    return None


def parse_components(raw: bytes, filename: str = "") -> tuple[str, list[dict]]:
    """(format, components). Raises UnsupportedComponentFormat when unrecognised."""
    fmt = detect_format(raw, filename)
    if fmt is None:
        raise UnsupportedComponentFormat(
            f"'{Path(filename or 'upload').name}' matches no supported component format.")
    text = raw.decode("utf-8", errors="replace")
    if fmt in ("cyclonedx", "spdx", "package-lock.json"):
        doc = json.loads(text)
        if fmt == "cyclonedx":
            return fmt, parse_cyclonedx(doc)
        if fmt == "spdx":
            return fmt, parse_spdx(doc)
        return fmt, parse_package_lock(doc)
    if fmt == "poetry.lock":
        return fmt, parse_poetry_lock(text)
    if fmt == "go.sum":
        return fmt, parse_go_sum(text)
    return fmt, parse_requirements_txt(text)


# --- persistence -----------------------------------------------------------------------------

def upsert_components(db: Session, org_id: str, project_id: str, source: str,
                      parsed: list[dict]) -> dict:
    """Insert or update, keyed on (project, name, version, ecosystem).

    The lookup is NULL-aware on purpose: SQL unique indexes treat NULLs as
    distinct, so re-uploading a requirements.txt with an unpinned line would
    otherwise add a second row for it on every upload."""
    added = updated = unpinned = 0
    for item in parsed:
        if item["version"] is None:
            unpinned += 1
        query = db.query(Component).filter(
            Component.organisation_id == org_id,
            Component.project_id == project_id,
            Component.name == item["name"],
            Component.ecosystem == item["ecosystem"],
        )
        query = (query.filter(Component.version.is_(None)) if item["version"] is None
                 else query.filter(Component.version == item["version"]))
        row = query.first()
        if row is None:
            db.add(Component(
                organisation_id=org_id, project_id=project_id,
                name=item["name"], version=item["version"], ecosystem=item["ecosystem"],
                purl=item["purl"], cpe23=item["cpe23"], source=source, status="active",
                unpinned_reason=item["unpinned_reason"]))
            added += 1
        else:
            row.purl = item["purl"] or row.purl
            row.cpe23 = item["cpe23"] or row.cpe23
            row.source = source
            row.status = "active"
            row.unpinned_reason = item["unpinned_reason"]
            updated += 1
    return {"added": added, "updated": updated, "unpinned": unpinned, "total": len(parsed)}


def _run_import(job, project_id: str, org_id: str, actor_id: str, filename: str,
                fmt: str, parsed: list[dict]) -> dict:
    """Job body — owns its own session (runs on a worker thread)."""
    db = SessionLocal()
    try:
        job.message = f"Importing {len(parsed)} components from {fmt}"
        counts = upsert_components(db, org_id, project_id,
                                   SOURCE_BY_FORMAT.get(fmt, "sbom"), parsed)
        result = {"format": fmt, **counts}
        audit(db, org_id, actor_id, "components.import", "project", project_id,
              {"filename": filename, **result})
        db.commit()
        return result
    finally:
        db.close()


# --- serializer -------------------------------------------------------------------------------

def _component_dict(c: Component) -> dict:
    return {
        "id": c.id, "project_id": c.project_id, "name": c.name, "version": c.version,
        "ecosystem": c.ecosystem, "purl": c.purl, "cpe23": c.cpe23, "source": c.source,
        "status": c.status, "unpinned_reason": c.unpinned_reason,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


# --- routes -----------------------------------------------------------------------------------

@router.post("/projects/{project_id}/components", status_code=202)
async def import_components(project_id: str, file: UploadFile = File(...),
                            user: User = Depends(require("import_spec")),
                            db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    raw = await file.read()
    if not raw:
        raise HTTPException(422, detail={
            "code": "empty_file", "message": "Uploaded file is empty."})
    if len(raw) > MAX_COMPONENT_FILE_BYTES:
        raise HTTPException(413, detail={
            "code": "file_too_large",
            "message": f"File exceeds the {MAX_COMPONENT_FILE_BYTES // (1024 * 1024)}MB limit."})

    filename = file.filename or "components"
    # Parsing is pure and fast, and it must happen HERE: the caller needs the
    # 422 for an unrecognised file synchronously, not buried in a job result.
    try:
        fmt, parsed = parse_components(raw, filename)
    except UnsupportedComponentFormat as exc:
        raise HTTPException(422, detail={
            "code": "unsupported_component_format",
            "message": str(exc),
            "errors": list(SUPPORTED_FORMATS)})

    org_id, actor_id = user.organisation_id, user.id
    job = jobstore.submit(
        "ingest",
        lambda j: _run_import(j, project_id, org_id, actor_id, filename, fmt, parsed),
        project_id)
    return {"job_id": job.id}


@router.get("/projects/{project_id}/components")
def list_components(project_id: str, user: User = Depends(require("view")),
                    db: Session = Depends(get_db)):
    get_project_scoped(project_id, user, db)
    rows = db.query(Component).filter(
        Component.project_id == project_id,
        Component.organisation_id == user.organisation_id,
    ).order_by(Component.ecosystem.asc(), Component.name.asc()).all()
    return {"components": [_component_dict(c) for c in rows]}


@router.delete("/components/{component_id}")
def delete_component(component_id: str, user: User = Depends(require("import_spec")),
                     db: Session = Depends(get_db)):
    row = db.get(Component, component_id)
    if not row or row.organisation_id != user.organisation_id:
        raise HTTPException(404, detail={
            "code": "not_found", "message": "Component not found"})
    db.delete(row)
    db.commit()
    return {"deleted": True, "id": component_id}
