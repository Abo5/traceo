/**
 * Security test generation — S0 of docs/SECURITY_TESTING_PLAN.md, end to end
 * (@critical @regression).
 *
 * Security is not a second engine. It is a technique family inside generation
 * plus one new inventory — the shipped weakness catalogue — so the promise this
 * spec exists to hold the product to is the promise every other case already
 * makes, applied to a class of case that is much easier to fake:
 *
 *   1. The CORPUS IS A SHIPPED, VERSIONED FILE (S0.1). It is data, reviewable in
 *      a pull request, and every entry carries the machine-checkable precondition
 *      that decides whether a class applies to an endpoint. A catalogue without a
 *      version is a coverage claim nobody can date.
 *   2. Cases are GROUNDED (S0.2, BO-07). The adversarial assertion below is a
 *      DIFF against the project's own discovered inventory: every step of every
 *      security case must name a method+path that exists there. A security tool
 *      that invents an endpoint does not report a vulnerability — it reports a
 *      hallucination, and someone acts on it.
 *   3. Cases are TRACEABLE. Every one carries >=1 requirement link, and the link
 *      resolves to a requirement OF THIS PROJECT. An endpoint with no mapped
 *      requirement produces NO cases; that is BO-07 working, and the coverage
 *      report says so with a reason rather than silently dropping the pair.
 *   4. Cases are TAGGED with a class from the closed list (`weakness_id`), so a
 *      finding can be argued with: which class, which standard, which severity.
 *   5. The COVERAGE MATRIX IS INTERNALLY CONSISTENT (§11). covered +
 *      not_applicable + gap == total, per corpus and per class, and every
 *      skipped pair carries a reason. "security: 94%" cannot be checked;
 *      "126 of 126 applicable pairs, 34 skipped with reasons" can — but only if
 *      the arithmetic holds, which is what is asserted here.
 *   6. Generation is GATED (S0.3): the catalogue and the matrix are `view`, but
 *      generating is `generate` — and the server, not only the UI, refuses.
 *
 * Nothing in this surface calls a model: the catalogue is a file and the
 * builders are pure, so the whole flow is deterministic and offline (NFR-D1).
 *
 * Arrangement is API-side (§9): the `project` fixture pins automation "manual"
 * (test-data/project.factory.ts) so the autopilot never races the explicit
 * calls, and the seeds are the same reference documents the pipeline fixtures
 * use — the inventory is real, not synthetic.
 */
import type { ApiClient } from '../api/client';
import { endpointKey } from '../api/discovery.repository';
import { securityCases } from '../api/security.repository';
import type { Endpoint, SecurityCoverage, TestCase, WeaknessCatalogue } from '../api/types';
import { test, expect } from '../fixtures';
import {
  TEST_TECHNIQUES,
  WEAKNESS_ACTIVITIES,
  WEAKNESS_SEVERITIES,
  type TestTechnique,
} from '../constants/states';
import { expectApiError } from '../helpers/expect-api-error';
import { sampleFile } from '../helpers/test-data';

/** Ingest job + spec import + the endpoint × class fan-out (§16 budgets). */
const ENGINE_TEST_TIMEOUT_MS = 240_000;

/** The minimum corpus the contract ships (S0.1: at least ten weakness classes). */
const MINIMUM_CLASSES = 10;

/** Stable slug: lowercase, digits and single hyphens — the id shape of S0.1. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A dotted numeric version, e.g. "1.0.0" — datable, comparable, stampable. */
const VERSION = /^\d+(?:\.\d+)+$/;

/**
 * Give the builders something to ground themselves in: confirmed requirements
 * (every case must link to >=1) and a discovered endpoint inventory (every pair
 * is an endpoint × a class). Identical to the arrangement the generation and
 * insight engines use — security reuses the pipeline, it does not fork it.
 */
async function groundProject(api: ApiClient, projectId: string): Promise<void> {
  await api.ingestion.uploadAndConfirm(projectId, sampleFile('sample_requirements_en.md'));
  const imported = await api.discovery.importSpec(projectId, sampleFile('sample_openapi.yaml'));
  expect(imported.endpoints_count, 'the OpenAPI sample produced no endpoints').toBeGreaterThan(0);
}

/** Only INCLUDED endpoints are in scope — an excluded one is out of the corpus. */
function includedInventory(endpoints: Endpoint[]): string[] {
  return endpoints.filter((e) => !e.excluded).map((e) => endpointKey(e.method, e.path));
}

/** Sum of one bucket across the per-class rows of the matrix. */
function sumBucket(
  coverage: SecurityCoverage,
  bucket: 'covered' | 'not_applicable' | 'gap',
): number {
  return coverage.by_weakness.reduce((total, row) => total + row[bucket], 0);
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

test.describe('security corpus @critical @regression', () => {
  test('the shipped weakness catalogue is versioned, non-empty and machine-checkable', async ({
    api,
  }) => {
    const catalogue: WeaknessCatalogue = await api.security.catalogue();

    // The version is the whole point of shipping the corpus as a file: it is
    // stamped into generated cases, and a change makes them stale (§3.1).
    expect(typeof catalogue.version).toBe('string');
    expect(catalogue.version, 'the catalogue ships without a usable version').toMatch(VERSION);

    expect(Array.isArray(catalogue.weaknesses)).toBe(true);
    expect(
      catalogue.weaknesses.length,
      `the catalogue ships ${catalogue.weaknesses.length} classes — the contract ships at least ${MINIMUM_CLASSES}`,
    ).toBeGreaterThanOrEqual(MINIMUM_CLASSES);

    const ids = catalogue.weaknesses.map((w) => w.id);
    expect(new Set(ids).size, `duplicate weakness ids in the catalogue: ${ids.join(', ')}`).toBe(
      ids.length,
    );

    for (const weakness of catalogue.weaknesses) {
      await test.step(`class ${weakness.id} is a complete entry`, async () => {
        expect(weakness.id, `"${weakness.id}" is not a stable slug`).toMatch(SLUG);
        expect(weakness.title.trim().length, `class ${weakness.id} has no title`).toBeGreaterThan(0);
        expect(WEAKNESS_SEVERITIES, `class ${weakness.id} has an unknown severity`).toContain(
          weakness.severity,
        );
        expect(WEAKNESS_ACTIVITIES, `class ${weakness.id} has an unknown activity`).toContain(
          weakness.activity,
        );

        // The precondition is what makes a skipped pair auditable rather than
        // invisible, so it must be a non-empty, machine-checkable object — never
        // prose the builder cannot evaluate.
        expect(typeof weakness.precondition, `class ${weakness.id} has no precondition`).toBe(
          'object',
        );
        expect(weakness.precondition).not.toBeNull();
        expect(
          Object.keys(weakness.precondition).length,
          `class ${weakness.id} carries an empty precondition — every endpoint would match it`,
        ).toBeGreaterThan(0);

        expect(
          Array.isArray(weakness.checks) && weakness.checks.length > 0,
          `class ${weakness.id} declares no check family, so it can assert nothing`,
        ).toBe(true);

        // A class with no standard reference cannot be argued with in a report.
        const refs = weakness.refs ?? {};
        const referenced =
          (typeof refs.owasp_api === 'string' && refs.owasp_api.length > 0) ||
          (refs.cwe?.length ?? 0) > 0 ||
          (refs.asvs?.length ?? 0) > 0;
        expect(referenced, `class ${weakness.id} cites no OWASP/CWE/ASVS reference`).toBe(true);
      });
    }

    // §7's safety tag has to partition something: the passive classes are what
    // S0 may run at all, and at least one class (rate limiting) must be active
    // so the S1 execution gate has something to refuse.
    const passive = catalogue.weaknesses.filter((w) => w.activity === 'passive');
    const active = catalogue.weaknesses.filter((w) => w.activity === 'active');
    expect(passive.length, 'no passive class — S0 could execute nothing safely').toBeGreaterThan(0);
    expect(
      active.length,
      'no active class is marked — a class that writes or floods must be tagged active (§7)',
    ).toBeGreaterThan(0);

    // The corpus is a file, not a query: two reads are the same corpus.
    const second = await api.security.catalogue();
    expect(second.version).toBe(catalogue.version);
    expect(second.weaknesses.map((w) => w.id)).toEqual(ids);
  });
});

test.describe('security generation @critical @regression', () => {
  test('every generated case is grounded in the inventory, traceable and tagged with a catalogue class', async ({
    api,
    project,
  }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    await groundProject(api, project.id);

    const catalogue = await api.security.catalogue();
    const classIds = catalogue.weaknesses.map((w) => w.id);

    const { result, cases } = await api.security.generateAndWait(project.id);

    await test.step('the run reports what it persisted, what it discarded and what it skipped', async () => {
      expect(isNonNegativeInteger(result.generated)).toBe(true);
      expect(isNonNegativeInteger(result.discarded)).toBe(true);
      expect(result.generated, 'the security run persisted nothing at all').toBeGreaterThan(0);
      expect(Array.isArray(result.skipped)).toBe(true);

      // A skipped pair without a reason is an invisible gap — the exact failure
      // mode §1 says is worse than no tool at all.
      for (const skip of result.skipped) {
        expect(
          typeof skip.reason === 'string' && skip.reason.trim().length > 0,
          `a skipped pair (${skip.endpoint} × ${skip.weakness}) carries no reason`,
        ).toBe(true);
        expect(
          classIds,
          `a pair was skipped for class "${skip.weakness}", which is not in the catalogue`,
        ).toContain(skip.weakness);
        expect(String(skip.endpoint).length).toBeGreaterThan(0);
      }
    });

    // Vocabulary guard: `security` joined an existing closed list — a value
    // outside it means the backends and constants/states.ts have drifted.
    for (const testCase of cases) {
      expect(TEST_TECHNIQUES, `unknown technique on case ${testCase.id}`).toContain(
        testCase.technique as TestTechnique,
      );
    }

    const produced = securityCases(cases);
    expect(
      produced.length,
      'the number of security-technique cases contradicts the run counters',
    ).toBe(result.generated);

    // The tag is exclusive to the family: a functional or edge case must never
    // carry a weakness id, or the matrix would count cases that assert nothing
    // about a weakness class.
    for (const other of cases.filter((c) => c.technique !== 'security')) {
      expect(
        other.weakness_id,
        `case ${other.id} is technique "${other.technique}" yet carries weakness_id ${other.weakness_id}`,
      ).toBeNull();
    }

    const requirements = await api.ingestion.listRequirements(project.id, { state: 'confirmed' });
    const requirementIds = requirements.map((r) => r.id);
    expect(requirementIds.length, 'no confirmed requirement to trace to').toBeGreaterThan(0);

    await test.step('every case is a draft, tagged with a catalogue class and traceable to this project', async () => {
      for (const testCase of produced) {
        expect(testCase).toBeInState('draft'); // the human gate stays closed (BO-07)

        expect(
          classIds,
          `case ${testCase.id} carries weakness_id "${testCase.weakness_id}", which is not in the ` +
            `shipped catalogue (an id the closed-list gate should have refused)`,
        ).toContain(testCase.weakness_id as string);

        // TRACEABILITY — the hard contract: a security case with no requirement
        // is a finding nobody asked for and nobody can prioritise.
        expect(
          testCase.links.length,
          `case ${testCase.id} links to no requirement (S0.2: requirement_ids is non-empty)`,
        ).toBeGreaterThan(0);
        for (const link of testCase.links) {
          expect(
            requirementIds,
            `case ${testCase.id} links to requirement ${link.id}, which is not a requirement of ` +
              `this project (fabricated identifier, BO-07)`,
          ).toContain(link.id);
        }
      }
    });

    // --- ADVERSARIAL GROUNDING ASSERTION (BO-07, the product's core promise) ---
    // The oracle is the project's OWN discovered inventory, parsed and diffed.
    // Steps are matched verbatim: no normalising of paths, no stripping of
    // templated segments — any such leniency would let an invented path pass as
    // "close enough", which is precisely how a security tool starts reporting
    // vulnerabilities in endpoints that do not exist.
    await test.step('every step of every security case exists in the endpoint inventory', async () => {
      const endpoints = await api.discovery.listEndpoints(project.id);
      const inventory = includedInventory(endpoints);
      const endpointIds = endpoints.map((e) => e.id);
      expect(inventory.length, 'empty inventory — the oracle would be vacuous').toBeGreaterThan(0);

      // Control: prove the oracle CAN fail. If a fabricated pair matched, every
      // assertion below would be meaningless.
      expect(inventory).not.toContain(endpointKey('POST', '/__traceo_fabricated__/{id}'));
      expect(inventory).not.toContain(endpointKey('GET', '/auth/login')); // right path, wrong method

      let stepsChecked = 0;
      for (const listed of produced) {
        const detail: TestCase = await api.review.get(listed.id);
        const steps = detail.steps ?? [];
        // A case with no steps would pass the loop below vacuously.
        expect(steps.length, `security case ${detail.id} has no step to ground`).toBeGreaterThan(0);

        // S0.2: steps[0] carries method/path/request exactly like a generated
        // functional case — the shape review, execution and evidence rely on.
        const first = steps[0];
        expect(String(first.method ?? '').length, `case ${detail.id} step 0 has no method`).toBeGreaterThan(0);
        expect(String(first.path ?? '').startsWith('/'), `case ${detail.id} step 0 has no path`).toBe(true);
        expect(typeof first.request, `case ${detail.id} step 0 has no request object`).toBe('object');

        for (const step of steps) {
          const key = endpointKey(step.method ?? '', step.path ?? '');
          expect(
            inventory,
            `case ${detail.id} step #${step.order} calls "${key}" — absent from the ` +
              `project's endpoint inventory (fabricated identifier, BO-07)`,
          ).toContain(key);
          if (step.endpoint_id !== null && step.endpoint_id !== undefined) {
            expect(
              endpointIds,
              `case ${detail.id} step #${step.order} references endpoint ${step.endpoint_id}, ` +
                `which is not an endpoint of this project`,
            ).toContain(step.endpoint_id);
          }
          stepsChecked += 1;
        }
      }
      expect(stepsChecked, 'the grounding oracle inspected no step at all').toBeGreaterThan(0);
    });
  });

  test('the coverage matrix adds up, names its corpus, and every skipped pair carries a reason', async ({
    api,
    project,
  }) => {
    test.setTimeout(ENGINE_TEST_TIMEOUT_MS);
    await groundProject(api, project.id);

    const catalogue = await api.security.catalogue();
    const classIds = catalogue.weaknesses.map((w) => w.id);
    const { cases } = await api.security.generateAndWait(project.id);
    const produced = securityCases(cases);

    const endpoints = await api.discovery.listEndpoints(project.id);
    const inventory = includedInventory(endpoints);
    const endpointIds = endpoints.map((e) => e.id);

    const coverage: SecurityCoverage = await api.security.coverage(project.id);

    await test.step('the matrix states which corpus it was computed against', async () => {
      // A coverage number without a corpus version is undatable — §11 puts the
      // version beside the result precisely so nobody reads it as more.
      expect(coverage.corpus_version).toBe(catalogue.version);
    });

    await test.step('covered + not_applicable + gap == total, at the corpus level', async () => {
      const { pairs } = coverage;
      for (const [bucket, value] of Object.entries(pairs)) {
        expect(isNonNegativeInteger(value), `pairs.${bucket} is not a count: ${value}`).toBe(true);
      }
      expect(pairs.total, 'the matrix reports zero pairs over a non-empty inventory').toBeGreaterThan(0);
      expect(
        pairs.covered + pairs.not_applicable + pairs.gap,
        `the buckets (${pairs.covered} + ${pairs.not_applicable} + ${pairs.gap}) do not add up to ` +
          `the ${pairs.total} pairs the matrix claims — the report cannot be audited`,
      ).toBe(pairs.total);

      // The matrix is endpoints × classes, so it can never exceed that product.
      expect(
        pairs.total,
        `the matrix reports more pairs than ${inventory.length} endpoints × ` +
          `${classIds.length} classes can produce`,
      ).toBeLessThanOrEqual(inventory.length * classIds.length);
      expect(pairs.covered, 'a generation run persisted cases yet nothing is covered').toBeGreaterThan(0);
    });

    await test.step('the per-class rows partition the same totals', async () => {
      const rowIds = coverage.by_weakness.map((r) => r.weakness_id);
      expect(new Set(rowIds).size, `duplicate rows in by_weakness: ${rowIds.join(', ')}`).toBe(
        rowIds.length,
      );

      // Every class of the corpus gets a row: a matrix that silently omits a
      // class hides exactly the gaps the report exists to surface (§1).
      expect(
        [...rowIds].sort(),
        'by_weakness does not report one row per catalogue class — omitted classes hide gaps',
      ).toEqual([...classIds].sort());

      for (const row of coverage.by_weakness) {
        for (const bucket of ['covered', 'not_applicable', 'gap'] as const) {
          expect(
            isNonNegativeInteger(row[bucket]),
            `by_weakness[${row.weakness_id}].${bucket} is not a count: ${row[bucket]}`,
          ).toBe(true);
        }
      }

      for (const bucket of ['covered', 'not_applicable', 'gap'] as const) {
        expect(
          sumBucket(coverage, bucket),
          `the per-class ${bucket} counts do not sum to the corpus-level ${bucket} count`,
        ).toBe(coverage.pairs[bucket]);
      }
    });

    await test.step('the covered classes are exactly the classes cases were persisted for', async () => {
      // Two independent endpoints, one truth: the matrix may not claim coverage
      // the review queue cannot show, nor omit coverage it can.
      const classesWithCases = new Set(produced.map((c) => c.weakness_id));
      for (const row of coverage.by_weakness) {
        const hasCases = classesWithCases.has(row.weakness_id);
        expect(
          row.covered > 0,
          hasCases
            ? `class ${row.weakness_id} has persisted cases but the matrix reports it uncovered`
            : `class ${row.weakness_id} has no persisted case but the matrix reports ${row.covered} covered`,
        ).toBe(hasCases);
      }
    });

    await test.step('every skipped pair names a real pair and says why it was skipped', async () => {
      expect(Array.isArray(coverage.skipped)).toBe(true);
      // The sample API mixes collection endpoints with item endpoints, so at
      // least one class cannot apply somewhere — a matrix with no skip at all
      // over this inventory would mean the preconditions are never evaluated.
      expect(
        coverage.skipped.length,
        'no pair was skipped over an inventory where some preconditions cannot hold',
      ).toBeGreaterThan(0);

      const reasons = new Set<string>();
      for (const skip of coverage.skipped) {
        expect(
          typeof skip.reason === 'string' && skip.reason.trim().length > 0,
          `skipped pair ${skip.method} ${skip.path} × ${skip.weakness_id} carries no reason`,
        ).toBe(true);
        reasons.add(skip.reason);

        expect(
          classIds,
          `a pair was skipped for class "${skip.weakness_id}", which is not in the catalogue`,
        ).toContain(skip.weakness_id);
        expect(
          endpointIds,
          `skipped pair references endpoint ${skip.endpoint_id}, which is not one of this project's`,
        ).toContain(skip.endpoint_id);
        expect(
          inventory,
          `skipped pair names "${endpointKey(skip.method, skip.path)}", absent from the inventory`,
        ).toContain(endpointKey(skip.method, skip.path));
      }
      expect(
        reasons.size,
        'the skipped pairs carry no reason text at all — the report states nothing diagnostic',
      ).toBeGreaterThan(0);
    });
  });
});

/**
 * Capability gating of the security surface (backend/app/security.py
 * PERMISSIONS): reading the corpus and the matrix is `view`, generating is
 * `generate` (admin|qa_lead|qa_engineer). The server refuses on its own — the
 * UI is not the gate.
 */
test.describe('security permission gating @permission @regression', () => {
  test('a viewer is refused generation with 403 forbidden @negative', async ({ api, project }) => {
    await expectApiError(api.as('viewer').security.generate(project.id), {
      status: 403,
      code: 'forbidden',
    });

    // …and no case slipped through the refusal.
    const cases = await api.review.list(project.id);
    expect(securityCases(cases).length, 'a refused request still persisted cases').toBe(0);
  });

  test('a viewer can read the catalogue and the coverage matrix (capability "view")', async ({
    api,
    project,
  }) => {
    const viewer = api.as('viewer');

    const catalogue = await viewer.security.catalogue();
    expect(catalogue.weaknesses.length).toBeGreaterThanOrEqual(MINIMUM_CLASSES);

    const coverage = await viewer.security.coverage(project.id);
    expect(coverage.corpus_version).toBe(catalogue.version);
    expect(
      coverage.pairs.covered + coverage.pairs.not_applicable + coverage.pairs.gap,
    ).toBe(coverage.pairs.total);
  });
});
