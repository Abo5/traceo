# Traceo Backend — Module Contract (v2)

Every module file lives at `backend/app/modules/<name>.py` and MUST expose `router = APIRouter()`.
Routers are mounted under `/v1` by `main.py`. Do not create the FastAPI app yourself.

## Shared infrastructure (already written — import, don't reimplement)

```python
from ..db import get_db                      # Session dependency
from ..models import *                       # all ORM models (see models.py)
from ..deps import get_current_user, require, get_project_scoped, audit
from ..security import encrypt_secret, decrypt_secret, redact, SECRET_MASK, has_permission
from ..config import settings
from .. import jobs as jobstore              # jobstore.submit(kind, fn) -> Job; poll GET /v1/jobs/{id}
from ..llm import get_provider               # get_provider().complete_json(prompt_id, prompt, schema) -> LLMResult
```

- Auth: `user = Depends(require("<capability>"))` — capabilities in `security.PERMISSIONS`.
- Org isolation: EVERY query on tenant tables must filter `organisation_id == user.organisation_id`.
  For project-scoped resources call `get_project_scoped(project_id, user, db)` first.
- Long operations (parse/generate/execute/export): run via `jobstore.submit(...)`, return
  `{"job_id": job.id}` with status 202. Job threads must open their own `SessionLocal()` (import from `..db`).
- Errors: `raise HTTPException(status, detail={"code": "...", "message": "human text"})`.
- Audit (FR-USR-06): call `audit(db, org_id, user.id, action, object_type, object_id, detail)` for:
  auth events, requirement edits, approvals/rejections, environment changes, run initiation.
- Timestamps ISO 8601 UTC; ids are UUID strings; JSON field names snake_case.

## LLM prompt contract (MockProvider heuristics depend on these exact markers)

- `extract_requirement`: prompt = instructions + `"SEGMENT:\n" + segment_text`.
  Schema: `{external_id, description, acceptance_criteria: [str], type, priority, confidence}`.
- `map_requirement`: prompt = instructions + `"PAYLOAD:\n" + json.dumps({"requirement": text, "candidates": [{method, path, summary, operation_id, tags}]})`.
  Schema: `{selected: [int], confidence: number}` — indices into the candidates list (closed list, TRD §4.3).

## Module ownership & endpoints

### modules/identity.py
- POST /auth/register {org_name, name, email, password} -> {token, user} (creates org + admin)
- POST /auth/login {email, password} -> {token, user{id,name,email,role,locale,organisation_id,org_name}}
- GET  /me -> user profile; PATCH /me {name?, locale?}
- GET  /members (view) / POST /members/invite {email,name,role,password} (manage_members)
- PATCH /members/{id} {role} / DELETE /members/{id} (manage_members)
- GET  /audit?limit=&cursor= (view_audit_log) — newest first, each entry carries `retain_until`
- GET  /audit/retention (view_audit_log) / PUT /audit/retention {retention_days} (manage_members) — FR-082 AC3
- POST /audit/purge (manage_members) — the ONLY delete path, and it cannot touch an entry before
  its retain_until. No route mutates an entry: immutability is structural (FR-082 AC2).
- GET  /audit/export.csv (view_audit_log) — the whole log for an auditor (FR-082 AC4)

### modules/projects.py
- CRUD /projects (create/rename/archive/delete = manage_projects; list/get = view)
- GET /projects/{id}/dashboard?branch=&environment_id=&drop_threshold= ->
  {requirement_count, confirmed_count, test_case_counts{...}, coverage_pct, latest_run|null,
   trend: [{run_id, display_id, coverage_pct, branch, source, dropped, delta}], branches: [..],
   regression_watch: [..], gaps_detail: [..], open_defects, median_duration_ms}
  (FR-PRJ-07 · FR-054 branch/environment filter + drop marking · FR-062 regression watch)
- CRUD /projects/{id}/environments — secrets: accept `auth_config` dict on write, store via
  encrypt_secret, NEVER return values (return `auth_config_masked` + `secret_rotated_at` + auth_type).
  FR-PRJ-04, FR-083 AC3.
  `fixtures: [{name, create{method,path,body}, extract{var: json_path}, delete{method,path}}]` declares
  the test-data lifecycle for every run against this environment (FR-043).
- POST /projects/{id}/environments/{eid}/check — connectivity check via httpx (FR-PRJ-06), no secret leakage in errors.

### modules/ingestion.py  (Requirements Parser, TRD §4.1)
- POST /projects/{id}/documents (multipart file: pdf/docx/xlsx/md/txt, ≤50MB) -> 202 {job_id, document_id}
  An encrypted or image-only PDF is rejected by name — OCR is out of scope (SRS §4.1).
  Hijri dates are ANNOTATED in place, never replaced: `1447/03/15هـ (≈ 2025-09-08 م)`.
  The conversion is the tabular Islamic calendar and can differ from Umm al-Qura by a
  day at a month boundary; the annotation is marked `≈` for exactly that reason.
  `annotate_hijri_dates` is idempotent so re-parsing does not restack annotations and
  spuriously re-version every requirement (FR-012 AC4).
- POST /projects/{id}/requirements/paste {text, title?} -> 202 — the fallback the zero-requirements
  empty state offers (FR-010 AC4). Same pipeline, so re-pasting the same title diffs and re-versions.
  Pipeline: extract text (pymupdf for pdf, python-docx for docx, plain read otherwise; guard imports),
  deterministic segmentation (numbered clauses/headings/bullets — Arabic + English, Arabic-Indic digit
  normalization ٠-٩ -> 0-9), then per-segment `extract_requirement` LLM call. Persist Requirements
  state='extracted' with source_text + confidence. Re-upload of same filename bumps document version and
  diffs by external_id/content_hash: new -> added, changed -> version+1 & state='changed' (mark linked
  approved cases stale via traceability helper), missing -> state='removed'. (FR-REQ-06, FR-TRC-04)
- GET  /projects/{id}/documents
- GET  /projects/{id}/requirements?state=&type=&priority=&q= (sorted low-confidence first when state=extracted)
- PATCH /requirements/{rid} {description?, external_id?, acceptance_criteria?, type?, priority?, state?('confirmed')}
  — editing a CONFIRMED requirement bumps version, sets content_hash, marks linked approved cases stale.
- POST /requirements (manual add) / DELETE /requirements/{rid}
- POST /projects/{id}/requirements/confirm_all — bulk confirm extracted.

### modules/discovery.py  (Discovery Engine, TRD §4.2 — deterministic, NO LLM)
- POST /projects/{id}/api-specs {url} or multipart file (json/yaml) -> parsed synchronously.
  OpenAPI 3.x + Swagger 2.0 (normalize swagger2: parameters.in=body -> request_schema, host+basePath).
  Resolve internal $refs (cycle-safe). Flatten each operation -> Endpoint row with parameters
  [{name, location, type, required, constraints{minimum,maximum,minLength,maxLength,pattern,enum,format}}],
  request_schema, response_schemas keyed by status, security, tags. Unresolvable operation -> record in
  response `warnings`, skip, don't fail import (FR-DSC-04). Structural validation errors -> 422 with details.
  SSRF guard on URL fetch: block private/link-local/metadata IPs, https/http only, max 5MB, 10s timeout.
- GET /projects/{id}/endpoints ; PATCH /endpoints/{eid} {excluded: bool}
  Each endpoint also reports `discovery_source` (openapi|traffic|dom|postman), `times_seen`,
  `inferred`, `dom_fields` and `declared_never_seen` (FR-020 AC3).
  COVERAGE (FR-024 AC2) is what the suite EXERCISES, not what it sends: `coverage_pct` is
  the mean of `covered_params_pct` and `covered_responses_pct`, and `uncovered_statuses`
  names the declared branches nothing asserts. Every declared status is a key of
  `response_schemas` — a `422` documented without a body is stored as `{}` so it still
  carries a coverage obligation while validating anything.
  A spec re-import replaces ONLY the openapi-sourced slice; endpoints another source contributed
  survive, and their observation counts survive even when the spec re-asserts ownership.

### modules/capture.py  (Discovery sources beyond the spec — FR-021/022/023, deterministic, NO LLM)
- POST /projects/{id}/discovery/traffic {har, base_url?, include_all?} — HAR from a proxy, browser
  devtools or the optional Playwright driver. Concrete paths generalise into templates named after
  their collection (`/orders/8812` -> `/orders/{orderId}`); observations accumulate; credentials are
  redacted at capture point, and bodies are reduced to field names + inferred types (never values).
- POST /projects/{id}/discovery/postman {collection, variables?} — v2.1; folders become tags;
  unresolved `{{variables}}` are reported, never guessed.
- POST /projects/{id}/discovery/dom {forms, base_url?} — form fields with required flags and
  validation patterns become candidate boundary/equivalence inputs; RTL containers are reported.
- POST /projects/{id}/discovery/crawl {url, max_pages?, wait_ms?} — drives the app with Playwright
  and feeds both parsers. 501 with install instructions when Playwright is absent.
- POST /projects/{id}/discovery/reset {source} — drop one non-spec source's contribution.
- Merge precedence (SRS §4.2): openapi > traffic > dom > postman per attribute; observation counts
  always accumulate; an observed template is reconciled onto a declared endpoint of the same shape,
  so `/customers/{customerId}` does not fork from the spec's `/customers/{id}`.

### modules/generation.py  (Mapper §4.3 + Generator §4.4 + Grounding Validator §4.5)
- POST /projects/{id}/generate {requirement_ids?: [..] (default: all confirmed), depth: "smoke"|"standard"|"exhaustive"} -> 202 {job_id}
  Per requirement: map to candidate endpoints (lexical prefilter top-10 -> `map_requirement` LLM pick);
  below confidence 0.3 or no candidates -> report unmappable (FR-GEN-13).
  Generation is DETERMINISTIC from the endpoint record ("the model is not trusted to identify boundaries"):
    * positive case per mapped endpoint (valid representative values from schema/constraints/format)
    * EP: one invalid-class case per constrained input (FR-GEN-03)
    * BVA: min/min+1/max-1/max cases per bounded numeric/string-length input (FR-GEN-04) [standard+]
    * negative: missing required param, wrong type, unauthenticated on secured op, malformed body (FR-GEN-08)
    * exhaustive adds enum sweeps + decision tables when 2+ constraints interact (FR-GEN-05).
      An input with no derivable invalid value cannot vary, so its invalid half is
      UNREACHABLE — excluded and disclosed, never generated (FR-032 AC2). Past
      `DECISION_TABLE_MAX_COMBOS`, `pairwise_combinations()` produces an all-pairs
      covering set (10 conditions: 12 cases instead of 1024) and every case it produces
      says so in its description (FR-032 AC3).
  Every case: title, description, preconditions, steps[{order, endpoint_id, method, path, request{headers,params,body}, assertions, extractions}], type, priority, technique, generated=True, model, prompt_version, links to requirement (RequirementTestCase with requirement_version_at_link).
  Assertions format (list): {"type": "status_code", "expected": 200|422|...} | {"type": "json_field", "path": "a.b[0].c", "op": "eq|ne|gt|lt|contains|regex|exists|absent", "expected": ...} | {"type": "response_time_ms", "max": 2000} | {"type": "header", "name": "...", "op": "eq|contains", "expected": "..."} | {"type": "json_schema"} (validate against endpoint response schema).
  GROUNDING GATE (FR-GEN-06, BR-09 — hard gate): before persisting, validate every step against the
  endpoint inventory: endpoint exists (method+path), every param/body field exists in its schema,
  assertion targets valid. Violations -> case DISCARDED (never repaired, never shown), counted.
  Skip duplicates: same requirement + endpoint + technique + title already approved (FR-GEN-11).
  Auth-class negatives (FR-033 AC1) cover: no credential, expired credential ({{expired_token}}),
  wrong-role credential ({{wrong_role_token}}), malformed JSON, oversized payload, injection shapes.
  REGENERATION (FR-036 AC3): cases are indexed by (technique, method, path, title). A case that is
  user_modified or hand-written is PROTECTED — never touched. A generated, untouched draft/stale case
  is refreshed in place. Everything else is added.
  Job result: {generated, discarded, duplicates, refreshed, preserved_manual_edits,
               changed_cases: [{test_case_id, title, change}], unmappable: [{requirement_id, reason}]}.
- Expose `def grounding_validate(case_dict, endpoints_by_key) -> list[str]` (importable — reporting/tests use it).

### modules/review.py  (FR-REV)
- GET  /projects/{id}/test-cases?state=&requirement_id=&type=&q= — include requirement links {id, external_id, description}
- GET  /test-cases/{id} — full detail incl. steps + linked requirements (queue shows req text alongside, FR-REV-02)
- PATCH /test-cases/{id} — full edit (title/desc/steps/assertions/priority/preconditions); sets user_modified, state->draft if was approved/stale (bump version)
- POST /test-cases/{id}/approve (approve_reject) — state=approved, approved_by/at, audit (FR-REV-05)
- POST /test-cases/{id}/reject {reason_code, reason_text} (approve_reject)
- POST /test-cases/bulk {ids, action: approve|reject, reason_code?} (FR-REV-04)
- POST /projects/{id}/test-cases (manual authoring, requirement_ids required — FR-REV-07, FR-GEN-02)
  Steps are bound to the endpoint they target by (method, path) when no endpoint_id is
  supplied, so a hand-written case counts in the endpoint coverage map like a generated
  one (FR-036 AC4). A path outside the inventory stays unbound rather than being refused.
- POST /test-cases/{id}/links {requirement_id} / DELETE .../links/{requirement_id} (FR-TRC-05)

### modules/execution.py  (Execution Engine, TRD §4.6)
- POST /projects/{id}/runs {environment_id, test_case_ids?, branch?, concurrency? (1..32)} -> 202 {job_id, run_id}
  Async job: auth once per run (api_key/basic/bearer/oauth2_cc via decrypt_secret; failure -> run state
  'aborted' + single diagnostic, FR-EXE-04). httpx.Client per run, ThreadPool concurrency
  settings.RUN_CONCURRENCY. Per case: steps in order, variable interpolation {{var}} from project env
  variables + prior-step extractions [{"name": "x", "path": "json.path"}], halt case on first failed
  assertion, distinguish failed vs errored (timeout/connection = errored, FR-EXE-11). Evidence per step:
  request(method,url,headers,body redacted via redact()), response(status,headers,body truncated to
  EVIDENCE_MAX_BYTES), elapsed_ms, assertion outcomes. Results immutable, test_case_version recorded.
  Partial results stream to DB as cases finish; run.counts updated at end.
- GET /runs/{id} -> status + counts; GET /runs/{id}/results?outcome= -> per-case results with evidence
- POST /runs/{id}/cancel (best-effort flag, FR-EXE-10)
- GET /projects/{id}/runs — history. Every run payload carries `source` (manual|ci|scheduler),
  `branch` and `fixtures` {created, removed, orphans, setup_failed}.
  FIXTURE LIFECYCLE (FR-043): fixtures declared on the environment are created before the suite with
  `{{run_ns}}` = `traceo-<run prefix>` so leftovers are identifiable, extracted values are published
  into the run context, and teardown runs in a `finally` block — on success, failure AND cancellation.
  Anything that cannot be removed is reported in `fixtures.orphans` rather than silently dropped.
- `start_run(...)` is the shared entry point for the manual, CI and scheduled paths, so all three
  behave identically; `serialise_per_environment=True` defers rather than overlapping (FR-060 AC3).

### modules/traceability.py  (TRD §4.7)
- GET /projects/{id}/traceability -> {rows: [{requirement{id,external_id,description,type,priority,state,version}, cases: [{id,title,state,latest_outcome}], status}], coverage_pct, gaps: [{requirement_id, external_id, reason: "no_approved_cases"|"unmappable"}]}
  Status per req (FR-TRC-02): not_covered | covered_not_run | passing | failing | errored.
  Coverage % = confirmed reqs with ≥1 approved linked case / all confirmed (stale/draft/rejected excluded).
- Expose helper `def mark_stale(db, requirement_id)` — sets linked approved cases -> stale (used by ingestion).
- GET /requirements/{id}/history -> runs affecting its linked cases (FR-TRC-07)

### modules/reporting.py  (TRD §4.8)
- GET /projects/{id}/exports/matrix.xlsx?lang=en|ar|both&run_id= — openpyxl, sheets:
  Requirements / Test Cases / Matrix / Gaps / Failures / Latest Results (FR-071 AC1).
  `lang=both` renders bilingual headers and sheet names (AC3); every sheet carries a footer stamp with
  run, environment, branch and export time so identity survives printing (AC4). RTL sheets for ar/both.
- GET /runs/{id}/report -> JSON summary {run, counts, cases: [{test_case, outcome, duration_ms, failure_reason, requirements}]} (FR-RPT-01/02/03 defect view data)
- GET /runs/{id}/report.html?lang=en|ar|both — self-contained printable HTML; serves as the PDF
  deliverable via browser print (FR-RPT-05, FR-071). A fixed page-stamp repeats the run identity.
- GET /runs/{id}/compare/{other_id} -> {newly_failing, newly_passing, unchanged,
  coverage_delta, requirement_delta, endpoint_delta} (FR-RPT-06, FR-053).
  The two deltas answer "what moved", not "did a number move": each entry carries
  `previous_verdict`, `verdict` and a `direction` of regressed|recovered, sorted
  regressions first.

### modules/automation.py  (FR-060 schedules · FR-061 CI gate)
- GET /projects/{id}/gate (view) / PUT /projects/{id}/gate {enabled, min_coverage_pct,
  max_new_failures, block_on: any|high_priority|none} (manage_projects)
- GET /runs/{id}/gate -> {passed, exit_code, coverage_pct, covered_requirements, total_requirements,
  new_failures, compared_with, breaches: [{code, message, requirements: [{external_id, ...}]}],
  report_url}. 409 while the run is still in flight. Regressions are compared against the previous
  completed run ON THE SAME BRANCH, so a feature branch is not judged against main.
- POST /projects/{id}/ci/runs {environment_id, branch?, concurrency?} -> 202 {job_id, run_id, gate_url}
  Tagged source=ci; 409 `environment_busy` when a run is already in flight there.
- GET/POST /tokens, DELETE /tokens/{id} (manage_tokens) — CI principals. Only the sha256 hash is
  stored; the clear `trc_` value is returned exactly once, at creation. A token carries its own role
  and may be scoped to one project (enforced by `assert_token_scope`). `Authorization: Bearer trc_…`
  is accepted anywhere a session JWT is.
- CRUD /projects/{id}/schedules {environment_id, cron, timezone (default Asia/Riyadh), branch,
  enabled} — five-field cron parsed in-process (no dependency); `run_due_schedules(db, now)` is the
  tick, driven by a daemon thread in main.py and callable directly from tests.

### modules/integrations.py  (FR-070 Jira/Xray · FR-011 Confluence · FR-072 Slack)
- CRUD /integrations (+ ?project_id=) — `secret` is write-only and encrypted; reads return
  `secret_set` + `secret_rotated_at` only (FR-083 AC3). POST /integrations/{id}/check probes it.
- POST /runs/{rid}/results/{result_id}/export {integration_id} — Jira issue carrying numbered
  reproduction steps, verbatim request/response (already redacted), expected vs actual and severity.
  Deduped on (integration, run, case): a re-export UPDATES that issue instead of creating a second
  one (FR-070 AC2). GET /runs/{rid}/exports lists what has been pushed.
- POST /runs/{rid}/xray/sync {integration_id} — one test execution with every case verdict.
- POST /runs/{rid}/notify — Slack summary; also fired automatically on run completion, filtered by
  the integration's alert_level (all | failures | regressions).
- GET /integrations/{id}/confluence/pages ; POST /projects/{id}/confluence/import {integration_id,
  page_ids} -> 202 — pages go through the SAME ingestion pipeline as an upload, under a stable
  per-page filename, so a re-import of a changed page re-versions its requirements and marks the
  linked cases stale (FR-011 AC3).
- ALL outbound calls go through `_request`, which enforces the on-premise egress allow-list
  (FR-081 AC2) and is the single seam tests replace.

## Schema evolution

There is no migration tool by design (NFR-POR-03: one process, one file). `db.sync_schema()` runs at
startup: it creates missing tables, then ALTERs in any column the models gained. Releases may only ever
ADD nullable/defaulted columns, so an existing database — including a customer's on-premise one —
stays usable across upgrades.

## Quality gates (NFR-MNT-04)
`backend/tests/` (pytest + fastapi TestClient):
- test_grounding.py — adversarial fixtures: fabricated endpoint/param/field/assertion-target are discarded. RELEASE GATE.
- test_isolation.py — two orgs; every list/get endpoint returns 404/empty across tenants. RELEASE GATE.
- test_flow.py — end-to-end: register -> project -> upload md doc -> confirm -> import spec -> generate -> approve -> run against a local test SUT (spin up in-process FastAPI test app) -> matrix has passing rows -> export xlsx.
- test_discovery_sources.py — templating, redaction, observation counts, source precedence, and that a
  spec re-import neither deletes observed endpoints nor loses their counts.
- test_automation.py — cron parsing and timezone arithmetic, gate pass/fail/disabled, branch-scoped
  regression comparison, CI token auth + scoping + revocation, schedule firing and deferral.
- test_integrations.py — Jira create-then-update dedupe, Xray sync, Slack alert levels, Confluence
  import + stale re-import, secrets never echoed, on-premise egress refusal.
- test_techniques.py — Hijri conversion against published Umm al-Qura dates (±1 day, the
  stated limit) and annotation idempotence; pairwise completeness and determinism for
  2..10 conditions plus the disclosure text; coverage counting response branches rather
  than requests; run comparison naming the requirement AND endpoint that moved.
- test_lifecycle.py — fixtures created/torn down against a real in-process HTTP server, including
  teardown when every case fails and the orphan report when a DELETE fails; per-run concurrency
  bounds; manual edits surviving regeneration; XLSX + paste ingestion; bilingual export sheets;
  audit retention, bounded purge and CSV export.
