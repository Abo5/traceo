# Traceo Backend — Module Contract (v1)

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
- GET  /audit?limit=&cursor= (view_audit_log) — newest first

### modules/projects.py
- CRUD /projects (create/rename/archive/delete = manage_projects; list/get = view)
- GET /projects/{id}/dashboard -> {requirement_count, confirmed_count, test_case_counts{draft,approved,rejected,stale,archived}, coverage_pct, latest_run{...}|null}  (FR-PRJ-07)
- CRUD /projects/{id}/environments — secrets: accept `auth_config` dict on write, store via
  encrypt_secret, NEVER return values (return `auth_config_masked: true/false` + auth_type). FR-PRJ-04.
- POST /projects/{id}/environments/{eid}/check — connectivity check via httpx (FR-PRJ-06), no secret leakage in errors.

### modules/ingestion.py  (Requirements Parser, TRD §4.1)
- POST /projects/{id}/documents (multipart file: pdf/docx/md/txt, ≤50MB) -> 202 {job_id, document_id}
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

### modules/generation.py  (Mapper §4.3 + Generator §4.4 + Grounding Validator §4.5)
- POST /projects/{id}/generate {requirement_ids?: [..] (default: all confirmed), depth: "smoke"|"standard"|"exhaustive"} -> 202 {job_id}
  Per requirement: map to candidate endpoints (lexical prefilter top-10 -> `map_requirement` LLM pick);
  below confidence 0.3 or no candidates -> report unmappable (FR-GEN-13).
  Generation is DETERMINISTIC from the endpoint record ("the model is not trusted to identify boundaries"):
    * positive case per mapped endpoint (valid representative values from schema/constraints/format)
    * EP: one invalid-class case per constrained input (FR-GEN-03)
    * BVA: min/min+1/max-1/max cases per bounded numeric/string-length input (FR-GEN-04) [standard+]
    * negative: missing required param, wrong type, unauthenticated on secured op, malformed body (FR-GEN-08)
    * exhaustive adds enum sweeps + decision-table combos when 2+ constraints interact (FR-GEN-05)
  Every case: title, description, preconditions, steps[{order, endpoint_id, method, path, request{headers,params,body}, assertions, extractions}], type, priority, technique, generated=True, model, prompt_version, links to requirement (RequirementTestCase with requirement_version_at_link).
  Assertions format (list): {"type": "status_code", "expected": 200|422|...} | {"type": "json_field", "path": "a.b[0].c", "op": "eq|ne|gt|lt|contains|regex|exists|absent", "expected": ...} | {"type": "response_time_ms", "max": 2000} | {"type": "header", "name": "...", "op": "eq|contains", "expected": "..."} | {"type": "json_schema"} (validate against endpoint response schema).
  GROUNDING GATE (FR-GEN-06, BR-09 — hard gate): before persisting, validate every step against the
  endpoint inventory: endpoint exists (method+path), every param/body field exists in its schema,
  assertion targets valid. Violations -> case DISCARDED (never repaired, never shown), counted.
  Skip duplicates: same requirement + endpoint + technique + title already approved (FR-GEN-11).
  Job result: {generated, discarded, unmappable: [{requirement_id, reason}]}.
- Expose `def grounding_validate(case_dict, endpoints_by_key) -> list[str]` (importable — reporting/tests use it).

### modules/review.py  (FR-REV)
- GET  /projects/{id}/test-cases?state=&requirement_id=&type=&q= — include requirement links {id, external_id, description}
- GET  /test-cases/{id} — full detail incl. steps + linked requirements (queue shows req text alongside, FR-REV-02)
- PATCH /test-cases/{id} — full edit (title/desc/steps/assertions/priority/preconditions); sets user_modified, state->draft if was approved/stale (bump version)
- POST /test-cases/{id}/approve (approve_reject) — state=approved, approved_by/at, audit (FR-REV-05)
- POST /test-cases/{id}/reject {reason_code, reason_text} (approve_reject)
- POST /test-cases/bulk {ids, action: approve|reject, reason_code?} (FR-REV-04)
- POST /projects/{id}/test-cases (manual authoring, requirement_ids required — FR-REV-07, FR-GEN-02)
- POST /test-cases/{id}/links {requirement_id} / DELETE .../links/{requirement_id} (FR-TRC-05)

### modules/execution.py  (Execution Engine, TRD §4.6)
- POST /projects/{id}/runs {environment_id, test_case_ids?: [..] (default: all approved)} -> 202 {job_id, run_id}
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
- GET /projects/{id}/runs — history

### modules/traceability.py  (TRD §4.7)
- GET /projects/{id}/traceability -> {rows: [{requirement{id,external_id,description,type,priority,state,version}, cases: [{id,title,state,latest_outcome}], status}], coverage_pct, gaps: [{requirement_id, external_id, reason: "no_approved_cases"|"unmappable"}]}
  Status per req (FR-TRC-02): not_covered | covered_not_run | passing | failing | errored.
  Coverage % = confirmed reqs with ≥1 approved linked case / all confirmed (stale/draft/rejected excluded).
- Expose helper `def mark_stale(db, requirement_id)` — sets linked approved cases -> stale (used by ingestion).
- GET /requirements/{id}/history -> runs affecting its linked cases (FR-TRC-07)

### modules/reporting.py  (TRD §4.8)
- GET /projects/{id}/exports/matrix.xlsx — openpyxl, sheets: Requirements / Test Cases / Matrix / Latest Results. RTL sheet (sheet_view.rightToLeft=True) when project.language=='ar' (FR-RPT-07).
- GET /runs/{id}/report -> JSON summary {run, counts, cases: [{test_case, outcome, duration_ms, failure_reason, requirements}]} (FR-RPT-01/02/03 defect view data)
- GET /runs/{id}/report.html — self-contained printable HTML (dir=rtl when ar) — serves as the PDF deliverable via browser print (FR-RPT-05).
- GET /runs/{id}/compare/{other_id} -> {newly_failing: [...], newly_passing: [...]} (FR-RPT-06)

## Quality gates (NFR-MNT-04)
`backend/tests/` (pytest + fastapi TestClient):
- test_grounding.py — adversarial fixtures: fabricated endpoint/param/field/assertion-target are discarded. RELEASE GATE.
- test_isolation.py — two orgs; every list/get endpoint returns 404/empty across tenants. RELEASE GATE.
- test_flow.py — end-to-end: register -> project -> upload md doc -> confirm -> import spec -> generate -> approve -> run against a local test SUT (spin up in-process FastAPI test app) -> matrix has passing rows -> export xlsx.
