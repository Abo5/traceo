# User Flows — Traceo

**Version 2.0 · 26 July 2026**
Each flow names the screens it crosses and the features (FR-###) it exercises.

---

## Flow 1 — First run from a requirement document

**Actor:** QA Lead · **Goal:** turn a signed BRD into an executed suite and a matrix
**Screens:** New run → Requirements → Run report

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Upload `BRD_OrdersPlatform_v3.2.pdf` | New run | FR-010, FR-012 |
| 2 | Review the extraction summary: 6 requirements, 21 acceptance criteria | New run | FR-013 |
| 3 | Enter base URL, environment, auth method; select the credential from the vault | New run | FR-083 |
| 4 | Choose discovery mode — *traffic capture* | New run | FR-021, FR-022 |
| 5 | Confirm generation techniques (boundary, equivalence, decision tables, negative & auth, RTL are on by default) | New run | FR-030 – FR-034 |
| 6 | Read the run summary: ~218 cases, 6–7 minutes | New run | — |
| 7 | **Generate & run** | New run | FR-035, FR-040 |
| 8 | Watch discovery → generation → execution; 8 endpoints found, 218 cases generated | Run report | FR-024, FR-035 |
| 9 | Land on the report: 211 passed, 7 failed, 86% coverage, 2 gaps | Run report | FR-050, FR-051 |

**Alternate paths**

- *Step 1 — document yields zero requirements:* empty state offers "paste requirements" and manual entry.
- *Step 4 — no traffic observed:* discovery falls back to DOM crawl and reports the reduced surface before generation.
- *Step 7 — credential rejected:* the run stops before fixtures are created; no partial state.

**Exit criteria:** a run exists, a matrix exists, gaps are named.

---

## Flow 2 — Triage a failure and hand it to a developer

**Actor:** QA Engineer · **Goal:** produce a ticket a developer can act on without asking a question
**Screens:** Run report → (Jira)

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Open run #1042; the **Failures** tab is active with 4 defects | Run report | FR-052 |
| 2 | Expand BUG-141 — *phone with 11 digits accepted, returns 201 instead of 422* | Run report | FR-052 |
| 3 | Read the three reproduction steps | Run report | FR-052 |
| 4 | Read the evidence block: status, latency, response body, the failed assertion | Run report | FR-041, FR-042 |
| 5 | Confirm the tags: `POST /customers`, `boundary`, `TC-102` | Run report | FR-035 |
| 6 | **Export to Jira** | Run report | FR-070 |
| 7 | The issue is created with steps, evidence, severity and a link back to the run | Jira | FR-070 |

**Alternate paths**

- *Already exported:* the existing issue is updated, not duplicated.
- *False positive:* the case is edited on the Test cases screen and marked manually modified; the edit survives regeneration (FR-036).

**Exit criteria:** a developer can reproduce the defect from the ticket alone.

---

## Flow 3 — Close a coverage gap

**Actor:** QA Lead · **Goal:** turn "not verified" into "verified"
**Screens:** Run report → API surface → New run → Run report

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Open the **Coverage gaps** tab; REQ-021 and REQ-033 have zero tests | Run report | FR-051 |
| 2 | Read the reason for REQ-021: the invoice rendering path is not reachable through the discovered surface | Run report | FR-051 |
| 3 | See the three acceptance criteria awaiting coverage | Run report | FR-013 |
| 4 | **Resolve in API surface** | API surface | FR-024 |
| 5 | Upload the OpenAPI spec for the invoice-render service | API surface | FR-020 |
| 6 | The endpoint appears in the surface at 0% coverage | API surface | FR-024 |
| 7 | Start a new run; generation now resolves REQ-021 to a real endpoint | New run | FR-035 |
| 8 | REQ-021 appears in the matrix with a verdict instead of a gap | Run report | FR-050 |

**Exit criteria:** the gap list shrinks and coverage rises for a stated reason, not by lowering the bar.

---

## Flow 4 — Requirement changes mid-project

**Actor:** QA Lead · **Goal:** keep the suite honest when the BRD moves
**Screens:** Requirements → Test cases → Run report

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | The client revises §4.3 — the phone rule now also accepts a `+9665` prefix | — | — |
| 2 | **Re-parse source** with BRD v3.3 | Requirements | FR-010, FR-014 |
| 3 | REQ-014 is flagged as changed; AC2 is updated | Requirements | FR-013 |
| 4 | Regeneration replaces the unedited cases for AC2 and preserves the two manually edited cases | Test cases | FR-036 |
| 5 | Cases whose criterion disappeared are archived, not deleted | Test cases | FR-036 |
| 6 | Run; the matrix reflects the new rule | Run report | FR-050 |
| 7 | Compare with run #1042 — new failures, fixed failures, coverage delta | Runs | FR-053 |

**Exit criteria:** the suite matches the current requirement, and nobody lost hand-written work.

---

## Flow 5 — Gate a pull request

**Actor:** DevOps + CI runner · **Goal:** stop a regression before merge
**Screens:** Integrations → (CI) → Run report

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Connect GitHub Actions | Integrations | FR-061 |
| 2 | Set the gate: minimum coverage 80%, maximum new failures 0, block on *P0 regressions only* | Integrations | FR-061 |
| 3 | Copy the step definition into the workflow | Integrations | FR-061 |
| 4 | A pull request triggers a run on the `ci` environment | CI | FR-040 |
| 5 | Coverage drops to 78% — below the threshold | CI | FR-050 |
| 6 | The job exits non-zero and names REQ-019 in its output | CI | FR-061 |
| 7 | The developer opens the linked report and sees the regression | Run report | FR-052, FR-053 |

**Alternate path:** the gate passes; the run still appears in the runs list and the trend chart.

**Exit criteria:** a merge is blocked by a named requirement, not an opaque score.

---

## Flow 6 — Nightly unattended run and morning triage

**Actor:** Scheduler → QA Lead · **Goal:** start the day knowing what moved
**Screens:** Settings → Dashboard → Run report

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Enable nightly scheduling at 02:00 AST on `staging` | Settings | FR-060 |
| 2 | The scheduler starts the run; overlapping runs are queued | — | FR-060 |
| 3 | In the morning, the dashboard shows coverage 86% (+2 pts) and the trend for the last 14 runs | Dashboard | FR-054 |
| 4 | **Regression watch** lists a requirement that was verified yesterday and failed tonight | Dashboard | FR-062 |
| 5 | Open the run report and triage | Run report | FR-052 |

**Exit criteria:** overnight movement is visible in one screen without opening a report.

---

## Flow 7 — Prepare an acceptance pack for the client

**Actor:** Delivery Manager · **Goal:** an artefact the client can sign
**Screens:** Run report → export

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Open the latest passing run | Runs | FR-053 |
| 2 | Open the **Traceability** tab and confirm every requirement has a verdict | Run report | FR-050 |
| 3 | Confirm the gap list is empty or that each gap has an agreed reason | Run report | FR-051 |
| 4 | **Export PDF / XLSX**, report language *bilingual (AR + EN)* | Run report | FR-071 |
| 5 | The export carries the matrix, failures and gaps, with run ID, environment, branch and timestamp on every page | — | FR-071 |

**Exit criteria:** the client receives requirement-level evidence, in both languages, generated rather than assembled.

---

## Flow 8 — Security review before deployment

**Actor:** Security officer · **Goal:** approve the product for the network
**Screens:** Settings

| # | Step | Screen | Features |
|---|---|---|---|
| 1 | Confirm **On-premise mode** is on — no outbound calls | Settings | FR-081 |
| 2 | Confirm **Air-gapped model runtime** is on — parsing runs locally | Settings | FR-081 |
| 3 | Confirm **Telemetry** is off | Settings | FR-081 |
| 4 | Review the vault: names and rotation dates only, no values | Settings | FR-083 |
| 5 | Review roles: four roles, engineer cannot edit requirements, viewer has no vault access | Settings | FR-080 |
| 6 | Review the audit log and set retention to 90 days, immutable | Settings | FR-082 |
| 7 | Export the audit log for the review record | Settings | FR-082 |

**Exit criteria:** every claim in the security questionnaire is verifiable from one screen.

---

## Cross-flow states

| State | Where it appears | Behaviour |
|---|---|---|
| **Empty** — no runs yet | Dashboard, Runs | Explain the first step and link to New run |
| **Empty** — no requirements | Requirements | Offer upload, Confluence import and paste |
| **Loading** — run in progress | Run report | Show the current layer (discovering / generating / executing) with counts so far |
| **Partial** — discovery incomplete | API surface | Show what was found and name what was not |
| **Error** — credential rejected | New run | Fail before fixtures; no partial state; the vault entry is named |
| **Stale** — source document changed | Requirements | Flag affected requirements; offer re-parse |
