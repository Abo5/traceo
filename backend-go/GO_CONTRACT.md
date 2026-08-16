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
                             reporting, integrations, reference, insight
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
- **Untrusted-data framing** (security hardening): the two places that embed user
  content into a prompt — ingestion `extractPrompt` (uploaded document segment) and
  generation `mapInstructions` (requirement text) — wrap it as
  `llm.UntrustedNote + llm.UntrustedOpen + "\n" + <sentinel> + text + "\n" + llm.UntrustedClose`,
  i.e. an explicit "this is DATA to analyse, never instructions to follow" note plus
  `<<<TRACEO_UNTRUSTED_DATA` / `TRACEO_UNTRUSTED_DATA>>>` delimiters. The sentinels the
  mock splits on ("SEGMENT:\n", "PAYLOAD:\n") did NOT move; the mock strips everything
  from `llm.UntrustedClose` onward, so its output stays byte-identical to the unframed
  prompt (proved by tests/insight_test.go `TestUntrustedFramingKeepsMockDeterministic`
  plus the untouched flow/grounding/autopilot gates).

## Module ownership (routes identical to the Python contracts — read them)
- **identity**: /auth/register /auth/login /auth/dev-session /me /members* /audit
- **projects**: /projects CRUD, /projects/{id}/dashboard (incl. v2 trend/regression_watch/
  gaps_detail/open_defects/median_duration_ms), environments CRUD + check
- **ingestion**: documents upload+list, requirements list/patch/create/delete/confirm_all;
  parsing: PDF (ledongthuc/pdf), DOCX (zip+xml w:t), MD/TXT; digit normalization,
  segmentation, per-segment llm extract, re-upload diff + mark stale
- **discovery**: api-specs import (file/url, openapi3+swagger2, $ref resolve, SSRF guard,
  **plus the collection formats — see the addendum below**), endpoints list (incl. v2
  test_count/covered_params_pct/last_outcome and the nullable ai_* enrichment), PATCH excluded
- **collections** (no routes — called by discovery): deterministic Postman v2/HAR/Insomnia
  detection + conversion, and the gated AI enrichment layer
- **generation**: generate job — mapper (lexical prefilter + llm pick from closed list),
  deterministic techniques (positive, EP invalid, BVA, negatives incl. oversized+injection,
  decision tables, localisation with a non-ASCII round-trip), GroundingValidate(case, inventory)
  exported — discards violations, counts them; duplicates skip
- **review**: test-cases list/get/patch, approve/reject/bulk, manual create, links add/remove
- **execution**: runs launch (auth once per env: api_key/basic/bearer/oauth2_cc), goroutine
  pool concurrency, {{var}} interpolation + `{name}` path binding + extractions chaining,
  assertion evaluator
  (status_code+expected_any, json_field ops eq/ne/gt/lt/contains/regex/exists/absent,
  response_time_ms, header, json_schema-lite), failed vs errored, evidence redacted+truncated,
  cancel, display_id; fires integrations.FireWebhooks on terminal state (lazy/no cycle)
- **traceability**: matrix rows/coverage_pct/gaps(+v2 reasons+next_action), MarkStale(),
  requirement history
- **reporting**: matrix.xlsx (excelize, 4 sheets, always LTR, styled header FF8A22),
  run report JSON (severity, perf p50/p95/max), report.html (self-contained dark printable,
  always `dir="ltr" lang="en"`), compare (+unchanged+coverage_delta)
- **integrations**: api-keys CRUD+revoke, X-API-Key alt auth for gate/runs/traceability reads,
  CI gate (+?exit=1→412), webhooks CRUD+test+FireWebhooks (HMAC, Slack text payload),
  xray.json + defects.csv (BOM), schedules CRUD + goroutine ticker scheduler, org export
- **insight** (the sixth engine, QA Insight Agent): GET /projects/{id}/insights
  + POST /projects/{id}/insights/generate — deterministic, ZERO LLM calls, reuses
  generation.GroundingValidate (see the addendum below)
- **reference**: GET /reference/features static catalog (37 features)
- **autopilot** (no routes — hooks called by ingestion/discovery): the v2 automation chain

## Automation addendum (fixed contract — parity with the Python backend is mandatory)

0. **The product is ENGLISH-ONLY.** There is no project language: `Project.Language` does
   not exist (removed via the AutoMigrate convention — the legacy SQLite column is simply
   left behind, unread and unwritten), `language` appears in no request or response payload,
   and no behaviour anywhere branches on a language. All output is LTR English.
1. `POST /v1/projects` body: `name` (required), `automation` OPTIONAL (`"auto"|"manual"`,
   default `"auto"`). A `language` key in the body is ignored (unknown fields always are).
2. `Project.automation` is NOT NULL, default `"auto"`. `PATCH /v1/projects/{id}` accepts
   `name`, `automation` and `status` — freedom to override anytime.
3. (removed — language auto-detection and the `auto.language.detect` audit action are gone.)
4. Autopilot chain — ONLY when `project.automation == "auto"`:
   a. after a successful document parse: confirm ALL of the project's requirements currently
      in state `"extracted"`, then (b);
   b. generation auto-trigger (also after a successful api-spec import): >= 1 included
      endpoint AND >= 1 confirmed requirement AND no generation job for the project
      queued/running (`jobs.TrySubmitForProject("generate", projectID, ...)` is the atomic
      guard — manual generate jobs count too) => enqueue a standard-depth generation job
      over all confirmed requirements (`generation.Run` with nil requirement ids);
   c. approval and runs stay MANUAL — auto stops at draft cases ready for review (BO-07);
   d. every auto step writes an AuditEntry with an `auto.`-prefixed action
      (`auto.requirements.confirm_all`, `auto.generate`), attributed to the user whose
      upload/import initiated the chain.
5. All pre-existing manual endpoints keep working unchanged (confirm_all, generate, …) —
   automation adds defaults, removes nothing.

## Insight-engine addendum (fixed contract — parity with the Python backend is mandatory)

**Taxonomy.** Nine canonical category ids, identical strings in both backends and the UI,
in this response order (`insight.Categories`):
`boundary_surprise | exotic_input | control_chars | idempotency | state_corruption |
permission_edge | timing_dst | resource_exhaustion | downstream_failure`.

**Schema.** `TestCase.edge_category` is a NULLABLE column (`*string`, `gorm:"size:32;index"`,
JSON `edge_category`) holding one of the nine ids; NULL for every pre-existing and
non-insight case. Added through the repo's AutoMigrate convention (`models.All()` already
lists TestCase — no backfill, no data migration). `TestCase.technique` gains the legal value
`"edge_case"` next to `ep|bva|decision_table|negative|manual|localisation`. Both fields ship
in the test-case payloads (`review.caseDict` → list + detail).

**Routes.**
1. `GET /v1/projects/{id}/insights` — capability `view`, org-scoped (404 for a foreign
   tenant), deterministic, NO job. Response:
   `{categories:[{id, covered_count, suggestable_count, status}], total_cases,
   total_covered, total_suggestable}`.
   `status` = `"covered"` when `covered_count > 0`, else `"gap"` when
   `suggestable_count > 0`, else `"n_a"` (nothing in the inventory to ground the category —
   e.g. no date/date-time field anywhere ⇒ `timing_dst` is `n_a`).
   `covered_count` counts non-archived cases already in the category: an `edge_category`
   match, or `insight.Classify` for legacy cases — a pure function that MIRRORS the Python
   `classify_case()` rule table line for line (step evidence first, then title keywords, no
   technique/type fallback), so both backends report the same `covered_count` for the same
   project. Its exotic_input evidence is general NON-ASCII (any rune above U+007F in a
   request value), never a script-specific rule; control characters still outrank it. Plain BVA is deliberately NOT `boundary_surprise`: taxonomy A defines that
   category as the edges BEYOND plain BVA. Rules documented in classify.go.
   `suggestable_count` is a dry run of the SAME planner the job uses (`insight.plan`),
   filtered by the same grounding gate — it creates nothing and already-existing cases are
   never re-suggested.
2. `POST /v1/projects/{id}/insights/generate` — capability `generate`, org-scoped. Body
   `{categories:[ids] (required, non-empty, all legal ⇒ otherwise 422 `invalid_category`),
   requirement_ids: optional subset}`. Returns `202 {"job_id": ...}` (kind `insight`,
   following the existing one-word job-kind convention, polled at `GET /v1/jobs/{id}`). The job runs the
   deterministic builders over the project's INCLUDED endpoints and persists TestCase rows
   in state `draft`, technique `edge_case`, `edge_category` set, each linked to ≥ 1
   requirement. Requirement → endpoint association is the generator's lexical
   `generation.Prefilter` (no LLM anywhere). Every case passes `generation.GroundingValidate`
   before persistence — reused verbatim, never bypassed or reimplemented; failures are
   discarded and counted exactly as the generator does. Result:
   `{generated, discarded, duplicates, categories, by_category}` — `by_category` carries
   every REQUESTED category, zeros included, and `duplicates` counts candidates the project
   already covers. One audit entry per run: action `insight.generate` with
   `{categories, created, discarded, duplicates}`.

**Builders** derive values ONLY from the inventory, and match the Python engine case for
case (same counts per category for the same inventory — verified by a cross-backend parity
probe). `exotic_input` mutates an EXISTING free-text BODY field or QUERY parameter — never a
path parameter, which is routing rather than payload — with the four character-set probes
(mixed-script CJK + accented Latin, emoji, NFC-vs-NFD, zero-width — a general non-ASCII
mix with ZERO Arabic); oversized values belong to
`resource_exhaustion` per contract item D, not here;
`control_chars` writes NUL/C0 into one; `boundary_surprise` uses the just-OUTSIDE values
plain BVA never emits (min-1, max+1, maxLength+1, minLength-1); `idempotency` repeats the
SAME existing mutating step twice (no 5xx, no duplicate side effect); `state_corruption`
pairs a DELETE with another EXISTING method on the same path; `permission_edge` replays the
same request as a lower-privileged actor and only fires when the endpoint declares security;
`timing_dst` only fires on fields whose schema type/format is date/date-time; 
`resource_exhaustion` uses an EXISTING pagination parameter or an oversized value for an
EXISTING string field; `downstream_failure` only fires when the endpoint DOCUMENTS a 5xx.
A category with nothing to ground itself in produces zero cases and is reported `n_a` —
it never invents an endpoint, parameter or field.

Everything else is unchanged: no existing endpoint changes shape, manual flows and the
autopilot (`automation auto|manual`) are untouched — the engine is opt-in via its own two
routes (its jobs use their own kind, so the autopilot's `generate` guard is unaffected).

## API collection import + AI enrichment addendum (fixed contract — parity with the Python backend is mandatory)

**No new routes.** Everything lands on the endpoint that already takes OpenAPI:
`POST /v1/projects/{id}/api-specs` (multipart `file` OR `{"url": ...}`, same 5MB cap,
same SSRF guard). Package `internal/modules/collections` owns detection, conversion and
enrichment; `discovery` wires it in. **OpenAPI 3.x / Swagger 2.0 behaviour is unchanged.**

**1. Format detection** (deterministic, on the parsed document, before OpenAPI validation):

| format id   | detected by                                                        | `Endpoint.source` |
|-------------|--------------------------------------------------------------------|-------------------|
| `openapi3`  | `openapi: 3.x` (existing)                                           | `spec`            |
| `swagger2`  | `swagger: "2.0"` (existing)                                         | `spec`            |
| `postman2`  | `info.schema` contains `getpostman.com/json/collection/v2` (v2.0+v2.1) | `postman`      |
| `har`       | top-level `log` object carrying `entries`                            | `traffic`         |
| `insomnia4` | `"_type":"export"` plus `resources`                                  | `postman`         |

The `Endpoint.source` enum is NOT extended — Insomnia reuses `postman` per the contract's
preference. When nothing matches, the existing `422 invalid_spec` is kept and its `errors`
list ends with `collections.SupportedFormatsNote`, which names every accepted format.
A collection that yields zero requests is also `422 invalid_spec`.

**2. Deterministic conversion (NO LLM — the grounding source of truth).** Every format
produces the SAME inventory shape the OpenAPI importer emits
(`{name, location, type, required, constraints}` parameters, an inferred request schema,
response schemas keyed by status code):
- **paths**: Postman `:param` and `{{var}}` segments become `{param}`; a leading base-url
  variable (`{{baseUrl}}`, `{{ _.baseUrl }}`) or an absolute origin is stripped so paths are
  server-relative; trailing slashes and duplicate slashes are normalized away.
- **HAR/Insomnia concrete ids** are templated with a documented, narrow heuristic
  (`collections.concreteIDName`): a segment that is all digits, a canonical UUID, or a 24+
  character hex token becomes `{id}`, then `{id2}`, `{id3}`, … within the same path.
- **variables** are resolved from collection variables / `url.variable` / Insomnia
  environments and recorded as `constraints.example`; they are never baked into the path.
- **query params** come from `url.query` (Postman), `queryString` (HAR), `parameters`
  (Insomnia) or the raw query string, with `constraints.example` and a scalar type inferred
  from that example (`true/false` → boolean, integers → integer, other numerics → number,
  else string). `disabled` entries are skipped. **Headers are captured as `location:
  "header"` params, never as query params**; credential-bearing header values
  (authorization, cookie, x-api-key, proxy-authorization) are captured by NAME only.
- **request body**: raw/JSON examples produce an inferred JSON Schema — types from values,
  objects and arrays recursed, NOTHING invented (no `required`, no formats, no extra
  fields). Non-JSON bodies (formdata, urlencoded, file, graphql) record the media type
  under `x-media-type` plus the field names only.
- **responses**: HAR response statuses and Postman saved-response `code`s are recorded as
  observed status codes, with a schema inferred from the example body when it is JSON.
- **dedupe**: identical method+path merge — params union on (name, location), request
  schemas merge property-wise, response schemas merge per status, `observed_count` sums
  (HAR only; collections leave it 0).
- collections declare no `operation_id`, `security` or `tags`, so those stay empty.

**3. Fidelity precedence `spec > traffic > dom > postman` governs re-imports** (upsert, not
replace): a row is written only when the importing source ranks >= the row's current source,
and an import removes only rows that came from its OWN source. So a later OpenAPI import
wins over collection-derived data for the same endpoint and never deletes the rest; a later
collection import never downgrades a spec-sourced row. Rows are updated in place, so ids,
the `excluded` flag (FR-DSC-05), grounding links and the ai_* enrichment survive re-imports.
`observed_count` is STATED by a traffic import (summed within one file, not accumulated
across imports), so re-importing the same document is a no-op in every format.

**4. AI enrichment (optional, gated — "the model proposes, the system verifies").**
After a SUCCESSFUL collection import, and only when `project.automation == "auto"` (the
existing flag — no new one), the DETERMINISTIC inventory (methods, paths, param names,
inferred body field names — **never raw file text**) goes to `llm.Get()` with promptID
`enrich_endpoints`, batched 50 endpoints per call, framed with the untrusted-data
delimiters. The model is asked ONLY for a one-line plain-English description, a resource
group name, and a criticality hint (`high|medium|low`).
**The gate (`collections.ValidateEnrichment`, exported so it can be tested adversarially)
is inviolable:** every item is matched to the inventory by EXACT method+path; unknown
method/path, a renamed path, a referenced parameter/field outside the endpoint's closed
list, a duplicate item, or nothing usable ⇒ DISCARDED and counted. Descriptions and groups
are stored as sanitized PLAIN TEXT (control characters and angle brackets stripped,
whitespace collapsed, clipped to 300/60 runes); an illegal criticality is dropped.
Enrichment may NEVER create, rename or delete an endpoint, nor alter a path, param or field
— it only writes the three ai_* columns. A provider error, empty output or garbage means
the import still SUCCEEDS with zero enrichment. Since the import is synchronous in both
backends, the counters travel in the import response (and the `spec.imported` audit detail).

**5. Schema.** `Endpoint` gains three NULLABLE columns via the AutoMigrate convention (no
backfill): `ai_description` (text), `ai_group` (short string), `ai_criticality`
(`high|medium|low`). They ship in every endpoint payload as `ai_description`, `ai_group`,
`ai_criticality` (null when absent).

**6. Response shape.** `POST /v1/projects/{id}/api-specs` keeps every existing key with its
existing meaning (`spec_id`, `version`, `endpoints_count`, `warnings`, `diff{added,
removed, changed}` — lists) and ADDS: `format` (one of the five ids), the counters `added`,
`updated`, `removed`, `total` (integers — created rows, rows whose signature changed, rows
deleted, inventory size) and `enriched` / `enrichment_discarded`.

**7. Deterministic mock.** `mockProvider.enrichEndpoints` keys on the marker
`"INVENTORY:\n"` and describes ONLY the endpoints it was handed, copying method and path
verbatim: description `"<verb> the <resource> resource at <path>."`, group = first concrete
(non-templated, non-`v<N>`) path segment, criticality = DELETE `high` / other writes
`medium` / reads `low`. Every pre-existing mock behaviour is byte-identical — this is a new
promptID branch only.

## Derived environment addendum (fixed contract — parity with the Python backend is mandatory)

An imported document already states its base URL, so the import derives a **runnable
environment** instead of leaving the New run screen with an empty picker.
`internal/modules/collections/environment.go` owns the derivation (deterministic, part of the
existing conversion — **no LLM**); `discovery.autocreateEnvironment` wires it in.
**No new routes.**

**1. Base-URL derivation** — `collections.DeriveEnvironment(format, root) EnvironmentDraft`:

| format                | base URL                                                                    |
|-----------------------|-----------------------------------------------------------------------------|
| `postman2`            | collection variable named `baseUrl`/`base_url`/`url`/`host` (case-insensitive, that PREFERENCE order, first usable match wins); else the most frequent origin across the request URLs |
| `insomnia4`           | same names in the `environment` resources' `data`; else the most frequent origin |
| `har`                 | the most frequent origin across `log.entries[].request.url`                   |
| `openapi3`            | `servers[0].url`, with declared server-variable `default`s substituted        |
| `swagger2`            | `schemes` (https preferred) + `host` + `basePath`                             |

A candidate is USABLE only if it states `scheme://host` and holds no unresolved `{…}`
placeholder; userinfo, query, fragment and the trailing slash are dropped. Most-frequent
ties break on first appearance (Python `Counter.most_common` semantics).
**If nothing can be derived, nothing is derived — a host is NEVER invented.**

**The invariant: `base_url + endpoint path` reconstructs the original URL exactly.** Endpoint
paths are stored server-relative with ONLY the origin (or the leading `{{baseUrl}}` token)
stripped, so the derived base carries exactly what was stripped — including a path prefix
such as `/calendar/v3` that lived inside the variable. That is also why the most-frequent
fallback derives the ORIGIN only: nothing beyond `scheme://host` was removed from those
paths, so appending a "common prefix" would double it.

**2. Suggested variables.** Every OTHER collection/environment variable becomes the
environment's `variables` map with its example value. A name containing `token`, `secret`,
`key`, `password`, `auth`, `bearer` or `apikey` (case-insensitive substring,
`collections.IsCredentialName`) is a CREDENTIAL: the key is carried with an **empty** value
for the user to fill, and its value is never copied into the database, a response, or a log.

**3. Auto-create on import.** After a SUCCESSFUL api-specs import, when the project has
**zero** environments AND a base URL was derived: create one via `projects.CreateEnvironment`
(the single environment-creation path, shared with `POST /environments`) with
`name = "<document title> (imported)"` clipped to the 100-char column limit, falling back to
`"Imported environment"`; `base_url` = derived; `auth_type = "none"`; `variables` = item 2;
`tls_strict = true`. An existing environment is NEVER touched or overwritten — this only ever
fills a genuine void. Audit action **`environment.autocreated`** (`environment`/`env.ID`,
detail `{"name", "auth_type", "auth_config_set", "format", "base_url", "variables"}` — the
base detail every environment write records, plus the source format, the derived URL and the
variable NAMES; a variable VALUE never reaches the audit trail). A failure here never fails
the import.

**Document title.** The title feeding `EnvironmentName` (and the ApiSpec row) is what the
document calls itself, byte for byte as the Python backend derives it: Postman `info.name`;
HAR `log.creator.name` (the creator's *version* is NOT appended — it names a tool build, not
the document); Insomnia the **workspace** resource's `name` (`__export_source` identifies the
exporting application, not the document, and must never become an environment name).

**4. Response.** `POST /v1/projects/{id}/api-specs` gains exactly one key,
`environment_created`: `null`, or `{id, name, base_url}` (those three keys only). Every
pre-existing key keeps its name and meaning; the grounding gate and every other behaviour
are untouched.

## Path parameters and dev auto-login (fixed contract — parity with the Python backend)

**Path-parameter binding** (`internal/modules/execution`, port of `_bind_path_params`).
Inventories store paths as templates (`/calendars/{calendarId}/events`) and the value lives
in the step's params, so sending the template literally requests a URL that cannot exist —
every path-parameterised case would 404 whatever the system under test does. Once per step,
AFTER `{{var}}` interpolation and AFTER the params map is assembled, every **single-brace**
`{name}` placeholder (`\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}` — the `{{var}}` mechanism is
separate and already ran) is resolved:

1. the step/auth params, when the key is present and non-null — the key is then REMOVED from
   the params map so the value is not also sent as a query parameter;
2. otherwise the run context (environment variables), which consumes nothing;
3. otherwise the placeholder is left literal.

Values are percent-encoded as `urllib.parse.quote(v, safe="")` — nothing is safe, so a value
containing `/` or a space cannot alter the path structure.

**Dev auto-login.** `POST /v1/auth/dev-session` returns `{token, user}` exactly like
`/auth/login` for the configured user, with no credentials. Guards:

| | |
|---|---|
| `TRACEO_DEV_AUTOLOGIN` | `"1"` enables the route; anything else (default) → **404** `not_found`, indistinguishable from a route that does not exist |
| `TRACEO_DEV_AUTOLOGIN_EMAIL` | user to hand out, default `demo@traceo.sa`; matched case-insensitively after trimming |
| no such user | **503** `dev_session_unavailable`, message naming the address looked up |
| `TRACEO_ENV=production` + flag on | `config.ProductionSafetyError` refuses to boot, alongside the dev-secret and demo-seed checks |

Every success writes the audit action **`auth.dev_session`** (`user`/user id, detail
`{"email"}`).

## Security testing S0 + component inventory S2 (fixed contract — parity with the Python backend is mandatory)

Implements phases **S0** and **S2** of `docs/SECURITY_TESTING_PLAN.md`. Security is a
**technique family inside generation**, not a second engine: the requirement → endpoint
mapping, the case shape, the grounding gate, jobs, review, approval and the traceability
matrix are all the existing ones. **Zero LLM calls** — every builder is deterministic, so
the whole phase works air-gapped and the coverage matrix is reproducible.

### 1. The weakness corpus is a shipped DATA file
`backend/app/data/weaknesses.json` is the ONE source of truth for both backends;
`go:embed` cannot reach outside the module, so `internal/modules/security/data/weaknesses.json`
is a **byte-identical copy**, refreshed by `./scripts/sync-weaknesses.sh` (also wired as the
package's `go:generate` step) and guarded by `tests/weakness_catalogue_test.go`, which FAILS
the build when the two files diverge. Version `1.0.0` ships the ten classes
`missing-authn · broken-object-level-authz · broken-function-level-authz · mass-assignment ·
injection-surface · input-validation · error-leakage · security-headers · token-handling ·
rate-limiting`, each with `title`, `description`, `refs{owasp_api (NULLABLE — the 2023 API
Top 10 has no injection entry and none is invented), cwe[], asvs[]}`, `severity`
(critical|high|medium|low), `activity` (passive|active), `precondition` and `checks`.
`mass-assignment` (it writes) and `rate-limiting` (it floods) are **active**.

`checks` names the assertion FAMILIES a class verifies. The builders emit them literally,
including the S1 types the executor does not know yet (`no_5xx`, `body_not_matches`,
`header_present`, `header_absent`, `rate_limited_within`) — both engines skip unknown
assertion types rather than failing on them, so the case ships with the knowledge and the
runner gains the ability in S1.

### 2. `security.Applicable(endpoint, weakness) (bool, reason)` — pure, reason REQUIRED
The precondition vocabulary is CLOSED, and every term is a named predicate over the
endpoint record plus the reason printed when it does not hold:
`always · declares_security · path_has_parameter · request_has_body · has_string_field ·
has_constrained_input · request_has_privileged_field`. A term the table does not define is
reported as unknown, never assumed — a catalogue typo is visible in the report instead of
silently generating (or silently skipping) cases. A skipped pair with no reason is
indistinguishable from a pair nobody thought about, which is why the reason is mandatory.

### 3. `security.BuildCases(requirement, endpoint, weakness) []case`
Case dicts carry exactly the keys the functional generator returns (`title`, `description`,
`preconditions`, `type`, `priority`, `technique`, `steps`, `requirement_ids`) plus
`weakness_id`; `technique = "security"`, `priority` = the class's base severity, and
`steps[0]` carries method/path/request exactly like a generated functional case
(`generation.Step`). Targets come from the GENERATOR'S own helpers, newly exported in
`generation/exported.go` (`Input`, `ConstrainedInputs`, `FreeTextBodyFields`, `ParamSchema`,
`IsFreeText`, `InvalidFor`, `ApplyInput`, `Step`) — reused, never restated, so both engines
violate a constraint and pick a free-text field the same way. Where Python iterates a JSON
object's declaration order, Go sorts the property names: a Go map has no order, and sorted
is the deterministic equivalent.

**Traceability (BO-07).** Every case carries non-empty `requirement_ids`. The anchor comes
from `endpointRequirements`: existing traceability links first (a requirement already linked
to a case that hits this endpoint is the strongest statement of intent there is), then the
generator's own lexical `generation.Prefilter`, each list sorted by `(external_id, id)`. An
endpoint no requirement maps to produces **NO** security cases, and the reports state that as
its own reason — that is BO-07, not a bug. **Grounding:** every case passes
`generation.GroundingValidate` before persistence, reused verbatim; failures are discarded
and counted, never repaired or shown.

### 4. Routes
| route | capability | notes |
|---|---|---|
| `GET /v1/weaknesses` | `view` | `{version, weaknesses[]}` — the shipped corpus verbatim |
| `POST /v1/projects/{id}/security/generate` | `generate` | body `{weakness_ids?, requirement_ids?}` → `202 {job_id}` (job kind `security`); an id outside the corpus ⇒ `422 unknown_weakness` with `errors` = the sorted corpus |
| `GET /v1/projects/{id}/security/coverage` | `view` | the §11 matrix |
| `POST /v1/projects/{id}/components` | `import_spec` | multipart `file` → `202 {job_id}` (job kind `ingest`); empty ⇒ `422 empty_file`, >10MB ⇒ `413 file_too_large`, unrecognised ⇒ `422 unsupported_component_format` with `errors` = the supported formats |
| `GET /v1/projects/{id}/components` | `view` | `{components: [...]}` ordered by ecosystem, name |
| `DELETE /v1/components/{id}` | `import_spec` | `{deleted: true, id}`; 404 across tenants |

Generate job result: `{generated, discarded, skipped:[{endpoint:"METHOD path", weakness,
reason}]}`. Coverage: `{corpus_version, pairs{total, covered, not_applicable, gap},
by_weakness[{weakness_id, covered, not_applicable, gap}] (catalogue order),
skipped[{endpoint_id, method, path, weakness_id, reason}]}` where
`covered + not_applicable + gap == total` always, `covered` is PAIR granularity (token
handling emits two cases and covers its pair once), and **`gap` = applicable but no case
exists — the number that matters**. `skipped` carries every not-applicable pair with the
precondition that failed, plus every gap that CANNOT be covered until a requirement maps
there (the BO-07 reason). Audit actions: **`security.generate`**, **`components.import`**.

### 5. Safety rail (§7)
An ACTIVE class is GENERATED and MARKED, never executed: `execution.runnableCases` drops
any case whose `weakness_id` names an active class at both selection points, and
`ExecuteRun` drops it again, so no path can route around the rail until the S1
per-environment authorisation flag exists.

### 6. Component inventory (S2)
`internal/modules/components/parse.go` holds six PURE parsers — no network, no filesystem,
no clock: `cyclonedx` · `spdx` · `package-lock.json` (v1 `dependencies` and v2/v3
`packages`) · `requirements.txt` · `go.sum` (the `/go.mod` twin deduplicated) ·
`poetry.lock`. Detection is content-first, filename only as a tie-breaker. **A VERSION IS
NEVER INVENTED:** a range, a bare name, an absent `version` or SPDX `NOASSERTION` is stored
as `version = NULL` with a stated `unpinned_reason`, because "we do not know which version
runs" is a fact the CVE track must be told, not a blank to fill in. A purl is derived
deterministically (`pkg:{ecosystem}/{name}@{version}`, PEP 503 normalisation for pypi,
scoped npm names kept verbatim); a **cpe23 is only ever carried when the document states
one** — the vendor half cannot be derived from a package name, so it is never synthesised.
Import result: `{format, added, updated, unpinned, total}` where `total` is the size of the
imported DOCUMENT; re-importing is idempotent (`added: 0`).

### 7. Schema
`TestCase.weakness_id` (nullable, `size:64`, indexed, in every test-case payload) and
`TestCase.technique` gains the legal value `security`. `Run.kind` (NOT NULL, default
`functional`, values `functional|security|performance`) ships in every run payload. New
table `Component(organisation_id, project_id, name, version NULLABLE, ecosystem, purl,
cpe23, source sbom|lockfile|manual|fingerprint, unpinned_reason, status)` with a unique
index on `(project_id, name, version, ecosystem)`; because SQL treats NULLs as distinct, the
upsert lookup is explicitly NULL-aware so an unpinned line does not add a row per upload.
All of it arrives through the AutoMigrate convention — no backfill.

## Quality gates
backend-go/tests as Go tests (httptest against a fresh in-memory app+temp sqlite):
grounding gate (adversarial fixtures — zero fabricated identifiers persisted), tenant
isolation (org B gets 404/empty on all org A resources), e2e flow (register→project→upload
md→confirm→import spec→generate→approve→matrix+xlsx), integrations (api key auth, gate),
autopilot (automation defaults + no language field in any payload, auto chain to draft
cases, manual-mode opt-out, double-trigger guard), insight
(taxonomy strings + order, covered/gap/n_a semantics, legacy classifier, 422
invalid_category, 202 job pattern, capability guards + tenant isolation, adversarial
grounding over every persisted edge case, offline guarantee, mock-determinism under the
untrusted-data framing, exotic probes non-ASCII yet Arabic-free), collections
(`tests/collections_test.go` — the REAL 300KB Postman v2.1 export in `tests/fixtures/`:
37 endpoints, `:param` templating, `{{baseUrl}}` stripping, typed query examples, header
params, inferred body schemas with no invented fields, observed status codes, idempotent
re-import; HAR concrete-id templating + observed_count + credential-header redaction;
Insomnia; the 422 that names the supported formats; the ADVERSARIAL enrichment gate;
fidelity precedence both ways; OpenAPI regression; mock determinism; nullable ai_* columns),
derived environment (`tests/environment_import_test.go` — the same real Postman export
yields `base_url = https://www.googleapis.com/calendar/v3` and `calendarId` as a suggested
variable, `base_url + path` reconstruction, HAR most-frequent origin, Insomnia environment
variable, OpenAPI `servers[0]` with a variable default, Swagger `schemes+host+basePath`, a
spec without `servers` derives NOTHING, an existing environment is never touched, a
re-import creates nothing, credential-named variables carried empty with their live values
never disclosed, name precedence, userinfo stripping, name fallback + column limit),
path binding (`tests/path_binding_test.go` — a real run against a local recorder asserts the
request line on the wire: value from the step params with the consumed key gone from the
query, value from an environment variable, an unfillable placeholder left literal, and a
value containing a space and a slash percent-encoded), dev auto-login
(`tests/dev_session_test.go` — 404 while off, token+user+`auth.dev_session` audit entry when
on, 503 `dev_session_unavailable` when the configured user is missing, production refusal),
security S0 (`tests/security_test.go` — the corpus is shipped, versioned and well-formed with
every precondition inside the closed vocabulary; `Applicable` never refuses without a reason;
every persisted case re-validated against `generation.GroundingValidate` and linked to a
requirement; the auth classes build the right request shapes (`Authorization` dropped,
`{{low_privilege_token}}`, `{{expired_token}}`/`{{unsigned_token}}`, `{{foreign_object_id}}`
in the DECLARED path parameter); an endpoint with no requirement generates NOTHING and both
reports say why; the matrix adds up and `gap` shrinks after generation; re-running generates
nothing; `422 unknown_weakness`; capability guards + tenant isolation; the ACTIVE-class
executor rail and `run.kind`) and the catalogue sync gate (`tests/weakness_catalogue_test.go`
— byte-identity with `backend/app/data/weaknesses.json`, skipped only in a Go-only checkout),
components S2 (`tests/components_test.go` — all six parsers, ranges and `NOASSERTION` stored
as NULL with a reason, `-r` directives ignored, the `/go.mod` twin deduplicated, poetry
sub-tables ignored, scoped npm purls, the npm root skipped, v1 nested dependencies walked,
idempotent re-import, the 422 that names the supported formats, delete + tenant isolation +
capability guards, and both audit actions).
`gofmt -l .` silent; `go vet ./...` clean; `go build ./...` clean;
`go test -race -count=1 ./...` green.

## Web target addendum (fixed contract — parity with the Python backend is mandatory)

`internal/modules/webtarget` is a 1:1 port of `backend/app/modules/webtarget.py`: same four routes,
same codes, same JSON. Read `backend/API_CONTRACT_V2_ADDENDUM.md` §"Web targets" for the surface —
this section only records what is Go-specific.

- The browser sidecar is SHARED (`tools/web-discovery/discover.mjs`); both backends shell out to it,
  so parity here is about the API surface and the persistence, not the crawler.
- `webtarget.SidecarRunner` is the seam the tests replace with a recorded document. No test in this
  repo starts a browser.
- `internal/modules/design` is the Go port of the deterministic parts of `backend/app/modules/
  design.py` + the colour half of `visual.py`: PNG decode (stdlib `image/png`), Roles/TextInks,
  Regions, ProjectionProfile/Spacing, DesignFacts, UICases, ContrastRatio, DeltaE2000 and
  NearestAccessible. It is used by the ui track and by nothing else yet.
- `jobs.Fail(code, message)` produces a coded failure; `jobs.Job.ErrorCode` surfaces it on
  `GET /v1/jobs/{id}` as `error_code` (null for every other failure).
- `models.WebTarget` arrives through AutoMigrate. UNIQUE (project_id, url, viewport).
- Exported for reuse rather than duplicated: `collections.Param`, `collections.TemplateConcretePath`
  (the HAR id-templating rule), `discovery.PublicHostError` (the SSRF rule), `security.PersistCase`.
