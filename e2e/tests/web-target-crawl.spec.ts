/**
 * The AUTHENTICATED crawl — sign in once, then read what is behind the login
 * (@critical @regression).
 *
 * WHY THIS SPEC EXISTS. Until now discovery never submitted anything, and the
 * owner's question was the obvious one: he handed Traceo a login URL and an
 * account, and got a report about the sign-in screen. Most of a product is
 * behind its login. Reaching it costs exactly one submitted form, and that one
 * exception is the most dangerous thing this product does — so it is fenced by
 * a rule, and the rule is what this file proves.
 *
 * THE SAFETY RULE, stated here exactly as it is stated in the sidecar, in the
 * backend and in docs/WEB_TARGETS.md:
 *
 *     The crawler submits THE LOGIN FORM ONLY, once, with the credentials the
 *     user supplied. It submits no other form, ever. It clicks no control whose
 *     accessible name or href matches logout / sign out / delete / remove /
 *     destroy / reset / deactivate / terminate. It stays on the login URL's
 *     origin. It follows links only.
 *
 * Every clause of that is a NEGATIVE about the outside world, and a discovery
 * report cannot be its own witness for a negative — a crawler that clicked
 * "Delete account" and forgot to mention it would pass its own assertions. So
 * the fixture server (helpers/local-web-target.ts) records every request it
 * receives, with the session cookie it carried and the FIELD NAMES of anything
 * submitted, and every safety assertion below is made against THAT log.
 *
 * WHAT ELSE IT HOLDS THE PRODUCT TO
 *
 *   1. NO ANONYMOUS CRAWL. A run that cannot sign in must say so. Reporting the
 *      logged-out shell as the product is the one outcome worse than failing,
 *      because the counts read as "this application is nearly empty".
 *   2. THE PASSWORD NEVER COMES BACK. It is write-only: the payload answers
 *      `auth_configured`, and the pair appears in no response, no job, no case
 *      and no error message — checked literally, percent-encoded and base64'd,
 *      because a leak is a leak in any encoding.
 *   3. PER-PAGE GROUNDING. Every persisted case cites an artefact from the page
 *      it came from. The fixture gives each page its own form with its own
 *      field ids for exactly this reason: `#profile-email` can only have come
 *      from the profile page, so "grounded in the right page" is checkable and
 *      not merely plausible.
 *   4. THE BUDGET IS A CAP, NOT A WISH. `max_pages` bounds what is visited, and
 *      what was not visited is reported WITH ITS REASON.
 *
 * HERMETICITY (§8, §10). The suite never browses the public internet. The
 * fixture is served on loopback (ports 8010–8030) and every page it serves is
 * built by script, so a plain GET shows no form, no input and no button — on
 * EVERY page, not only the login page. An inventory with four forms in it is
 * therefore proof that a browser rendered four pages.
 *
 * Loopback is exactly what the SSRF guard blocks, so the backend under test
 * needs TRACEO_ALLOW_PRIVATE_TARGETS=1 for this path to be reachable at all.
 * Without it, the guard's typed refusal is asserted (the guard applying to the
 * crawl is itself a contract) and the crawl battery is skipped with that reason
 * stated — never silently passed.
 */
import type { ApiClient } from '../api/client';
import { endpointKey } from '../api/discovery.repository';
import type { Endpoint, TestCase, WebTargetDetail, WebTargetJobResult } from '../api/types';
import {
  apiStepKeys,
  caseAnchors,
  citedPageUrls,
  crawlOf,
  credentialsSource,
  designFactIds,
  designOf,
  discoveredSelectors,
  inventoryOf,
  loginRequirement,
  pagesSkipped,
  pagesVisited,
  secretTraces,
  type GroundingOracle,
  type WebTargetDiscovery,
} from '../api/webtarget.repository';
import type { WebTargetTestType } from '../constants/states';
import { test, expect } from '../fixtures';
import { expectApiError } from '../helpers/expect-api-error';
import {
  CRAWL_FORBIDDEN_PATHS,
  CRAWL_PAGE_PATHS,
  startAuthenticatedWebTarget,
  type AuthenticatedWebTarget,
} from '../helpers/local-web-target';
import { TargetPage } from '../pages/target.page';

/** A sign-in, four navigations, four screenshots, then five tracks (§16). */
const CRAWL_TEST_TIMEOUT_MS = 300_000;

const VIEWPORT = '1280x800';

/**
 * The tracks this spec runs. `functional` and `api` are the two whose artefacts
 * are PAGE-SCOPED — one requirement per form on that page, and that page's own
 * captured traffic — so they are what makes per-page grounding checkable;
 * `performance` is here because the contract says each page is measured against
 * its OWN elapsed_ms. The ui and security tracks are proven per-page-agnostic
 * by web-target.spec.ts and add hundreds of cases to every assertion loop
 * below without adding a question this file can answer.
 */
const CRAWL_TYPES: WebTargetTestType[] = ['functional', 'api', 'performance'];

/** Exactly the number of pages behind the fixture's login. */
const PAGES_BEHIND_LOGIN = CRAWL_PAGE_PATHS.length;

/**
 * The budget that covers the whole fixture. The login page counts as one of the
 * pages the crawl reports: it is the URL the operator actually named, it carries
 * the sign-in form, and its screenshot is the only record of the logged-out
 * surface. So the full budget is that page plus everything behind it.
 */
const MAX_PAGES = PAGES_BEHIND_LOGIN + 1;

/**
 * The budget a run gets when it states none — webtarget.py DEFAULT_MAX_PAGES.
 * It explores on purpose: somebody who hands Traceo a URL is asking about the
 * product, and a default of one page would answer about one screen.
 */
const DEFAULT_MAX_PAGES = 25;

/** The path every page behind the login fetches — the deduplication oracle. */
const SHARED_XHR_PATH = '/api/v2/session';

/** Concrete ids the pages request, which the api track must template to {id}. */
const CONCRETE_IDS = ['1042', '3f0f8e2c-4d1a-4a53-9f4b-6a2c9b7e1d55'];

/**
 * One field id per page behind the login. If a requirement names
 * `#settings-locale`, the crawl reached the settings page and read its form —
 * no other page in the fixture carries that id.
 */
const PAGE_FIELD_SELECTORS: Record<string, string> = {
  '/app/dashboard': '#dashboard-term',
  '/app/profile': '#profile-email',
  '/app/orders': '#orders-reference',
  '/app/settings': '#settings-locale',
};

/**
 * A URL for the refusal cases, NEVER contacted by anything. The server
 * validates the URL before the body, so a body-shape refusal cannot be
 * requested with a loopback URL: on a node without
 * TRACEO_ALLOW_PRIVATE_TARGETS the SSRF guard would answer first and the
 * assertion would be about the wrong contract. A literal PUBLIC IP passes that
 * guard without a DNS lookup and without a packet.
 */
const UNREACHED_PUBLIC_URL = 'http://93.184.216.34/login';

/** Controls for the grounding oracle: tokens no crawl could ever produce. */
const FABRICATED_SELECTOR = '#__traceo_fabricated_field__';
const FABRICATED_FACT_ID = 'element:99999,99999';

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Endpoints this project holds that came from a crawled DOM (fidelity "dom"). */
function domEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return endpoints.filter((e) => e.source === 'dom');
}

/**
 * The bag of artefacts a generated case is allowed to point at. The URLs of
 * EVERY page the crawl was supposed to reach are in it, because a multi-page
 * run grounds its cases in `page:<final_url>` as well as in selectors.
 */
function buildOracle(
  detail: WebTargetDetail,
  endpoints: Endpoint[],
  target: AuthenticatedWebTarget,
): GroundingOracle {
  const inventory = inventoryOf(detail);
  const dom = domEndpoints(endpoints);
  const pageUrls = [target.loginUrl, ...target.pageUrls];
  return {
    selectors: discoveredSelectors(inventory),
    factIds: designFactIds(designOf(detail)),
    endpointKeys: dom.map((e) => endpointKey(e.method, e.path)),
    // A functional, UI or performance case acts on a SCREEN, so every crawled
    // page's own path is a legitimate step path.
    paths: [...dom.map((e) => e.path), ...pageUrls.map((u) => new URL(u).pathname)],
    urls: [...pageUrls, detail.final_url ?? '', detail.url].filter(Boolean),
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
    description: `Derived from the design: ${FABRICATED_FACT_ID} on page:http://127.0.0.1:1/__never__`,
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
 * Assert the endings a crawl attempt may legitimately have in THIS environment
 * and return the result, or null when the crawl was not exercised at all.
 *
 * The only legitimate failure is a missing browser. `login_failed` reaching
 * here would mean the product could not sign in with credentials the fixture
 * accepts — a defect, and the assertion says so rather than skipping.
 */
async function settleCrawl(
  discovery: WebTargetDiscovery,
  api: ApiClient,
  projectId: string,
): Promise<WebTargetJobResult | null> {
  if (discovery.kind === 'refused') {
    expect(
      ['ssrf_blocked', 'invalid_url'],
      `creating a loopback target was refused with an unexpected code ` +
        `"${discovery.error.code}" (${discovery.error.status}) — the guard must refuse it the ` +
        `way the spec fetcher does, or allow it under TRACEO_ALLOW_PRIVATE_TARGETS=1`,
    ).toContain(discovery.error.code);
    expect(discovery.error.status).toBe(422);
    expect(await api.webTargets.list(projectId)).toEqual([]);
    return null;
  }

  if (discovery.kind === 'failed') {
    expect(
      discovery.code,
      `the crawl failed with "${discovery.error}" — the credentials in this spec are the ones ` +
        `the fixture accepts, so the only failure this environment may legitimately produce is ` +
        `browser_discovery_unavailable`,
    ).toBe('browser_discovery_unavailable');
    return null;
  }

  return discovery.result;
}

/** The skip message a settled-but-not-exercised crawl reports (§16). */
const NOT_EXERCISED =
  'the authenticated crawl was not exercised in this environment — see the assertions above ' +
  '(a loopback target needs TRACEO_ALLOW_PRIVATE_TARGETS=1, and the sidecar needs node + ' +
  'Playwright with Chromium)';

test.describe('authenticated web-target crawl @critical @regression', () => {
  test('one sign-in reaches every page behind the login, and every case is grounded in the page it came from', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    const target = await startAuthenticatedWebTarget();
    try {
      await test.step('the fixture states nothing a browser did not render', () => {
        // The premise of every assertion below: these bytes carry no form, no
        // input and no button, so an inventory containing four forms cannot
        // have come from parsing HTML.
        expect(
          /<\s*(form|input|button)\b/i.test(target.servedHtml()),
          'the fixture served a form in its HTML — the crawl could then be passing without a browser',
        ).toBe(false);
      });

      // ONE create for the whole test: a second one would run a second crawl,
      // and "the login form was submitted exactly once" would then be false for
      // reasons that have nothing to do with the crawler.
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: CRAWL_TYPES,
        auth: { username: target.username, password: target.password },
        max_pages: MAX_PAGES,
      });

      if (discovery.kind !== 'refused') {
        // The 202 body is the first place a write-only credential could come
        // back out, so it is checked before anything else is read.
        expect(
          secretTraces(discovery.accepted, target.password),
          'the 202 acceptance echoed the password back',
        ).toEqual([]);
      }

      const result = await settleCrawl(discovery, api, project.id);
      if (result === null) {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      await test.step('the sign-in happened once, and the run says which proof of it fired', () => {
        const login = result.login ?? null;
        expect(login, 'the run reported no login outcome for a crawl that was given credentials')
          .not.toBeNull();
        expect(
          login?.succeeded,
          'the crawl reported a failed sign-in with the credentials the fixture accepts',
        ).toBe(true);
        expect(
          typeof login?.strategy === 'string' && login.strategy.trim().length > 0,
          `the run does not say WHICH success proof fired (strategy: ${JSON.stringify(login?.strategy)}) ` +
            `— "it worked" is not diagnosable when it stops working`,
        ).toBe(true);

        // The server's own account of the same event.
        const submissions = target.loginSubmissions();
        expect(
          submissions.length,
          `the login form was submitted ${submissions.length} time(s); the rule is exactly once`,
        ).toBe(1);
        expect(submissions[0].credentialsAccepted).toBe(true);
        expect(
          submissions[0].submittedFields,
          'the login submission did not carry both credential fields',
        ).toEqual(['password', 'username']);
      });

      await test.step('every page behind the login was read, each one with the session cookie', async () => {
        expect(
          target.visitedPagePaths().sort(),
          'the crawl did not read every page behind the login',
        ).toEqual([...CRAWL_PAGE_PATHS].sort());
        expect(
          pagesVisited(result),
          `the run says it visited ${pagesVisited(result)} page(s); the budget was ${MAX_PAGES} ` +
            `and the fixture has a login page plus exactly ${PAGES_BEHIND_LOGIN} pages behind it`,
        ).toBe(MAX_PAGES);

        // The cookie assertion is what separates "crawled the application" from
        // "crawled the login wall four times".
        expect(
          target.unauthenticatedBehindLogin(),
          'something behind the login was requested WITHOUT the session cookie — the crawl was ' +
            'reading the logged-out product',
        ).toEqual([]);

        for (const skip of pagesSkipped(result)) {
          expect(
            typeof skip.reason === 'string' && skip.reason.trim().length > 0,
            `the crawl skipped ${skip.url} without saying why`,
          ).toBe(true);
        }

        // The inventory's own summary and the job result are two views of one
        // crawl; they may not disagree about the budget that was asked for.
        const crawl = crawlOf(await api.webTargets.get(result.target_id));
        if (crawl.requested_max_pages !== undefined && crawl.requested_max_pages !== null) {
          expect(crawl.requested_max_pages).toBe(MAX_PAGES);
        }
        if (crawl.visited !== undefined && crawl.visited !== null) {
          expect(crawl.visited).toBe(pagesVisited(result));
        }
      });

      await test.step('the safety rule held: one form, nothing clicked, one origin', () => {
        const submissions = target.submissions();
        expect(
          submissions.map((r) => `${r.method} ${r.path} [${(r.submittedFields ?? []).join(',')}]`),
          'a form other than the login form was submitted — the ONE exception is exactly one',
        ).toEqual(['POST /login [password,username]']);

        expect(
          target.mutatingRequests().map((r) => `${r.method} ${r.path}`),
          'the crawl sent a non-GET request other than the single login submission',
        ).toEqual(['POST /login']);

        expect(
          target.forbiddenActivations().map((r) => `${r.method} ${r.path}`),
          `a forbidden control was activated (${CRAWL_FORBIDDEN_PATHS.join(', ')}) — the crawl ` +
            `logged itself out, reset something, or deleted an account`,
        ).toEqual([]);
      });

      await test.step('the credentials went in and nothing came back out', async () => {
        const detail = await api.webTargets.get(result.target_id);
        const listed = await api.webTargets.list(project.id);
        const row = listed.find((t) => t.id === result.target_id);

        expect(
          detail.auth_configured,
          'the target does not report that credentials are stored for it — the UI cannot then ' +
            'tell a crawl that will sign in from one that will not',
        ).toBe(true);
        expect(row?.auth_configured).toBe(true);
        if (detail.max_pages !== undefined) expect(detail.max_pages).toBe(MAX_PAGES);

        for (const [name, payload] of Object.entries({
          'the target detail': detail,
          'the target list': listed,
          'the job': discovery.kind === 'completed' ? discovery.job : null,
          'the persisted requirements': await api.ingestion.listRequirements(project.id),
          'the persisted cases': await api.review.list(project.id),
        })) {
          expect(
            secretTraces(payload, target.password),
            `${name} contains the password (write-only means it never comes back, in any encoding)`,
          ).toEqual([]);
          expect(
            secretTraces(payload, target.username),
            `${name} contains the username — the stored pair is write-only, both halves of it`,
          ).toEqual([]);
        }
      });

      await test.step('one requirement per form, per page, with page-scoped ids', async () => {
        const requirements = await api.ingestion.listRequirements(project.id);
        expect(
          requirements.length,
          `the run reported ${result.requirements} requirement(s); the project holds ` +
            `${requirements.length}`,
        ).toBe(result.requirements);

        const text = (r: (typeof requirements)[number]) =>
          `${r.description} ${r.source_text} ${JSON.stringify(r.acceptance_criteria)}`;
        const matched: string[] = [];
        for (const [path, selector] of Object.entries(PAGE_FIELD_SELECTORS)) {
          const owning = requirements.filter((r) => text(r).includes(selector));
          expect(
            owning.length,
            `no requirement names "${selector}" — the form on ${path} was never turned into a ` +
              `requirement, so that page was rendered and then thrown away`,
          ).toBeGreaterThan(0);
          matched.push(...owning.map((r) => r.external_id));
        }

        // Page-scoped, stable ids: four forms on four pages must not collapse
        // into one requirement because every page's first form is "form 1".
        expect(
          new Set(matched).size,
          `the four page forms produced ${new Set(matched).size} distinct requirement id(s) ` +
            `(${[...new Set(matched)].join(', ')}) — a form id that is not page-scoped means one ` +
            `page silently overwrites another`,
        ).toBe(Object.keys(PAGE_FIELD_SELECTORS).length);

        for (const requirement of requirements) {
          expect(
            requirement.external_id.startsWith('WEB-'),
            `requirement ${requirement.external_id} did not come from the web target, yet this ` +
              `project has no other source`,
          ).toBe(true);
          expect(
            ['extracted', 'confirmed'],
            `requirement ${requirement.id} landed in state "${requirement.state}"`,
          ).toContain(requirement.state);
        }
      });

      await test.step('the captured traffic is deduplicated across pages and templated', async () => {
        const dom = domEndpoints(await api.discovery.listEndpoints(project.id));
        expect(dom.length, 'no endpoint was persisted from the crawled traffic').toBeGreaterThan(0);
        expect(
          dom.length,
          `the run reported ${result.endpoints} endpoint(s); the inventory holds ${dom.length}`,
        ).toBe(result.endpoints);

        // Every page fetches this one. Four captures of the same operation are
        // one operation — counting them again per page would inflate the
        // inventory by the number of pages that load the app shell.
        const shared = dom.filter((e) => e.path === SHARED_XHR_PATH);
        expect(
          target.requestsTo(SHARED_XHR_PATH).length,
          `the fixture's shared endpoint was fetched ${target.requestsTo(SHARED_XHR_PATH).length} ` +
            `time(s) — fewer than the ${PAGES_BEHIND_LOGIN} pages that request it`,
        ).toBeGreaterThanOrEqual(PAGES_BEHIND_LOGIN);
        expect(
          shared.length,
          `${SHARED_XHR_PATH} was persisted ${shared.length} times — the same capture seen on the ` +
            `next page is the same fact, not a second endpoint`,
        ).toBe(1);

        for (const endpoint of dom) {
          expect(endpoint.path.startsWith('/'), `"${endpoint.path}" is not server-relative`).toBe(
            true,
          );
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

        // An endpoint the page DECLARED (a form action) is recorded without
        // being exercised: recording that a form posts to /app/profile is not
        // submitting it, and the fixture's log is what proves the difference.
        // The sign-in form's action is the ONE address this rule exempts,
        // because submitting that form once is the whole point; the steps above
        // and below pin its submissions to exactly one and prove no OTHER form
        // was sent.
        const loginPath = new URL(target.loginUrl).pathname;
        const declaredElsewhere = dom.filter(
          (e) => e.method.toUpperCase() !== 'GET' && e.path !== loginPath,
        );
        expect(
          declaredElsewhere.length,
          'no non-GET endpoint outside the login action was persisted, so the check below would ' +
            'have passed without looking at anything',
        ).toBeGreaterThan(0);
        for (const declared of declaredElsewhere) {
          expect(
            target.requestsTo(declared.path).filter((r) => r.method !== 'GET'),
            `a ${declared.method} endpoint was persisted for ${declared.path} AND a ${declared.method} ` +
              `request arrived there — a declared form action was submitted`,
          ).toEqual([]);
        }
      });

      await test.step('every generated case cites an artefact from a page the crawl actually visited', async () => {
        const detail = await api.webTargets.get(result.target_id);
        const endpoints = await api.discovery.listEndpoints(project.id);
        const oracle = buildOracle(detail, endpoints, target);
        const visitable = new Set([target.loginUrl, ...target.pageUrls]);

        expect(
          oracle.selectors.length + oracle.factIds.length + oracle.endpointKeys.length,
          'the crawled inventory is empty — every grounding assertion would pass vacuously',
        ).toBeGreaterThan(0);

        // Control: the matcher can fail. A case built entirely of fabricated
        // artefacts, including a fabricated page, must anchor to nothing.
        expect(
          caseAnchors(fabricatedCase(), oracle),
          'the grounding matcher anchored a fabricated case — every assertion below would be ' +
            'meaningless',
        ).toEqual([]);
        expect(
          citedPageUrls(fabricatedCase()).every((url) => !visitable.has(url)),
          'the page-citation reader accepted a page the crawl never visited',
        ).toBe(true);

        const requirementIds = (await api.ingestion.listRequirements(project.id)).map((r) => r.id);
        const cases = await api.review.list(project.id);
        expect(cases.length, 'the crawl persisted no case at all').toBeGreaterThan(0);

        let anchorsChecked = 0;
        let citedPages = 0;
        for (const listed of cases) {
          const testCase = await api.review.get(listed.id);
          expect(
            (testCase.steps ?? []).length,
            `case ${testCase.id} has no step to ground`,
          ).toBeGreaterThan(0);

          const anchors = caseAnchors(testCase, oracle);
          expect(
            anchors.length,
            `case ${testCase.id} ("${testCase.title}") references NOTHING the crawl found — not a ` +
              `selector, not a captured request, not a page ` +
              `(known selectors: ${oracle.selectors.slice(0, 6).join(', ')}; ` +
              `known endpoints: ${oracle.endpointKeys.slice(0, 6).join(', ')})`,
          ).toBeGreaterThan(0);
          anchorsChecked += anchors.length;

          // A case may only be about a page the crawl actually opened. One that
          // cites a page nobody visited was written from an assumption.
          for (const url of citedPageUrls(testCase)) {
            expect(
              visitable.has(url),
              `case ${testCase.id} cites page:${url}, which the crawl never visited ` +
                `(visited: ${[...visitable].join(', ')})`,
            ).toBe(true);
            citedPages += 1;
          }

          for (const step of apiStepKeys(testCase)) {
            expect(
              oracle.endpointKeys.includes(step.key) || oracle.paths.includes(step.path),
              `case ${testCase.id} step #${step.order} calls "${step.key}", which is neither a ` +
                `discovered endpoint nor a crawled page (fabricated identifier, BO-07)`,
            ).toBe(true);
          }

          for (const link of testCase.links) {
            expect(
              requirementIds,
              `case ${testCase.id} links to requirement ${link.id}, which is not this project's`,
            ).toContain(link.id);
          }
        }
        expect(anchorsChecked, 'the grounding oracle matched nothing anywhere').toBeGreaterThan(0);
        expect(
          citedPages,
          'not one case cited the page it came from — `page:<final_url>` is the artefact that ' +
            'makes a multi-page crawl traceable, and the check above passed only because nothing ' +
            'used it',
        ).toBeGreaterThan(0);
      });

      await test.step('the run counts what it persisted', async () => {
        for (const [name, value] of Object.entries({
          forms: result.forms,
          controls: result.controls,
          requests: result.requests,
          endpoints: result.endpoints,
          requirements: result.requirements,
          pages_visited: pagesVisited(result),
        })) {
          expect(isNonNegativeInteger(value), `result.${name} is not a count: ${value}`).toBe(true);
        }
        // One form per page — the sign-in form included, since the login page is
        // one of the pages the crawl reports.
        expect(
          result.forms,
          `the crawl reported ${result.forms} form(s) across ${MAX_PAGES} pages that each carry one`,
        ).toBeGreaterThanOrEqual(MAX_PAGES);

        const cases = await api.review.list(project.id);
        const byType = result.cases_by_type ?? {};
        expect(
          Object.keys(byType).sort(),
          'cases_by_type does not carry one key per requested test type',
        ).toEqual([...CRAWL_TYPES].sort());
        expect(
          cases.length,
          'the per-type case counts do not add up to the queue the run left behind',
        ).toBe(Object.values(byType).reduce((total, n) => total + n, 0));
      });
    } finally {
      await target.close();
    }
  });

  test('the page budget is a cap, and what it left out is reported with a reason', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);
    const budget = 2;

    const target = await startAuthenticatedWebTarget();
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional'],
        auth: { username: target.username, password: target.password },
        max_pages: budget,
      });

      const result = await settleCrawl(discovery, api, project.id);
      if (result === null) {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      expect(
        pagesVisited(result),
        `the budget was ${budget} but the run says it visited ${pagesVisited(result)} page(s) — ` +
          `a budget that is not a cap is a suggestion`,
      ).toBe(budget);
      // The login page spends one of the two, so exactly one page behind it is
      // read. A budget that quietly excluded the page the operator named would
      // not be a cap on the same thing the result counts.
      expect(
        target.visitedPagePaths().length,
        `the fixture served ${target.visitedPagePaths().length} pages behind the login for a ` +
          `budget of ${budget}, one of which the login page itself spends`,
      ).toBe(budget - 1);

      // The pages the budget left out are not free to vanish.
      const skipped = pagesSkipped(result);
      expect(
        skipped.length,
        `${MAX_PAGES - budget} page(s) were left unvisited and none of them was reported — a page ` +
          `that silently disappears is indistinguishable from a page that was never found`,
      ).toBeGreaterThan(0);
      for (const skip of skipped) {
        expect(
          typeof skip.reason === 'string' && skip.reason.trim().length > 0,
          `${skip.url} was skipped without a reason`,
        ).toBe(true);
        expect(
          skip.url.startsWith(target.origin) || skip.url.startsWith('http'),
          `a skipped entry carries "${skip.url}", which is not a URL`,
        ).toBe(true);
      }

      // The rule does not relax because the budget is smaller.
      expect(target.loginSubmissions().length).toBe(1);
      expect(target.mutatingRequests().map((r) => `${r.method} ${r.path}`)).toEqual(['POST /login']);
      expect(target.forbiddenActivations()).toEqual([]);
      expect(target.unauthenticatedBehindLogin()).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('a login page that publishes its own demo account is signed into without the operator supplying one', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    // The motivating target prints "Username : Admin / Password : admin123"
    // beside its form. A value that is rendered on the page is a fact about
    // the page — reading it is the same grounding rule as everything else here.
    const target = await startAuthenticatedWebTarget({ publishCredentials: true });
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional'],
        max_pages: 2,
      });

      const result = await settleCrawl(discovery, api, project.id);
      if (result === null) {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      expect(
        result.login?.succeeded,
        'the crawl did not sign in with the account the page prints on itself — the operator ' +
          'supplied nothing, so this page was reported as a locked front door',
      ).toBe(true);

      const submissions = target.loginSubmissions();
      expect(submissions.length, 'the login form was not submitted exactly once').toBe(1);
      expect(
        submissions[0].credentialSource,
        'the sign-in used something other than the credentials the page published',
      ).toBe('page');
      expect(
        target.visitedPagePaths().length,
        'nothing behind the login was read after signing in',
      ).toBeGreaterThan(0);
      expect(target.unauthenticatedBehindLogin()).toEqual([]);
      expect(target.forbiddenActivations()).toEqual([]);

      // No credentials were supplied, so none are stored.
      const detail = await api.webTargets.get(result.target_id);
      expect(
        detail.auth_configured ?? false,
        'the target claims stored credentials for a run the operator gave none to',
      ).toBe(false);
    } finally {
      await target.close();
    }
  });

  test('nothing is supplied and no budget is stated: the crawl explores by itself and says whose credentials it used', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    // The point of this one is everything it does NOT pass: no credentials, no
    // page budget, no flag saying the page needs a sign-in. An operator who
    // hands Traceo a URL is asking about the product, not about one screen,
    // and a default that stops at the first page does nothing until it is
    // asked to.
    const target = await startAuthenticatedWebTarget({ publishCredentials: true });
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional'],
      });

      const result = await settleCrawl(discovery, api, project.id);
      if (result === null) {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      expect(
        pagesVisited(result),
        `the crawl visited ${pagesVisited(result)} page(s) with no max_pages given — the default ` +
          `budget has to explore`,
      ).toBeGreaterThan(1);
      expect(
        target.visitedPagePaths().length,
        'the default budget read at most one page behind the login',
      ).toBeGreaterThan(1);

      // WHERE the credentials came from is the auditable half of signing in by
      // itself: "page" is a fact about the rendered screen and must be
      // reportable, where an operator's secret must not be described at all.
      expect(
        credentialsSource(result),
        'the run signed itself in and does not say where the credentials came from — a crawl ' +
          'that uses an account nobody handed it has to be auditable',
      ).toBe('page');

      const detail = await api.webTargets.get(result.target_id);
      if (detail.max_pages !== undefined) expect(detail.max_pages).toBe(DEFAULT_MAX_PAGES);
      expect(target.loginSubmissions().length).toBe(1);
      expect(target.forbiddenActivations()).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('the endpoint the login form DECLARES is recorded, though nothing was ever posted to it', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    // Nothing can sign in here, so nothing is ever submitted — which is what
    // makes this the sharp version of the claim: `POST /login` can only have
    // been read off the form's own `action` and `method`. A form states an
    // endpoint whether or not anybody sends anything to it, and that statement
    // is exactly as much a discovered artefact as a captured request is.
    const target = await startAuthenticatedWebTarget();
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional', 'api'],
      });

      const result = await settleCrawl(discovery, api, project.id);
      if (result === null) {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      expect(
        credentialsSource(result),
        'the run claims a credential source although nothing supplied or published one',
      ).toBeNull();

      const declared = endpointKey('POST', '/login');
      const dom = domEndpoints(await api.discovery.listEndpoints(project.id));
      expect(
        dom.map((e) => endpointKey(e.method, e.path)),
        `the login form declares action="/login" method="post"; no endpoint was recorded for it ` +
          `(got: ${dom.map((e) => endpointKey(e.method, e.path)).join(', ') || 'none'})`,
      ).toContain(declared);

      // Witnessed by the server: the declaration was READ, never exercised.
      expect(
        target.mutatingRequests().map((r) => `${r.method} ${r.path}`),
        'the endpoint was recorded by calling it — a declared endpoint is read off the form',
      ).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('a login page with no credentials anywhere is reported as needing one — never crawled anonymously', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    const target = await startAuthenticatedWebTarget();
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional'],
        max_pages: MAX_PAGES,
      });

      const result = await settleCrawl(discovery, api, project.id);
      if (result === null) {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      // Nothing was submitted and nothing behind the login was read: a crawl
      // that cannot sign in reads the public surface, and that is all.
      expect(
        target.loginSubmissions(),
        'the crawl submitted a login form with credentials it was never given',
      ).toEqual([]);
      expect(target.visitedPagePaths(), 'the crawl read pages behind a login it never passed').toEqual(
        [],
      );
      expect(
        target.unauthenticatedBehindLogin().map((r) => `${r.method} ${r.path}`),
        'the crawl asked for pages behind the login without a session — it was crawling the ' +
          'logged-out product',
      ).toEqual([]);

      // And it SAYS so. Reporting the sign-in screen as the application, with
      // no indication that everything else is behind it, is the one outcome
      // worse than failing: the counts read as "this product is nearly empty".
      const requirement = loginRequirement(result);
      expect(
        requirement.present,
        `the run found a login form and no credentials, and reported neither — result.login: ` +
          `${JSON.stringify(result.login)}, login_required: ${JSON.stringify(result.login_required)}`,
      ).toBe(true);
      expect(
        requirement.selectors.length,
        'the run says a sign-in is required but names no selector of the form that would unlock ' +
          'it — an apology instead of a finding',
      ).toBeGreaterThan(0);
      expect(result.login?.succeeded ?? false).toBe(false);
    } finally {
      await target.close();
    }
  });
});

test.describe('authenticated crawl refusals @regression', () => {
  test('credentials the site rejects fail the job with login_failed, naming neither half @negative', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    const target = await startAuthenticatedWebTarget();
    const wrongPassword = 'not-the-fixture-password-2f7a';
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional'],
        auth: { username: target.username, password: wrongPassword },
        max_pages: MAX_PAGES,
      });

      if (discovery.kind === 'refused') {
        expect(['ssrf_blocked', 'invalid_url']).toContain(discovery.error.code);
        test.skip(true, NOT_EXERCISED);
        return;
      }
      if (discovery.kind === 'completed') {
        throw new Error(
          'the crawl reported SUCCESS with credentials the site rejected — it crawled something, ' +
            `and it cannot have been the signed-in product (result: ${JSON.stringify(discovery.result)})`,
        );
      }
      if (discovery.code === 'browser_discovery_unavailable') {
        test.skip(true, NOT_EXERCISED);
        return;
      }

      expect(
        discovery.code,
        `a rejected sign-in must fail with login_failed; it failed with "${discovery.code}"`,
      ).toBe('login_failed');

      const message = discovery.error;
      expect(
        secretTraces(message, wrongPassword),
        'the failure message contains the password that was tried',
      ).toEqual([]);
      expect(
        secretTraces(message, target.username),
        'the failure message contains the username that was tried',
      ).toEqual([]);
      expect(
        /credential|sign.?in|log.?in/i.test(message),
        `the message does not say what was rejected: "${message}"`,
      ).toBe(true);
      // It may name both halves or neither, never exactly one: saying which of
      // the two was wrong is the enumeration identity.py refuses to do.
      const namesUsername = /user\s?name|username/i.test(message);
      const namesPassword = /password/i.test(message);
      expect(
        namesUsername === namesPassword,
        `the message singles out one half of the credential pair: "${message}"`,
      ).toBe(true);

      // It tried exactly once, was refused, and stopped. A crawl that fell back
      // to the logged-out product would show up here as pages behind the login.
      const submissions = target.loginSubmissions();
      expect(submissions.length, 'a rejected sign-in was retried').toBe(1);
      expect(submissions[0].credentialsAccepted).toBe(false);
      expect(
        target.visitedPagePaths(),
        'the crawl read pages behind the login after being refused entry',
      ).toEqual([]);
      expect(
        target.unauthenticatedBehindLogin(),
        'after the sign-in was refused the crawl went on browsing anonymously and would have ' +
          'reported the logged-out product as the product',
      ).toEqual([]);
      expect(target.forbiddenActivations()).toEqual([]);

      // The row stays, saying why, and nothing derived from a page it never
      // read was persisted.
      const targets = await api.webTargets.list(project.id);
      expect(targets.length, 'a failed crawl left no target row to explain itself').toBe(1);
      expect(targets[0].status).toBe('failed');
      expect(targets[0].error ?? '', 'the failed target row does not say why').toContain(
        'login_failed',
      );
      expect(
        secretTraces(targets, wrongPassword),
        'the stored target row carries the password that was refused',
      ).toEqual([]);
      expect(await api.ingestion.listRequirements(project.id)).toEqual([]);
      expect(await api.review.list(project.id)).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('a rejection that re-renders the login form is still a rejection, not a sign-in @negative', async ({
    api,
    project,
  }) => {
    test.setTimeout(CRAWL_TEST_TIMEOUT_MS);

    // THE REGRESSION THIS PINS. A real SPA answers a wrong password by
    // re-mounting its login form, and for that window the password field is not
    // in the DOM. "The password field is gone" is one of the three things the
    // crawler accepts as proof of a sign-in — so measured against the
    // motivating target, a wrong password produced login.succeeded = true and
    // the logged-out product was crawled and reported as the application. The
    // fixture now reproduces the transient, so the proof has to outlive it.
    const target = await startAuthenticatedWebTarget({ blankOnRejection: true });
    const wrongPassword = 'not-the-fixture-password-4b19';
    try {
      const discovery = await api.webTargets.createAndSettle(project.id, {
        url: target.loginUrl,
        viewport: VIEWPORT,
        test_types: ['functional'],
        auth: { username: target.username, password: wrongPassword },
        max_pages: MAX_PAGES,
      });

      if (discovery.kind === 'refused') {
        expect(['ssrf_blocked', 'invalid_url']).toContain(discovery.error.code);
        test.skip(true, NOT_EXERCISED);
        return;
      }
      if (discovery.kind === 'completed') {
        throw new Error(
          'a sign-in the site REFUSED was reported as successful — the crawl believed a form ' +
            'that was merely re-rendering, and everything it went on to describe is the ' +
            `logged-out product (result: ${JSON.stringify(discovery.result)})`,
        );
      }
      if (discovery.code === 'browser_discovery_unavailable') {
        test.skip(true, NOT_EXERCISED);
        return;
      }
      expect(
        discovery.code,
        `a rejected sign-in must fail with login_failed; it failed with "${discovery.code}"`,
      ).toBe('login_failed');
      expect(
        secretTraces(discovery.error, wrongPassword),
        'the failure message contains the password that was tried',
      ).toEqual([]);

      // The oracle that makes this test capable of failing: the fixture really
      // did serve the blanking page, and it really did leave the form off long
      // enough for the transient to be observable.
      const submissions = target.loginSubmissions();
      expect(submissions.length, 'the login form was not submitted exactly once').toBe(1);
      expect(submissions[0].credentialsAccepted).toBe(false);
      expect(
        target.visitedPagePaths(),
        'the crawl read pages behind the login after being refused entry',
      ).toEqual([]);
      expect(target.unauthenticatedBehindLogin()).toEqual([]);
      expect(target.forbiddenActivations()).toEqual([]);
    } finally {
      await target.close();
    }
  });

  test('a page budget outside 1..50 is refused with 422 invalid_max_pages naming the window @negative', async ({
    api,
    project,
  }) => {
    for (const pages of [0, 51]) {
      const error = await expectApiError(
        api.webTargets.create(project.id, {
          url: UNREACHED_PUBLIC_URL,
          viewport: VIEWPORT,
          test_types: ['functional'],
          max_pages: pages,
        }),
        { status: 422, code: 'invalid_max_pages' },
      );
      // The refusal has to state the window, or the caller is left guessing
      // which end of it they hit.
      expect(
        error.errors,
        `invalid_max_pages for ${pages} did not name the legal window: ${JSON.stringify(error.errors)}`,
      ).toEqual(['1', '50']);
    }
    expect(await api.webTargets.list(project.id)).toEqual([]);
  });

  test('a blank half of the credential pair is refused with 422 invalid_credentials @negative', async ({
    api,
    project,
  }) => {
    for (const auth of [
      { username: '', password: 'a-password' },
      { username: 'a-user', password: '' },
      { username: '   ', password: 'a-password' },
    ]) {
      const error = await expectApiError(
        api.webTargets.create(project.id, {
          url: UNREACHED_PUBLIC_URL,
          viewport: VIEWPORT,
          test_types: ['functional'],
          auth,
        }),
        { status: 422, code: 'invalid_credentials' },
      );
      // Half a credential is not a credential, and the refusal must not say
      // WHICH half was blank — the same rule the failed sign-in obeys.
      expect(
        secretTraces([error.message, ...error.errors], 'a-password'),
        'the refusal echoed the password that was sent',
      ).toEqual([]);
    }
    expect(await api.webTargets.list(project.id)).toEqual([]);
  });
});

test.describe('target page — sign in first @regression', () => {
  test('the credential fields are collapsed until asked for, and the password never leaves the field', async ({
    asQaLead,
    project,
  }) => {
    const targetPage = new TargetPage(asQaLead);
    const secret = 'ui-typed-password-8c31';

    await targetPage.goto(project.id);
    await expect(targetPage.root).toBeVisible({ timeout: 20_000 });
    await expect(targetPage.authSection).toBeVisible();

    // Collapsed on first paint: a credential field on a screen that does not
    // need one invites a real password into a tool that never asked for it.
    await expect(targetPage.authToggle).not.toBeChecked();
    await expect(targetPage.authUsernameInput).toBeHidden();
    await expect(targetPage.authPasswordInput).toBeHidden();
    // The crawl width is not a credential and does not hide with them.
    await expect(targetPage.maxPagesInput).toBeVisible();

    await targetPage.fillCredentials('some-operator', secret);
    await expect(targetPage.authPasswordInput).toHaveAttribute('type', 'password');
    await expect(targetPage.authHint).toBeVisible();

    // A secret in an address bar ends up in history, in a referrer, in a
    // screenshot and in a server log; one in localStorage outlives the tab.
    const state = await targetPage.clientSideState();
    for (const [where, value] of Object.entries(state)) {
      expect(
        secretTraces(value, secret),
        `the typed password reached ${where} — it may exist in the field and nowhere else`,
      ).toEqual([]);
    }

    // Unticking the section is not decoration: it clears what was typed, so a
    // launcher that no longer shows a password cannot still send one.
    await targetPage.authToggle.uncheck();
    await targetPage.authToggle.check();
    await expect(targetPage.authPasswordInput).toHaveValue('');
  });

  test('a viewer never sees the credential fields at all @permission', async ({
    asViewer,
    project,
  }) => {
    const targetPage = new TargetPage(asViewer);

    await targetPage.goto(project.id);
    // Settle an anchor that renders for EVERY role first: gated controls mount
    // only after the client resolves the role post-hydration, so a hidden
    // assertion made earlier would pass vacuously (permissions-ui.spec.ts).
    await expect(targetPage.designSection).toBeVisible({ timeout: 20_000 });

    await expect(targetPage.authSection).toBeHidden();
    await expect(targetPage.authToggle).toBeHidden();
    await expect(targetPage.authPasswordInput).toBeHidden();
    await expect(targetPage.maxPagesInput).toBeHidden();
  });
});
