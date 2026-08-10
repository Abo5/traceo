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
