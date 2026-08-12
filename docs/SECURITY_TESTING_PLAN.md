# Security testing — backend plan

> How Traceo generates, grounds and runs security test cases, and how a live CVE feed becomes test cases instead of noise.
>
> Scope: **backend only** — engines, data model, routes, jobs. No UI in this document.
> Status: proposal.

## 0. Where security sits

Five test types, one pipeline. They differ in what grounds them and what a failure means, not in the machinery:

| Type | Grounded in | A failure means |
|---|---|---|
| `functional` | requirement × endpoint | the system does not do what was specified |
| `api` | endpoint contract | the contract is violated |
| `ui` | design element (see `DESIGN_AS_REQUIREMENT_SOURCE.md`) | the build drifted from the design |
| `performance` | endpoint + a stated budget | the system is too slow under a stated load |
| `security` | endpoint × a **weakness class** | the system accepts something it must refuse |

Security is not a bolt-on engine. It is a **technique family inside generation** plus two new inventories (weaknesses, components) and hard safety rails around execution. Everything else — jobs, runs, evidence, review, traceability, the gate — is reused. A security case that cannot be traced to a requirement and grounded in a discovered endpoint is discarded, exactly like every other case.

---

## 1. What "cover every possibility" can honestly mean

The request is to leave no possibility uncovered. That is worth being precise about, because a security tool that overstates its coverage is worse than none — it converts an unknown risk into a false assurance, and people stop looking.

**Not achievable, by anyone:** proving the absence of vulnerabilities. Vulnerability classes are unbounded, business-logic flaws are specific to intent no scanner can read, and a system can be exploitable through a component nobody enumerated. Any product claiming 100% here is selling.

**Achievable, and the right target:**

1. **Complete coverage of a defined corpus.** Every endpoint × every applicable weakness class in a versioned catalogue (OWASP API Security Top 10, OWASP ASVS, the CWE Top 25), with a case per applicable pair and an explicit **not-applicable reason** for every skipped pair. The claim becomes "126 of 126 applicable pairs are covered, and here are the 34 skipped with reasons" — checkable, and it makes gaps visible instead of invisible.
2. **Complete coverage of a declared component set.** Every component in the SBOM matched against every CVE affecting it, tracked to a verdict.
3. **A named, dated gap list.** What the corpus does not cover, stated in the report rather than left as an implicit promise.

That is what §11's coverage model computes. It is a real 100% — of something defined — rather than a fictional 100% of everything.

---

## 2. The missing link: without an SBOM, a CVE feed is news

This is the single most important design decision in this document.

A CVE feed is a firehose about *other people's software*. The examples in the NVD window you sampled are a FileRun command injection and a WordPress plugin authorisation bypass. Neither is relevant to a system that runs neither — and if Traceo generated test cases from raw CVE text, it would produce hundreds of confident, ungrounded cases about software the target does not contain. That is exactly the fabrication BO-07 exists to prevent, arriving through a new door.

**A CVE becomes actionable only when it matches something the target actually runs.** So the CVE track requires a component inventory:

```
Component (name, version, ecosystem, cpe23, source)
```

Populated from what the project can supply, in fidelity order:

| Source | How | Fidelity |
|---|---|---|
| SBOM upload | CycloneDX or SPDX JSON | highest — versions are exact |
| Lockfile upload | `package-lock.json`, `poetry.lock`, `go.sum`, `requirements.txt` | high |
| Response fingerprints | `Server`, `X-Powered-By`, framework error signatures observed during runs | low — a hint, never a version |
| Manual | declared by the user | as good as the user |

Without any of these, the CVE engine reports **"no component inventory — CVE matching is disabled"** rather than generating plausible nonsense. A disabled feature that says so is worth more than an enabled one that invents.

---

## 3. Knowledge sources

Two tiers, deliberately separated because one is offline and stable and the other is online and volatile.

### 3.1 Offline corpus (ships with the product, versioned)

- **Weakness catalogue** — OWASP API Security Top 10, ASVS verification requirements, CWE entries. Each entry: id, title, the *precondition* that makes it applicable to an endpoint (has auth? takes an id? accepts a file? renders user input?), and the check family that verifies it.
- **Payload classes** — descriptions of *what to send*, parameterised by the endpoint's own schema. Not a copied exploit list: a payload is built from the endpoint's declared fields, so it stays grounded and it stays safe.

The corpus is a data file, reviewable in a pull request, with a version stamped into every generated case. When it changes, affected cases go `stale` — the same cascade a changed requirement triggers today.

### 3.2 Live feeds (optional, network-gated)

| Feed | Why | Cost |
|---|---|---|
| **NVD CVE 2.0** | the canonical record, with CVSS, CWE and CPE | rate-limited, large |
| **CISA KEV** | *known exploited* — the sharpest prioritisation signal that exists | tiny, daily |
| **OSV** | ecosystem-accurate ranges for npm/PyPI/Go, better than CPE for libraries | per-ecosystem |

These break the air-gapped guarantee (NFR-D1), so they are **off by default**, run in a dedicated egress-allowed job, and cache locally. An air-gapped deployment imports a periodically-exported snapshot instead. The engine must work — degraded and saying so — with no feed at all.

---

## 4. The NVD sync, with its real constraints

Measured against the live API, not assumed:

| Constraint | Value | Consequence for the design |
|---|---|---|
| Rate limit, no key | 5 requests / rolling 30 s | a full backfill is days |
| Rate limit, with key | 50 requests / rolling 30 s | backfill in hours; **require a key** |
| `resultsPerPage` max | **2000** (2001 → 404) | page at 2000, always |
| `pubStartDate`/`pubEndDate` range | **≤ 120 days** (121 → 404) | backfill walks 120-day windows |
| Incremental | `lastModStartDate`/`lastModEndDate` | the only sane steady state |
| Cadence | no more than every 2 hours | scheduler minimum |
| Corpus size | ~358k CVEs today | backfill is a one-off, not a per-run cost |

**Sync design.** A dedicated `cve_sync` job, not part of a test run — nobody should wait on NIST to run their suite.

1. **Backfill** (once): walk `pubStartDate`/`pubEndDate` in 120-day windows, `resultsPerPage=2000`, persisting `startIndex` so an interrupted sync resumes rather than restarts.
2. **Incremental** (scheduled): `lastModStartDate` = the last successful sync timestamp, `lastModEndDate` = now. Store the watermark only after the whole page range succeeds, so a partial failure re-reads rather than skips.
3. **Backoff**: 429 and 5xx are expected. Exponential backoff with jitter, honouring `Retry-After`; a failed sync degrades matching to the last snapshot and says so in the report, never blocks a run.
4. **Narrow first**: for a small SBOM, `cpeName=` per component is far cheaper than mirroring the corpus. Mirror only when the inventory is large enough to justify it.

**Stored per CVE**, the fields that drive decisions: id, published, lastModified, `vulnStatus`, English description, CVSS v3.1/v4.0 base score and severity, the CVSS **vector** (its `AV`/`PR`/`UI` components decide whether a check is even reachable), CWE ids, affected vendor/product/version ranges, CPE criteria, references, and the KEV flag joined from CISA.

**Terms of use apply.** NVD data is redistributable with attribution; the sync must send a descriptive `User-Agent` and carry the attribution into exported reports.

---

## 5. Generation — two tracks, one gate

### 5.1 Deterministic builders (the backbone)

For every (endpoint × weakness class) pair where the class's precondition holds, a builder emits a case. No model involved, so the coverage matrix is complete and reproducible. Sketch of the families:

| Class | Precondition | The case asserts |
|---|---|---|
| Broken object-level authorisation | path takes an id | actor A cannot read/modify actor B's object → 403/404, never 200 |
| Broken function-level authorisation | endpoint guarded by a capability | a lower role is refused, per `security.py`'s own map |
| Unauthenticated access | endpoint declares security | no credentials → 401, and the body leaks nothing |
| Mass assignment | request schema has fields the client should not set | a privileged field in the body does not take effect |
| Injection surfaces | a string field reaches a query/command/template | metacharacters are handled as data: no 5xx, no oracle in the error |
| Input validation | any constrained field | oversize, wrong type, null byte, deep nesting → 4xx, never 5xx |
| Rate limiting | any endpoint | N rapid requests eventually 429 |
| Transport & headers | any endpoint | HSTS, no `Server` version banner, correct CORS, no secrets in URLs |
| Error handling | any endpoint | no stack traces, no framework versions, no internal hostnames |
| Auth token handling | any authenticated endpoint | expired/forged/`alg:none` tokens rejected |

A **5xx is a finding in every class.** Whatever the input, an unhandled exception is a defect and often an oracle.

### 5.2 CVE-derived cases (matched, never invented)

Pipeline, with a human gate before anything is generated:

```
CVE (from feed)
  → match against Component inventory (CPE / OSV range)
     → matched? no  → stored, never generates a case
     → matched? yes → candidate finding: (component, version, CVE, CVSS, KEV)
        → human confirms it applies      ← the gate
           → generate cases:
               (a) version assertion — the deployed version is not in the affected range
               (b) behavioural check — only when the CWE maps to a class in §5.1
                   and the endpoint inventory has a reachable surface
```

Two rules that keep this honest:

- **No exploit generation.** Traceo verifies *the property that must hold* (patched version, request refused, no 5xx), never reproduces the exploit. A QA platform that ships working exploits is a liability to its customer, and the verification is what the customer actually needs.
- **A CVE with no reachable surface produces a version assertion only.** Claiming a behavioural test for a vulnerability in a code path the inventory cannot reach would be theatre.

### 5.3 Where the model is allowed to help

The LLM never decides what is true. It proposes; the system verifies — the same division that already governs generation:

| The model may | The system then |
|---|---|
| read a CVE description and propose which weakness class it belongs to | validate the class is in the catalogue; discard otherwise |
| propose which endpoints in the inventory are plausibly affected | **discard any endpoint not in the inventory** — the grounding gate |
| draft the human-readable title and rationale | never derive a verdict from prose |
| read a requirement and propose that it implies a security property | route it through the same confirm step as any requirement |

The model may **not** produce payloads, decide a verdict, or introduce an identifier. Every generated case still passes `grounding_validate` before persistence, so a security case is subject to exactly the same zero-fabrication rule as a functional one.

---

## 6. Prompting, and the fact that the input is hostile

CVE descriptions are attacker-authored text. So is a vendor advisory. Feeding them to a model that also drives a test runner is a prompt-injection surface, and it must be treated as one:

1. **Untrusted framing.** Every CVE description, advisory body and uploaded document is wrapped in the explicit delimiters already added to the ingestion and mapping prompts — *data to analyse, never instructions to follow*.
2. **Schema-constrained output.** Responses are JSON-schema validated, so the model's output space is a set of enum choices and references, not free text that could carry an instruction.
3. **Closed-list references.** Every endpoint, component and weakness id the model returns must exist in the corresponding inventory; anything else is discarded and counted. This is the structural defence — injection cannot invent a target that passes a closed-list check.
4. **No tool access from the prompt.** The generation prompt has no ability to fetch, execute or write. It returns a document; the caller decides what to do with it.
5. **Determinism preserved.** The mock provider still yields a deterministic result, so the whole security pipeline is testable offline in CI.

The prompt itself states the job narrowly: *given this weakness class and this endpoint inventory, select the endpoints where the class's precondition holds and explain why.* Selection from a closed list, with a reason — not "write me security tests".

---

## 7. Safety rails on execution

Security cases send hostile-shaped input to a live system. The rails are part of the design, not an afterthought:

- **Authorisation is explicit.** A security run requires a per-environment `security_testing_authorised` flag with a recorded actor and timestamp. No flag, no run.
- **Production is refused.** An environment marked production cannot host a security run. This mirrors the existing boot guard that refuses demo seeding in production.
- **Non-destructive by default.** Classes are tagged `passive` (headers, error shapes, authz reads) or `active` (writes, rate-limit floods, oversize payloads). Only `passive` runs unless `active` is explicitly enabled per run.
- **Rate limiting is bounded.** A rate-limit test is capped and backs off — a QA tool must not be the outage.
- **Blast radius is scoped.** The run refuses hosts outside the environment's declared origin, reusing the SSRF guard already protecting spec fetching and webhooks.
- **Evidence is redacted.** The existing redaction covers secrets; security evidence additionally truncates response bodies that may carry leaked data, storing a hash and a classification rather than the payload.
- **Full audit.** Who authorised, what ran, against what, when — append-only, as with every other action.

---

## 8. Data model (backend)

New tables, following existing conventions (org-scoped, string states with the legal values in a comment, audit on every mutation):

| Table | Purpose | States |
|---|---|---|
| `Weakness` | catalogue entry: class id, title, standard refs (OWASP/CWE/ASVS), precondition, activity tag | `active \| deprecated` |
| `Component` | one entry in the SBOM: name, version, ecosystem, cpe23, source | `active \| removed` |
| `Vulnerability` | a synced CVE: id, dates, CVSS score/vector/severity, CWEs, affected ranges, KEV flag | `new \| matched \| dismissed \| confirmed` |
| `ComponentVulnerability` | the join that makes a CVE actionable: component × CVE, match method, confidence | `candidate \| confirmed \| not_applicable` |
| `SecurityFinding` | the outcome: which case, which class or CVE, severity, evidence ref | `open \| fixed \| accepted_risk \| false_positive` |

`TestCase` gains `weakness_id` and `vulnerability_id` (both nullable) — a security case still carries `requirement_ids`, so it appears in the traceability matrix like everything else. `Run` gains a `kind` (`functional \| security \| performance`) so gates and reports can separate them.

---

## 9. API surface (backend)

Same async job pattern, Go parity mandatory:

```
POST   /v1/projects/{id}/components              upload an SBOM or lockfile → 202
GET    /v1/projects/{id}/components
GET    /v1/weaknesses                            the shipped catalogue + its version
POST   /v1/cve/sync                              202 — backfill or incremental (admin)
GET    /v1/cve/sync                              watermark, last run, degraded flag
GET    /v1/projects/{id}/vulnerabilities         matched CVEs with CVSS/KEV and match method
POST   /v1/vulnerabilities/{id}/confirm          the human gate → eligible for generation
POST   /v1/projects/{id}/security/generate       202 — cases from classes and confirmed CVEs
GET    /v1/projects/{id}/security/coverage       the matrix of §11
POST   /v1/projects/{id}/security-runs           202 — requires the authorisation flag
GET    /v1/security-runs/{id}/findings
```

---

## 10. Execution and evidence

Security cases run on the existing engine — same steps, same interpolation, same evidence capture — with three additions:

1. **Multi-actor steps.** BOLA needs actor A to create and actor B to fetch. The step gains an `actor` field resolved from the environment's configured roles, so cross-tenant checks are expressible without a second engine.
2. **Assertion types.** Beyond `status_code`: `header_present`, `header_absent`, `body_not_matches` (for stack traces, SQL errors, internal hostnames), `no_5xx`, `response_time_under`, `rate_limited_within`.
3. **Finding severity.** From CVSS when the case came from a CVE; from the weakness class's base severity otherwise, adjusted by whether the endpoint is authenticated and internet-reachable. Deterministic, and the inputs are recorded so the number can be argued with.

---

## 11. Coverage, stated so it can be audited

The security report is a matrix, not a percentage:

```
endpoints × applicable weakness classes = N pairs
  covered        : a case exists and ran
  not applicable : with the precondition that failed, per pair
  gap            : applicable, no case — this is the number that matters

components × CVEs
  confirmed / dismissed / unverified
  KEV-listed unverified  → the highest-priority line in the report

corpus version, feed freshness, and the declared gap list
```

A gate can then say something meaningful: *no `gap` in the `critical` classes, no unverified KEV-listed CVE, corpus and feed no older than N days.* Compare that with "security: 94%", which cannot be acted on and cannot be checked.

---

## 12. Phases

| Phase | Deliverable | Depends on |
|---|---|---|
| **S0** | Weakness catalogue + deterministic builders for the passive classes; coverage matrix | nothing |
| **S1** | Active classes behind the authorisation flag; multi-actor steps; new assertion types | S0 |
| **S2** | Component inventory: SBOM/lockfile parsing → `Component` | nothing |
| **S3** | NVD + KEV sync, matching, the confirm gate, version-assertion cases | S2 |
| **S4** | Model-assisted class mapping under the closed-list gate | S0, S3 |
| **S5** | Security gate in `/gate`, severity model, exports | S1, S3 |

S0 and S2 are independent and both worth shipping alone: S0 covers the classes that apply to every API without any feed at all, and S2 makes the CVE track possible later while immediately answering "what do we even run?".

---

## 13. Honest limits

- **This finds classes, not zero-days.** It verifies that known weakness classes are handled and that known-vulnerable components are not deployed. Novel logic flaws remain a human job.
- **Business-logic abuse is out of reach.** "A user can refund the same order twice" is a requirement problem; write it as a requirement and the functional engine covers it.
- **CVE matching is only as good as the SBOM.** Fingerprints from response headers are hints, never versions, and must be labelled as such in the report.
- **Feeds go stale, and a stale feed is a silent risk.** Freshness is part of the gate, not a footnote.
- **A green security run is not a certificate.** It says the covered corpus passed. The report states the corpus version and the gap list beside the result, precisely so nobody reads it as more than that.

**Sources:** [NVD Vulnerability APIs](https://nvd.nist.gov/developers/vulnerabilities) · [NVD API workflows](https://nvd.nist.gov/developers/api-workflows) · [NVD API key](https://nvd.nist.gov/developers/request-an-api-key) · [NVD terms of use](https://nvd.nist.gov/developers/terms-of-use)
