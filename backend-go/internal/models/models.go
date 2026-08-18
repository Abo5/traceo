// Package models: GORM schema — 1:1 port of the Python reference (TRD §5 + v2 addendum).
// Tenant-scoped tables carry OrganisationID; isolation enforced in the query layer.
package models

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// ---- JSON column types (stored as TEXT) ----

type JSONMap map[string]any

func (m JSONMap) Value() (driver.Value, error) {
	if m == nil {
		m = JSONMap{}
	}
	b, err := json.Marshal(m)
	return string(b), err
}

func (m *JSONMap) Scan(v any) error {
	return scanJSON(v, m)
}

type JSONList []any

func (l JSONList) Value() (driver.Value, error) {
	if l == nil {
		l = JSONList{}
	}
	b, err := json.Marshal(l)
	return string(b), err
}

func (l *JSONList) Scan(v any) error {
	return scanJSON(v, l)
}

// StringList is a JSON array of strings. JSONList would store the same bytes,
// but every reader would then have to assert each element back to a string;
// the columns that hold a fixed vocabulary use this instead so the type says
// what is in them.
type StringList []string

func (l StringList) Value() (driver.Value, error) {
	if l == nil {
		l = StringList{}
	}
	b, err := json.Marshal(l)
	return string(b), err
}

func (l *StringList) Scan(v any) error {
	return scanJSON(v, l)
}

func scanJSON(v, dst any) error {
	switch t := v.(type) {
	case nil:
		return nil
	case []byte:
		if len(t) == 0 {
			return nil
		}
		return json.Unmarshal(t, dst)
	case string:
		if t == "" {
			return nil
		}
		return json.Unmarshal([]byte(t), dst)
	}
	return errors.New("unsupported JSON column type")
}

// ---- Base ----

type Base struct {
	ID        string    `gorm:"primaryKey;size:36" json:"id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (b *Base) BeforeCreate(_ *gorm.DB) error {
	if b.ID == "" {
		b.ID = uuid.NewString()
	}
	return nil
}

// ---- Tables ----

type Organisation struct {
	Base
	Name     string  `json:"name"`
	Plan     string  `gorm:"default:free" json:"plan"`
	Settings JSONMap `gorm:"type:text" json:"settings"`
}

type User struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	Email          string `gorm:"uniqueIndex" json:"email"`
	Name           string `json:"name"`
	PasswordHash   string `json:"-"`
	Role           string `gorm:"default:qa_engineer" json:"role"` // admin|qa_lead|qa_engineer|viewer
	Locale         string `gorm:"default:en" json:"locale"`
}

type Project struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	Name           string `json:"name"`
	Status         string `gorm:"default:active" json:"status"` // active|archived
	// Automation "auto" runs the autopilot chain after parse/import (confirm
	// extracted requirements -> enqueue generation); "manual" preserves the
	// hand-driven flow. Approval and runs stay manual either way (BO-07).
	Automation string `gorm:"not null;default:auto" json:"automation"`
	// TestTypes: which of the five kinds of testing this project is for
	// (internal/testtypes). Declared when the project is created and editable
	// afterwards; the engines that produce cases read it, so narrowing it
	// narrows what the project does. An empty list means the same as all five —
	// a project that had nothing said about it predates the field, and reading
	// that as "test nothing" would silently disable every existing project.
	TestTypes StringList `gorm:"type:json;not null;default:'[]'" json:"test_types"`
}

type Environment struct {
	Base
	OrganisationID      string  `gorm:"index" json:"organisation_id"`
	ProjectID           string  `gorm:"index" json:"project_id"`
	Name                string  `json:"name"`
	BaseURL             string  `json:"base_url"`
	AuthType            string  `gorm:"default:none" json:"auth_type"` // none|api_key|basic|bearer|oauth2_cc
	AuthConfigEncrypted []byte  `json:"-"`
	Variables           JSONMap `gorm:"type:text" json:"variables"`
	// Pointer, not bool: GORM treats a zero value as "unset" and writes the
	// column default, so `tls_strict: false` from the client silently became
	// true and TLS verification could never be turned off.
	TLSStrict *bool `gorm:"default:true" json:"tls_strict"`
}

type SourceDocument struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	ProjectID      string `gorm:"index" json:"project_id"`
	Filename       string `json:"filename"`
	MimeType       string `json:"mime_type"`
	Size           int64  `json:"size"`
	StorageKey     string `json:"storage_key"`
	Language       string `gorm:"default:en" json:"language"`
	Version        int    `gorm:"default:1" json:"version"`
	ParseStatus    string `gorm:"default:pending" json:"parse_status"` // pending|parsing|parsed|failed
	ParseError     string `json:"parse_error,omitempty"`
}

type Requirement struct {
	Base
	OrganisationID     string   `gorm:"index" json:"organisation_id"`
	ProjectID          string   `gorm:"index" json:"project_id"`
	SourceDocumentID   *string  `json:"source_document_id"`
	ExternalID         string   `json:"external_id"`
	Description        string   `json:"description"`
	AcceptanceCriteria JSONList `gorm:"type:text" json:"acceptance_criteria"`
	Type               string   `gorm:"default:functional" json:"type"`
	Priority           string   `gorm:"default:medium" json:"priority"`
	State              string   `gorm:"default:extracted" json:"state"` // extracted|confirmed|changed|removed
	Version            int      `gorm:"default:1" json:"version"`
	SourceLocation     JSONMap  `gorm:"type:text" json:"source_location"`
	SourceText         string   `json:"source_text"`
	Confidence         float64  `gorm:"default:1" json:"confidence"`
	ContentHash        string   `json:"content_hash"`
}

type ApiSpec struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	ProjectID      string `gorm:"index" json:"project_id"`
	Source         string `json:"source"`
	Format         string `gorm:"default:openapi3" json:"format"`
	Version        int    `gorm:"default:1" json:"version"`
	Title          string `json:"title"`
}

type Endpoint struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	// Empty for endpoints discovered without a spec document (FR-021/022/023).
	// The column carries no NOT NULL constraint, so no migration is needed here.
	ApiSpecID       string   `gorm:"index" json:"api_spec_id"`
	ProjectID       string   `gorm:"index" json:"project_id"`
	Method          string   `json:"method"`
	Path            string   `json:"path"`
	OperationID     string   `json:"operation_id"`
	Summary         string   `json:"summary"`
	Parameters      JSONList `gorm:"type:text" json:"parameters"`
	RequestSchema   JSONMap  `gorm:"type:text" json:"request_schema"`
	ResponseSchemas JSONMap  `gorm:"type:text" json:"response_schemas"`
	Security        JSONList `gorm:"type:text" json:"security"`
	Tags            JSONList `gorm:"type:text" json:"tags"`
	Excluded        bool     `gorm:"default:false" json:"excluded"`
	// Source records which discovery mode produced this endpoint. When several
	// modes see the same one, the highest-fidelity source wins per attribute:
	// spec > traffic > dom > postman (SRS §L2).
	Source string `gorm:"default:spec" json:"source"`
	// ObservedCount is how many times traffic capture saw this endpoint
	// (FR-021 AC-3); stays 0 for endpoints that were declared, not observed.
	ObservedCount int `gorm:"default:0" json:"observed_count"`
	// AI enrichment (API collection import contract item 3) — descriptive ONLY.
	// Written exclusively by the validated enrichment layer, which may never
	// create, rename or delete an endpoint nor touch a path, parameter or field.
	// All three are NULLABLE and arrive through the AutoMigrate convention (no
	// backfill): plain-text one-line description, short resource group name, and
	// a criticality hint constrained to high|medium|low.
	AIDescription *string `gorm:"column:ai_description;type:text" json:"ai_description"`
	AIGroup       *string `gorm:"column:ai_group;size:80" json:"ai_group"`
	AICriticality *string `gorm:"column:ai_criticality;size:8" json:"ai_criticality"`
}

type TestCase struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	ProjectID      string `gorm:"index" json:"project_id"`
	Title          string `json:"title"`
	Description    string `json:"description"`
	Preconditions  string `json:"preconditions"`
	Type           string `gorm:"default:positive" json:"type"`
	Priority       string `gorm:"default:medium" json:"priority"`
	State          string `gorm:"default:draft" json:"state"` // draft|approved|rejected|stale|archived
	Generated      bool   `gorm:"default:false" json:"generated"`
	UserModified   bool   `gorm:"default:false" json:"user_modified"`
	Model          string `json:"model"`
	PromptVersion  string `json:"prompt_version"`
	// ep|bva|decision_table|negative|manual|localisation|edge_case|security
	// |design|a11y|performance|scenario — the canonical list is
	// backend/app/models.py TECHNIQUES. "scenario" is a behaviour a model
	// proposed for a crawled screen and the grounding gate admitted; it is kept
	// apart from the deterministic techniques because it is the one kind whose
	// EXPECTATION nothing verified, only its targets.
	Technique string `json:"technique"`
	// EdgeCategory is set ONLY by the insight engine (technique "edge_case") and
	// carries one of insight's 9 canonical category ids. NULL for every other
	// case — the column is nullable and needs no backfill (AutoMigrate adds it).
	EdgeCategory *string `gorm:"size:32;index" json:"edge_category"`
	// WeaknessID is set ONLY by the security engine (technique "security") and
	// carries a weakness id from the shipped catalogue (backend-go/internal/
	// modules/security/data/weaknesses.json). NULL for every other case — the
	// column is nullable and arrives through the AutoMigrate convention.
	WeaknessID      *string    `gorm:"size:64;index" json:"weakness_id"`
	ApprovedBy      *string    `json:"approved_by"`
	ApprovedAt      *time.Time `json:"approved_at"`
	RejectionReason string     `json:"rejection_reason,omitempty"`
	Version         int        `gorm:"default:1" json:"version"`

	Steps []TestStep `gorm:"foreignKey:TestCaseID;constraint:OnDelete:CASCADE" json:"steps,omitempty"`
}

type TestStep struct {
	Base
	TestCaseID  string   `gorm:"index" json:"test_case_id"`
	Order       int      `gorm:"column:step_order" json:"order"`
	EndpointID  *string  `json:"endpoint_id"`
	Method      string   `gorm:"default:GET" json:"method"`
	Path        string   `json:"path"`
	Request     JSONMap  `gorm:"type:text" json:"request"`
	Assertions  JSONList `gorm:"type:text" json:"assertions"`
	Extractions JSONList `gorm:"type:text" json:"extractions"`
}

// RequirementTestCase — "this table is the product" (TRD §5).
type RequirementTestCase struct {
	RequirementID            string    `gorm:"primaryKey;size:36" json:"requirement_id"`
	TestCaseID               string    `gorm:"primaryKey;size:36" json:"test_case_id"`
	LinkSource               string    `gorm:"default:generated" json:"link_source"`
	RequirementVersionAtLink int       `gorm:"default:1" json:"requirement_version_at_link"`
	CreatedAt                time.Time `json:"created_at"`
}

type Run struct {
	Base
	OrganisationID string `gorm:"index" json:"organisation_id"`
	ProjectID      string `gorm:"index" json:"project_id"`
	EnvironmentID  string `json:"environment_id"`
	State          string `gorm:"default:queued" json:"state"` // queued|running|completed|cancelled|aborted
	// Kind separates the run types so gates and reports never mix them
	// (SECURITY_TESTING_PLAN §8). NOT NULL, default "functional"; existing rows
	// take the default when AutoMigrate adds the column.
	Kind        string     `gorm:"not null;default:functional" json:"kind"` // functional|security|performance
	StartedAt   *time.Time `json:"started_at"`
	FinishedAt  *time.Time `json:"finished_at"`
	Counts      JSONMap    `gorm:"type:text" json:"counts"`
	InitiatedBy string     `json:"initiated_by"`
	AbortReason string     `json:"abort_reason,omitempty"`
}

type TestResult struct {
	Base
	RunID           string   `gorm:"index" json:"run_id"`
	TestCaseID      string   `gorm:"index" json:"test_case_id"`
	TestCaseVersion int      `gorm:"default:1" json:"test_case_version"`
	Outcome         string   `json:"outcome"` // passed|failed|errored
	DurationMs      int      `json:"duration_ms"`
	FailureReason   JSONMap  `gorm:"type:text" json:"failure_reason"`
	Evidence        JSONList `gorm:"type:text" json:"evidence"`
}

// AuditEntry — append-only (NFR-SEC-08); no update/delete path in the app layer.
type AuditEntry struct {
	ID             string    `gorm:"primaryKey;size:36" json:"id"`
	OrganisationID string    `gorm:"index" json:"organisation_id"`
	ActorID        *string   `json:"actor_id"`
	Action         string    `json:"action"`
	ObjectType     string    `json:"object_type"`
	ObjectID       string    `json:"object_id"`
	Detail         JSONMap   `gorm:"type:text" json:"detail"`
	OccurredAt     time.Time `json:"occurred_at"`
}

func (a *AuditEntry) BeforeCreate(_ *gorm.DB) error {
	if a.ID == "" {
		a.ID = uuid.NewString()
	}
	if a.OccurredAt.IsZero() {
		a.OccurredAt = time.Now().UTC()
	}
	return nil
}

// ---- v2 addendum ----

type ApiKey struct {
	Base
	OrganisationID string     `gorm:"index" json:"organisation_id"`
	Name           string     `json:"name"`
	Prefix         string     `json:"prefix"`
	KeyHash        string     `gorm:"index" json:"-"`
	CreatedBy      string     `json:"created_by"`
	LastUsedAt     *time.Time `json:"last_used_at"`
	Revoked        bool       `gorm:"default:false" json:"revoked"`
}

type Schedule struct {
	Base
	OrganisationID  string     `gorm:"index" json:"organisation_id"`
	ProjectID       string     `gorm:"index" json:"project_id"`
	EnvironmentID   string     `json:"environment_id"`
	Name            string     `json:"name"`
	IntervalMinutes int        `json:"interval_minutes"`
	Enabled         bool       `gorm:"default:true" json:"enabled"`
	LastRunAt       *time.Time `json:"last_run_at"`
	NextRunAt       *time.Time `json:"next_run_at"`
	CreatedBy       string     `json:"created_by"`
}

type Webhook struct {
	Base
	OrganisationID string     `gorm:"index" json:"organisation_id"`
	ProjectID      string     `gorm:"index" json:"project_id"`
	Name           string     `json:"name"`
	URL            string     `json:"url"`
	Secret         string     `json:"-"`
	Events         JSONList   `gorm:"type:text" json:"events"`
	Enabled        bool       `gorm:"default:true" json:"enabled"`
	LastStatus     *int       `json:"last_status"`
	LastFiredAt    *time.Time `json:"last_fired_at"`
}

// Component — one entry of the project's declared software inventory
// (SECURITY_TESTING_PLAN §2). Without it a CVE feed is news about other people's
// software, so this table is the precondition of the whole CVE track.
//
// Version is NULLABLE on purpose: an unpinned or ranged dependency is recorded
// with a null version and a stated reason. A version is NEVER guessed.
type Component struct {
	Base
	OrganisationID string  `gorm:"index" json:"organisation_id"`
	ProjectID      string  `gorm:"index;uniqueIndex:idx_component_identity" json:"project_id"`
	Name           string  `gorm:"size:255;uniqueIndex:idx_component_identity" json:"name"`
	Version        *string `gorm:"size:128;uniqueIndex:idx_component_identity" json:"version"`
	Ecosystem      string  `gorm:"size:64;uniqueIndex:idx_component_identity" json:"ecosystem"`
	// Purl is derived deterministically from name+version+ecosystem.
	Purl *string `gorm:"size:512" json:"purl"`
	// CPE23 is carried ONLY when the source document states it — a CPE is never
	// synthesised from a package name, because the vendor half cannot be derived.
	CPE23 *string `gorm:"column:cpe23;size:512" json:"cpe23"`
	// Source in fidelity order (§2): sbom > lockfile > manual > fingerprint.
	Source string `gorm:"size:32" json:"source"`
	// UnpinnedReason states why Version is null; null when the version is exact.
	UnpinnedReason *string `gorm:"size:255" json:"unpinned_reason"`
	Status         string  `gorm:"default:active" json:"status"` // active|removed
}

// WebTarget — a URL this project tests (web target contract §2). The row is
// created by the POST and updated by the discovery job, so a target is visible
// (status "pending") while the browser is still rendering: a job that dies never
// leaves the user with nothing.
//
// One row per (project, url, viewport): pointing Traceo at the same page again
// RE-discovers that target instead of accumulating duplicates, which is what
// keeps the requirements and cases derived from it stable.
type WebTarget struct {
	Base
	OrganisationID string     `gorm:"index" json:"organisation_id"`
	ProjectID      string     `gorm:"index;uniqueIndex:idx_web_target_identity" json:"project_id"`
	URL            string     `gorm:"size:1000;uniqueIndex:idx_web_target_identity" json:"url"`
	Viewport       string     `gorm:"size:20;default:1280x800;uniqueIndex:idx_web_target_identity" json:"viewport"`
	Status         string     `gorm:"size:20;default:pending" json:"status"` // pending|discovered|failed
	Title          string     `gorm:"size:500" json:"title"`
	FinalURL       string     `gorm:"size:1000" json:"final_url"`
	LastDiscovered *time.Time `gorm:"column:last_discovered_at" json:"last_discovered_at"`
	ScreenshotKey  string     `gorm:"size:300" json:"screenshot_key"`
	// Inventory is what the render actually found: the counts, the form/control/
	// request digests and the design summary. Stored rather than recomputed —
	// analysing a full-page raster costs seconds, and the detail route must
	// answer from what THIS discovery saw, not from a re-render of a page that
	// has since moved.
	Inventory JSONMap `gorm:"type:text" json:"inventory"`
	// LastError states why Status is "failed". A failed target with no reason is
	// indistinguishable from one nobody ever looked at.
	LastError *string `gorm:"type:text" json:"last_error"`
	// AuthConfigEncrypted holds {username, password} for the crawl's sign-in,
	// sealed with the same envelope environment secrets use. `json:"-"` is not
	// decoration: this value has no representation on the wire at all, and the
	// API answers auth_configured true/false instead.
	AuthConfigEncrypted []byte `json:"-"`
	// MaxPages is the crawl's page budget (1..50). The default explores — a user
	// who hands Traceo a URL is asking about the product, not one screen of it.
	MaxPages int `gorm:"default:25" json:"max_pages"`
}

func All() []any {
	return []any{
		&Organisation{}, &User{}, &Project{}, &Environment{}, &SourceDocument{},
		&Requirement{}, &ApiSpec{}, &Endpoint{}, &TestCase{}, &TestStep{},
		&RequirementTestCase{}, &Run{}, &TestResult{}, &AuditEntry{},
		&ApiKey{}, &Schedule{}, &Webhook{}, &Component{}, &WebTarget{},
	}
}

// TLSStrictOf reports an environment's TLS verification setting, defaulting to
// strict when the column was never written (nil).
func TLSStrictOf(e *Environment) bool {
	if e == nil || e.TLSStrict == nil {
		return true
	}
	return *e.TLSStrict
}
