# Traceo — v2 Addendum Contract (Integrations / Settings / Public API / Reference)

Extends API_CONTRACT.md. Same conventions (org isolation, error envelope, audit, /v1 prefix).
NEW TABLES are allowed (SQLite create_all adds missing tables). NO column changes to existing tables.

## New models (models.py additions — new tables only)

- **ApiKey**: TimestampMixin + organisation_id, name, prefix (first 8 chars, shown in UI), key_hash (sha256 of full key), created_by, last_used_at (nullable), revoked (bool default False). Full key shown ONCE at creation.
- **Schedule**: TimestampMixin + organisation_id, project_id, environment_id, name, interval_minutes (int, min 15), enabled (bool), last_run_at (nullable), next_run_at, created_by.
- **Webhook**: TimestampMixin + organisation_id, project_id, name, url, secret (nullable — used for HMAC-SHA256 signature header X-Traceo-Signature), events (JSON list — MVP: ["run.completed"]), enabled (bool), last_status (nullable int), last_fired_at (nullable).

## modules/integrations.py (new module — mount in main.py)

### API keys (FR-061 token surface; capability manage_projects for create/revoke, view for list)
- POST /api-keys {name} -> {id, name, prefix, key} — key = "trc_" + 40 hex chars, returned ONCE; store sha256. Audit 'api_key.created'.
- GET /api-keys -> [{id, name, prefix, created_at, last_used_at, revoked}]
- POST /api-keys/{id}/revoke — audit.
- **Public API auth**: header `X-API-Key: trc_...` accepted as an ALTERNATIVE to Bearer JWT on these read/CI endpoints only: GET gate, GET traceability, GET runs/{id}, POST projects/{id}/runs. Implement as a dependency `user_or_api_key` in the module that resolves an Organisation from the key (updates last_used_at) and returns a synthetic actor (role qa_engineer, org-scoped). 401 on revoked/unknown.

### CI/CD gate (FR-061)
- GET /projects/{id}/gate?min_coverage=80&max_critical=0&max_failed= (all optional, defaults min_coverage=80, max_critical=0)
  -> 200 {pass: bool, coverage_pct, open_defects{total,critical}, latest_run{id,display_id,counts}, breaches: [{check, limit, actual, requirement_external_ids?}]}
  breaches include names of requirements breaching (failing reqs when max_failed exceeded). HTTP status ALWAYS 200 (CI script checks .pass) — plus `?exit=1` variant returns 412 when failing (for `curl -f`).

### Webhooks (FR-070/072 transport — works with Slack incoming webhooks)
- CRUD: GET/POST /projects/{id}/webhooks, PATCH/DELETE /webhooks/{id} (manage_projects). POST body {name, url, secret?, events?, enabled?}. SSRF-guard the URL (same rules as discovery).
- POST /webhooks/{id}/test — fires a sample payload now, returns delivery status.
- **Firing**: execution module calls `fire_webhooks(db, project_id, "run.completed", payload)` (import from integrations, lazy import to avoid cycles) after a run reaches a terminal state. Payload: {event, project{id,name}, run{id,display_id,state,counts,coverage_pct?}, timestamp}. If secret set: header X-Traceo-Signature: sha256=HMAC_hex(secret, body). 5s timeout, one attempt, store last_status/last_fired_at. Slack-compat: if url contains "hooks.slack.com", send {text: "<English summary line>"} instead — "Run #<display_id> completed in project <name>: <passed> passed, <failed> failed, <errored> errored of <total>".

### Xray/Jira export (FR-070 as file export — no tenant needed)
- GET /runs/{id}/exports/xray.json — Xray import format: {info:{summary, description}, tests:[{testKey?, testInfo:{summary, type:"Generic", definition}, start, finish, status: PASSED/FAILED, evidence?, comment}]} built from results + requirement links.
- GET /runs/{id}/exports/defects.csv — Jira-importable CSV: Summary, Description (steps+expected/actual), Priority (from severity), Labels (REQ ids) — failures only. UTF-8 BOM so Excel reads the file as UTF-8 rather than the local codepage.

### Schedules (FR-060)
- CRUD: GET/POST /projects/{id}/schedules, PATCH/DELETE /schedules/{id} (manage_projects). interval_minutes >= 15. next_run_at computed on create/update.
- **Scheduler**: daemon thread started from main.py startup (guard: only once): every 60s scan enabled schedules where next_run_at <= now; for each: trigger the same run-launch path as POST /projects/{id}/runs (all approved cases, the schedule's environment, initiated_by=schedule.created_by), update last_run_at/next_run_at. Skip silently if project has no approved cases. Audit 'run.scheduled'.

### Data export (FR-082, PDPL)
- GET /export/organisation — streams a JSON file: org, projects, requirements, test cases (+steps), runs (+result summaries, evidence EXCLUDED), audit count. Content-Disposition attachment traceo_export.json. Capability: manage_members (admin).

## modules/reference.py (new tiny module)
- GET /reference/features -> static JSON catalog of the v2 feature reference (id FR-###, group, name_en, priority P0/P1/P2, status: built|planned, description_en). English-only: the former `name_ar`/`description_ar` twins are gone, and groups carry `key` + `name_en`. Source: hardcoded list built from Traceov2/docs/02-Feature-Reference.md — 37 features, 8 groups. `status: built` must reflect reality of THIS codebase (35 built claims in the doc are for the design; mark honestly: built for what exists here incl. this addendum, planned otherwise).

## Frontend screens (frontend agent)

Sidebar: the "Setup" group grows to: Environments, Settings, Integrations; and a new bottom group "Reference" with Reference. Routes under /projects/[id]/: settings, integrations, reference (reference may also read global).

1. **/settings** — tabs (Pill): API keys (list + create modal showing the key ONCE with copy button + revoke) · Schedules (schedules CRUD: name, environment select, interval select 15m/30m/1h/6h/24h, enabled toggle, next run DateTimeText) · Data export (org JSON export button + PDPL note). RefChips FR-061/FR-060/FR-082.
2. **/integrations** — cards grid: **Webhooks** (CRUD + test button + last status badge + secret field + Slack hint "Paste your Slack Incoming Webhook URL"), **CI/CD Gate** (RefChip FR-061): thresholds inputs (min_coverage, max_critical) + generated curl snippet in a Code block with copy button: `curl -f -H "X-API-Key: $TRACEO_KEY" "https://.../v1/projects/<id>/gate?min_coverage=80&exit=1"`, live gate status card (pass green / breaches list), **Jira/Xray** (RefChip FR-070): run select + download xray.json / defects.csv buttons, **Coming soon** muted cards: Confluence (FR-011), direct Jira sync.
3. **/reference** — the in-app feature catalog (like shots/reference.png): search + group filter pills, table/cards: FR-### mono chip, name, group, priority badge (P0 error-ish/P1 warning/P2 muted), status badge (Built success / Planned muted). Data from GET /reference/features (`name_en`, `description_en`).
4. **New Run wizard restyle** (shots/new.png): rework /runs launch card into a numbered 3-step card layout (01 Target: environment + base_url display; 02 Scope: approved count + subset; 03 Rules: read-only chips of enabled techniques incl. localisation) keeping existing behavior — keep it one page, numbered sections with NumberedChips.

Design: follow docs/FIGMA_DESIGN_SPEC.md (tokens, components). The product is English-only and LTR: `<html lang="en" dir="ltr">`, no language switcher, no RTL rules.

## Web targets (fixed contract — "give it a URL and pick the test types")

`modules/webtarget.py` (Python) and `internal/modules/webtarget` (Go) — identical routes, codes and
JSON. The page is rendered by ONE shared Node/Playwright sidecar,
`tools/web-discovery/discover.mjs`, invoked as
`node discover.mjs --url <url> --out <dir> --viewport WxH --timeout <ms>`; both backends shell out to
the same script. This is not an optimisation: the reference target
(https://opensource-demo.orangehrmlive.com/web/index.php/auth/login) is a Vue SPA whose plain HTTP GET
returns 3453 bytes with 0 forms, 0 inputs and 0 buttons, so server-side HTML parsing discovers
nothing at all.

### Model
`web_targets` — organisation_id, project_id, url, viewport, status (pending|discovered|failed), title,
final_url, last_discovered_at, screenshot_key, inventory (JSON: counts + form/control/request digests
+ design summary), last_error. UNIQUE (project_id, url, viewport): re-posting the same URL
RE-discovers that target instead of forking the requirements and cases derived from it.
Python migration `f2c6a09b41d8`; Go arrives through AutoMigrate.

### Routes
- `POST /projects/{id}/web-targets` — capability **import_spec**, body `{url, viewport?, test_types[]}`
  → **202** `{job_id, target_id, test_types}`. test_types ⊆
  `["functional","api","ui","performance","security"]`; an unknown or empty value → **422**
  `{"code":"invalid_test_type", "errors":[the five legal values]}`. Non-http(s) → 422 `invalid_url`;
  a private/loopback host → 422 `ssrf_blocked` unless `TRACEO_ALLOW_PRIVATE_TARGETS=1` (the spec
  fetcher's rule, reused); a malformed viewport → 422 `invalid_viewport`.
- `GET /projects/{id}/web-targets` — capability **view** → `{"web_targets":[...]}`.
- `GET /web-targets/{id}` — capability **view** → the target plus `inventory` (forms/controls/
  requests/endpoints/console_errors/skipped) and `design` (palette with shares, contrast findings with
  the suggested passing colour from `visual.nearest_accessible`, fact list).
- `GET /web-targets/{id}/screenshot` — capability **view** → `image/png`, 404 `no_screenshot`.

### The job (kind `discover`)
Result: `{target_id, title, forms, controls, requests, endpoints, requirements, cases_by_type{},
skipped:[{type, reason}], discarded, duplicates}`. Per selected type:
- **api** — Endpoint rows with `source="dom"`, paths templated by the SAME rule the HAR importer uses
  (concrete ids → `{id}`, `{id2}`…), query values recorded as `constraints.example`, `observed_count`
  = times the browser made the call. Fidelity precedence spec > traffic > dom > postman: a spec or
  traffic row is never overwritten, and nothing is ever deleted (a crawl observes a page, it does not
  enumerate an API). Selecting **security** implies this persistence — the S0 builders need the
  inventory to stand on.
- **functional** — one Requirement per FORM, state `extracted` (awaiting confirmation), description
  naming the form and its required fields, plus cases carrying the form's selectors verbatim.
- **ui** — `design.design_facts` over the screenshot, cases via `design.ui_cases` (techniques
  `design`/`a11y`), and the design summary for the UI's design box.
- **performance** — a requirement and a case (technique `performance`) asserting page load under
  `TRACEO_PAGE_LOAD_BUDGET_MS` (default 3000) with the observed `elapsed_ms` recorded as the baseline.
- **security** — the S0 builders over the endpoints above, through
  `generation.grounding_validate` exactly like the security generator.

If the sidecar cannot run (node or Playwright missing) the job **FAILS** with
`error_code = "browser_discovery_unavailable"` and a message naming what to install — never a silent
empty result. `GET /jobs/{id}` now carries `error_code` (null unless the job failed with a coded
error).

### Grounding (unchanged, non-negotiable)
Every generated case cites at least one artefact the discovery actually found — a form field
selector, a captured request, or a design fact id — and every id it cites must be in that set. A case
that fails the check is discarded and counted, never repaired and never shown (BO-07).

### Settings
`TRACEO_WEB_DISCOVERY_SCRIPT`, `TRACEO_NODE_BIN`, `TRACEO_WEB_DISCOVERY_TIMEOUT_S`,
`TRACEO_ALLOW_PRIVATE_TARGETS`, `TRACEO_PAGE_LOAD_BUDGET_MS`, `TRACEO_DESIGN_MAX_PIXELS`.
