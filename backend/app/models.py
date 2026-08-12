"""Database schema per TRD §5. All tables carry id/created_at/updated_at; tenant-scoped
tables carry organisation_id (org isolation enforced in the query layer — NFR-SEC-04)."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import (String, Text, Integer, Float, Boolean, DateTime, ForeignKey, JSON,
                        LargeBinary, UniqueConstraint)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


def uid() -> str:
    return str(uuid.uuid4())

def now() -> datetime:
    return datetime.now(timezone.utc)


class TimestampMixin:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now, onupdate=now)


class Organisation(TimestampMixin, Base):
    __tablename__ = "organisations"
    name: Mapped[str] = mapped_column(String(200))
    plan: Mapped[str] = mapped_column(String(20), default="free")  # free|pro|team|enterprise
    settings: Mapped[dict] = mapped_column(JSON, default=dict)


class User(TimestampMixin, Base):
    __tablename__ = "users"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(Text)  # Argon2id
    role: Mapped[str] = mapped_column(String(20), default="qa_engineer")  # admin|qa_lead|qa_engineer|viewer
    locale: Mapped[str] = mapped_column(String(5), default="en")


class Project(TimestampMixin, Base):
    __tablename__ = "projects"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    # Autopilot mode: "auto" chains parse -> confirm_all -> generate; "manual"
    # leaves every step to the user. Approval/runs stay manual either way
    # (BO-07).
    automation: Mapped[str] = mapped_column(String(10), default="auto",
                                            server_default="auto")  # auto|manual
    status: Mapped[str] = mapped_column(String(20), default="active")  # active|archived


class Environment(TimestampMixin, Base):
    __tablename__ = "environments"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    base_url: Mapped[str] = mapped_column(String(500))
    auth_type: Mapped[str] = mapped_column(String(20), default="none")  # none|api_key|basic|bearer|oauth2_cc
    auth_config_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # FR-PRJ-04
    variables: Mapped[dict] = mapped_column(JSON, default=dict)  # non-secret, FR-PRJ-05
    tls_strict: Mapped[bool] = mapped_column(Boolean, default=True)


class SourceDocument(TimestampMixin, Base):
    __tablename__ = "source_documents"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    filename: Mapped[str] = mapped_column(String(300))
    mime_type: Mapped[str] = mapped_column(String(100), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    storage_key: Mapped[str] = mapped_column(String(300))
    # Document content language. Traceo is English-only, so this is always "en";
    # the column is kept because the document payload has always carried it.
    language: Mapped[str] = mapped_column(String(5), default="en")
    version: Mapped[int] = mapped_column(Integer, default=1)  # increments per re-upload
    parse_status: Mapped[str] = mapped_column(String(20), default="pending")  # pending|parsing|parsed|failed
    parse_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class Requirement(TimestampMixin, Base):
    __tablename__ = "requirements"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    source_document_id: Mapped[str | None] = mapped_column(ForeignKey("source_documents.id"), nullable=True)
    external_id: Mapped[str] = mapped_column(String(100), default="")  # as written in source
    description: Mapped[str] = mapped_column(Text)
    acceptance_criteria: Mapped[list] = mapped_column(JSON, default=list)
    type: Mapped[str] = mapped_column(String(30), default="functional")  # functional|business_rule|data|interface|non_functional
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    state: Mapped[str] = mapped_column(String(20), default="extracted")  # extracted|confirmed|changed|removed
    version: Mapped[int] = mapped_column(Integer, default=1)
    source_location: Mapped[dict] = mapped_column(JSON, default=dict)  # page/offset/span — FR-REQ-07
    source_text: Mapped[str] = mapped_column(Text, default="")  # original text shown side-by-side
    confidence: Mapped[float] = mapped_column(Float, default=1.0)  # FR-REQ-08
    content_hash: Mapped[str] = mapped_column(String(64), default="")  # drives staleness FR-TRC-04


class ApiSpec(TimestampMixin, Base):
    __tablename__ = "api_specs"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    source: Mapped[str] = mapped_column(String(500))  # filename or URL
    format: Mapped[str] = mapped_column(String(20), default="openapi3")  # openapi3|swagger2
    version: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(300), default="")


class Endpoint(TimestampMixin, Base):
    __tablename__ = "endpoints"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    # Nullable because only spec-imported endpoints belong to an ApiSpec; those
    # discovered from traffic, the DOM or a Postman collection (FR-021/022/023)
    # have no spec document behind them.
    api_spec_id: Mapped[str | None] = mapped_column(
        ForeignKey("api_specs.id"), index=True, nullable=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    method: Mapped[str] = mapped_column(String(10))
    path: Mapped[str] = mapped_column(String(500))
    operation_id: Mapped[str] = mapped_column(String(200), default="")
    summary: Mapped[str] = mapped_column(String(500), default="")
    parameters: Mapped[list] = mapped_column(JSON, default=list)  # name/location/type/required/constraints
    request_schema: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    response_schemas: Mapped[dict] = mapped_column(JSON, default=dict)  # keyed by status code
    security: Mapped[list] = mapped_column(JSON, default=list)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False)  # FR-DSC-05
    # Which discovery mode produced this endpoint. When the same endpoint is seen
    # by several modes, the highest-fidelity source wins per attribute:
    # spec > traffic > dom > postman (SRS §L2).
    source: Mapped[str] = mapped_column(String(20), default="spec")
    # How many times traffic capture observed this endpoint (FR-021 AC-3); stays 0
    # for endpoints that were declared rather than observed.
    observed_count: Mapped[int] = mapped_column(Integer, default=0)
    # Optional AI annotations produced AFTER the deterministic import (see
    # modules/enrichment.py). They are commentary only: every value was matched
    # back to a deterministically-discovered method+path before being stored, and
    # nothing here may ever influence method, path, parameters or schemas. NULL
    # whenever enrichment did not run, failed, or was discarded by the gate.
    ai_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_group: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ai_criticality: Mapped[str | None] = mapped_column(String(10), nullable=True)  # high|medium|low


# Legal TestCase.technique values. "localisation" is the FR-034 Unicode
# round-trip probe; "edge_case" is produced only by the Insight engine
# (modules/insight.py) and is always accompanied by a non-null edge_category;
# "security" is produced only by the security builders (modules/security.py) and
# is always accompanied by a non-null weakness_id.
TECHNIQUES: tuple[str, ...] = (
    "ep", "bva", "decision_table", "negative", "manual", "localisation", "edge_case",
    "security",
)

# Legal Run.kind values (SECURITY_TESTING_PLAN §8). A run carries exactly one
# kind so gates and reports can separate a functional regression from a security
# sweep instead of averaging them into one meaningless number.
RUN_KINDS: tuple[str, ...] = ("functional", "security", "performance")


def is_legal_technique(technique: str | None) -> bool:
    """Technique validation — the single place that decides what may be stored."""
    return technique in TECHNIQUES


class TestCase(TimestampMixin, Base):
    __tablename__ = "test_cases"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    title: Mapped[str] = mapped_column(String(500))
    description: Mapped[str] = mapped_column(Text, default="")
    preconditions: Mapped[str] = mapped_column(Text, default="")
    type: Mapped[str] = mapped_column(String(20), default="positive")  # positive|negative|boundary
    priority: Mapped[str] = mapped_column(String(20), default="medium")
    state: Mapped[str] = mapped_column(String(20), default="draft")  # draft|approved|rejected|stale|archived
    generated: Mapped[bool] = mapped_column(Boolean, default=False)
    user_modified: Mapped[bool] = mapped_column(Boolean, default=False)  # FR-REV-03
    model: Mapped[str] = mapped_column(String(100), default="")  # provenance FR-GEN-09
    prompt_version: Mapped[str] = mapped_column(String(20), default="")
    technique: Mapped[str] = mapped_column(String(30), default="")  # see TECHNIQUES
    # Insight engine taxonomy (the sixth engine). NULL for every case that does not
    # belong to an edge-case family — which is every case generated before this
    # engine existed, and every manually authored one.
    edge_category: Mapped[str | None] = mapped_column(String(30), nullable=True)
    # Weakness class this case verifies (SECURITY_TESTING_PLAN §8), a slug from the
    # shipped catalogue app/data/weaknesses.json. NULL for every non-security case,
    # which is the honest value: "this case belongs to no weakness class" is not the
    # same statement as "it belongs to the class named none". Indexed because the
    # coverage matrix (§11) counts cases per (endpoint, weakness) pair.
    weakness_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    approved_by: Mapped[str | None] = mapped_column(String(36), nullable=True)  # FR-REV-05
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)  # FR-REV-06
    version: Mapped[int] = mapped_column(Integer, default=1)

    steps: Mapped[list["TestStep"]] = relationship(order_by="TestStep.order", cascade="all, delete-orphan")


class TestStep(TimestampMixin, Base):
    __tablename__ = "test_steps"
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), index=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    endpoint_id: Mapped[str | None] = mapped_column(ForeignKey("endpoints.id"), nullable=True)  # grounding link
    method: Mapped[str] = mapped_column(String(10), default="GET")
    path: Mapped[str] = mapped_column(String(500), default="")
    request: Mapped[dict] = mapped_column(JSON, default=dict)  # headers/params/body with {{placeholders}}
    assertions: Mapped[list] = mapped_column(JSON, default=list)  # ordered
    extractions: Mapped[list] = mapped_column(JSON, default=list)  # FR-EXE-05 chaining


class RequirementTestCase(Base):
    """The requirement<->test_case join. 'This table is the product' (TRD §5)."""
    __tablename__ = "requirement_test_cases"
    requirement_id: Mapped[str] = mapped_column(ForeignKey("requirements.id"), primary_key=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), primary_key=True)
    link_source: Mapped[str] = mapped_column(String(20), default="generated")  # generated|manual
    requirement_version_at_link: Mapped[int] = mapped_column(Integer, default=1)  # staleness driver
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class Run(TimestampMixin, Base):
    __tablename__ = "runs"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    environment_id: Mapped[str] = mapped_column(ForeignKey("environments.id"))
    # What this run is: see RUN_KINDS. NOT NULL with a server default because every
    # run that already exists is a functional one, and a nullable "kind" would make
    # every reader handle a state that has no meaning.
    kind: Mapped[str] = mapped_column(String(20), default="functional",
                                      server_default="functional")  # functional|security|performance
    state: Mapped[str] = mapped_column(String(20), default="queued")  # queued|running|completed|cancelled|aborted
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    counts: Mapped[dict] = mapped_column(JSON, default=dict)  # total/passed/failed/errored
    initiated_by: Mapped[str] = mapped_column(String(36))
    abort_reason: Mapped[str | None] = mapped_column(Text, nullable=True)  # FR-EXE-04 diagnostic


class TestResult(TimestampMixin, Base):
    __tablename__ = "test_results"
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), index=True)
    test_case_version: Mapped[int] = mapped_column(Integer, default=1)
    outcome: Mapped[str] = mapped_column(String(20))  # passed|failed|errored
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    failure_reason: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # assertion/expected/actual
    evidence: Mapped[list] = mapped_column(JSON, default=list)  # per-step, redacted + truncated


class ApiKey(TimestampMixin, Base):
    """Public API key (FR-061 token surface). Full key shown ONCE at creation;
    only the sha256 hash is stored (prefix kept for UI identification)."""
    __tablename__ = "api_keys"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    prefix: Mapped[str] = mapped_column(String(12))  # first 8 chars, shown in UI
    key_hash: Mapped[str] = mapped_column(String(64), index=True)  # sha256 of full key
    created_by: Mapped[str] = mapped_column(String(36))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Schedule(TimestampMixin, Base):
    """Scheduled run (FR-060) — the scheduler daemon launches the standard
    run path for every enabled schedule whose next_run_at has elapsed."""
    __tablename__ = "schedules"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    environment_id: Mapped[str] = mapped_column(ForeignKey("environments.id"))
    name: Mapped[str] = mapped_column(String(200))
    interval_minutes: Mapped[int] = mapped_column(Integer)  # min 15
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    next_run_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    created_by: Mapped[str] = mapped_column(String(36))


class Webhook(TimestampMixin, Base):
    """Outbound webhook (FR-070/072 transport — Slack incoming webhooks compatible)."""
    __tablename__ = "webhooks"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    url: Mapped[str] = mapped_column(String(500))
    secret: Mapped[str | None] = mapped_column(String(200), nullable=True)  # X-Traceo-Signature HMAC
    events: Mapped[list] = mapped_column(JSON, default=list)  # MVP: ["run.completed"]
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


# --- Component inventory (security plan §2, phase S2) -------------------------------
# Without a declared component set a CVE feed is news about other people's
# software, so this table is the precondition for the whole CVE track. It is
# populated by modules/components.py from an SBOM or a lockfile, in the fidelity
# order below. A version is NEVER guessed: an unpinned requirement line is stored
# with version NULL and the reason it could not be resolved.
COMPONENT_SOURCES: tuple[str, ...] = ("sbom", "lockfile", "manual", "fingerprint")


class Component(TimestampMixin, Base):
    __tablename__ = "components"
    __table_args__ = (
        # One row per (project, name, version, ecosystem): re-uploading the same
        # SBOM updates the inventory instead of duplicating it. version is
        # nullable, and SQL treats NULLs as distinct, so modules/components.py
        # ALSO does the NULL-aware lookup before inserting — this index is the
        # backstop, not the only guard.
        UniqueConstraint("project_id", "name", "version", "ecosystem",
                         name="uq_components_project_name_version_ecosystem"),
    )
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    version: Mapped[str | None] = mapped_column(String(100), nullable=True)  # NULL = unpinned
    ecosystem: Mapped[str] = mapped_column(String(30), default="generic")  # purl type
    purl: Mapped[str] = mapped_column(String(500), default="")
    cpe23: Mapped[str | None] = mapped_column(String(300), nullable=True)  # only when declared
    source: Mapped[str] = mapped_column(String(20), default="sbom")  # see COMPONENT_SOURCES
    status: Mapped[str] = mapped_column(String(20), default="active")  # active|removed
    # Why the version is NULL — quoted in the import report so an unpinned
    # dependency is visible rather than silently absent.
    unpinned_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
# --- end component inventory ---------------------------------------------------------


class AuditEntry(Base):
    """Append-only (NFR-SEC-08) — no update/delete path exposed by the application."""
    __tablename__ = "audit_entries"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(60))
    object_type: Mapped[str] = mapped_column(String(40), default="")
    object_id: Mapped[str] = mapped_column(String(36), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, default=now)
