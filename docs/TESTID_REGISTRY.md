# TESTID Registry

> The reference index of every `data-testid` in the Traceo UI. Its source of truth is the frontend code itself (`frontend/app` and `frontend/components/ui.tsx`); it is the basis for the selectors of the `e2e/` layer (see `docs/TEST_AUTOMATION_ARCHITECTURE.md` §5).

**Convention:** `domain-component-element-state` in kebab-case — e.g. `review-case-approve-button`. Repeated rows and badges carry one id that repeats (e.g. `review-case-row`); the individual row is identified by its content (entity data, never UI copy). State badges additionally carry `data-state` with values copied **verbatim** from `backend/app/models.py`:

- `Requirement.state`: `extracted | confirmed | changed | removed`
- `TestCase.state`: `draft | approved | rejected | stale | archived`
- `Run.state`: `queued | running | completed | cancelled | aborted`
- `Job.status`: `queued | running | completed | failed` — `SourceDocument.parse_status`: `pending | parsing | parsed | failed` — `TestResult.outcome`: `passed | failed | errored`
- Insight category status from `GET /v1/projects/{id}/insights`: `covered | gap | n_a` — a pure function of the two counters (`covered_count`/`suggestable_count`), read from `data-state` on `insights-category-status-badge`

State is asserted through `data-state` exclusively, never through the rendered text: copy is product wording and changes freely, state does not. The UI ships in one language (English, LTR) — there is no language switcher, no `traceo_lang` key and no language-related testid. When a new id is added, this file is updated in the same change; to verify: `grep -rn 'data-testid\|testId' frontend/app frontend/components`.

Note: the components in `frontend/components/ui.tsx` forward a `testId` prop to the real element (button, input, badge…), so a `Field`'s id lands on the `input/select/textarea` itself.

---

## /login — `frontend/app/login/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `login-page-root` | container | Login page root |
| `login-form-root` | form | Credentials form |
| `login-form-email-input` | Input | Email field |
| `login-form-password-input` | Input | Password field |
| `login-form-error-text` | text | Login failure message (rendered on error only) |
| `login-form-submit-button` | Button | Submit credentials |
| `login-register-link` | Link | Go to /register |

**Dev auto-login adds no testid — deliberately.** `frontend/components/providers.tsx` probes `POST /v1/auth/dev-session` once on mount when no token is stored; on a backend with `TRACEO_DEV_AUTOLOGIN=1` it stores the returned session and redirects to `/projects`, and on any other backend the endpoint answers `404` and the probe falls through silently. There is no rendered element, so there is nothing to register and nothing to select. The table above therefore stays the complete login surface for the suite: the E2E backend runs with the flag off (pinned by `negative.spec.ts` — "the dev auto-login route does not exist while the flag is off"), so `auth.spec.ts` and the login negatives observe the same page they always did.

## /register — `frontend/app/register/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `register-page-root` | container | Registration page root |
| `register-form-root` | form | Registration form (org + admin) |
| `register-form-org-name-input` | Input | Organisation name |
| `register-form-name-input` | Input | Admin display name |
| `register-form-email-input` | Input | Admin email |
| `register-form-password-input` | Input | Password (min 8 chars) |
| `register-form-error-text` | text | Registration failure message |
| `register-form-submit-button` | Button | Submit registration |
| `register-login-link` | Link | Go to /login |

## /projects — `frontend/app/projects/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `projects-page-root` | container | Project list page root |
| `projects-page-header` | PageHeader | Page title + actions |
| `projects-list-create-button` | Button | Primary header action — opens the create-project modal |
| `projects-page-error-text` | text | List load error |
| `projects-empty-state` | Empty | No projects yet — carries the create call to action |
| `projects-empty-create-button` | Button | Empty-state call to action — opens the SAME create-project modal as the header button |
| `projects-list-grid` | grid | Cards container |
| `projects-list-card` | card (repeated) | One project card — identified by project name |
| `projects-card-open-link` | Link | Project name link to the overview |
| `projects-card-status-badge` | Badge | `data-state="active\|archived"` — shown when archived |
| `projects-card-open-button` | Button | Open the project |
| `projects-card-unarchive-button` | Button | Restore an archived project |
| `projects-card-archive-button` | Button | Archive (opens confirm modal) |
| `projects-card-delete-button` | Button | Delete (opens confirm modal) |
| `projects-create-modal` | Modal | Create-project dialog — name only (automation defaults to `auto` server-side) |
| `projects-create-name-input` | Input | New project name |
| `projects-create-error-text` | text | Creation failure message |
| `projects-create-cancel-button` | Button | Close the dialog |
| `projects-create-submit-button` | Button | Create the project |
| `projects-confirm-modal` | Modal | Archive/delete confirmation dialog |
| `projects-confirm-cancel-button` | Button | Abort the destructive action |
| `projects-confirm-submit-button` | Button | Confirm archive/delete |

## App shell — `frontend/app/layout.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `nav-app-root` | container | Application shell root |

## /settings/members — `frontend/app/settings/members/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `members-page-root` | container | Members page root |
| `members-page-header` | PageHeader | Page title + actions |
| `members-audit-link-button` | Button | Go to the audit log |
| `members-invite-button` | Button | Open the invite modal (admin only) |
| `members-error-text` | text | Load/action error |
| `members-empty-state` | Empty | No members listed |
| `members-table-root` | Table | Members table |
| `members-row` | row (repeated) | One member — identified by email |
| `members-row-email-text` | text | Member email |
| `members-row-role-badge` | Badge | Member role (read-only view) |
| `members-row-role-select` | Select | Change member role (admin) |
| `members-row-remove-button` | Button | Open the remove-member modal |
| `members-invite-modal` | Modal | Invite dialog |
| `members-invite-name-input` | Input | Invitee name |
| `members-invite-email-input` | Input | Invitee email |
| `members-invite-role-select` | Select | Invitee role |
| `members-invite-password-input` | Input | Invitee password (set by inviter — no activation step) |
| `members-invite-error-text` | text | Invite failure message |
| `members-invite-cancel-button` | Button | Close the invite dialog |
| `members-invite-submit-button` | Button | Send the invite |
| `members-remove-modal` | Modal | Remove-member confirmation |
| `members-remove-cancel-button` | Button | Abort removal |
| `members-remove-confirm-button` | Button | Confirm removal |

## /settings/audit — `frontend/app/settings/audit/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `audit-page-root` | container | Audit log page root |
| `audit-page-header` | PageHeader | Page title + actions |
| `audit-members-link-button` | Button | Back to members page |
| `audit-error-text` | text | Load error |
| `audit-empty-state` | Empty | Empty audit log |
| `audit-table-root` | Table | Audit entries table |
| `audit-row` | row (repeated) | One append-only audit entry |
| `audit-row-action-badge` | Badge | Entry action label |
| `audit-load-more-button` | Button | Fetch next cursor page |

## Project shell — `frontend/app/projects/[id]/layout.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `nav-project-shell` | container | Project layout root (sidebar + content) |
| `nav-project-sidebar` | nav | Project sidebar |
| `nav-project-name` | text | Current project name |
| `nav-project-archived-badge` | Badge | Shown when the project is archived |
| `nav-link-overview` | Link | Sidebar → overview (dashboard) |
| `nav-link-requirements` | Link | Sidebar → requirements |
| `nav-link-endpoints` | Link | Sidebar → endpoints |
| `nav-link-generate` | Link | Sidebar → generate |
| `nav-link-insights` | Link | Sidebar → insights (QA Insight Agent — the sixth engine) |
| `nav-link-review` | Link | Sidebar → review |
| `nav-link-runs` | Link | Sidebar → runs |
| `nav-link-matrix` | Link | Sidebar → traceability matrix |
| `nav-link-environments` | Link | Sidebar → environments |
| `nav-link-settings` | Link | Sidebar → project settings |
| `nav-link-integrations` | Link | Sidebar → integrations |
| `nav-link-reference` | Link | Sidebar → reference catalog |

## /projects/[id] (overview) — `frontend/app/projects/[id]/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `dashboard-page-root` | container | Overview (dashboard) page root |
| `dashboard-page-header` | PageHeader | Page title + actions |
| `dashboard-error-card` | Card | Load-failure card |
| `dashboard-error-text` | text | Load error message |
| `dashboard-retry-button` | Button | Reload the dashboard |
| `dashboard-coverage-stat` | StatCard | Coverage percentage |
| `dashboard-approved-cases-stat` | StatCard | Approved test-case count |
| `dashboard-latest-run-stat` | StatCard | Latest run summary |
| `dashboard-open-defects-stat` | StatCard | Open defects count |
| `dashboard-median-duration-stat` | StatCard | Median run duration |
| `dashboard-coverage-trend-card` | Card | Coverage trend section |
| `dashboard-coverage-trendbars` | chart | Coverage trend bars |
| `dashboard-latest-run-card` | Card | Latest run section |
| `dashboard-latest-run-donut` | chart | Latest run outcome donut |
| `dashboard-latest-run-state-badge` | Badge | `data-state="queued\|running\|completed\|cancelled\|aborted"` |
| `dashboard-open-report-button` | Button | Open the latest run report |
| `dashboard-regression-card` | Card | Regression watch section |
| `dashboard-regression-row` | row (repeated) | One regressing case |
| `dashboard-regression-severity-badge` | Badge | `data-state` carries the severity |
| `dashboard-regression-outcome-badge` | Badge | `data-state="passed\|failed\|errored"` |
| `dashboard-gaps-card` | Card | Coverage gaps section |
| `dashboard-gap-row` | row (repeated) | One uncovered requirement |
| `dashboard-gap-targeted-generate-button` | Button | Generate targeting this gap |
| `dashboard-case-states-card` | Card | Case-state distribution |
| `dashboard-case-state-draft-chip` | chip | Draft case count |
| `dashboard-case-state-approved-chip` | chip | Approved case count |
| `dashboard-case-state-rejected-chip` | chip | Rejected case count |
| `dashboard-case-state-stale-chip` | chip | Stale case count |
| `dashboard-case-state-archived-chip` | chip | Archived case count |
| `dashboard-quick-actions-card` | Card | Quick actions section |
| `dashboard-quick-upload-doc-button` | Button | Quick action → upload document |
| `dashboard-quick-import-spec-button` | Button | Quick action → import API spec |
| `dashboard-quick-generate-button` | Button | Quick action → generate |
| `dashboard-quick-review-button` | Button | Quick action → review |
| `dashboard-quick-run-button` | Button | Quick action → run |

## /projects/[id]/requirements — `frontend/app/projects/[id]/requirements/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `requirements-page-root` | container | Requirements page root |
| `requirements-page-header` | PageHeader | Page title + actions |
| `requirements-toolbar-confirm-all-button` | Button | Confirm every extracted requirement |
| `requirements-upload-dropzone` | dropzone | Document drop area |
| `requirements-upload-file-input` | file input | Hidden input (.pdf/.docx/.md/.txt) |
| `requirements-upload-progress` | Progress | Ingest job progress |
| `requirements-documents-card` | Card | Source documents section |
| `requirements-documents-empty-state` | Empty | No documents uploaded |
| `requirements-document-row` | row (repeated) | One source document |
| `requirements-document-parse-status-badge` | Badge | `data-state="pending\|parsing\|parsed\|failed"` |
| `requirements-list-card` | Card | Requirements list section |
| `requirements-search-input` | Input | Free-text search |
| `requirements-type-select` | Select | Filter by requirement type |
| `requirements-priority-select` | Select | Filter by priority |
| `requirements-filter-all-pill` | Pill | State filter: all |
| `requirements-filter-extracted-pill` | Pill | State filter: extracted |
| `requirements-filter-confirmed-pill` | Pill | State filter: confirmed |
| `requirements-filter-changed-pill` | Pill | State filter: changed |
| `requirements-filter-removed-pill` | Pill | State filter: removed |
| `requirements-list-retry-button` | Button | Reload after a load error |
| `requirements-empty-state` | Empty | No requirements (or no filter matches) |
| `requirements-row` | row (repeated) | One requirement — identified by external_id/description |
| `requirements-row-status-dot` | StatusDot | Row state indicator |
| `requirements-row-state-badge` | Badge | `data-state="extracted\|confirmed\|changed\|removed"` |
| `requirements-row-confidence-progress` | Progress | Extraction confidence |
| `requirements-row-edit-button` | Button | Open the edit modal |
| `requirements-row-confirm-button` | Button | Confirm this requirement |
| `requirements-edit-modal` | Modal | Requirement edit dialog |
| `requirements-edit-external-id-input` | Input | External id |
| `requirements-edit-description-textarea` | Textarea | Description |
| `requirements-edit-type-input` | Input | Requirement type |
| `requirements-edit-priority-select` | Select | Priority |
| `requirements-edit-acceptance-textarea` | Textarea | Acceptance criteria (one per line) |
| `requirements-edit-cancel-button` | Button | Close without saving |
| `requirements-edit-save-button` | Button | Save changes |

## /projects/[id]/endpoints — `frontend/app/projects/[id]/endpoints/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `endpoints-page-root` | container | Endpoints page root |
| `endpoints-page-header` | PageHeader | Page title + actions |
| `endpoints-import-card` | Card | API document import section |
| `endpoints-import-accepts-hint` | text | Which formats the control accepts |
| `endpoints-import-url-pill` | Pill | Import mode: from URL |
| `endpoints-import-file-pill` | Pill | Import mode: from file |
| `endpoints-import-url-input` | Input | Spec URL |
| `endpoints-import-submit-button` | Button | Import from URL (synchronous — no job) |
| `endpoints-import-file-input` | file input | API document — OpenAPI/Swagger, Postman collection, HAR or Insomnia export |
| `endpoints-import-file-button` | Button | Pick a file to import |
| `endpoints-import-error` | container | Import refusal (e.g. `422 invalid_spec`) |
| `endpoints-import-error-list` | list | The refusal's `errors` list |
| `endpoints-import-error-item` | item (repeated) | One reason — names a format that *would* be accepted |
| `endpoints-import-format-badge` | Badge | Detected import format — `data-format` (see below) |
| `endpoints-import-added-badge` | Badge | Diff: endpoints added |
| `endpoints-import-updated-badge` | Badge | Diff: endpoints changed |
| `endpoints-import-removed-badge` | Badge | Diff: endpoints removed |
| `endpoints-import-total-badge` | Badge | Total endpoints after import |
| `endpoints-import-enriched-badge` | Badge | AI enrichment: endpoints annotated |
| `endpoints-import-enrichment-discarded-badge` | Badge | AI enrichment: items the validation gate refused |
| `endpoints-import-environment-created` | line | Confirmation that the import derived a runnable environment — prints its name and base URL (rendered only when `environment_created` is non-null) |
| `endpoints-import-environment-created-link` | Link | Go to the environments page to review or edit the derived environment |
| `endpoints-inventory-card` | Card | Endpoint inventory section |
| `endpoints-inventory-retry-button` | Button | Reload after a load error |
| `endpoints-empty-state` | Empty | No endpoints discovered |
| `endpoints-table-root` | Table | Inventory table |
| `endpoints-row` | row (repeated) | One endpoint — identified by METHOD + path |
| `endpoints-row-outcome-dot` | StatusDot | Last result outcome indicator |
| `endpoints-row-include-toggle` | toggle | Include/exclude from generation (PATCH {excluded}) |
| `endpoints-row-ai-description` | cell | `ai_description` — one-line plain-English description (nullable) |
| `endpoints-row-ai-group` | cell | `ai_group` — resource group name (nullable) |
| `endpoints-row-ai-criticality` | wrapper | `ai_criticality` — carries `data-state="high\|medium\|low"` (nullable) |
| `endpoints-row-ai-criticality-badge` | Badge | The rendered criticality badge inside that wrapper |

**Import-format badge.** `endpoints-import-format-badge` shows the `format` key of the import response — a closed vocabulary shared by both backends: `openapi3 | swagger2 | postman2 | har | insomnia4`. The badge PRINTS a human label ("Postman Collection v2") and carries the vocabulary value on **`data-format`** (mirrored on `data-state`), so it is asserted on the attribute and never on the label — the `data-state` convention of this document applied to a non-state vocabulary. `e2e/pages/endpoints.page.ts` (`formatBadgeFor`) reads `data-format` only, which leaves the wording free to change.

**Derived-environment line.** A successful import echoes `environment_created` — `null` or `{id, name, base_url}`. It is non-null **only** when the project had zero environments at import time *and* a base URL could be derived from the document itself; an existing environment is never touched, and no host is ever invented. When it is non-null the page renders `endpoints-import-environment-created` with the created name and base URL, plus `endpoints-import-environment-created-link` to `/projects/{id}/environments`. Absence of both ids is therefore a legitimate state (the usual one on any re-import), not a defect — specs assert their presence only on a project that started with no environment.

**AI-enrichment cells.** The three `endpoints-row-ai-*` ids are rendered **only where the corresponding column is non-null** — enrichment is optional (gated on the project's `automation: "auto"`) and an import always succeeds with zero enrichment. Absence of these ids is therefore a legitimate state, not a defect, and specs assert the count against the API rather than assuming a fixed number of them. `ai_description` and `ai_group` are stored and rendered as **plain text**: enrichment may never create, rename or delete an endpoint, nor alter a path, a parameter or a field name.

## /projects/[id]/generate — `frontend/app/projects/[id]/generate/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `generate-page-root` | container | Generate page root |
| `generate-page-header` | PageHeader | Page title + actions |
| `generate-requirements-card` | Card | Confirmed requirements checklist |
| `generate-select-all-button` | Button | Select/clear all listed requirements |
| `generate-filter-all-pill` | Pill | Priority filter: all |
| `generate-filter-high-pill` | Pill | Priority filter: high |
| `generate-filter-medium-pill` | Pill | Priority filter: medium |
| `generate-filter-low-pill` | Pill | Priority filter: low |
| `generate-requirements-retry-button` | Button | Reload after a load error |
| `generate-empty-state` | Empty | No confirmed requirements |
| `generate-requirement-row` | row (repeated) | One selectable requirement |
| `generate-requirement-checkbox` | checkbox (repeated) | Requirement selection |
| `generate-depth-card` | Card | Depth picker section |
| `generate-depth-smoke-button` | Button | Depth: smoke |
| `generate-depth-standard-button` | Button | Depth: standard (default) |
| `generate-depth-exhaustive-button` | Button | Depth: exhaustive |
| `generate-summary-card` | Card | Selection summary |
| `generate-job-progress` | Progress | Generate job progress (202 → poll) |
| `generate-submit-button` | Button | Start generation (disabled with no selection) |
| `generate-result-card` | Card | Job result panel (appears on completion) |
| `generate-generated-stat` | StatCard | Cases generated |
| `generate-discarded-stat` | StatCard | Cases discarded (ungrounded) |
| `generate-to-review-button` | Button | Go to the review page |

## /projects/[id]/insights — `frontend/app/projects/[id]/insights/page.tsx`

The **QA Insight Agent** screen — the sixth engine: fully deterministic, no language model and no outbound call. The page reads `GET /v1/projects/{id}/insights` and fires `POST /v1/projects/{id}/insights/generate` (202 + `job_id`, polled like any other job).

**All 9 taxonomy rows are always rendered** in the canonical order — `boundary_surprise | exotic_input | control_chars | idempotency | state_corruption | permission_edge | timing_dst | resource_exhaustion | downstream_failure`. Each row prints its canonical id in a monospace cell, so a row is addressed by its id (entity data) rather than by its display title. The status badge carries `data-state` with the literal server values: `covered | gap | n_a`.

| data-testid | Element | Purpose |
|---|---|---|
| `insights-page-root` | container | Insights page root |
| `insights-page-header` | PageHeader | Page title + subtitle |
| `insights-total-cases-stat` | StatCard | `total_cases` — cases counted across the taxonomy |
| `insights-total-covered-stat` | StatCard | `total_covered` |
| `insights-total-suggestable-stat` | StatCard | `total_suggestable` — what the builders could ground right now |
| `insights-categories-card` | Card | The 9-row taxonomy |
| `insights-select-all-button` | Button | Select/clear every selectable (non-`n_a`) category |
| `insights-page-error-text` | text | Coverage-map load error |
| `insights-retry-button` | Button | Reload after a load error |
| `insights-empty-state` | Empty | Nothing to ground yet (no inventory/cases) |
| `insights-category-row` | row (repeated) | One taxonomy row — identified by its canonical id |
| `insights-category-checkbox` | checkbox (repeated) | Category selection (disabled when `suggestable_count == 0`) |
| `insights-category-status-badge` | Badge | `data-state="covered\|gap\|n_a"` |
| `insights-summary-card` | Card | Sticky selection summary + the grounding note |
| `insights-job-progress` | Progress | Builder-job progress (202 → poll) |
| `insights-generate-button` | Button | Run the builders (capability `generate`; disabled with no selection) |
| `insights-generate-error-text` | text | Run refusal (e.g. 422 `invalid_category`) |
| `insights-result-card` | Card | Run result panel (appears on completion) |
| `insights-created-stat` | StatCard | Cases created (drafts, technique `edge_case`) |
| `insights-discarded-stat` | StatCard | Cases discarded by the grounding gate (BO-07) |
| `insights-to-review-button` | Button | Go to the review queue with the new drafts |

## /projects/[id]/review — `frontend/app/projects/[id]/review/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `review-page-root` | container | Review page root |
| `review-page-header` | PageHeader | Page title + shortcuts hint |
| `review-error-retry-button` | Button | Dismiss/retry after a load error |
| `review-bulk-bar` | bar | Bulk action bar (rendered while cases are checked) |
| `review-approve-all-button` | Button | Header shortcut — approve every queued draft in one click (shows the count; hidden without `approve_reject` or when no drafts remain) |
| `review-approve-all-modal` | Modal | Confirmation for the approve-all shortcut |
| `review-approve-all-confirm-button` | Button | Confirms approving every queued draft |
| `review-approve-all-cancel-button` | Button | Dismisses the approve-all confirmation |
| `review-bulk-approve-button` | Button | Bulk approve checked cases |
| `review-bulk-reject-button` | Button | Bulk reject checked cases |
| `review-bulk-clear-button` | Button | Clear the selection |
| `review-queue-card` | Card | Case queue section |
| `review-filter-all-pill` | Pill | State filter: all |
| `review-filter-draft-pill` | Pill | State filter: draft |
| `review-filter-approved-pill` | Pill | State filter: approved |
| `review-filter-rejected-pill` | Pill | State filter: rejected |
| `review-filter-stale-pill` | Pill | State filter: stale |
| `review-search-input` | Input | Free-text case search |
| `review-empty-state` | Empty | No cases (or no filter matches) |
| `review-case-row` | row (repeated) | One case — carries `data-state`, identified by title |
| `review-case-checkbox` | checkbox (repeated) | Case selection for bulk actions |
| `review-case-status-dot` | StatusDot | Row state indicator |
| `review-case-state-badge` | Badge | `data-state="draft\|approved\|rejected\|stale\|archived"` |
| `review-detail-card` | Card | Selected-case detail pane |
| `review-detail-status-dot` | StatusDot | Detail state indicator |
| `review-case-edit-button` | Button | Open the edit modal |
| `review-case-reject-button` | Button | Open the reject modal |
| `review-case-approve-button` | Button | Approve the selected case |
| `review-reject-modal` | Modal | Reject dialog |
| `review-reject-reason-select` | Select | Reason code: incorrect/shallow/duplicate/other |
| `review-reject-reason-textarea` | Textarea | Free-text reason detail |
| `review-reject-cancel-button` | Button | Close without rejecting |
| `review-reject-confirm-button` | Button | Confirm the rejection |
| `review-edit-modal` | Modal | Case edit dialog |
| `review-edit-title-input` | Input | Case title |
| `review-edit-description-textarea` | Textarea | Case description |
| `review-edit-priority-select` | Select | Case priority |
| `review-edit-steps-textarea` | Textarea | Steps as JSON |
| `review-edit-assertions-textarea` | Textarea | Assertions as JSON |
| `review-edit-cancel-button` | Button | Close without saving |
| `review-edit-save-button` | Button | Save the edit |

## /projects/[id]/reference — `frontend/app/projects/[id]/reference/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `reference-page-root` | container | Reference catalog page root |
| `reference-page-header` | PageHeader | Page title + actions |
| `reference-retry-button` | Button | Reload after a load error |
| `reference-search-input` | Input | Feature search |
| `reference-group-all-pill` | Pill | Group filter: all |
| `reference-group-{group}-pill` | Pill (dynamic) | Group filter — one per catalog group slug |
| `reference-priority-p0-pill` | Pill | Priority filter: P0 |
| `reference-priority-p1-pill` | Pill | Priority filter: P1 |
| `reference-priority-p2-pill` | Pill | Priority filter: P2 |
| `reference-empty-state` | Empty | No matching features |
| `reference-list-card` | Card | Feature list section |
| `reference-feature-row` | row (repeated) | One catalog feature |
| `reference-feature-refchip` | RefChip | Feature FR reference chip |
| `reference-feature-status-badge` | Badge | Feature implementation status |

## /projects/[id]/runs — `frontend/app/projects/[id]/runs/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `runs-page-root` | container | Runs page root |
| `runs-page-header` | PageHeader | Page title + actions |
| `runs-launch-env-select` | Select | Target environment — rendered **only** when the project has at least one environment |
| `runs-environment-empty-hint` | text | Shown *instead of* the picker when the project has no environment at all: an empty `<select>` offers nothing and explains nothing |
| `runs-environment-empty-link` | Link | Go to the environments page to create one |
| `runs-launch-subset-button` | Button | Open the subset picker modal |
| `runs-launch-run-button` | Button | Launch a run (202 {job_id, run_id}) |
| `runs-live-panel` | panel | Live run panel (while a run is active) |
| `runs-live-status-dot` | StatusDot | Live run state indicator |
| `runs-live-state-badge` | Badge | `data-state="queued\|running\|completed\|cancelled\|aborted"` |
| `runs-live-cancel-button` | Button | Cancel the live run |
| `runs-live-report-button` | Button | Open the live run's report |
| `runs-empty-state` | Empty | No runs yet |
| `runs-table-root` | Table | Run history table |
| `runs-row` | row (repeated) | One run — identified by display id |
| `runs-row-link` | Link | Open the run report |
| `runs-row-status-dot` | StatusDot | Row state indicator |
| `runs-row-state-badge` | Badge | `data-state` carries the literal Run.state |
| `runs-subset-modal` | Modal | Approved-case subset picker |
| `runs-subset-search-input` | Input | Filter cases in the picker |
| `runs-subset-clear-button` | Button | Clear the subset |
| `runs-subset-apply-button` | Button | Apply the subset |

**Environment picker vs. empty hint.** `runs-launch-env-select` and `runs-environment-empty-hint` are mutually exclusive: with zero environments the select is **not rendered at all** (so a spec asserts `toHaveCount(0)` on it, not that it is empty), and the hint takes its place with a link to `/projects/{id}/environments`. The usual way a project stops being in that state is the import itself — importing an API document into a project with no environment derives one from the document (see the endpoints page above).

## /projects/[id]/runs/[runId] — `frontend/app/projects/[id]/runs/[runId]/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `runs-report-page-root` | container | Run report page root |
| `runs-report-page-header` | PageHeader | Report title + actions |
| `runs-report-status-dot` | StatusDot | Run state indicator |
| `runs-report-state-badge` | Badge | `data-state` carries the literal Run.state |
| `runs-report-export-button` | Button | Export the report |
| `runs-report-total-stat` | StatCard | Total results |
| `runs-report-passed-stat` | StatCard | Passed count |
| `runs-report-failed-stat` | StatCard | Failed count |
| `runs-report-errored-stat` | StatCard | Errored count |
| `runs-report-duration-stat` | StatCard | Run duration |
| `runs-report-tab-failures-pill` | Pill | Tab: failures |
| `runs-report-tab-all-pill` | Pill | Tab: all results |
| `runs-report-tab-compare-pill` | Pill | Tab: compare with another run |
| `runs-report-no-failures-empty` | Empty | No failures in this run |
| `runs-report-severity-all-pill` | Pill | Severity filter: all |
| `runs-report-severity-critical-pill` | Pill | Severity filter: critical |
| `runs-report-severity-major-pill` | Pill | Severity filter: major |
| `runs-report-severity-minor-pill` | Pill | Severity filter: minor |
| `runs-report-failure-row` | row (repeated) | One failure — identified by case title |
| `runs-report-failure-toggle-button` | Button | Expand/collapse failure evidence |
| `runs-report-failure-severity-badge` | Badge | `data-state` carries the severity |
| `runs-report-failure-outcome-badge` | Badge | `data-state="failed\|errored"` |
| `runs-report-results-empty` | Empty | No results to list |
| `runs-report-table-root` | Table | All-results table |
| `runs-report-result-row` | row (repeated) | One result |
| `runs-report-result-status-dot` | StatusDot | Result outcome indicator |
| `runs-report-result-outcome-badge` | Badge | `data-state="passed\|failed\|errored"` |
| `runs-report-compare-select` | Select | Baseline run to compare against |
| `runs-report-perf-table` | Table | Duration comparison table |

## /projects/[id]/matrix — `frontend/app/projects/[id]/matrix/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `matrix-page-root` | container | Traceability matrix page root |
| `matrix-page-header` | PageHeader | Page title + actions |
| `matrix-export-button` | Button | Export the matrix |
| `matrix-coverage-stat` | StatCard | Coverage percentage |
| `matrix-gaps-stat` | StatCard | Uncovered requirement count |
| `matrix-filter-all-pill` | Pill | Status filter: all |
| `matrix-filter-not_covered-pill` | Pill | Status filter: not covered |
| `matrix-filter-covered_not_run-pill` | Pill | Status filter: covered, never run |
| `matrix-filter-passing-pill` | Pill | Status filter: passing |
| `matrix-filter-failing-pill` | Pill | Status filter: failing |
| `matrix-filter-errored-pill` | Pill | Status filter: errored |
| `matrix-table-root` | Card/Table | Matrix table container |
| `matrix-empty-state` | Empty | No requirements to trace |
| `matrix-row` | row (repeated) | One requirement — identified by external_id |
| `matrix-row-case-link` | Link (repeated) | Jump to a covering case on the review page |
| `matrix-case-status-dot` | StatusDot | Covering-case state indicator |
| `matrix-row-status-badge` | Badge | `data-state="not_covered\|covered_not_run\|passing\|failing\|errored"` |
| `matrix-row-progress` | Progress | Pass ratio of covering cases |
| `matrix-gap-card` | Card | Coverage gaps call-out |
| `matrix-gap-generate-button` | Button | Generate targeting the gaps |

## /projects/[id]/environments — `frontend/app/projects/[id]/environments/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `environments-page-root` | container | Environments page root |
| `environments-page-header` | PageHeader | Page title + actions |
| `environments-create-button` | Button | Open the create form |
| `environments-empty-state` | Empty | No environments yet |
| `environments-env-card` | card (repeated) | One environment — identified by name |
| `environments-env-check-badge` | Badge | Reachability check result |
| `environments-env-check-button` | Button | Run a reachability check |
| `environments-env-edit-button` | Button | Open the edit form |
| `environments-env-delete-button` | Button | Open the delete confirmation |
| `environments-form-modal` | Modal | Create/edit environment dialog |
| `environments-name-input` | Input | Environment name |
| `environments-base-url-input` | Input | Base URL |
| `environments-auth-type-select` | Select | Auth type: none/api_key/basic/bearer/oauth2_cc |
| `environments-auth-header-input` | Input | API-key header name |
| `environments-auth-key-input` | Input | API-key value (write-only) |
| `environments-auth-username-input` | Input | Basic auth username |
| `environments-auth-password-input` | Input | Basic auth password (write-only) |
| `environments-auth-token-input` | Input | Bearer token (write-only) |
| `environments-auth-token-url-input` | Input | OAuth2 token URL |
| `environments-auth-client-id-input` | Input | OAuth2 client id |
| `environments-auth-client-secret-input` | Input | OAuth2 client secret (write-only) |
| `environments-variables-textarea` | Textarea | Environment variables |
| `environments-tls-checkbox` | checkbox | Strict TLS verification |
| `environments-form-cancel-button` | Button | Close without saving |
| `environments-form-submit-button` | Button | Save the environment |
| `environments-delete-modal` | Modal | Delete confirmation |
| `environments-delete-cancel-button` | Button | Abort deletion |
| `environments-delete-confirm-button` | Button | Confirm deletion |

## /projects/[id]/settings — `frontend/app/projects/[id]/settings/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `settings-page-root` | container | Project settings page root |
| `settings-page-header` | PageHeader | Page title + actions |
| `settings-tab-general-pill` | Pill | Tab: general (automation override) |
| `settings-automation-select` | Select | Automation mode (`auto`/`manual`) — autopilot on/off |
| `settings-general-save-button` | Button | Save the general settings (PATCH /projects/{id}) |
| `settings-general-error-text` | text | General-settings save failure message |
| `settings-tab-keys-pill` | Pill | Tab: API keys |
| `settings-tab-schedules-pill` | Pill | Tab: schedules |
| `settings-tab-export-pill` | Pill | Tab: export |
| `settings-keys-new-button` | Button | Open the create-key modal |
| `settings-keys-empty-state` | Empty | No API keys |
| `settings-keys-table` | Table | API keys table |
| `settings-keys-row` | row (repeated) | One API key |
| `settings-keys-row-state-badge` | Badge | Key state (active/revoked) |
| `settings-keys-revoke-button` | Button | Open the revoke confirmation |
| `settings-schedules-new-button` | Button | Open the create-schedule modal |
| `settings-schedules-empty-state` | Empty | No schedules |
| `settings-schedules-table` | Table | Schedules table |
| `settings-schedules-row` | row (repeated) | One schedule |
| `settings-schedule-enabled-toggle` | toggle | Enable/disable a schedule inline |
| `settings-schedule-edit-button` | Button | Open the edit modal |
| `settings-schedule-delete-button` | Button | Open the delete confirmation |
| `settings-export-button` | Button | Export project data |
| `settings-key-modal` | Modal | Create-key dialog (also shows the created key once) |
| `settings-key-value` | code | The key value `trc_…` — shown exactly once |
| `settings-key-done-button` | Button | Acknowledge the shown key |
| `settings-key-name-input` | Input | New key name |
| `settings-key-cancel-button` | Button | Close without creating |
| `settings-key-submit-button` | Button | Create the key |
| `settings-revoke-modal` | Modal | Revoke confirmation |
| `settings-revoke-cancel-button` | Button | Abort the revoke |
| `settings-revoke-confirm-button` | Button | Confirm the revoke |
| `settings-schedule-modal` | Modal | Create/edit schedule dialog |
| `settings-schedule-name-input` | Input | Schedule name |
| `settings-schedule-env-select` | Select | Environment to run against |
| `settings-schedule-interval-select` | Select | Interval (min 15 minutes) |
| `settings-schedule-form-enabled-toggle` | toggle | Enabled flag in the form |
| `settings-schedule-cancel-button` | Button | Close without saving |
| `settings-schedule-submit-button` | Button | Save the schedule |
| `settings-schedule-delete-modal` | Modal | Delete-schedule confirmation |
| `settings-schedule-delete-cancel-button` | Button | Abort deletion |
| `settings-schedule-delete-confirm-button` | Button | Confirm deletion |

## /projects/[id]/integrations — `frontend/app/projects/[id]/integrations/page.tsx`

| data-testid | Element | Purpose |
|---|---|---|
| `integrations-page-root` | container | Integrations page root |
| `integrations-page-header` | PageHeader | Page title + actions |
| `integrations-webhooks-new-button` | Button | Open the create-webhook modal |
| `integrations-webhooks-empty-state` | Empty | No webhooks |
| `integrations-webhook-card` | card (repeated) | One webhook — identified by name/URL |
| `integrations-webhook-enabled-badge` | Badge | Enabled/disabled state |
| `integrations-webhook-test-button` | Button | Send a test delivery |
| `integrations-webhook-edit-button` | Button | Open the edit modal |
| `integrations-webhook-delete-button` | Button | Open the delete confirmation |
| `integrations-gate-min-coverage-input` | Input | CI gate: minimum coverage % |
| `integrations-gate-max-critical-input` | Input | CI gate: max open critical defects |
| `integrations-gate-check-button` | Button | Evaluate the gate now |
| `integrations-gate-result-badge` | Badge | Gate verdict (pass/fail) |
| `integrations-xray-run-select` | Select | Run to export for Jira/Xray |
| `integrations-xray-download-button` | Button | Download the Xray export |
| `integrations-defects-download-button` | Button | Download the defects export |
| `integrations-webhook-modal` | Modal | Create/edit webhook dialog |
| `integrations-webhook-name-input` | Input | Webhook name |
| `integrations-webhook-url-input` | Input | Delivery URL |
| `integrations-webhook-secret-input` | Input | Signing secret (write-only) |
| `integrations-webhook-enabled-checkbox` | checkbox | Enabled flag |
| `integrations-webhook-cancel-button` | Button | Close without saving |
| `integrations-webhook-submit-button` | Button | Save the webhook |
| `integrations-webhook-delete-modal` | Modal | Delete confirmation |
| `integrations-webhook-delete-cancel-button` | Button | Abort deletion |
| `integrations-webhook-delete-confirm-button` | Button | Confirm deletion |

---

## Surfaces that deliberately have no testids

**Security testing (S0) and the component inventory (S2)** — `docs/SECURITY_TESTING_PLAN.md` §14 — shipped as **API only**: the weakness catalogue, `POST /v1/projects/{id}/security/generate`, the coverage matrix and the SBOM/lockfile import have no screen, so there is nothing to register. Their cases land in the existing review queue and are selected there through the ids already listed under `/projects/[id]/review`. The specs that cover them (`e2e/tests/security.spec.ts`, `e2e/tests/components.spec.ts`) are therefore API-level, with no page objects. When a screen is added for either, its ids belong in this file in the same change.
