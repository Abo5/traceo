# Business Requirements Document — Traceo

**Product:** Traceo — requirement → test → result
**Version:** 2.0 · **Date:** 26 July 2026 · **Status:** For review
**Owner:** Product · **Audience:** Sponsor, delivery leads, QA leads, engineering, security

---

## 1. Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.9 | 12 Jun 2026 | Product | First draft, single-screen concept |
| 1.0 | 28 Jun 2026 | Product | Approved for pilot |
| 2.0 | 26 Jul 2026 | Product | Expanded scope: workspace application, 11 screens, 37 referenced features, on-premise deployment |

**Related documents**

- `02-Feature-Reference.md` — the FR catalogue every requirement in this BRD points to
- `03-SRS.md` — system and functional specification
- `04-User-Flows.md` — end-to-end flows
- `05-Design-Spec.md` — design system and layout rules
- `index.html` — interactive design of all 11 screens

---

## 2. Executive summary

Software testing tools verify that code behaves as written. Almost none verify that the code behaves as the **requirement** says it should. The gap between a signed BRD and an executed test suite is closed manually — by a QA engineer reading a document, writing cases, and maintaining a traceability spreadsheet that is stale within a week.

Traceo closes that gap automatically. It reads the requirement document, discovers the real API surface of the system under test, generates test cases grounded in both, executes them, and produces a traceability matrix that maps every requirement to the cases that prove it and the verdict they returned.

The commercial target is Saudi delivery organisations — system integrators, government programme vendors, and banking/fintech QA teams — where acceptance is contractual, deliverables are audited, and requirement documents are frequently in Arabic. Traceo runs on-premise so that requirement documents, credentials and captured traffic never leave the customer network.

---

## 3. Business context

### 3.1 The problem

| # | Problem | Business consequence |
|---|---|---|
| P1 | Requirements and test suites drift apart. A requirement changes in the BRD; the suite does not. | Defects surface in UAT or production, where the cost of a fix is 10–30× the cost at test design. |
| P2 | Coverage is asserted, not evidenced. "We tested it" is an opinion until you can point at the requirement and the case. | Acceptance disputes, delayed sign-off, retained payment milestones. |
| P3 | Test design is the bottleneck. Writing boundary, negative and rule-combination cases by hand takes days per module. | Regression suites are thin; teams test the happy path and ship the rest. |
| P4 | Arabic and RTL behaviour is an afterthought. | Encoding, direction and Hijri-date defects reach production because nobody generated a case for them. |
| P5 | Bug reports are not reproducible. | ~30% of tickets return as "cannot reproduce", costing a full extra cycle. |
| P6 | Cloud QA tooling is not acceptable to regulated customers. | Deals stall at security review; requirement documents cannot legally leave the network. |

### 3.2 Why now

- Requirement documents are increasingly machine-readable (structured BRDs, Confluence, Jira epics).
- API-first architectures make the system's true surface discoverable from traffic and specs.
- Saudi data-residency expectations make an on-premise, air-gapped QA product a differentiator rather than a limitation.

### 3.3 Opportunity

A QA lead running a 6-requirement module today spends roughly 4–5 days on test design and maintains the traceability matrix by hand. Traceo produced 218 cases and an 86% coverage matrix for the same module in 6 minutes 12 seconds. The value is not "faster testing" — it is **evidence of coverage that a client can sign**.

---

## 4. Objectives and success metrics

| # | Objective | Metric | Baseline | Target (12 months) |
|---|---|---|---|---|
| O1 | Cut test-design effort | Hours to a runnable suite for one module | 32–40 h | ≤ 1 h |
| O2 | Make coverage evidential | % of requirements with a linked, executed case | ~45% (spreadsheet) | ≥ 90% |
| O3 | Catch requirement regressions before UAT | Defects found by Traceo vs. found in UAT | 0 / 100% | ≥ 60% / ≤ 40% |
| O4 | Make defects reproducible first time | "Cannot reproduce" ticket rate | ~30% | ≤ 8% |
| O5 | Pass security review | Deals lost at security review | — | 0 (on-premise SKU) |
| O6 | Serve Arabic requirement documents | Parsing fidelity on Arabic BRDs vs. English | — | Parity (± 5% extraction accuracy) |
| O7 | Commercial | Paying workspaces | 0 | 25 |

---

## 5. Scope

### 5.1 In scope (release 2.0)

| Area | Included | Feature refs |
|---|---|---|
| Requirement ingestion | PDF / DOCX / MD / XLSX upload, Confluence import, Arabic parsing, acceptance-criteria extraction, source traceback | FR-010 … FR-014 |
| API discovery | OpenAPI import, traffic capture, DOM crawl, Postman import, endpoint coverage map | FR-020 … FR-024 |
| Test generation | Boundary, equivalence, decision tables, negative & auth, RTL/localisation, grounded generation, editable case library | FR-030 … FR-036 |
| Execution | HTTP engine, schema assertions, business-rule assertions, test-data lifecycle | FR-040 … FR-043 |
| Reporting | Traceability matrix, coverage-gap detection, reproducible bug reports, run comparison, coverage trend | FR-050 … FR-054 |
| Automation | Scheduled runs, CI/CD gate, regression watch | FR-060 … FR-062 |
| Integrations | Jira/Xray, PDF/XLSX export | FR-070, FR-071 |
| Platform | RBAC, on-premise deployment, audit log, secrets vault | FR-080 … FR-083 |

### 5.2 Deferred (post-2.0)

| Item | Ref | Rationale |
|---|---|---|
| Performance capture / p95 per endpoint | FR-044 | Not required for acceptance evidence; competing with load-testing tools |
| Slack notifications | FR-072 | Jira and CI cover the primary alerting path for pilot customers |

### 5.3 Explicitly out of scope

- UI/visual regression testing and screenshot diffing.
- Load, stress and soak testing.
- Security penetration testing (Traceo generates injection-*shaped* negative cases, not exploits).
- Mobile-native (iOS/Android) test execution.
- Writing or modifying the customer's application code.

---

## 6. Stakeholders

| Stakeholder | Interest | What they need from Traceo |
|---|---|---|
| **QA Lead** (primary user) | Owns coverage and sign-off evidence | Generate a suite from the BRD, defend coverage in a review meeting |
| **QA Engineer** | Executes and maintains cases | Edit generated cases without losing edits on regeneration |
| **Developer** | Fixes defects | A bug report with steps, request, response and diff — enough to reproduce without asking |
| **Delivery / Project Manager** | Milestone acceptance | A matrix the client signs; a gap list that is a work item, not a surprise |
| **Client / Sponsor** | Contractual acceptance | Requirement-level evidence in a report, bilingual |
| **Security / Compliance** | Data residency, auditability | On-premise deployment, immutable audit log, secrets never logged |
| **DevOps** | Pipeline health | A gate that fails a build on regression, configurable thresholds |

---

## 7. Business requirements

Each business requirement (BR) states a business need and points to the features that satisfy it. Feature detail lives in `02-Feature-Reference.md`.

### BR-01 — Requirements must be readable by the system, in Arabic and English

The product shall ingest a requirement document in the formats delivery teams actually produce and decompose it into atomic, testable acceptance criteria, preserving a link to the source paragraph.

- **Satisfied by:** FR-010, FR-011, FR-012, FR-013, FR-014
- **Acceptance:** A 40-page Arabic BRD yields requirements with ID, description, type, priority and ≥ 3 acceptance criteria each, with ≥ 90% extraction accuracy against a human baseline.
- **Priority:** Must

### BR-02 — Test generation must be grounded in the real system, not imagined

The product shall discover the actual API surface before generating, and shall refuse to generate a case against an endpoint it has not observed or been given.

- **Satisfied by:** FR-020, FR-021, FR-022, FR-023, FR-035
- **Acceptance:** 100% of generated cases reference a discovered endpoint; zero cases target a non-existent path.
- **Priority:** Must

### BR-03 — Coverage must be demonstrable at requirement level

The product shall maintain, at all times, a matrix of requirement → test cases → verdict, and shall surface any requirement with zero linked cases as an explicit gap with a stated reason.

- **Satisfied by:** FR-050, FR-051, FR-024
- **Acceptance:** Every requirement in the workspace appears in the matrix with either a verdict or a gap reason; the matrix is exportable to PDF and XLSX.
- **Priority:** Must

### BR-04 — Defects must be reproducible without a conversation

Every failure shall be reported with steps, the request issued, the response received, the assertion that failed and the expected value.

- **Satisfied by:** FR-052, FR-041, FR-042, FR-070
- **Acceptance:** A developer unfamiliar with the run can reproduce ≥ 90% of reported defects from the report alone.
- **Priority:** Must

### BR-05 — Arabic and RTL behaviour must be tested by default

The product shall generate localisation cases — Arabic payloads, encoding round-trips, RTL rendering assertions and mixed-direction content — as a standard technique, not an opt-in.

- **Satisfied by:** FR-034, FR-012
- **Acceptance:** For any requirement with user-facing text, at least one localisation case is generated automatically.
- **Priority:** Must

### BR-06 — The suite must run unattended and gate delivery

The product shall run on a schedule and inside CI, and shall fail a pipeline when coverage drops below a threshold or a P0 requirement regresses.

- **Satisfied by:** FR-060, FR-061, FR-062, FR-053, FR-054
- **Acceptance:** A GitHub Actions or GitLab CI job fails deterministically when the configured threshold is breached, with the breaching requirement named in the job output.
- **Priority:** Must

### BR-07 — The product must be deployable inside the customer network

The full stack — including requirement parsing — shall run on-premise with no outbound network dependency.

- **Satisfied by:** FR-081, FR-083, FR-082
- **Acceptance:** A complete run executes successfully on an air-gapped host; egress monitoring records zero outbound connections.
- **Priority:** Must

### BR-08 — Access and changes must be governed

The product shall enforce role-based access and record every configuration change and run in an immutable log retained for a configurable period.

- **Satisfied by:** FR-080, FR-082
- **Acceptance:** Four roles enforced; audit entries cannot be edited or deleted before their retention date.
- **Priority:** Should

### BR-09 — Results must land where the team already works

The product shall push failures to the issue tracker and sync executions to the test-management tool.

- **Satisfied by:** FR-070, FR-071, FR-011
- **Acceptance:** A failure exports to Jira with steps and evidence in one action; Xray test executions reflect the run verdicts.
- **Priority:** Should

### BR-10 — Generated cases must remain the team's property

Engineers shall be able to edit, disable and annotate generated cases, and those edits shall survive regeneration.

- **Satisfied by:** FR-036, FR-035
- **Acceptance:** After a regeneration triggered by a requirement change, previously edited cases retain their edits and are flagged as manually modified.
- **Priority:** Should

---

## 8. Business process — before and after

**Before**

1. QA lead reads the BRD and writes a test plan in a document. *(2 days)*
2. QA engineers write cases in a spreadsheet or test-management tool. *(3 days)*
3. Cases are automated selectively — usually the happy path. *(5 days)*
4. Traceability is maintained by hand and goes stale. *(ongoing)*
5. Coverage is defended in a meeting with a spreadsheet screenshot.

**After**

1. QA lead uploads the BRD and points Traceo at the environment. *(10 minutes)*
2. Traceo extracts requirements, discovers the surface, generates and runs the suite. *(~6 minutes)*
3. QA lead reviews failures and gaps, edits or adds cases where judgement is required. *(2 hours)*
4. The matrix regenerates on every run and on every requirement change. *(automatic)*
5. Coverage is defended with a live, exportable, requirement-level matrix.

---

## 9. Commercial model

| Plan | Price | Projects | Included |
|---|---|---|---|
| Team | SAR 4,900 / month | up to 3 | 5 QA seats, 200 runs/month, Jira + GitHub Actions, KSA region, email support |
| Business | SAR 12,500 / month | up to 12 | 20 QA seats, unlimited runs, all integrations, on-premise option, named CSM, 99.9% SLA |
| Enterprise | Custom, annual | unlimited | Unlimited seats, air-gapped deployment, custom techniques, security-review support, 24/7 support |

Pricing is per project rather than per test, so that generating more cases never costs the customer more — removing the incentive to under-test.

---

## 10. Assumptions

| # | Assumption | If false |
|---|---|---|
| A1 | Requirement documents are structured enough to extract IDs and criteria (headings, numbering, tables). | Extraction accuracy drops; manual mapping UI is required. |
| A2 | The system under test exposes an HTTP API that carries the business rules. | Coverage is limited to what the UI reveals via DOM crawl. |
| A3 | A non-production environment with representative data is available. | Test-data lifecycle (FR-043) must create far more fixtures, extending run time. |
| A4 | Customers accept an isolated container running inside their network. | On-premise SKU is not viable; cloud-only, narrowing the addressable market. |
| A5 | A local model of sufficient quality can run air-gapped for requirement parsing. | Air-gapped deployments lose Arabic parsing fidelity. |

---

## 11. Constraints

| # | Constraint | Impact |
|---|---|---|
| C1 | No customer data may leave the customer network in on-premise deployments. | No telemetry by default; no cloud model calls; support diagnostics must be exportable bundles. |
| C2 | The product must not modify the system under test beyond its own fixtures. | Destructive techniques are excluded; teardown must be reliable. |
| C3 | Arabic must be first-class in interface, parsing and reporting. | RTL layout, bilingual export and Arabic typography are release blockers, not enhancements. |
| C4 | Credentials are held on the customer's behalf. | Vault encryption at rest, never logged, never rendered in reports. |

---

## 12. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Generated cases are plausible but wrong, eroding trust after one bad run. | M | H | Grounded generation (FR-035): schema-validate every case before it can run; show the endpoint and criterion each case derives from. |
| R2 | Requirement extraction misses criteria in unstructured documents. | H | M | Source traceback (FR-014) so a human can verify; manual add/edit of requirements; extraction confidence surfaced in the UI. |
| R3 | Traffic capture misses endpoints reachable only through rare flows. | M | M | Three discovery modes (spec, traffic, DOM) plus Postman import; "declared but never seen" is reported explicitly. |
| R4 | Fixtures leak into a shared environment. | M | H | Per-run isolated container and mandatory teardown (FR-043); fixtures namespaced per run ID. |
| R5 | Security review blocks the deal on model usage. | M | H | Air-gapped runtime; documented data-flow diagram; no outbound egress in on-prem mode (FR-081). |
| R6 | Customers treat 86% coverage as "done" and stop thinking. | M | M | Gaps are shown as first-class work items with reasons, not hidden behind a percentage. |
| R7 | Competitor bundles similar generation into an existing test-management suite. | M | H | Differentiate on requirement-level traceability, Arabic parity and on-premise deployment. |

---

## 13. Dependencies

- Issue tracker API access (Jira/Xray or Azure DevOps) for BR-09.
- CI runner with network access to the system under test for BR-06.
- A credential with sufficient rights to exercise the API under test, supplied through the vault.
- Confluence space access where requirement import is used.

---

## 14. Acceptance of this document

| Role | Name | Decision | Date |
|---|---|---|---|
| Product sponsor | | | |
| Delivery lead | | | |
| QA lead | | | |
| Security | | | |

---

*Every FR-### reference in this document resolves to an entry in `02-Feature-Reference.md` and appears beside the corresponding control in the interface design.*
