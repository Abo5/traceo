# Delivery Notes — v2.1

**Supersedes nothing. Records the delta between the v2.0 specification set and the
implementation that now exists.**

The v2.0 documents — `01-BRD`, `02-Feature-Reference`, `03-SRS`, `04-User-Flows`,
`05-Design-Spec`, and the released `TADQEEQ_*_v2.0.docx` deliverables — describe the
product as designed. This note records what changed on contact with implementation:
what shipped as specified, where the specification was corrected because the build
proved it wrong, and where the build falls short and the reason is stated rather than
hidden.

The `.docx` deliverables are dated snapshots of a released version and have deliberately
**not** been edited in place. Editing a document that has already gone out rewrites a
record. This note is the addendum; a v2.1 re-issue of those files, if the client wants
one, should be generated from these notes.

---

## 1. Status

All 37 features in `02-Feature-Reference` are implemented and covered by tests. The two
that v2.0 listed as *Planned* — FR-044 performance capture and FR-072 Slack — shipped.

| | v2.0 as written | v2.1 as built |
|---|---|---|
| Features shipped | 35 of 37 | **37 of 37** |
| Backend tests | 23 | **82** |
| In-product screens | 9 of 11 | **10 of 11** (Integrations added; see §4.5) |
| Backend modules | 9 | **12** (+ capture, automation, integrations) |

---

## 2. Delivered as specified

Nothing surprising here; listed so the omissions below are unambiguous.

- **Layers 1–5** — parser, discovery, generator with the grounding gate, execution,
  reporting — behave as `03-SRS §4` describes.
- **FR-061 CI gate** exits non-zero and names the breaching requirement by its external
  id, as `04-User-Flows` Flow 5 requires.
- **FR-043 fixture lifecycle** tears down in a `finally` block, so cancellation and
  failure are covered, and reports anything it could not remove.
- **FR-070 Jira export** deduplicates: a re-export updates the issue it opened.
- **FR-011 Confluence re-import** re-versions changed requirements and marks the linked
  cases stale, through the same ingestion pipeline as an uploaded file.
- **FR-060 scheduling** defers an overlapping run instead of executing two against one
  environment.

---

## 3. Specification corrected by implementation

Places where building the thing showed the written design was wrong or incomplete. The
v2.0 markdown set has been updated; the `.docx` snapshots have not.

### 3.1 Coverage is measured per criterion, and the number changed

`03-SRS §4.5` always specified criterion-level, priority-weighted coverage. The
implementation had been computing "confirmed requirements holding at least one approved
case". With acceptance criteria now first-class, the specified formula is computable and
is the headline number.

On the reference project this moves coverage from **100% to 87.8%** (29 of 33 criteria).
The old number was comfortable and wrong. Anyone quoting 100% into a contract would have
been disputing it later.

One computation (`traceability.project_coverage`) serves the matrix, the dashboard and
the CI gate. Three surfaces quoting three coverage numbers was a live risk; a gate that
disagrees with the matrix is worse than no gate.

**Progressive rigour** was added during implementation, not from the specification: a
requirement is measured per criterion as soon as *any* linked case cites one, and until
then on whether an approved case exists. Without it, a lead who writes a case by hand,
links it and approves it is told they have 0% coverage for not using a labelling feature
they may not know exists. Two existing tests failed and forced this.

### 3.2 The governing design rule was only half enforced

`03-SRS §1`: *a test case may only exist if it can name (a) the acceptance criterion it
derives from and (b) the discovered endpoint it targets.*

Half (b) — the grounding gate — was enforced from the start. Half (a) was not
implemented at all: criteria were plain strings, cases linked only to requirements, and
nothing recorded which sentence a case verified. Generation now iterates criteria, every
case stores the criterion that produced it, and the matrix reports per criterion.

The immediate effect on the reference project: four requirements that reported no gaps
now name specific uncovered criteria, including *"age above 120 is rejected"*.

### 3.3 Severity table

`03-SRS §4.5` specifies that a **medium**-priority business-rule violation is `major`.
The implementation flattened everything non-high to `minor`, ranking a broken business
rule below a schema drift. Corrected; where a case serves several requirements, the most
severe governs.

### 3.4 Smaller corrections

| Item | Was | Now |
|---|---|---|
| Decision-table ceiling | 8, truncating `itertools.product` — silent and biased toward the first conditions | 64 per SRS, then a real all-pairs covering set, disclosed on every case |
| Path templating | Missed prefixed ids (`CUST-001`), forking a duplicate endpoint per observation | Recognised; reconciled onto the declared endpoint of the same shape |
| Response branches | Responses declared without a body schema were dropped, so a documented `422` was invisible to coverage | Every declared status is a branch |
| Hand-written cases | Never bound to an endpoint, so they were absent from the coverage map — FR-036 AC4 was false where it was measurable | Bound by (method, path); a path outside the inventory stays unbound rather than refused |

---

## 4. Where the build falls short of v2.0

Stated plainly. Each is a deliberate decision with a reason, not an oversight.

### 4.1 Run isolation is process-level, not a container

`03-SRS §4.4` steps 1 and 8 specify provisioning and destroying a container per run.
This build isolates with a dedicated HTTP client, an in-memory secret scope and a
per-run fixture namespace.

Container-per-run remains the target for the hosted deployment. An on-premise
installation runs the stack as a single process by design (NFR-POR-03), and that is the
deployment this release optimises for. **Consequence:** a hostile system under test
could in principle affect the runner process; the mitigations are the request timeout,
the run timeout and TLS verification, not kernel isolation.

### 4.2 Traffic capture consumes a capture; the driver is optional

`03-SRS §4.2` described traffic capture as *"headless browser drives the app"*. The
implementation accepts a HAR — from a proxy, browser devtools, or Traceo's own Playwright
driver — and DOM form descriptors on the same basis. Playwright is an optional
dependency because it pulls a browser binary an air-gapped installation may refuse.
**Consequence:** on a minimal install, capture is a two-step operation rather than one
button.

### 4.3 The PDF is a printable HTML report

FR-071's deliverable is a self-contained printable page (print → PDF); XLSX is generated
natively. Both are bilingual and stamp the run identity on every page. No native PDF
engine is bundled.

### 4.4 Criterion attribution can over-claim, bounded by review

Whether a criterion receives cases depends on the mapper's precision, bounded by
`MIN_MAP_CONFIDENCE`. A non-functional sentence — *"response time is measured at the API
gateway"* — can be mapped and will then read as covered.

A lexical gate requiring the criterion to name the endpoint's fields was implemented and
**removed**: it silently dropped legitimate criteria that name no field, such as *"an
unauthorised caller is rejected"*. Losing real coverage to improve a number is the worse
error. The human review gate — no case counts until someone approves it — is the
designed control. The reasoning is recorded in `tests/test_criteria.py` so it is not
re-implemented later.

### 4.5 The in-product Feature reference screen was not built

`03-SRS §5` lists eleven screens; screen 11, *Feature reference* (`#/reference`), the
FR catalogue rendered inside the product, does not exist. Every `FR-###` chip in the UI
is present and correct, but clicking through to an in-product catalogue is not
implemented — the catalogue lives in `02-Feature-Reference.md`.

Screen 1, *Overview*, is the marketing page (`Traceo.html`), not an application route,
which is as designed.

**This entry exists because the first draft of this document claimed "11 of 11".**
Checking each claim against the repository caught it. A delivery note that argues for
under-claiming and then over-claims its own scope would be worth less than nothing.

### 4.6 Hijri conversion is tabular, not Umm al-Qura

FR-012 AC4 normalises Hijri dates by annotating them with a Gregorian equivalent. The
conversion is the tabular Islamic calendar and can differ from Umm al-Qura by one day at
a month boundary, which is why the annotation reads `≈`. Three of four published
reference dates match exactly; the fourth is one day out.

---

## 5. Decisions worth carrying forward

1. **Under-claim over over-claim.** Where coverage could not be traced, it is not
   claimed. In a document that ends up in a contract, an unclaimed truth is recoverable
   and a false claim is not.
2. **One number, one computation.** Any metric shown in more than one place is computed
   once.
3. **Additive schema only.** `db.sync_schema()` adds tables and columns at startup;
   releases never remove them, so a customer database survives upgrades without a
   migration tool.
4. **Say the limit in the artefact.** Every shortfall above is stated in the code
   comment, the contract document, or the test that guards it — not only here.

---

*TADQEEQ project — Confidential. Proprietary; do not distribute.*
