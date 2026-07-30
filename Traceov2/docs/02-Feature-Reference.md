# Feature Reference — Traceo

**Version 2.0 · 37 features · 8 capability groups · all 37 shipped**

Every capability in Traceo carries a stable reference ID. The same ID appears beside the feature in the interface, in the BRD, in the SRS and in acceptance criteria — so a conversation about **FR-035** means one thing everywhere.

## How to read an entry

| Field | Meaning |
|---|---|
| **Ref** | Stable identifier. Never reused, never renumbered. |
| **Group** | Which layer of the pipeline the feature belongs to. |
| **Screen** | Where the feature is exercised in the interface. |
| **Priority** | P0 must ship · P1 should ship · P2 may ship |
| **Status** | Shipped (implemented and tested in the codebase) |
| **Satisfies** | The business requirement in `01-BRD-Traceo.md` this feature serves. |
| **Depends on** | Features that must exist for this one to function. |

## Numbering scheme

| Range | Group |
|---|---|
| FR-010 … FR-019 | Layer 1 — Parser |
| FR-020 … FR-029 | Layer 2 — Discovery |
| FR-030 … FR-039 | Layer 3 — Generator |
| FR-040 … FR-049 | Layer 4 — Execution |
| FR-050 … FR-059 | Layer 5 — Reporting |
| FR-060 … FR-069 | Automation |
| FR-070 … FR-079 | Integrations |
| FR-080 … FR-089 | Platform |

## Index

| Ref | Feature | Group | Screen | Pri | Status |
|---|---|---|---|---|---|
| FR-010 | Requirements ingestion | Parser | New run | P0 | Shipped |
| FR-011 | Confluence import | Parser | Integrations | P1 | Shipped |
| FR-012 | Arabic requirement parsing | Parser | Requirements | P0 | Shipped |
| FR-013 | Acceptance-criteria extraction | Parser | Requirements | P0 | Shipped |
| FR-014 | Source traceback | Parser | Requirements | P1 | Shipped |
| FR-020 | OpenAPI discovery | Discovery | API surface | P0 | Shipped |
| FR-021 | Traffic-capture discovery | Discovery | API surface | P0 | Shipped |
| FR-022 | DOM crawl | Discovery | API surface | P1 | Shipped |
| FR-023 | Postman import | Discovery | New run | P2 | Shipped |
| FR-024 | Endpoint coverage map | Discovery | API surface | P1 | Shipped |
| FR-030 | Boundary value analysis | Generator | New run | P0 | Shipped |
| FR-031 | Equivalence partitioning | Generator | New run | P0 | Shipped |
| FR-032 | Decision tables | Generator | New run | P1 | Shipped |
| FR-033 | Negative & auth cases | Generator | New run | P0 | Shipped |
| FR-034 | RTL / localisation checks | Generator | New run | P1 | Shipped |
| FR-035 | Grounded generation | Generator | Test cases | P0 | Shipped |
| FR-036 | Test case library | Generator | Test cases | P1 | Shipped |
| FR-040 | HTTP execution engine | Execution | Report | P0 | Shipped |
| FR-041 | Schema assertions | Execution | Report | P0 | Shipped |
| FR-042 | Business-rule assertions | Execution | Report | P0 | Shipped |
| FR-043 | Test data lifecycle | Execution | Report | P1 | Shipped |
| FR-044 | Performance capture | Execution | Report | P2 | Shipped |
| FR-050 | Traceability matrix | Reporting | Report | P0 | Shipped |
| FR-051 | Coverage gap detection | Reporting | Report | P0 | Shipped |
| FR-052 | Reproducible bug reports | Reporting | Report | P0 | Shipped |
| FR-053 | Run comparison | Reporting | Runs | P1 | Shipped |
| FR-054 | Coverage trend | Reporting | Dashboard | P1 | Shipped |
| FR-060 | Scheduled runs | Automation | Settings | P1 | Shipped |
| FR-061 | CI/CD gate | Automation | Integrations | P0 | Shipped |
| FR-062 | Regression watch | Automation | Dashboard | P1 | Shipped |
| FR-070 | Jira / Xray export | Integrations | Integrations | P0 | Shipped |
| FR-071 | PDF / XLSX report export | Integrations | Report | P1 | Shipped |
| FR-072 | Slack notifications | Integrations | Integrations | P2 | Shipped |
| FR-080 | Role-based access | Platform | Settings | P1 | Shipped |
| FR-081 | On-premise deployment | Platform | Settings | P0 | Shipped |
| FR-082 | Audit log | Platform | Settings | P1 | Shipped |
| FR-083 | Secrets vault | Platform | Settings | P0 | Shipped |

---

# Layer 1 — Parser

## FR-010 · Requirements ingestion

**Screen:** New run · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-01

Upload a PDF, DOCX, Markdown or XLSX requirement document. Traceo extracts each requirement with an ID, description, type and priority.

**Acceptance criteria**

1. PDF, DOCX, MD and XLSX up to 50 MB are accepted; unsupported types are rejected with a named reason.
2. Each extracted requirement carries an ID (from the document where present, generated otherwise), a description, a type (functional / business rule / non-functional / localisation / compliance) and a priority.
3. The extraction result is shown before generation begins and can be corrected by the user.
4. A document that yields zero requirements returns an explanatory empty state, not a silent success.

**Depends on:** —

## FR-011 · Confluence import

**Screen:** Integrations · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-01, BR-09

Pull requirement pages from a Confluence space instead of uploading a file.

**Acceptance criteria**

1. A space can be connected with a token and a space key; pages are listed for selection.
2. Selected pages are parsed by the same pipeline as uploaded documents.
3. Re-import detects changed pages and flags affected requirements as stale.

**Depends on:** FR-010

## FR-012 · Arabic requirement parsing

**Screen:** Requirements · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-01, BR-05

Arabic RFPs and BRDs are parsed with the same fidelity as English, including RTL text and mixed-direction content.

**Acceptance criteria**

1. Extraction accuracy on an Arabic document is within 5 percentage points of the English baseline.
2. Mixed-direction paragraphs (Arabic prose with Latin identifiers or digits) preserve both segments intact.
3. Arabic requirement text renders RTL throughout the interface and in exports.
4. Hijri dates appearing in requirements are recognised and normalised alongside Gregorian.

**Depends on:** FR-010

## FR-013 · Acceptance-criteria extraction

**Screen:** Requirements · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-01, BR-03

Each requirement is decomposed into atomic, testable acceptance criteria.

**Acceptance criteria**

1. Every criterion is a single verifiable statement; compound statements are split.
2. Criteria are numbered per requirement (AC1, AC2 …) and are stable across re-parses.
3. A requirement with no derivable criteria is flagged for human input rather than silently accepted.
4. Each criterion is the unit that generation targets and that the matrix reports against.

**Depends on:** FR-010

## FR-014 · Source traceback

**Screen:** Requirements · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-01

Every requirement keeps a link back to its source document and paragraph.

**Acceptance criteria**

1. Each requirement records document name, version and section reference (e.g. `BRD §4.3`).
2. The source paragraph can be viewed without leaving the requirements screen.
3. Traceback survives re-parsing of an updated document; a moved paragraph updates its reference.

**Depends on:** FR-010

---

# Layer 2 — Discovery

## FR-020 · OpenAPI discovery

**Screen:** API surface · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-02

When a specification exists, endpoints, parameters and schemas are read directly.

**Acceptance criteria**

1. OpenAPI 3.0 and 3.1 documents are accepted by upload or URL.
2. Paths, methods, parameters, request and response schemas and auth schemes are imported.
3. Endpoints declared in the spec but never observed in traffic are labelled *declared but never seen*.

**Depends on:** —

## FR-021 · Traffic-capture discovery

**Screen:** API surface · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-02

A headless browser drives the application; the endpoint map is built from observed network traffic.

**Acceptance criteria**

1. Requests are recorded with method, path template, parameters and observed response shapes.
2. Path parameters are generalised into templates (`/orders/8812` → `/orders/{id}`).
3. Each endpoint records how many times it was observed.
4. Credentials and tokens in captured traffic are redacted before storage.

**Depends on:** FR-083

## FR-022 · DOM crawl

**Screen:** API surface · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-02

Forms, inputs, buttons and client-side validation rules are collected from the rendered DOM.

**Acceptance criteria**

1. Form fields are captured with name, type, required flag and any pattern attribute.
2. Client-side validation patterns become candidate boundary and equivalence inputs.
3. RTL containers and locale switches are detected and reported.

**Depends on:** FR-021

## FR-023 · Postman import

**Screen:** New run · **Priority:** P2 · **Status:** Shipped · **Satisfies:** BR-02

An existing collection can be imported and treated as the discovered surface.

**Acceptance criteria**

1. Collection v2.1 files are accepted; folders map to endpoint groups.
2. Environment variables are resolved or reported as unresolved.
3. Imported endpoints are marked with source *postman* in the coverage map.

**Depends on:** FR-024

## FR-024 · Endpoint coverage map

**Screen:** API surface · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-02, BR-03

Every discovered endpoint shows how many tests hit it and how much of it is covered.

**Acceptance criteria**

1. Each endpoint row shows method, path, times seen, test count, coverage percentage and discovery source.
2. Coverage is computed from parameters and response branches exercised, not request count.
3. Endpoints at 0% are visually distinct and link to the requirements that would need them.

**Depends on:** FR-020, FR-021, FR-035

---

# Layer 3 — Generator

## FR-030 · Boundary value analysis

**Screen:** New run · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-02

Minimum, maximum and one past each edge are generated for every bounded field.

**Acceptance criteria**

1. For each numeric or length-bounded field: min, min−1, max, max+1 and a nominal value are generated.
2. Bounds are taken from the schema, the acceptance criteria or the DOM pattern, in that order of precedence.
3. Each case names the bound it exercises and the criterion it derives from.

**Depends on:** FR-013, FR-024

## FR-031 · Equivalence partitioning

**Screen:** New run · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-02

One representative case per valid and invalid class.

**Acceptance criteria**

1. Classes are derived from enumerations, formats and stated rules.
2. Exactly one representative per class is generated by default; the count is configurable.
3. Invalid-class cases assert the documented rejection behaviour, not merely a non-2xx status.

**Depends on:** FR-013, FR-024

## FR-032 · Decision tables

**Screen:** New run · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-02

State and rule combinations are enumerated for business-rule requirements.

**Acceptance criteria**

1. Conditions and outcomes are extracted from the acceptance criteria into a table.
2. Every reachable combination is generated; unreachable combinations are reported, not generated.
3. Where combinations exceed a configurable ceiling, pairwise reduction is applied and disclosed.

**Depends on:** FR-013

## FR-033 · Negative & auth cases

**Screen:** New run · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-02

Missing token, wrong role, malformed body and injection-shaped payloads.

**Acceptance criteria**

1. Every endpoint receives: no credential, expired credential, wrong-role credential, malformed JSON and an oversized payload.
2. Injection-shaped strings assert safe handling; no case attempts to exploit or persist damage.
3. Expected behaviour is taken from the requirement where stated, and from HTTP semantics otherwise.

**Depends on:** FR-024, FR-083

## FR-034 · RTL / localisation checks

**Screen:** New run · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-05

Arabic payloads, encoding round-trips and right-to-left rendering assertions.

**Acceptance criteria**

1. Any field accepting free text receives an Arabic value and is asserted to round-trip byte-identically.
2. Responses carrying user-facing text are asserted to declare a UTF-8 charset.
3. Where a rendered document is reachable, direction and numeral handling are asserted.
4. Localisation cases are generated by default for every requirement with user-facing text.

**Depends on:** FR-012, FR-031

## FR-035 · Grounded generation

**Screen:** Test cases · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-02, BR-10

Generation is restricted to discovered endpoints; every case is schema-validated before it can run.

**Acceptance criteria**

1. A case referencing an endpoint not present in the surface is rejected at generation time.
2. Every request body validates against the discovered or declared schema before execution.
3. Each case records the endpoint, the technique and the acceptance criterion it derives from.
4. Zero generated cases target a non-existent path in any run.

**Depends on:** FR-024, FR-013

## FR-036 · Test case library

**Screen:** Test cases · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-10

All generated cases are browsable, filterable and editable; manual edits survive regeneration.

**Acceptance criteria**

1. Cases are filterable by requirement, endpoint, technique and last result.
2. A case can be edited, disabled or annotated; edited cases are marked as manually modified.
3. Regeneration after a requirement change preserves manual edits and reports which cases changed.
4. A case can be added by hand and participates in the matrix like a generated one.

**Depends on:** FR-035

---

# Layer 4 — Execution

## FR-040 · HTTP execution engine

**Screen:** Report · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-04

Isolated container per run, configurable concurrency, session reuse after one authentication.

**Acceptance criteria**

1. Each run executes in an isolated container that is destroyed on completion.
2. Concurrency is configurable from 1 to 32 and is respected under load.
3. Authentication is performed once and the session reused across cases where the auth scheme permits.
4. A run can be cancelled mid-flight; teardown still executes.

**Depends on:** FR-083, FR-043

## FR-041 · Schema assertions

**Screen:** Report · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-04

The response body is validated against the discovered or declared schema.

**Acceptance criteria**

1. Every response is validated; violations are reported with the failing JSON path.
2. Where no schema exists, the shape observed during discovery is used and labelled as inferred.
3. A schema violation fails the case even when the status code is as expected.

**Depends on:** FR-020, FR-021

## FR-042 · Business-rule assertions

**Screen:** Report · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-04, BR-03

Assertions derived from acceptance criteria, not just status codes.

**Acceptance criteria**

1. Each case asserts the outcome its criterion states, in the criterion's own terms.
2. The failure message names the criterion, the expected value and the actual value.
3. A case passing on status code but violating its criterion is reported as failed.

**Depends on:** FR-013, FR-035

## FR-043 · Test data lifecycle

**Screen:** Report · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-04

Fixtures are created before the suite and torn down after, per run.

**Acceptance criteria**

1. Fixtures are namespaced by run ID and are identifiable in the target system.
2. Teardown runs on success, failure and cancellation.
3. Any fixture that cannot be removed is reported explicitly at the end of the run.

**Depends on:** FR-040

## FR-044 · Performance capture

**Screen:** Report · **Priority:** P2 · **Status:** Shipped · **Satisfies:** BR-04

Latency recorded per case; p95 reported per endpoint.

**Acceptance criteria**

1. Wall-clock latency is recorded for every case.
2. p50, p95 and max are reported per endpoint for the run.
3. A configurable latency threshold can fail a case.

**Depends on:** FR-040

---

# Layer 5 — Reporting

## FR-050 · Traceability matrix

**Screen:** Report · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-03

Requirement → test cases → verdict, always current, exportable.

**Acceptance criteria**

1. Every requirement in the workspace appears with criteria count, case count, pass/fail counts, coverage and verdict.
2. The matrix regenerates on every run and on every requirement change, with no manual step.
3. Any row can be expanded to the individual cases and their verdicts.
4. The matrix exports to PDF and XLSX with the same content.

**Depends on:** FR-013, FR-035, FR-042

## FR-051 · Coverage gap detection

**Screen:** Report · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-03

Requirements with zero tests are surfaced with a reason.

**Acceptance criteria**

1. Every requirement with no linked case appears as a gap.
2. Each gap states why generation was not possible (no reachable endpoint, ambiguous criteria, unsupported technique).
3. Each gap offers the next action — supply a spec, add an endpoint, write a case by hand.
4. Gaps are counted on the dashboard and in the run report header.

**Depends on:** FR-050, FR-024

## FR-052 · Reproducible bug reports

**Screen:** Report · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-04

Steps, request log, response body and diff — enough for a developer to reproduce without asking.

**Acceptance criteria**

1. Each failure reports numbered reproduction steps in plain language.
2. The request issued and the response received are captured verbatim, with credentials redacted.
3. The failing assertion is shown with expected and actual values side by side.
4. Severity is assigned from the requirement priority and the failure class.

**Depends on:** FR-041, FR-042

## FR-053 · Run comparison

**Screen:** Runs · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-06

Diff two runs: new failures, fixed failures, coverage delta.

**Acceptance criteria**

1. Any two runs of the same project can be compared.
2. The diff lists newly failing cases, newly passing cases and cases whose verdict is unchanged.
3. Coverage delta is reported at requirement and endpoint level.

**Depends on:** FR-050

## FR-054 · Coverage trend

**Screen:** Dashboard · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-06

Requirement coverage over time, per project and per branch.

**Acceptance criteria**

1. The last 14 runs are charted with the coverage value of each.
2. The series can be filtered by branch and environment.
3. A drop greater than a configurable threshold is visually marked.

**Depends on:** FR-050

---

# Automation

## FR-060 · Scheduled runs

**Screen:** Settings · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-06

Cron-style scheduling per environment.

**Acceptance criteria**

1. A schedule can be set per project and environment with a timezone (default AST).
2. A scheduled run behaves identically to a manual one and appears in the runs list with source *scheduler*.
3. Overlapping runs are queued, not executed concurrently against the same environment.

**Depends on:** FR-040

## FR-061 · CI/CD gate

**Screen:** Integrations · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-06

Fail the pipeline when coverage drops or a P0 requirement regresses.

**Acceptance criteria**

1. Minimum coverage, maximum new failures and block-on policy are configurable.
2. The job exits non-zero when a threshold is breached and names the breaching requirement in its output.
3. GitHub Actions and GitLab CI are supported with a documented step definition.
4. A gate failure links back to the run report.

**Depends on:** FR-050, FR-053

## FR-062 · Regression watch

**Screen:** Dashboard · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-06

Alert when a previously passing requirement starts failing.

**Acceptance criteria**

1. A requirement transitioning from verified to failed is surfaced on the dashboard.
2. The entry names the requirement, the case, the bug and the severity.
3. The watch list is ordered by severity and then by recency.

**Depends on:** FR-053

---

# Integrations

## FR-070 · Jira / Xray export

**Screen:** Integrations · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-09

Push failures as issues and sync executions to Xray test runs.

**Acceptance criteria**

1. A failure exports to a configured Jira project in one action, carrying steps, evidence and severity.
2. Re-exporting an already-exported failure updates the existing issue instead of creating a duplicate.
3. Where Xray is present, test executions are created and verdicts synced.
4. The created issue links back to the Traceo run and case.

**Depends on:** FR-052

## FR-071 · PDF / XLSX report export

**Screen:** Report · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-03, BR-09

A client-ready traceability report in one action.

**Acceptance criteria**

1. Export produces the matrix, the failure list and the gap list.
2. Arabic content renders RTL correctly in both formats.
3. Bilingual export (AR + EN) is selectable.
4. The export records run ID, environment, branch and timestamp on every page.

**Depends on:** FR-050, FR-051, FR-052

## FR-072 · Slack notifications

**Screen:** Integrations · **Priority:** P2 · **Status:** Shipped · **Satisfies:** BR-09

Run summaries and failure alerts to a channel.

**Acceptance criteria**

1. A channel can be connected per project.
2. Run completion posts a summary with counts and a link.
3. Alert level (all runs / failures only / regressions only) is configurable.

**Depends on:** FR-062

---

# Platform

## FR-080 · Role-based access

**Screen:** Settings · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-08

Owner, QA lead, engineer and viewer roles.

**Acceptance criteria**

1. Four roles are enforced server-side, not only in the interface.
2. Engineers can run suites and view reports but cannot edit requirements.
3. Viewers have read-only access to reports and no access to the vault.
4. Role changes take effect on the next request, not the next session.

**Depends on:** —

## FR-081 · On-premise deployment

**Screen:** Settings · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-07

The full stack runs inside the customer network; no data leaves the Kingdom.

**Acceptance criteria**

1. A complete run — parse, discover, generate, execute, report — succeeds on an air-gapped host.
2. Egress monitoring records zero outbound connections in on-premise mode.
3. Requirement parsing runs on a local model runtime.
4. Telemetry is off by default and cannot be enabled without an explicit administrator action.

**Depends on:** FR-083

## FR-082 · Audit log

**Screen:** Settings · **Priority:** P1 · **Status:** Shipped · **Satisfies:** BR-08

Every configuration change and run is logged and immutable.

**Acceptance criteria**

1. Actor, action, target and timestamp are recorded for every configuration change and run.
2. Entries cannot be edited or deleted before their retention date.
3. Retention is configurable; the default is 90 days.
4. The log is exportable for audit.

**Depends on:** FR-080

## FR-083 · Secrets vault

**Screen:** Settings · **Priority:** P0 · **Status:** Shipped · **Satisfies:** BR-07, BR-08

Credentials for the system under test are encrypted at rest and never logged.

**Acceptance criteria**

1. Secrets are encrypted at rest and decrypted only inside the run container.
2. Secret values are never written to logs, reports, exports or captured traffic.
3. The interface shows only the secret name and last rotation date.
4. Rotating a secret takes effect on the next run without editing any case.

**Depends on:** —

---

## Coverage of business requirements

| BR | Satisfied by |
|---|---|
| BR-01 Requirements readable, AR + EN | FR-010, FR-011, FR-012, FR-013, FR-014 |
| BR-02 Generation grounded in the real system | FR-020, FR-021, FR-022, FR-023, FR-030, FR-031, FR-032, FR-033, FR-035 |
| BR-03 Coverage demonstrable at requirement level | FR-024, FR-050, FR-051, FR-071 |
| BR-04 Defects reproducible | FR-040, FR-041, FR-042, FR-043, FR-052 |
| BR-05 Arabic and RTL tested by default | FR-012, FR-034 |
| BR-06 Unattended runs and delivery gate | FR-053, FR-054, FR-060, FR-061, FR-062 |
| BR-07 Deployable inside the customer network | FR-081, FR-082, FR-083 |
| BR-08 Access and changes governed | FR-080, FR-082 |
| BR-09 Results land where the team works | FR-011, FR-070, FR-071 |
| BR-10 Generated cases remain the team's property | FR-035, FR-036 |
