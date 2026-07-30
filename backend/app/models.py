"""Database schema per TRD §5. All tables carry id/created_at/updated_at; tenant-scoped
tables carry organisation_id (org isolation enforced in the query layer — NFR-SEC-04)."""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, Integer, Float, Boolean, DateTime, ForeignKey, JSON, LargeBinary
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
    locale: Mapped[str] = mapped_column(String(5), default="en")  # en|ar — drives RTL


class Project(TimestampMixin, Base):
    __tablename__ = "projects"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    language: Mapped[str] = mapped_column(String(5), default="en")  # primary requirements language
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
    # FR-043 test-data lifecycle: [{name, create:{method,path,body}, extract:{var:json_path},
    #                               delete:{method,path}}] — run-namespaced, torn down always.
    fixtures: Mapped[list] = mapped_column(JSON, default=list)


class SourceDocument(TimestampMixin, Base):
    __tablename__ = "source_documents"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    filename: Mapped[str] = mapped_column(String(300))
    mime_type: Mapped[str] = mapped_column(String(100), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    storage_key: Mapped[str] = mapped_column(String(300))
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
    api_spec_id: Mapped[str] = mapped_column(ForeignKey("api_specs.id"), index=True)
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
    # --- multi-source discovery (FR-020/021/022/023) ---
    discovery_source: Mapped[str] = mapped_column(String(20), default="openapi")  # openapi|traffic|dom|postman
    times_seen: Mapped[int] = mapped_column(Integer, default=0)  # observations in captured traffic
    inferred: Mapped[bool] = mapped_column(Boolean, default=False)  # shape observed, not declared
    dom_fields: Mapped[list] = mapped_column(JSON, default=list)  # FR-022 form fields


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
    technique: Mapped[str] = mapped_column(String(30), default="")  # ep|bva|decision_table|negative|manual
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
    state: Mapped[str] = mapped_column(String(20), default="queued")  # queued|running|completed|cancelled|aborted
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    counts: Mapped[dict] = mapped_column(JSON, default=dict)  # total/passed/failed/errored
    initiated_by: Mapped[str] = mapped_column(String(36))
    abort_reason: Mapped[str | None] = mapped_column(Text, nullable=True)  # FR-EXE-04 diagnostic
    source: Mapped[str] = mapped_column(String(20), default="manual")  # manual|scheduler|ci — FR-060/061
    branch: Mapped[str] = mapped_column(String(200), default="")  # FR-054 trend filter
    concurrency: Mapped[int] = mapped_column(Integer, default=0)  # 0 = server default — FR-040
    fixtures: Mapped[dict] = mapped_column(JSON, default=dict)  # FR-043 lifecycle report


class TestResult(TimestampMixin, Base):
    __tablename__ = "test_results"
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), index=True)
    test_case_version: Mapped[int] = mapped_column(Integer, default=1)
    outcome: Mapped[str] = mapped_column(String(20))  # passed|failed|errored
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    failure_reason: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # assertion/expected/actual
    evidence: Mapped[list] = mapped_column(JSON, default=list)  # per-step, redacted + truncated


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
    retain_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # FR-082


# ---------------------------------------------------------------------------
# Automation — CI gate (FR-061), API tokens, schedules (FR-060)
# ---------------------------------------------------------------------------

class GatePolicy(TimestampMixin, Base):
    """Delivery-gate thresholds evaluated after a run (FR-061). One per project."""
    __tablename__ = "gate_policies"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), unique=True, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    min_coverage_pct: Mapped[float] = mapped_column(Float, default=80.0)
    max_new_failures: Mapped[int] = mapped_column(Integer, default=0)
    block_on: Mapped[str] = mapped_column(String(20), default="high_priority")  # any|high_priority|none


class ApiToken(TimestampMixin, Base):
    """Non-interactive principal for CI runners (FR-061). Only the hash is stored."""
    __tablename__ = "api_tokens"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    prefix: Mapped[str] = mapped_column(String(16), default="")  # shown in the UI for recognition
    role: Mapped[str] = mapped_column(String(20), default="qa_engineer")
    created_by: Mapped[str] = mapped_column(String(36), default="")
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Schedule(TimestampMixin, Base):
    """Cron-style unattended runs per project + environment (FR-060)."""
    __tablename__ = "schedules"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id"), index=True)
    environment_id: Mapped[str] = mapped_column(ForeignKey("environments.id"))
    cron: Mapped[str] = mapped_column(String(100))  # m h dom mon dow
    timezone: Mapped[str] = mapped_column(String(50), default="Asia/Riyadh")  # AST default
    branch: Mapped[str] = mapped_column(String(200), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    next_due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_by: Mapped[str] = mapped_column(String(36), default="")


# ---------------------------------------------------------------------------
# Integrations — Jira/Xray (FR-070), Confluence (FR-011), Slack (FR-072)
# ---------------------------------------------------------------------------

class Integration(TimestampMixin, Base):
    __tablename__ = "integrations"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id"), nullable=True, index=True)
    type: Mapped[str] = mapped_column(String(20))  # jira|xray|confluence|slack
    name: Mapped[str] = mapped_column(String(200), default="")
    config: Mapped[dict] = mapped_column(JSON, default=dict)  # non-secret: base_url, project_key, space…
    secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)  # FR-083
    state: Mapped[str] = mapped_column(String(20), default="configured")  # configured|connected|error
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    alert_level: Mapped[str] = mapped_column(String(20), default="failures")  # slack: all|failures|regressions


class DefectExport(TimestampMixin, Base):
    """One row per (integration, run, case) — the dedupe key that turns a re-export
    into an update instead of a duplicate issue (FR-070 AC2)."""
    __tablename__ = "defect_exports"
    organisation_id: Mapped[str] = mapped_column(ForeignKey("organisations.id"), index=True)
    integration_id: Mapped[str] = mapped_column(ForeignKey("integrations.id"), index=True)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id"), index=True)
    test_case_id: Mapped[str] = mapped_column(ForeignKey("test_cases.id"), index=True)
    external_key: Mapped[str] = mapped_column(String(100), default="")  # e.g. PAY-231
    external_url: Mapped[str] = mapped_column(String(500), default="")
    severity: Mapped[str] = mapped_column(String(20), default="")
    action: Mapped[str] = mapped_column(String(20), default="created")  # created|updated
    synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
