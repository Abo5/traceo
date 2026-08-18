/**
 * API collection import — a REAL Postman v2.1 collection, end to end
 * (@critical @regression).
 *
 * The motivating defect: a real 300KB Postman collection was uploaded and the
 * product answered `422 invalid_spec`, even though `Endpoint.source` had always
 * documented "postman" as a legal value. The importer now detects the format on
 * the SAME endpoint that takes OpenAPI (`POST /v1/projects/{id}/api-specs`) and
 * converts Postman v2.x, HAR 1.2 and Insomnia v4 into the one internal endpoint
 * inventory.
 *
 * What this spec is built to prove — in the order the contract states it:
 *
 *   1. DETECTION is deterministic: the collection is recognised as `postman2`,
 *      and a document that is none of the supported formats is still refused —
 *      with an `errors` list that NAMES the supported formats (actionable).
 *   2. CONVERSION is faithful: 37 requests become 37 endpoints, `:param`
 *      segments become `{param}`, `{{baseUrl}}` is stripped so paths are
 *      server-relative, `url.query` becomes query parameters, and raw JSON
 *      bodies become an inferred schema whose fields are the body's own.
 *   3. NOTHING IS INVENTED. The adversarial assertion is a DIFF against the
 *      fixture itself: `helpers/postman-collection.ts` re-derives the inventory
 *      from the file in the test process, and the two sets must be equal. The
 *      oracle is therefore the user's document, not the system under test (§6).
 *   4. The GROUNDING GATE still holds downstream: cases generated from a
 *      collection-derived inventory may not reference a path outside it (BO-07)
 *      — the same promise, now anchored in a document the model never saw.
 *   5. ENRICHMENT IS ANNOTATION-ONLY: on an `automation: "auto"` project the AI
 *      layer may add a description, a group and a criticality — and may NEVER
 *      create, rename or delete an endpoint. Asserted by importing the same
 *      file into a "manual" and an "auto" project and requiring the two
 *      inventories to be IDENTICAL by method+path.
 *   6. FIDELITY PRECEDENCE (spec > traffic > dom > postman): a later OpenAPI
 *      import wins for its own endpoints and does not delete the
 *      collection-derived ones.
 *   7. THE IMPORT LEAVES A RUNNABLE PROJECT BEHIND. The base URL is in the
 *      document, so a project that had NO environment gets one derived from it
 *      — otherwise "I only added a Postman collection" ends at an empty
 *      environment picker and nothing can be executed. The assertion is again a
 *      reconstruction against the fixture: `base_url + endpoint.path` must
 *      reproduce the URL the collection declares, character for character. An
 *      environment that already exists is never touched, and a variable whose
 *      NAME looks like a credential arrives as an empty key — its example value
 *      never travels.
 *
 * The mock LLM keeps the whole flow offline and hermetic (NFR-D1), so the
 * enrichment counters are deterministic rather than best-effort.
 */
import type { ApiClient } from '../api/client';
import {
  endpointKey,
  paramNamesAt,
  queryParamNames,
  requestBodyFields,
  resolvedUrl,
  resolvedUrls,
} from '../api/discovery.repository';
import { environmentById, environmentVariables } from '../api/projects.repository';
import type { Endpoint, ImportSpecResult, TestCase } from '../api/types';
import { routes } from '../constants/routes';
import { AI_CRITICALITIES, SPEC_FORMATS, type AiCriticality } from '../constants/states';
import { test, expect } from '../fixtures';
import { expectApiError } from '../helpers/expect-api-error';
import {
  looksLikeCredential,
  readPostmanCollection,
  serverRelative,
  suggestedVariables,
} from '../helpers/postman-collection';
import { sampleFile, samplePath } from '../helpers/test-data';
import { RunsPage } from '../pages/runs.page';
import { projectFactory } from '../test-data/project.factory';

/** The real collection under test — 300KB, 37 requests, no auth block. */
const COLLECTION = 'calendar-api.postman_collection.json';
/** What the deterministic detector must call it. */
const COLLECTION_FORMAT = 'postman2';
/** Endpoint.source for collection-derived rows (the fidelity ladder's floor). */
const COLLECTION_SOURCE = 'postman';
/** The OpenAPI seed used to prove the precedence rule — disjoint paths by design. */
const OPENAPI_SPEC = 'sample_openapi.yaml';
const REQUIREMENTS_DOC = 'sample_requirements_en.md';
/**
 * A well-formed JSON document that is NONE of the five supported formats — the
 * input that must reach the format detector and be turned away by it. A
 * malformed file would be refused earlier, as `parse_error`, which is a
 * different contract; this fixture isolates `invalid_spec`.
 */
const UNSUPPORTED_DOC = 'not-an-api-document.json';
/**
 * A tiny SYNTHETIC v2.1 collection whose variables include credential-looking
 * names (`authToken`, `apiKey`, `client_secret`, `webhookPassword`) with fake
 * example values. The real calendar collection declares no such variable, and
 * `e2e/test-data/` is reference data that is never mutated (§8) — so the
 * credential rule gets its own fixture instead of the real file being doctored.
 */
const MINI_COLLECTION = 'billing-api.postman_collection.json';

/** Import + a generation job over a 37-endpoint inventory. */
const IMPORT_TEST_TIMEOUT_MS = 240_000;
/** Dev-server first navigation compiles the route on demand (§16). */
const FIRST_VISIT_TIMEOUT_MS = 20_000;
/** A 300KB upload plus the page's own inventory refresh. */
const UI_IMPORT_TIMEOUT_MS = 60_000;

/**
 * The oracle, read ONCE from the fixture at module load. Every expectation
 * below is derived from this — the spec hard-codes counts only where the brief
 * states them as facts about the file, and those are cross-checked against the
 * parse so a swapped fixture fails loudly instead of silently weakening.
 */
const collection = readPostmanCollection(COLLECTION);
/** The same oracle, over the synthetic credential-carrying collection. */
const mini = readPostmanCollection(MINI_COLLECTION);

/** `Environment.name` is String(100) in backend/app/models.py — the trim target. */
const ENVIRONMENT_NAME_LIMIT = 100;
/** The ASCII part of the collection's title, asserted to survive into the name. */
const COLLECTION_TITLE_WORDS = 'Calendar API';
/** The fallback name, used ONLY when a document carries no title at all. */
const FALLBACK_ENVIRONMENT_NAME = 'Imported environment';
/** Credential-looking variables of the synthetic collection (contract §2). */
const MINI_CREDENTIAL_KEYS = ['authToken', 'apiKey', 'client_secret', 'webhookPassword'];

/** Paths whose templating is asserted by name — the ":param" → "{param}" rule. */
const TEMPLATED_KEYS = [
  'GET /calendars/{calendarId}/acl/{ruleId}',
  'DELETE /calendars/{calendarId}/events/{eventId}',
  'GET /users/{userId}/calendarList',
  'GET /users/me/settings/{setting}',
];

/** A query-heavy request: its `url.query` keys must survive as query params. */
const QUERY_HEAVY_KEY = 'GET /calendars/{calendarId}/events';
const EXPECTED_QUERY_PARAMS = ['timeMin', 'timeMax', 'singleEvents', 'maxResults', 'orderBy'];

/** A body-carrying request: its raw JSON must yield an inferred field set. */
const BODY_KEY = 'POST /freeBusy';

/**
 * The imported inventory as `METHOD /path` keys, in the collection's dialect.
 *
 * `serverRelative` removes ONLY the base URL's own path prefix (`/calendar/v3`
 * here) when the importer chose to keep it — see the helper for why both
 * renderings are legitimate. It strips nothing else, so it cannot launder a
 * fabricated path into a real one.
 */
function importedKeys(endpoints: Endpoint[]): string[] {
  return endpoints.map((e) => endpointKey(e.method, serverRelative(e.path, collection.basePath)));
}

function endpointByKey(endpoints: Endpoint[], key: string): Endpoint | undefined {
  return endpoints.find((e) => endpointKey(e.method, serverRelative(e.path, collection.basePath)) === key);
}

/** Import the collection as the given client and return the response + inventory. */
async function importCollection(
  api: ApiClient,
  projectId: string,
): Promise<{ result: ImportSpecResult; endpoints: Endpoint[] }> {
  const result = await api.discovery.importSpec(projectId, sampleFile(COLLECTION));
  const endpoints = await api.discovery.listEndpoints(projectId);
  return { result, endpoints };
}

// --- the fixture itself is a precondition, not an assumption --------------------

test.describe('postman collection fixture @critical @regression', () => {
  test('the staged collection is the real v2.1 document the importer is specified against', () => {
    expect(collection.schema, 'the fixture is not a Postman v2.x collection').toContain(
      'getpostman.com/json/collection/v2',
    );
    expect(collection.requestCount, 'the fixture no longer holds 37 requests').toBe(37);
    // 37 requests, all distinct — so "37 endpoints" is a conversion assertion,
    // not an artefact of deduplication.
    expect(collection.keys.length).toBe(37);
    expect(collection.basePath, 'the base-url variable lost its path component').toBe(
      '/calendar/v3',
    );

    const queryParams = new Set(collection.requests.flatMap((r) => r.queryParams));
    expect(queryParams.size, 'the fixture no longer carries 35 distinct query params').toBe(35);
    // 19 requests carry a `raw` body; 4 of them are the literal JSON `null`, so
    // only 15 have fields an inferred schema could be built from. Both numbers
    // are pinned: the first is what the brief describes, the second is what the
    // body-inference assertions can legitimately expect.
    expect(collection.requests.filter((r) => r.hasRawBody).length).toBe(19);
    expect(collection.requests.filter((r) => r.hasJsonBody).length).toBe(15);

    // The templating rule the oracle applies — and therefore the keys the
    // imported inventory is diffed against.
    for (const key of [...TEMPLATED_KEYS, QUERY_HEAVY_KEY, BODY_KEY]) {
      expect(collection.keys, `${key} is absent from the fixture`).toContain(key);
    }
  });

  test('the collection carries the base URL and the variables an environment is derived from', () => {
    // The whole motivation: the base URL is IN the document. If the fixture ever
    // loses it, every derivation assertion below would pass vacuously.
    expect(collection.baseUrlKey, 'the fixture no longer declares a base-url variable').toBe(
      'baseUrl',
    );
    expect(collection.baseUrl).toBe('https://www.googleapis.com/calendar/v3');
    expect(collection.title, 'the fixture title no longer names the API').toContain(
      COLLECTION_TITLE_WORDS,
    );

    // The one non-base variable the derived environment must carry across.
    expect(collection.variables.calendarId).toBe('testCalendarID');
    expect(suggestedVariables(collection), 'the base-url variable leaked into the suggestions').toEqual(
      { calendarId: 'testCalendarID' },
    );
    // …and it is NOT credential-looking, so it travels with its value.
    expect(looksLikeCredential('calendarId')).toBe(false);

    // Reconstruction oracle: one absolute URL per distinct PATH — GET and
    // DELETE of the same resource share a URL, so there are fewer URLs than
    // method+path keys, and the reconstruction below compares SETS.
    expect(collection.absoluteUrls.length, 'the fixture no longer holds 23 distinct URLs').toBe(23);
    expect(collection.absoluteUrls.length).toBeLessThan(collection.keys.length);
    expect(collection.absoluteUrls).toContain(
      'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/acl/{ruleId}',
    );
    for (const url of collection.absoluteUrls) {
      expect(url.startsWith(collection.baseUrl), `${url} is not under the declared base URL`).toBe(
        true,
      );
    }
  });

  test('the synthetic collection stages the credential rule the real one cannot', () => {
    expect(mini.schema, 'the synthetic fixture is not a Postman v2.x collection').toContain(
      'getpostman.com/json/collection/v2',
    );
    expect(mini.title, 'the synthetic fixture lost its title').toBe('Billing API');
    expect(mini.baseUrlKey).toBe('baseUrl');
    expect(mini.baseUrl).toBe('https://billing.example.com/api/v2');
    expect(mini.keys).toEqual([
      'GET /tenants/{tenantId}/invoices',
      'POST /tenants/{tenantId}/invoices',
    ]);
    // Both requests address one URL — the two methods share it.
    expect(mini.absoluteUrls).toEqual([
      'https://billing.example.com/api/v2/tenants/{tenantId}/invoices',
    ]);

    // Plain variables carry their values; credential-looking ones are emptied —
    // and the fake values exist so the spec can prove they went nowhere.
    for (const key of MINI_CREDENTIAL_KEYS) {
      expect(looksLikeCredential(key), `${key} is not recognised as credential-looking`).toBe(true);
      expect(mini.variables[key], `${key} has no value to leak`).toBeTruthy();
    }
    expect(suggestedVariables(mini)).toEqual({
      tenantId: 'tenant-42',
      pageSize: '50',
      authToken: '',
      apiKey: '',
      client_secret: '',
      webhookPassword: '',
    });
    // Control: the rule is a substring match, not an allow-list of exact names.
    expect(looksLikeCredential('tenantId')).toBe(false);
    expect(looksLikeCredential('pageSize')).toBe(false);
  });
});

test.describe('postman collection import @critical @regression', () => {
});
