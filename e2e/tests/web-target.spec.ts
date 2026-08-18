/**
 * Web targets — point Traceo at a URL, tick test types, get grounded artefacts
 * (@critical @regression).
 *
 * WHAT THIS SPEC EXISTS TO HOLD THE PRODUCT TO
 *
 *   1. THE PAGE IS REALLY RENDERED. The feature was motivated by a measured
 *      fact: the OrangeHRM demo login answers a plain GET with ~3.4KB carrying
 *      0 forms, 0 inputs and 0 buttons — everything is client-rendered. So the
 *      hermetic target this spec serves (helpers/local-web-target.ts) has the
 *      same property on purpose: its markup is built by script. An inventory
 *      containing a form is therefore PROOF that a browser rendered the page;
 *      a server-side HTML parser would report nothing and pass no assertion
 *      below.
 *   2. NOTHING IS INVENTED (BO-07). Every persisted case must reference
 *      something the discovery actually found — a form-field selector, a
 *      captured request, or a design fact id. The oracle is built from the
 *      target's own inventory and is proved capable of failing before it is
 *      trusted.
 *   3. THE COUNTS ARE INTERNALLY CONSISTENT. The job result is the only thing
 *      a user reads after a discovery; if its arithmetic does not match what
 *      was persisted, the report is a story. Every selected type is accounted
 *      for — it produced cases, or it is in `skipped` WITH A REASON. A type
 *      that silently vanishes is indistinguishable from a broken track.
 *   4. DISCOVERY IS READ-ONLY. The contract says discovery navigates and reads;
 *      it never submits a form or clicks a destructive control. That is a
 *      negative about the outside world, so the target server itself records
 *      every request it receives and the assertion is made against ITS log —
 *      the discovery report cannot be its own witness.
 *   5. THE REFUSALS ARE TYPED. An unknown test type is a 422 that NAMES the
 *      legal list; a viewer is a 403; a non-http scheme is refused outright.
 *   6. A MISSING BROWSER FAILS LOUDLY. Without node/Playwright the job must
 *      fail with `browser_discovery_unavailable` and say what to install — an
 *      empty success would be the worst possible outcome, because the counts
 *      would read as "this page has nothing to test".
 *
 * HERMETICITY (§8, §10). The suite never browses the public internet: the
 * target is served on loopback from ports 8010–8030 by the spec itself, and
 * every response it gives is fixed offline data. That has one consequence
 * worth stating: loopback is exactly what the SSRF guard blocks, so the
 * backend under test must run with TRACEO_ALLOW_PRIVATE_TARGETS=1 for the
 * discovery path to be reachable at all. When it does not, the guard's typed
 * refusal is asserted (the guard applying to browser discovery is itself a
 * contract) and the discovery assertions are skipped with that reason stated —
 * never silently passed.
 */
import type { ApiClient } from '../api/client';
import { endpointKey } from '../api/discovery.repository';
import type {
  Endpoint,
  TestCase,
  WebTargetDetail,
  WebTargetJobResult,
  WebTargetSkip,
} from '../api/types';
import {
  apiStepKeys,
  caseAnchors,
  capturedKeys,
  designFactIds,
  designOf,
  discoveredSelectors,
  inventoryOf,
  requiredFieldSelectors,
  type GroundingOracle,
  type WebTargetDiscovery,
} from '../api/webtarget.repository';
import {
  ENDPOINT_SOURCES,
  WEB_TARGET_STATUSES,
  WEB_TARGET_TEST_TYPES,
  type WebTargetTestType,
} from '../constants/states';
import { test, expect } from '../fixtures';
import { expectApiError } from '../helpers/expect-api-error';
import { startLocalWebTarget, type LocalWebTarget } from '../helpers/local-web-target';

/** Browser launch + navigation + screenshot + five persistence tracks (§16). */
const DISCOVERY_TEST_TIMEOUT_MS = 300_000;

/** The design facts are extracted at this viewport, so the screenshot is too. */
const VIEWPORT = '1280x800';

/** Every type, every time: the spec's job is to prove all five tracks behave. */
const ALL_TYPES: WebTargetTestType[] = [...WEB_TARGET_TEST_TYPES];

/**
 * Concrete ids the page's fetch() calls carry. The collections importer
 * templates all-digit and canonical-UUID segments to `{id}`; DOM-discovered
 * traffic must be templated by the SAME rule, or a project ends up with one
 * endpoint per row of production data.
 */
const CONCRETE_IDS = ['1042', '3f0f8e2c-4d1a-4a53-9f4b-6a2c9b7e1d55'];

/**
 * A URL for the refusal cases, NEVER contacted by anything.
 *
 * The server validates the URL before the test types (webtarget.py
 * `create_web_target`), so a refusal case cannot use the loopback target: on a
 * node without TRACEO_ALLOW_PRIVATE_TARGETS the SSRF guard would answer first
 * and the assertion would be about the wrong contract. A literal PUBLIC IP
 * passes that guard without a DNS lookup and without a packet — validation
 * fails on the body long before any browser is launched, so the suite stays
 * hermetic (no name resolution, no egress).
 */
const UNREACHED_PUBLIC_URL = 'http://93.184.216.34/login';

/** Paths the page never requests unless something clicked — the safety oracle. */
const DESTRUCTIVE_PATH = '/api/v2/account';
const NAVIGATED_AWAY_PATH = '/help';

/** Controls for the grounding oracle: tokens no discovery could ever produce. */
const FABRICATED_SELECTOR = '#__traceo_fabricated_field__';
const FABRICATED_FACT_ID = 'element:99999,99999';
const FABRICATED_ENDPOINT = endpointKey('POST', '/__traceo_fabricated__/{id}');

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** Endpoints this project holds that came from a crawled DOM (fidelity "dom"). */
function domEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter((e) => e.source === 'dom');
}

/**
 * The bag of artefacts a generated case is allowed to point at, assembled from
 * the target's OWN inventory plus the endpoints persisted from its traffic.
 */
function buildOracle(
  detail: WebTargetDetail,
  endpoints: Endpoint[],
  target: LocalWebTarget,
): GroundingOracle {
  const inventory = inventoryOf(detail);
  const dom = domEndpoints(endpoints);
  return {
    selectors: discoveredSelectors(inventory),
    factIds: designFactIds(designOf(detail)),
    endpointKeys: dom.map((e) => endpointKey(e.method, e.path)),
    // The page's own path is a legitimate step path: a functional, UI or
    // performance case acts on the SCREEN, not on an endpoint.
    paths: [...dom.map((e) => e.path), new URL(target.url).pathname],
    urls: [target.url, detail.final_url ?? '', detail.url].filter(Boolean),
  };
}

/**
 * A case that references nothing real. Running the matcher against it is how
 * the oracle proves it CAN fail — without this control, every grounding
 * assertion below could be passing vacuously.
 */
function fabricatedCase(): TestCase {
  return {
    id: 'fabricated',
    project_id: 'fabricated',
    title: `Sign in with ${FABRICATED_SELECTOR}`,
    description: `Derived from the design: ${FABRICATED_FACT_ID}`,
    preconditions: '',
    type: 'positive',
    priority: 'medium',
    state: 'draft',
    generated: true,
    user_modified: false,
    model: '',
    prompt_version: '',
    technique: 'manual',
    edge_category: null,
    weakness_id: null,
    version: 1,
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    links: [],
    step_count: 1,
    created_at: null,
    updated_at: null,
    steps: [
      {
        order: 0,
        endpoint_id: null,
        method: 'POST',
        path: '/__traceo_fabricated__/{id}',
        request: { selector: FABRICATED_SELECTOR },
        assertions: [{ type: 'element_present', fact: FABRICATED_FACT_ID }],
        extractions: [],
      },
    ],
  };
}

/**
 * Assert the three legitimate endings of a discovery attempt and report which
 * one happened. `completed` returns the job result; the other two assert their
 * own contract and return null, and the caller skips the discovery battery
 * with the reason stated in the test output.
 */
async function settleDiscovery(
  discovery: WebTargetDiscovery,
  api: ApiClient,
  projectId: string,
): Promise<WebTargetJobResult | null> {
  if (discovery.kind === 'refused') {
    // The SSRF rule of the spec fetcher applies to browser discovery too. A
    // loopback target is refused unless TRACEO_ALLOW_PRIVATE_TARGETS=1 — and
    // the refusal is typed, so it can be acted on rather than read.
    expect(
      ['ssrf_blocked', 'invalid_url'],
      `creating a loopback target was refused with an unexpected code ` +
        `"${discovery.error.code}" (${discovery.error.status}) — the guard must refuse it ` +
        `the way the spec fetcher does, or allow it under TRACEO_ALLOW_PRIVATE_TARGETS=1`,
    ).toContain(discovery.error.code);
    expect(discovery.error.status).toBe(422);
    // A refused create persists nothing at all.
    expect(await api.webTargets.list(projectId)).toEqual([]);
    return null;
  }

  if (discovery.kind === 'failed') {
    // THE ONE FAILURE THE CONTRACT NAMES. A missing sidecar must never look
    // like a page with nothing on it.
    expect(
      discovery.code,
      `the discovery job failed with "${discovery.error}" — the only failure this ` +
        `environment may legitimately produce is browser_discovery_unavailable`,
    ).toBe('browser_discovery_unavailable');
    expect(
      /node|playwright/i.test(discovery.error),
      `browser_discovery_unavailable must say WHAT to install; it said: "${discovery.error}"`,
    ).toBe(true);

    // A failed discovery keeps its row (the failure stays visible) and
    // persists nothing derived from a page it never read.
    const targets = await api.webTargets.list(projectId);
    expect(targets.length, 'a failed discovery left no target row to explain itself').toBe(1);
    expect(targets[0].status).toBe('failed');
    expect(
      targets[0].error ?? '',
      'the failed target row does not say why it failed',
    ).toContain(discovery.code);
    expect(await api.discovery.listEndpoints(projectId)).toEqual([]);
    expect(await api.review.list(projectId)).toEqual([]);
    return null;
  }

  return discovery.result;
}

test.describe('web target discovery @critical @regression', () => {
  test('a URL discovered in a browser produces grounded artefacts for all five test types', async ({
    api,
    project,
  }) => {
    test.setTimeout(DISCOVERY_TEST_TIMEOUT_MS);

    const target = await startLocalWebTarget();
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.url,
        viewport: VIEWPORT,
        test_types: ALL_TYPES,
      });

      const result = await settleDiscovery(discovery, api, project.id);
      if (result === null) {
        test.skip(
          true,
          'browser discovery was not exercised in this environment — see the assertions above ' +
            '(a loopback target needs TRACEO_ALLOW_PRIVATE_TARGETS=1, and the sidecar needs ' +
            'node + Playwright)',
        );
        return;
      }

      await test.step('the browser found a form that server-side parsing cannot see', async () => {
        expect(typeof result.target_id === 'string' && result.target_id.length > 0).toBe(true);

        for (const [name, value] of Object.entries({
          forms: result.forms,
          controls: result.controls,
          requests: result.requests,
          endpoints: result.endpoints,
          requirements: result.requirements,
        })) {
          expect(isNonNegativeInteger(value), `result.${name} is not a count: ${value}`).toBe(true);
        }

        // The page's form exists only after its script ran. Zero forms here
        // means the page was parsed, not rendered — the exact failure mode
        // this feature exists to remove.
        expect(
          result.forms,
          'the discovery reported no form — a client-rendered page was read without a browser',
        ).toBeGreaterThanOrEqual(1);
        // Submit button, help link, destructive button.
        expect(result.controls).toBeGreaterThanOrEqual(3);
        // The document plus the three fetch() calls the page fires.
        expect(result.requests).toBeGreaterThanOrEqual(4);
        expect(result.title, 'the page title was not captured').toBe('Orders Platform — Sign in');
      });

      await test.step('every selected type is accounted for — cases, endpoints, or a stated reason', async () => {
        const byType = result.cases_by_type ?? {};
        expect(
          Object.keys(byType).sort(),
          'cases_by_type does not carry one key per requested test type',
        ).toEqual([...ALL_TYPES].sort());
        for (const [type, count] of Object.entries(byType)) {
          expect(ALL_TYPES, `cases_by_type names "${type}", which is not a legal test type`).toContain(
            type as WebTargetTestType,
          );
          expect(isNonNegativeInteger(count), `cases_by_type.${type} is not a count`).toBe(true);
        }

        expect(Array.isArray(result.skipped)).toBe(true);
        const skippedTypes = new Set(result.skipped.map((s: WebTargetSkip) => s.type));
        for (const skip of result.skipped) {
          expect(
            ALL_TYPES,
            `the run skipped "${skip.type}", which is not a legal test type`,
          ).toContain(skip.type as WebTargetTestType);
          expect(
            typeof skip.reason === 'string' && skip.reason.trim().length > 0,
            `the "${skip.type}" track was skipped without a reason — indistinguishable from a broken track`,
          ).toBe(true);
        }

        // NOTHING DISAPPEARS QUIETLY. A track that produced no case must say
        // why — except `api`, whose product is the ENDPOINT INVENTORY rather
        // than cases: it is accounted for by the endpoints it wrote.
        for (const type of ALL_TYPES) {
          const produced = byType[type] ?? 0;
          const accounted =
            produced > 0 ||
            skippedTypes.has(type) ||
            (type === 'api' && result.endpoints > 0);
          expect(
            accounted,
            `the "${type}" track produced nothing and gave no reason — a silent empty track is ` +
              `indistinguishable from a broken one`,
          ).toBe(true);
        }

        // The grounding gate's own counters must be countable.
        for (const [name, value] of Object.entries({
          discarded: result.discarded ?? 0,
          duplicates: result.duplicates ?? 0,
        })) {
          expect(isNonNegativeInteger(value), `result.${name} is not a count: ${value}`).toBe(true);
        }
      });

      await test.step('what the run claims to have persisted is what the project holds', async () => {
        const endpoints = await api.discovery.listEndpoints(project.id);
        const dom = domEndpoints(endpoints);
        expect(
          dom.length,
          `the run reported ${result.endpoints} endpoint(s) from the captured traffic but the ` +
            `inventory holds ${dom.length} with source "dom"`,
        ).toBe(result.endpoints);
        expect(
          result.endpoints,
          'more endpoints were persisted than requests were captured — an endpoint was invented',
        ).toBeLessThanOrEqual(result.requests);

        const requirements = await api.ingestion.listRequirements(project.id);
        expect(
          requirements.length,
          `the run reported ${result.requirements} requirement(s); the project holds ` +
            `${requirements.length}`,
        ).toBe(result.requirements);
        // One per discovered FORM, plus at most one each for the performance
        // budget, the design facts, the observed API surface and the security
        // plan over that surface — the api and security tracks state different
        // things about the same endpoints (they must answer as observed / they
        // must be free of catalogued weaknesses), so each owns its own
        // requirement. Nothing else may appear in a project from pointing it at
        // a URL.
        // …plus at most one BEHAVIOUR requirement per crawled page, holding the
        // cases the model proposed for that screen. That one is per page rather
        // than per crawl because it is a statement about a single screen, so the
        // bound has to count pages — a fixed number here would have to be raised
        // every time a crawl got wider, which is how a bound stops bounding.
        const CRAWL_WIDE_REQUIREMENTS = 4; // api, security, ui, performance
        const pages = Math.max(1, result.pages_visited ?? 1);
        expect(result.requirements).toBeGreaterThanOrEqual(result.forms);
        expect(result.requirements).toBeLessThanOrEqual(
          result.forms + CRAWL_WIDE_REQUIREMENTS + pages,
        );
        for (const requirement of requirements) {
          expect(
            requirement.external_id.startsWith('WEB-'),
            `requirement ${requirement.external_id} did not come from the web target, yet this ` +
              `project has no other source`,
          ).toBe(true);
        }

        const cases = await api.review.list(project.id);
        expect(
          cases.length,
          'the per-type case counts do not add up to the queue the run left behind',
        ).toBe(sum(Object.values(result.cases_by_type ?? {})));
      });

      await test.step('the target row records what was discovered, and serves its screenshot', async () => {
        const listed = await api.webTargets.list(project.id);
        expect(listed.map((t) => t.id)).toContain(result.target_id);

        const detail = await api.webTargets.get(result.target_id);
        expect(WEB_TARGET_STATUSES, 'unknown web-target status').toContain(detail.status);
        expect(detail.status).toBe('discovered');
        expect(detail.url).toBe(target.url);
        expect(detail.viewport).toBe(VIEWPORT);
        expect(detail.title).toBe(result.title);
        expect(
          detail.final_url ?? '',
          'final_url does not point at the page that was actually rendered',
        ).toContain(target.origin);
        expect(detail.last_discovered_at, 'a discovered target carries no timestamp').not.toBeNull();
        expect(detail.error ?? null, 'a discovered target still carries an error').toBeNull();
        expect([...(detail.test_types ?? [])].sort()).toEqual([...ALL_TYPES].sort());
        expect(detail.has_screenshot, 'the target reports no stored screenshot').toBe(true);

        // The stored counts and the job result are two views of ONE discovery.
        const counts = detail.counts ?? {};
        expect(counts.forms).toBe(result.forms);
        expect(counts.controls).toBe(result.controls);
        expect(counts.requests).toBe(result.requests);
        expect(counts.endpoints).toBe(result.endpoints);

        // The design box the owner asked for: a palette with shares, and the
        // contrast findings with a passing colour for every failing pair.
        const design = designOf(detail);
        expect(design.palette?.length, 'the design box has no palette').toBeGreaterThan(0);
        for (const entry of design.palette ?? []) {
          expect(entry.hex, `palette entry "${entry.hex}" is not a hex colour`).toMatch(
            /^#[0-9A-F]{6}$/,
          );
          expect(entry.share).toBeGreaterThan(0);
          expect(entry.share).toBeLessThanOrEqual(1);
        }
        expect(design.contrast?.length, 'the design box has no contrast finding').toBeGreaterThan(0);
        for (const finding of design.contrast ?? []) {
          expect(finding.fact_id).toMatch(/^contrast:/);
          expect(finding.ratio).toBeGreaterThan(0);
          if (finding.passes_aa === false && finding.achievable) {
            // The whole point of the suggestion: it must actually pass, and it
            // must be a colour, not a sentence.
            expect(finding.suggested).toMatch(/^#[0-9A-F]{6}$/);
            expect(
              finding.ratio_after,
              `the colour suggested for ${finding.fact_id} still fails AA (${finding.ratio_after}:1)`,
            ).toBeGreaterThanOrEqual(4.5);
            expect(finding.ratio_after).toBeGreaterThan(finding.ratio);
          }
        }

        const screenshot = await api.webTargets.screenshot(result.target_id);
        expect(screenshot.contentType).toContain('image/png');
        // Magic bytes — the route must serve the image, not a JSON envelope
        // describing one.
        expect(
          screenshot.body.subarray(0, 8).equals(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          ),
          'the screenshot route did not return PNG bytes',
        ).toBe(true);
        expect(screenshot.body.length).toBeGreaterThan(1024);
      });

      await test.step('captured traffic is templated by the same rule as every other import', async () => {
        const dom = domEndpoints(await api.discovery.listEndpoints(project.id));
        expect(dom.length, 'no endpoint was persisted from the captured XHR/fetch calls').toBeGreaterThan(0);

        for (const endpoint of dom) {
          expect(ENDPOINT_SOURCES, `endpoint ${endpoint.id} has an unknown source`).toContain(
            endpoint.source,
          );
          expect(endpoint.path.startsWith('/'), `"${endpoint.path}" is not a server-relative path`).toBe(
            true,
          );
          // A POST endpoint here is legitimate: a form DECLARES its action, and
          // recording that declaration is not performing it. What must stay true
          // is the safety rule itself, and the only witness for that is the
          // target server's own log — asserted below, outside this loop.
          // Reading "no POST endpoint" as proof of "nothing was submitted" would
          // conflate the inventory with the traffic, and would go on passing if
          // discovery started submitting forms that happened to be GET.
          expect(
            endpoint.method.toUpperCase(),
            `"${endpoint.method}" is not an HTTP method`,
          ).toMatch(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/);
          for (const concrete of CONCRETE_IDS) {
            expect(
              endpoint.path,
              `"${endpoint.path}" kept the concrete id ${concrete} — one endpoint per row of ` +
                `production data instead of one templated resource`,
            ).not.toContain(concrete);
          }
        }
        expect(
          dom.some((e) => e.path.endsWith('{id}')),
          `no discovered path was templated to {id} — got: ${dom.map((e) => e.path).join(', ')}`,
        ).toBe(true);

        // The target's own inventory summary and the endpoint inventory are two
        // views of the same conversion; they may not disagree.
        const detail = await api.webTargets.get(result.target_id);
        const ops = inventoryOf(detail).endpoints ?? [];
        expect(
          ops.map((op) => endpointKey(op.method, op.path)).sort(),
          'the target inventory lists different operations from the endpoint inventory',
        ).toEqual(dom.map((e) => endpointKey(e.method, e.path)).sort());
      });

      await test.step('discovery navigated and read — it submitted nothing and clicked nothing', async () => {
        // Asserted against the TARGET's own request log: the discovery report
        // cannot be its own witness for a negative about the outside world.
        expect(
          target.mutatingRequests(),
          'discovery sent a non-GET request — it submitted a form or triggered a destructive control',
        ).toEqual([]);
        expect(
          target.requestsTo(DESTRUCTIVE_PATH),
          'the destructive control was activated during discovery',
        ).toEqual([]);
        expect(
          target.requestsTo(NAVIGATED_AWAY_PATH),
          'discovery followed a link away from the target page',
        ).toEqual([]);
        expect(
          target.requestsTo('/').length,
          'the target page was never requested at all',
        ).toBeGreaterThan(0);
      });

      // --- ADVERSARIAL GROUNDING ASSERTION (BO-07) ------------------------------
      await test.step('every generated case references something the discovery actually found', async () => {
        const detail = await api.webTargets.get(result.target_id);
        const endpoints = await api.discovery.listEndpoints(project.id);
        const oracle = buildOracle(detail, endpoints, target);
        const inventory = inventoryOf(detail);

        // The oracle must be non-vacuous BEFORE anything is measured against it.
        expect(
          oracle.selectors.length + oracle.factIds.length + oracle.endpointKeys.length,
          'the discovered inventory is empty — every grounding assertion would pass vacuously',
        ).toBeGreaterThan(0);

        // Control 1: the oracle cannot contain what was never discovered.
        expect(oracle.selectors).not.toContain(FABRICATED_SELECTOR);
        expect(oracle.factIds).not.toContain(FABRICATED_FACT_ID);
        expect(oracle.endpointKeys).not.toContain(FABRICATED_ENDPOINT);
        expect(capturedKeys(inventory)).not.toContain(FABRICATED_ENDPOINT);

        // Control 2: the matcher itself can fail. A case that references only
        // fabricated artefacts must anchor to nothing.
        expect(
          caseAnchors(fabricatedCase(), oracle),
          'the grounding matcher anchored a fabricated case — every assertion below would be meaningless',
        ).toEqual([]);

        const requirementIds = (await api.ingestion.listRequirements(project.id)).map((r) => r.id);
        const cases = await api.review.list(project.id);
        expect(cases.length, 'the run persisted no case at all').toBeGreaterThan(0);

        let anchorsChecked = 0;
        for (const listed of cases) {
          const testCase = await api.review.get(listed.id);
          const steps = testCase.steps ?? [];
          expect(steps.length, `case ${testCase.id} has no step to ground`).toBeGreaterThan(0);

          const anchors = caseAnchors(testCase, oracle);
          expect(
            anchors.length,
            `case ${testCase.id} ("${testCase.title}") references NOTHING the discovery found — ` +
              `not a form selector, not a captured request, not a design fact ` +
              `(known selectors: ${oracle.selectors.slice(0, 6).join(', ')}; ` +
              `known facts: ${oracle.factIds.slice(0, 4).join(', ')}; ` +
              `known endpoints: ${oracle.endpointKeys.join(', ')})`,
          ).toBeGreaterThan(0);
          anchorsChecked += anchors.length;

          // An HTTP-shaped step is held to the stricter rule: the method+path
          // must exist in the persisted inventory (or be the page itself, which
          // is what a performance case measures). A selector match may not
          // excuse an invented endpoint.
          for (const step of apiStepKeys(testCase)) {
            const known =
              oracle.endpointKeys.includes(step.key) || oracle.paths.includes(step.path);
            expect(
              known,
              `case ${testCase.id} step #${step.order} calls "${step.key}", which is neither a ` +
                `discovered endpoint nor the target page (fabricated identifier, BO-07)`,
            ).toBe(true);
          }

          // Traceability: a link may never point outside this project, and a
          // case with no link at all has to be a design case — grounded in a
          // fact id rather than in a requirement.
          for (const link of testCase.links) {
            expect(
              requirementIds,
              `case ${testCase.id} links to requirement ${link.id}, which is not one of this project's`,
            ).toContain(link.id);
          }
          if (testCase.links.length === 0) {
            expect(
              anchors.some((a) => oracle.factIds.includes(a)),
              `case ${testCase.id} links to no requirement and grounds in no design fact — ` +
                `it traces to nothing`,
            ).toBe(true);
          }
        }
        expect(anchorsChecked, 'the grounding oracle matched nothing anywhere').toBeGreaterThan(0);
      });

      await test.step('the functional requirements name the form and the fields it requires', async () => {
        const detail = await api.webTargets.get(result.target_id);
        const forms = inventoryOf(detail).forms ?? [];
        if (forms.length === 0) return; // the detail route need not echo the forms

        const requirements = await api.ingestion.listRequirements(project.id);
        const text = requirements.map((r) => `${r.description} ${r.source_text}`).join('\n');
        for (const form of forms) {
          for (const selector of requiredFieldSelectors(form)) {
            expect(
              text,
              `no requirement names the required field "${selector}" of the discovered form — ` +
                `the description must name the form and its required fields`,
            ).toContain(selector);
          }
        }
        // Extraction is mechanical, so the human gate stays closed.
        for (const requirement of requirements) {
          expect(
            ['extracted', 'confirmed'],
            `requirement ${requirement.id} landed in state "${requirement.state}"`,
          ).toContain(requirement.state);
        }
      });
    } finally {
      await target.close();
    }
  });
});

test.describe('web target refusals @regression', () => {
  test('an unknown test type is refused with 422 invalid_test_type and the legal list @negative', async ({
    api,
    project,
  }) => {
    const error = await expectApiError(
      api.webTargets.create(project.id, {
        url: UNREACHED_PUBLIC_URL,
        viewport: VIEWPORT,
        test_types: ['functional', '__traceo_not_a_test_type__'],
      }),
      { status: 422, code: 'invalid_test_type' },
    );

    // A refusal that does not say what IS legal makes the caller guess — and
    // "perfomance" would otherwise be silently dropped, running four tracks
    // and reporting success for five.
    expect(
      error.errors.length,
      'invalid_test_type carried no `errors` list naming the legal test types',
    ).toBeGreaterThan(0);
    const listed = [...error.errors, error.message].join(' ');
    for (const type of ALL_TYPES) {
      expect(listed, `the refusal does not name the legal type "${type}"`).toContain(type);
    }

    // Nothing was created by a refused request.
    expect(await api.webTargets.list(project.id)).toEqual([]);
  });

  test('an empty type list is refused too @negative', async ({ api, project }) => {
    // Selecting nothing is not "discover everything": it is a request that
    // would render a page and produce nothing, which is never what was meant.
    await expectApiError(
      api.webTargets.create(project.id, { url: UNREACHED_PUBLIC_URL, test_types: [] }),
      { status: 422, code: 'invalid_test_type' },
    );
  });

  test('an out-of-range viewport is refused @negative', async ({ api, project }) => {
    await expectApiError(
      api.webTargets.create(project.id, {
        url: UNREACHED_PUBLIC_URL,
        viewport: '12x9',
        test_types: ['ui'],
      }),
      { status: 422, code: 'invalid_viewport' },
    );
  });

  test('a non-http(s) scheme is refused outright @negative', async ({ api, project }) => {
    // Same rule as the spec fetcher: a browser will happily render `data:` and
    // `file:` URLs, which is precisely why the server refuses them.
    await expectApiError(
      api.webTargets.create(project.id, {
        url: 'data:text/html,<form><input name="a"></form>',
        test_types: ['functional'],
      }),
      { status: 422, code: 'invalid_url' },
    );
    expect(await api.webTargets.list(project.id)).toEqual([]);
  });
});

test.describe('web target permission gating @permission @regression', () => {
  test('a viewer is refused creation with 403 forbidden @negative', async ({ api, project }) => {
    const target = await startLocalWebTarget();
    try {
      await expectApiError(
        api.as('viewer').webTargets.create(project.id, {
          url: target.url,
          viewport: VIEWPORT,
          test_types: ['functional', 'ui'],
        }),
        { status: 403, code: 'forbidden' },
      );

      // The refusal is total: no target row, and no browser was ever launched.
      expect(await api.webTargets.list(project.id)).toEqual([]);
      expect(
        target.requests,
        'a 403 still reached the target — the capability check runs before the browser',
      ).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('a viewer can list the project web targets (capability "view")', async ({ api, project }) => {
    expect(await api.as('viewer').webTargets.list(project.id)).toEqual([]);
  });
});

test.describe('target page @regression', () => {
});
