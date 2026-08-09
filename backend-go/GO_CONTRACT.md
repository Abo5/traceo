# Traceo Go Backend — Module Contract

Go 1.23 · Gin · GORM (glebarez/sqlite, pure-Go) · port 8000. This backend is a 1:1 port of the
Python backend's HTTP surface: **routes, JSON field names, and status codes must match
backend/API_CONTRACT.md + backend/API_CONTRACT_V2_ADDENDUM.md exactly** — the existing Next.js
frontend must work unchanged. When in doubt about a response shape, read the corresponding
Python module in backend/app/modules/ — it is the behavioral reference.

## Layout
```
backend-go/
  go.mod                     module traceo
  cmd/server/main.go         wiring: engine, CORS, routes, startup seed, scheduler
  internal/config/           Settings from env (same TRACEO_* vars as Python)
  internal/models/           all GORM models + JSONMap/JSONList types
  internal/db/               Open() + AutoMigrate + seed demo users
  internal/security/         argon2id, JWT, permission matrix, secret box, Redact
  internal/httpx/            error envelope, auth middleware, org scoping, audit
  internal/jobs/             in-memory job manager (goroutines)
  internal/llm/              Provider interface + Mock (deterministic) + optional Anthropic
  internal/modules/<name>/   one package per module: identity, projects, ingestion,
                             discovery, generation, review, execution, traceability,
                             reporting, integrations, reference
```

## Shared helpers (already written — import, don't reinvent)

```go
config.C                                  // global Settings
db.Open() *gorm.DB                        // singleton via db.DB
security.HashPassword/VerifyPassword
security.CreateToken(userID, orgID, role) / DecodeToken(tok) (*Claims, error)
security.Has(role, capability) bool       // permission matrix (same capabilities as Python)
security.Encrypt(map[string]any) []byte / Decrypt([]byte) map[string]any   // AES-GCM
security.Redact(s string, secrets []string) string
httpx.Err(c, status, code, message)       // {"detail":{"code":...,"message":...}}
httpx.Auth() gin.HandlerFunc              // sets c "user" *models.User; 401 otherwise
httpx.Require(capability) gin.HandlerFunc // after Auth; 403 on missing permission
httpx.User(c) *models.User
httpx.ProjectScoped(c, projectID) (*models.Project, bool)  // org check; writes 404 + returns false
httpx.Audit(orgID, actorID, action, objType, objID string, detail models.JSONMap)
jobs.Submit(kind string, fn func(j *jobs.Job) (any, error)) *jobs.Job
jobs.SubmitForProject(kind, projectID, fn) *jobs.Job   // tracked for the autopilot guard
jobs.TrySubmitForProject(kind, projectID, fn) (*jobs.Job, bool) // atomic double-trigger guard
jobs.ActiveForProject(kind, projectID) bool            // queued/running job of kind for project?
jobs.Get(id string) *jobs.Job             // Job{ID,Kind,Status,Progress,Message,Result,Error,CreatedAt}
llm.Get().CompleteJSON(promptID, prompt string, schema map[string]any) (llm.Result, error)
```

Each module package exposes `func Register(r *gin.RouterGroup)` — mounted under /v1 in main.go.
Long operations: return 202 {"job_id": ..., ...}; job polled at GET /v1/jobs/{id}.
Timestamps: RFC3339 UTC. IDs: uuid v4 strings. JSON tags snake_case on every response struct
(or use gin.H). Multipart uploads: field name "file".

## LLM prompt contract (Mock heuristics depend on markers — port of Python mock.py)
- extract_requirement: prompt ends with "SEGMENT:\n"+text → {external_id, description,
  acceptance_criteria[], type, priority, confidence}
- map_requirement: prompt ends with "PAYLOAD:\n"+json({requirement, candidates[]}) →
  {selected: []int, confidence: float}

## Module ownership (routes identical to the Python contracts — read them)
- **identity**: /auth/register /auth/login /me /members* /audit
- **projects**: /projects CRUD, /projects/{id}/dashboard (incl. v2 trend/regression_watch/
  gaps_detail/open_defects/median_duration_ms), environments CRUD + check
- **ingestion**: documents upload+list, requirements list/patch/create/delete/confirm_all;
  parsing: PDF (ledongthuc/pdf), DOCX (zip+xml w:t), MD/TXT; Arabic-digit normalization,
  segmentation, per-segment llm extract, re-upload diff + mark stale
- **discovery**: api-specs import (file/url, openapi3+swagger2, $ref resolve, SSRF guard),
  endpoints list (incl. v2 test_count/covered_params_pct/last_outcome), PATCH excluded
- **generation**: generate job — mapper (lexical prefilter + llm pick from closed list),
  deterministic techniques (positive, EP invalid, BVA, negatives incl. oversized+injection,
  decision tables, localisation with Arabic round-trip), GroundingValidate(case, inventory)
  exported — discards violations, counts them; duplicates skip
- **review**: test-cases list/get/patch, approve/reject/bulk, manual create, links add/remove
- **execution**: runs launch (auth once per env: api_key/basic/bearer/oauth2_cc), goroutine
  pool concurrency, {{var}} interpolation + extractions chaining, assertion evaluator
  (status_code+expected_any, json_field ops eq/ne/gt/lt/contains/regex/exists/absent,
  response_time_ms, header, json_schema-lite), failed vs errored, evidence redacted+truncated,
  cancel, display_id; fires integrations.FireWebhooks on terminal state (lazy/no cycle)
- **traceability**: matrix rows/coverage_pct/gaps(+v2 reasons+next_action), MarkStale(),
  requirement history
- **reporting**: matrix.xlsx (excelize, 4 sheets, RTL when project ar, styled header FF8A22),
  run report JSON (severity, perf p50/p95/max), report.html (self-contained dark RTL printable),
  compare (+unchanged+coverage_delta)
- **integrations**: api-keys CRUD+revoke, X-API-Key alt auth for gate/runs/traceability reads,
  CI gate (+?exit=1→412), webhooks CRUD+test+FireWebhooks (HMAC, Slack text payload),
  xray.json + defects.csv (BOM), schedules CRUD + goroutine ticker scheduler, org export
- **reference**: GET /reference/features static catalog (37 features)
- **autopilot** (no routes — hooks called by ingestion/discovery): the v2 automation chain

## Automation addendum (fixed contract — parity with the Python backend is mandatory)

1. `POST /v1/projects` body: `name` (required), `language` OPTIONAL (`"ar"|"en"`; omitted/null
   => auto-detect later), `automation` OPTIONAL (`"auto"|"manual"`, default `"auto"`).
   Existing clients sending `language` keep working.
2. `Project.language` is NULLABLE in the DB and API responses (null until detected).
   `Project.automation` is NOT NULL, default `"auto"`. `PATCH /v1/projects/{id}` accepts both
   fields — freedom to override anytime.
3. Language auto-detection (deterministic, offline, NO LLM — `autopilot.DetectLanguage`):
   when a document parse job succeeds and `project.language` is null, count Arabic-block
   chars (U+0600–U+06FF) vs total alphabetic chars in the parsed text; ratio >= 0.25 =>
   `"ar"` else `"en"`; persist on the project. Runs regardless of the automation mode.
4. Autopilot chain — ONLY when `project.automation == "auto"`:
   a. after a successful document parse: language detection (3), then confirm ALL of the
      project's requirements currently in state `"extracted"`, then (b);
   b. generation auto-trigger (also after a successful api-spec import): >= 1 included
      endpoint AND >= 1 confirmed requirement AND no generation job for the project
      queued/running (`jobs.TrySubmitForProject("generate", projectID, ...)` is the atomic
      guard — manual generate jobs count too) => enqueue a standard-depth generation job
      over all confirmed requirements (`generation.Run` with nil requirement ids);
   c. approval and runs stay MANUAL — auto stops at draft cases ready for review (BO-07);
   d. every auto step writes an AuditEntry with an `auto.`-prefixed action
      (`auto.language.detect`, `auto.requirements.confirm_all`, `auto.generate`),
      attributed to the user whose upload/import initiated the chain.
5. All pre-existing manual endpoints keep working unchanged (confirm_all, generate, …) —
   automation adds defaults, removes nothing.

## Quality gates
backend-go/tests as Go tests (httptest against a fresh in-memory app+temp sqlite):
grounding gate (adversarial fixtures — zero fabricated identifiers persisted), tenant
isolation (org B gets 404/empty on all org A resources), e2e flow (register→project→upload
md→confirm→import spec→generate→approve→matrix+xlsx), integrations (api key auth, gate),
autopilot (nullable language + automation defaults, detection rule, auto chain to draft
cases, manual-mode opt-out, preset language kept, double-trigger guard).
`go vet ./...` clean; `go build ./...` clean; `go test ./...` green.
