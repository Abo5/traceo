# Software Requirements Specification — Traceo

**Version 2.0 · 26 July 2026**
Companion to `01-BRD-Traceo.md` (why) and `02-Feature-Reference.md` (what). This document covers **how the system behaves**.

---

## 1. System overview

Traceo is a workspace application with a five-layer processing pipeline. Each layer consumes the output of the previous one and is independently inspectable in the interface.

```
Requirement document ─┐
Confluence page ──────┼─▶ L1 Parser ──────▶ requirements + acceptance criteria
                      ┘                          │
OpenAPI spec ─────────┐                          │
Live traffic ─────────┼─▶ L2 Discovery ──▶ endpoint surface
DOM crawl ────────────┘                          │
Postman collection ───┘                          ▼
                          L3 Generator ──▶ grounded, schema-valid test cases
                                                 │
                                                 ▼
                          L4 Execution ───▶ verdicts + evidence
                                                 │
                                                 ▼
                          L5 Reporting ───▶ matrix · gaps · bug reports · trend
```

**Design rule that governs the whole system:** a test case may only exist if it can name (a) the acceptance criterion it derives from and (b) the discovered endpoint it targets. A case that cannot name both is not generated. This is what makes the matrix trustworthy.

---

## 2. Actors

| Actor | Description |
|---|---|
| QA Lead | Creates runs, edits requirements and cases, exports reports, configures the workspace |
| QA Engineer | Runs suites, edits cases, triages failures |
| Developer | Reads reports and bug detail; no configuration rights |
| Viewer | Read-only reports |
| Scheduler | System actor that starts runs on a cron schedule |
| CI runner | System actor that starts runs and reads the gate verdict |

---

## 3. Information model

| Entity | Key attributes | Relationships |
|---|---|---|
| **Workspace** | name, default environment, interface language, report language, deployment mode | has many Projects |
| **Project** | name, base URL, environments | has many Requirements, Endpoints, Runs |
| **Requirement** | id, title, type, priority, source reference, coverage | has many Criteria, has many Cases |
| **Criterion** | index (AC1…), statement | belongs to Requirement; targeted by Cases |
| **Endpoint** | method, path template, times seen, discovery source, coverage | targeted by Cases |
| **Test case** | id, title, technique, request, assertions, edited flag, last result, latency | belongs to Requirement + Criterion + Endpoint |
| **Run** | id, environment, branch, started, duration, counts, coverage, status | has many Case results, has many Defects |
| **Defect** | id, title, severity, steps, evidence, tags, export state | belongs to Run, Requirement, Case |
| **Integration** | type, state, configuration | belongs to Workspace |
| **Audit entry** | actor, action, target, timestamp | append-only, belongs to Workspace |
| **Secret** | name, encrypted value, last rotation | belongs to Workspace |

**Identifier conventions**

| Prefix | Entity | Example |
|---|---|---|
| `REQ-###` | Requirement | REQ-014 |
| `AC#` | Acceptance criterion (scoped to a requirement) | REQ-014 / AC2 |
| `TC-###` | Test case | TC-102 |
| `BUG-###` | Defect | BUG-141 |
| `#####` | Run | #1042 |
| `FR-###` | Product feature (documentation only) | FR-035 |

---

## 4. Functional specification by layer

### 4.1 Layer 1 — Parser · FR-010 … FR-014

**Inputs:** PDF, DOCX, MD, XLSX (≤ 50 MB); Confluence pages; pasted text.

**Processing**

1. Normalise the document to structured text, preserving headings, numbering, tables and text direction.
2. Segment into candidate requirements using structural signals (numbered headings, "shall/must/يجب" constructions, requirement tables).
3. Classify each requirement: functional · business rule · non-functional · localisation · compliance.
4. Assign priority from an explicit marker where present, from language strength otherwise.
5. Decompose into atomic acceptance criteria; split compound statements.
6. Record a source reference (document, version, section) per requirement.

**Outputs:** Requirements with criteria, types, priorities and traceback references.

**Error handling**

| Condition | Behaviour |
|---|---|
| Unsupported file type | Reject at upload with the accepted list |
| Zero requirements extracted | Explanatory empty state with a "paste requirements" fallback |
| Encrypted or image-only PDF | Reject with a named reason; OCR is not in scope for 2.0 |
| Criteria not derivable for a requirement | Requirement is kept and flagged *needs human criteria* |

### 4.2 Layer 2 — Discovery · FR-020 … FR-024

**Modes** (one or more, combined)

| Mode | Trigger | Output |
|---|---|---|
| OpenAPI | Spec uploaded or URL supplied | Paths, methods, params, schemas, auth schemes |
| Traffic capture | A HAR is imported, or the optional headless driver produces one | Observed endpoints, parameter templates, response shapes |
| DOM crawl | Form descriptors imported, or captured by the same driver | Form fields, types, required flags, patterns, RTL containers |
| Postman | Collection imported | Endpoints marked source *postman* |

**Processing**

1. Generalise concrete paths into templates. Numeric, UUID/ULID, long-hex, ISO-date and
   prefixed business identifiers (`CUST-001`) are recognised; the template is named after
   the preceding collection, so `/orders/{orderId}` and `/users/{userId}` never collide.
2. Merge modes into one surface; the highest-fidelity source wins per attribute
   (spec > traffic > DOM > postman). An observed template is reconciled onto a declared
   endpoint of the same shape, so `/customers/{customerId}` does not fork from the
   spec's `/customers/{id}`. Observation counts accumulate from every source, and a
   specification re-import replaces only the specification-derived slice.
3. Redact credentials and tokens from captured traffic before storage. Bodies are
   reduced to field names and inferred types — no captured value is persisted at all.
4. Label endpoints declared but never observed.

**Outputs:** Endpoint surface with per-endpoint discovery source and observation count.

### 4.3 Layer 3 — Generator · FR-030 … FR-036

**Preconditions:** at least one acceptance criterion and one discovered endpoint.

**Per criterion:**

1. Select applicable techniques by requirement type:

   | Requirement type | Techniques applied |
   |---|---|
   | functional | boundary, equivalence, negative & auth, localisation* |
   | business rule | decision table, equivalence, negative & auth |
   | non-functional | negative & auth, (performance — FR-044, planned) |
   | localisation | localisation, equivalence |
   | compliance | equivalence, negative & auth |

   \* localisation is applied to any criterion touching user-facing text, regardless of type.

2. Resolve the target endpoint from the criterion's subject; abort the criterion if none resolves and record a gap reason.
3. Build the request from the schema; validate it against that schema.
4. Attach assertions: status, schema (FR-041) and the business rule stated by the criterion (FR-042).
5. Emit the case with `requirement`, `criterion`, `endpoint`, `technique` recorded.

**Regeneration rule:** on re-parse, cases with `edited = true` are preserved verbatim; cases with `edited = false` whose criterion changed are replaced; cases whose criterion disappeared are archived, not deleted.

**Ceilings:** decision-table combinations above the configured ceiling (default 64,
`TRACEO_DECISION_TABLE_MAX_COMBOS`) are reduced to an all-pairs covering set, and the
reduction is disclosed on every case it produces. An input for which no invalid value
can be derived cannot vary, so its invalid half is unreachable: it is excluded and
disclosed rather than generated.

**Criterion attribution.** Every emitted case stores the criterion that produced it, and
is additionally credited to any sibling criterion whose own words name the field the
case is about. Two criteria that produce the same case share it and the case cites both.
Attribution never widens on generic word overlap — only on the case's subject field — so
a plain positive request, which is about no field in particular, claims nothing.

**Limit of the mapping.** Whether a criterion receives cases at all depends on the
mapper's precision, bounded by `MIN_MAP_CONFIDENCE`. A non-functional sentence can be
mapped and will then be reported as covered; the human review gate is the designed
control, since no case counts toward coverage until a reviewer approves it.

### 4.4 Layer 4 — Execution · FR-040 … FR-043

**Sequence**

1. Isolate the run. *This build isolates at the process level — a dedicated HTTP client,
   an in-memory secret scope and a per-run fixture namespace — not in a container.
   Container-per-run remains the target for the hosted deployment; an on-premise
   installation runs the stack as a single process by design (NFR-POR-03).*
2. Load secrets from the vault into run memory only.
3. Create fixtures, namespaced `traceo-run-{runId}`.
4. Authenticate once; reuse the session where the scheme allows.
5. Execute cases at the configured concurrency (default 8, range 1–32).
6. Record per case: request, response, latency, assertion outcomes.
7. Tear down fixtures in reverse creation order; report any that could not be removed.
   Teardown is in a `finally` block, so it runs on success, failure and cancellation.
8. Release the run scope (see the isolation note in step 1).

**Verdict rules**

| Condition | Verdict |
|---|---|
| All assertions pass | pass |
| Status as expected, schema violated | fail (schema) |
| Status as expected, business rule violated | fail (rule) |
| Transport error or timeout | fail (error) — with the raw error captured |
| Case disabled | skipped, excluded from coverage |

Teardown executes on success, failure and cancellation alike.

### 4.5 Layer 5 — Reporting · FR-050 … FR-054

**Traceability matrix** — for each requirement: its criteria with per-criterion coverage, case count, passed, failed, coverage %, verdict (verified / failed / not verified).

**Coverage formula**

```
requirement coverage = (criteria with >= 1 APPROVED case citing them) / (total criteria)
project coverage     = weighted mean of requirement coverage, weighted by priority
                       (high/critical = 3, medium = 2, low = 1)
```

Coverage counts APPROVED cases, not executed ones: a case a human has approved is
designed coverage, and whether it has run yet is the separate verdict axis
(`covered_not_run` -> `passing` / `failing`). Approving is the act that makes a case
count, which is why the review queue exists.

**Progressive rigour.** A requirement is measured per criterion as soon as ANY linked
case cites one. Until then it is measured on whether an approved case exists at all — a
lead who writes a case by hand, links it and approves it is not told they have 0%
coverage for not using a labelling feature they may not know about. Once citations
appear, the stricter measure takes over and stays.

One computation serves the matrix, the dashboard and the CI gate
(`traceability.project_coverage`), so the number that fails a pipeline is the number on
the screen. A gate that disagrees with the matrix is worse than no gate.

**Gap reasons** — one of: `no_criteria` (nothing testable stated — fix this first),
`no_reachable_endpoint`, `all_cases_disabled`, `no_approved_cases`, `criteria_uncovered`
(the requirement holds an approved case but a named criterion has none). Every gap
carries a next action.

**Defect severity**

| Requirement priority | Failure class | Severity |
|---|---|---|
| high | rule violation | critical |
| high | schema violation | major |
| medium | rule violation | major |
| medium / low | schema violation | minor |
| any | transport error | major |

---

## 5. Interface specification

| # | Screen | Route | Primary purpose | Key features |
|---|---|---|---|---|
| 1 | Overview (marketing) | `#/overview` | Explain the product and pricing | — |
| 2 | Dashboard | `#/dashboard` | Health of the project at a glance | FR-054, FR-062, FR-051 |
| 3 | Runs | `#/runs` | History and comparison | FR-053 |
| 4 | New run | `#/new` | Configure and start a run | FR-010, FR-021, FR-030–FR-034, FR-060 |
| 5 | Run report | `#/runs/{id}` | Failures, traceability, gaps | FR-050, FR-051, FR-052, FR-071 |
| 6 | Requirements | `#/requirements` | Requirements, criteria, linked cases | FR-012, FR-013, FR-014 |
| 7 | Test cases | `#/testcases` | The case library | FR-035, FR-036 |
| 8 | API surface | `#/api` | What was discovered and how well it is covered | FR-020–FR-024 |
| 9 | Integrations | `#/integrations` | Connections and the pipeline gate | FR-070, FR-061, FR-011 |
| 10 | Settings | `#/settings` | Workspace, deployment, access, retention | FR-060, FR-080–FR-083 |
| 11 | Feature reference | `#/reference` | The FR catalogue, in-product | — |

Navigation is grouped: **Workspace** (Dashboard, Runs, New run) · **Analysis** (Requirements, Test cases, API surface) · **Configure** (Integrations, Settings) · **Docs** (Feature reference).

---

## 6. Non-functional requirements

### 6.1 Performance

| # | Requirement |
|---|---|
| NFR-P1 | A 40-page requirement document parses in ≤ 90 seconds. |
| NFR-P2 | A 220-case suite executes in ≤ 8 minutes at concurrency 8. |
| NFR-P3 | Any interface screen renders in ≤ 1.5 s on a mid-range laptop over LAN. |
| NFR-P4 | The traceability matrix renders for up to 500 requirements without pagination stalls. |

### 6.2 Security

| # | Requirement |
|---|---|
| NFR-S1 | Secrets encrypted at rest; decrypted only inside the run container. |
| NFR-S2 | Secret values never appear in logs, reports, exports or captured traffic. |
| NFR-S3 | Role checks enforced server-side on every request. |
| NFR-S4 | The audit log is append-only and immutable before its retention date. |
| NFR-S5 | Captured traffic is redacted for `Authorization`, `Cookie`, `Set-Cookie` and configured header patterns before storage. |
| NFR-S6 | Injection-shaped negative cases assert safe handling and must not persist state changes. |

### 6.3 Data residency and privacy

| # | Requirement |
|---|---|
| NFR-D1 | In on-premise mode, zero outbound network connections are made by any component. |
| NFR-D2 | Requirement parsing runs on a local model runtime in on-premise mode. |
| NFR-D3 | Telemetry is off by default and requires an explicit administrator action to enable. |
| NFR-D4 | Run artefact retention is configurable; default 90 days. |

### 6.4 Reliability

| # | Requirement |
|---|---|
| NFR-R1 | Fixture teardown executes on success, failure and cancellation. |
| NFR-R2 | A crashed run leaves no orphaned container after 10 minutes. |
| NFR-R3 | Concurrent scheduled runs against the same environment are queued, never parallel. |

### 6.5 Usability and localisation

| # | Requirement |
|---|---|
| NFR-U1 | Interface available in English and Arabic, with full RTL layout mirroring. |
| NFR-U2 | Reports exportable in English, Arabic or bilingual. |
| NFR-U3 | Arabic text renders without mojibake in interface, PDF and XLSX. |
| NFR-U4 | Every destructive action is confirmable and, where feasible, reversible. |
| NFR-U5 | Colour is never the sole carrier of meaning; verdicts also carry text labels. |

### 6.6 Accessibility

| # | Requirement |
|---|---|
| NFR-A1 | Text contrast meets WCAG 2.1 AA against its surface. |
| NFR-A2 | Every interactive control is keyboard reachable with a visible focus ring. |
| NFR-A3 | Tables carry proper header semantics; status badges carry accessible labels. |

---

## 7. Deployment

| Mode | Description |
|---|---|
| **Cloud (KSA region)** | Managed by the vendor, data resident in the Kingdom. Team and Business plans. |
| **On-premise** | Full stack inside the customer network, local model runtime, no egress. Business and Enterprise plans. |
| **Air-gapped** | On-premise with no internet route at all; updates delivered as signed bundles. Enterprise only. |

---

## 8. Traceability — SRS section → features → BR

| SRS § | Features | BR |
|---|---|---|
| 4.1 Parser | FR-010 … FR-014 | BR-01, BR-05 |
| 4.2 Discovery | FR-020 … FR-024 | BR-02 |
| 4.3 Generator | FR-030 … FR-036 | BR-02, BR-05, BR-10 |
| 4.4 Execution | FR-040 … FR-043 | BR-04 |
| 4.5 Reporting | FR-050 … FR-054 | BR-03, BR-04, BR-06 |
| 5 Interface | all | all |
| 6.2 Security | FR-082, FR-083 | BR-07, BR-08 |
| 6.3 Residency | FR-081 | BR-07 |
| 6.5 Localisation | FR-012, FR-034, FR-071 | BR-05 |
