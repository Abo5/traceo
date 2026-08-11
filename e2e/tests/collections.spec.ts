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
import { EndpointsPage } from '../pages/endpoints.page';
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
  test('a real Postman v2.1 collection imports as a faithful endpoint inventory', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const { result, endpoints } = await importCollection(api, project.id);

    await test.step('the format detector names the document, on the OpenAPI endpoint', async () => {
      expect(SPEC_FORMATS, `unknown format "${result.format}"`).toContain(result.format);
      expect(result.format).toBe(COLLECTION_FORMAT);
    });

    await test.step('37 requests become 37 endpoints — counters agree with the inventory', async () => {
      expect(result.endpoints_count).toBe(collection.keys.length);
      expect(result.total).toBe(collection.keys.length);
      // A fresh project: everything is new, nothing changed, nothing removed.
      expect(result.added).toBe(collection.keys.length);
      expect(result.updated).toBe(0);
      expect(result.removed).toBe(0);
      // The flat counters and the legacy `diff` lists are two views of one fact.
      expect(result.diff.added.length).toBe(result.added);
      expect(result.diff.removed.length).toBe(result.removed);
      expect(result.diff.changed.length).toBe(result.updated);

      expect(endpoints.length).toBe(collection.keys.length);
      for (const endpoint of endpoints) {
        expect(endpoint.source, `endpoint ${endpoint.method} ${endpoint.path} is not marked as collection-derived`).toBe(
          COLLECTION_SOURCE,
        );
      }
    });

    await test.step('path templating: ":param" became "{param}" and no variable leaked through', async () => {
      const keys = importedKeys(endpoints);
      for (const key of TEMPLATED_KEYS) {
        expect(keys, `${key} is missing or was not templated`).toContain(key);
      }
      for (const endpoint of endpoints) {
        expect(endpoint.path, `":param" survived in ${endpoint.path}`).not.toContain(':');
        expect(endpoint.path, `an unresolved {{variable}} survived in ${endpoint.path}`).not.toContain('{{');
        expect(endpoint.path, `${endpoint.path} is not server-relative`).not.toContain('://');
        expect(endpoint.path.startsWith('/'), `${endpoint.path} is not rooted`).toBe(true);
      }
    });

    await test.step('query parameters come from url.query, with headers kept out of them', async () => {
      const endpoint = endpointByKey(endpoints, QUERY_HEAVY_KEY);
      expect(endpoint, `${QUERY_HEAVY_KEY} did not survive the import`).toBeDefined();

      const imported = queryParamNames(endpoint!);
      for (const name of EXPECTED_QUERY_PARAMS) {
        expect(imported, `${QUERY_HEAVY_KEY} lost query param "${name}"`).toContain(name);
      }
      // Every recorded query param is one the file actually declares — the
      // converter may drop, but never add.
      const declared = collection.requests.find((r) => r.key === QUERY_HEAVY_KEY)!.queryParams;
      for (const name of imported) {
        expect(declared, `query param "${name}" is not in the collection`).toContain(name);
      }

      // Path parameters are captured as such, not folded into the query.
      expect(paramNamesAt(endpoint!, 'path')).toContain('calendarId');
      // ...and the transport headers the requests carry are not query params.
      expect(imported).not.toContain('Accept');
      expect(imported).not.toContain('Content-Type');
    });

    await test.step('a raw JSON body yields an inferred schema built from the body itself', async () => {
      const endpoint = endpointByKey(endpoints, BODY_KEY);
      expect(endpoint, `${BODY_KEY} did not survive the import`).toBeDefined();
      expect(endpoint!.request_schema, `${BODY_KEY} produced no request schema`).not.toBeNull();

      const inferred = requestBodyFields(endpoint!);
      const declared = collection.requests.find((r) => r.key === BODY_KEY)!.bodyFields;
      expect(declared.length, 'the fixture body has no fields to infer from').toBeGreaterThan(0);

      for (const field of declared) {
        expect(inferred, `${BODY_KEY} lost body field "${field}"`).toContain(field);
      }
      // The inverse is the one that matters: NO invented field.
      for (const field of inferred) {
        expect(declared, `${BODY_KEY} gained body field "${field}", which the collection never declares`).toContain(
          field,
        );
      }
    });

    // --- ADVERSARIAL GROUNDING ASSERTION (the product's core promise) ---------
    // The oracle is the uploaded document, re-parsed in this process. Sets are
    // compared verbatim — no fuzzy matching, no "close enough".
    await test.step('every imported endpoint exists in the collection file, and vice versa', async () => {
      const imported = [...new Set(importedKeys(endpoints))].sort();
      const declared = [...collection.keys].sort();

      // Control: prove the oracle CAN fail — otherwise everything below is
      // vacuous.
      expect(declared).not.toContain('POST /__traceo_fabricated__/{id}');
      expect(declared).not.toContain('POST /colors'); // real path, wrong method

      const invented = imported.filter((key) => !declared.includes(key));
      expect(
        invented,
        `the importer produced endpoints the collection never declares (fabricated identifiers, BO-07):\n` +
          invented.map((k) => `  - ${k}`).join('\n'),
      ).toEqual([]);

      const dropped = declared.filter((key) => !imported.includes(key));
      expect(
        dropped,
        `the importer silently dropped requests the collection declares:\n` +
          dropped.map((k) => `  - ${k}`).join('\n'),
      ).toEqual([]);

      expect(imported).toEqual(declared);
    });
  });

  test('cases generated from a collection-derived inventory stay inside it', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    // Generation needs both halves of the grounding: confirmed requirements to
    // trace to, and an endpoint inventory to build steps from. Here the second
    // half comes from a Postman collection instead of an OpenAPI spec — the
    // gate must not care where the inventory came from.
    await api.ingestion.uploadAndConfirm(project.id, sampleFile(REQUIREMENTS_DOC));
    const { result, endpoints } = await importCollection(api, project.id);
    expect(result.endpoints_count).toBe(collection.keys.length);

    const inventory = endpoints.filter((e) => !e.excluded).map((e) => endpointKey(e.method, e.path));
    const endpointIds = endpoints.map((e) => e.id);
    expect(inventory.length, 'empty inventory — the oracle would be vacuous').toBeGreaterThan(0);

    const jobResult = await api.generation.generateAndWaitForResult(project.id);

    await test.step('the run reports what it persisted and what the gate discarded', async () => {
      expect(Number.isInteger(jobResult.generated)).toBe(true);
      expect(jobResult.generated).toBeGreaterThanOrEqual(0);
      expect(jobResult.discarded).toBeGreaterThanOrEqual(0);
      // The requirements document describes a different API than the calendar
      // collection, so the honest outcomes are "grounded cases" or "discarded
      // proposals" — never "cases against invented paths". Something must have
      // happened either way, or the run was a silent no-op.
      expect(
        jobResult.generated + jobResult.discarded,
        'the generation run neither persisted nor discarded anything',
      ).toBeGreaterThan(0);
    });

    // --- THE GROUNDING GATE, ON A COLLECTION-DERIVED INVENTORY ---------------
    await test.step('no step of any generated case references a path outside the inventory', async () => {
      // Control: the oracle is falsifiable.
      expect(inventory).not.toContain(endpointKey('POST', '/__traceo_fabricated__/{id}'));

      const cases = await api.review.list(project.id);
      let stepsChecked = 0;

      for (const listed of cases) {
        const detail: TestCase = await api.review.get(listed.id);
        for (const step of detail.steps ?? []) {
          const key = endpointKey(step.method ?? '', step.path ?? '');
          expect(
            inventory,
            `case ${detail.id} step #${step.order} calls "${key}" — absent from the inventory ` +
              `imported from ${COLLECTION} (fabricated identifier, BO-07)`,
          ).toContain(key);
          if (step.endpoint_id != null) {
            expect(
              endpointIds,
              `case ${detail.id} step #${step.order} references endpoint ${step.endpoint_id}, ` +
                `which is not an endpoint of this project`,
            ).toContain(step.endpoint_id);
          }
          stepsChecked += 1;
        }
      }

      // Non-vacuity: if the model produced nothing groundable, the gate must
      // have said so out loud rather than the run having quietly done nothing.
      if (stepsChecked === 0) {
        expect(
          jobResult.discarded,
          'no case reached a step AND nothing was discarded — the gate was never exercised',
        ).toBeGreaterThan(0);
      }
    });

    await test.step('the import did not disturb the inventory it grounded the run in', async () => {
      const after = await api.discovery.listEndpoints(project.id);
      expect([...new Set(importedKeys(after))].sort()).toEqual([...collection.keys].sort());
    });
  });

  test('AI enrichment annotates the inventory and can never change it', async ({ api }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    // Enrichment is gated on the EXISTING automation flag — no new switch. Two
    // projects, one file: "manual" is the deterministic control, "auto" is the
    // enriched subject. Their inventories must be indistinguishable.
    const lead = api.as('qa_lead');
    const control = await lead.projects.create(projectFactory({ automation: 'manual' }));
    const subject = await lead.projects.create(projectFactory({ automation: 'auto' }));

    const controlImport = await importCollection(api, control.id);
    const subjectImport = await importCollection(api, subject.id);

    await test.step('the import succeeds either way and reports both enrichment counters', async () => {
      for (const { result } of [controlImport, subjectImport]) {
        expect(result.format).toBe(COLLECTION_FORMAT);
        expect(result.endpoints_count).toBe(collection.keys.length);
        expect(Number.isInteger(result.enriched), 'enriched is not a count').toBe(true);
        expect(Number.isInteger(result.enrichment_discarded), 'enrichment_discarded is not a count').toBe(true);
        // Nothing can be enriched that was not in the deterministic inventory.
        expect(result.enriched).toBeLessThanOrEqual(collection.keys.length);
      }

      // A "manual" project asks the model for nothing at all — the existing
      // automation flag is the whole gate, there is no second switch.
      expect(controlImport.result.enriched, 'enrichment ran on a manual project').toBe(0);
      expect(controlImport.result.enrichment_discarded).toBe(0);

      // Under the mandated deterministic mock provider (§8) the enrichment step
      // is reproducible, so this is an equality, not a "greater than zero":
      // every endpoint is annotated and the gate has nothing to refuse. That
      // makes the counters a real oracle instead of a shrug.
      expect(subjectImport.result.enriched, 'the auto project was not enriched').toBe(
        collection.keys.length,
      );
      expect(
        subjectImport.result.enrichment_discarded,
        'the gate discarded annotations the deterministic mock should have grounded',
      ).toBe(0);
    });

    await test.step('enrichment created, renamed and deleted nothing', async () => {
      const controlKeys = [...new Set(importedKeys(controlImport.endpoints))].sort();
      const subjectKeys = [...new Set(importedKeys(subjectImport.endpoints))].sort();

      expect(
        subjectKeys,
        'the enriched inventory differs from the deterministic one — enrichment altered an endpoint',
      ).toEqual(controlKeys);
      expect(subjectKeys).toEqual([...collection.keys].sort());

      // Param names are part of the grounding surface too: enrichment may not
      // rename one.
      for (const key of [QUERY_HEAVY_KEY, BODY_KEY]) {
        const before = endpointByKey(controlImport.endpoints, key)!;
        const after = endpointByKey(subjectImport.endpoints, key)!;
        expect(queryParamNames(after).sort(), `query params of ${key} changed under enrichment`).toEqual(
          queryParamNames(before).sort(),
        );
        expect(requestBodyFields(after).sort(), `body fields of ${key} changed under enrichment`).toEqual(
          requestBodyFields(before).sort(),
        );
      }
    });

    await test.step('what the model returned is stored as plain annotations only', async () => {
      const annotated = subjectImport.endpoints.filter(
        (e) => e.ai_description != null || e.ai_group != null || e.ai_criticality != null,
      );
      // The counter and the rows must tell the same story.
      expect(annotated.length, 'the counter and the persisted rows disagree').toBe(
        subjectImport.result.enriched,
      );

      for (const endpoint of annotated) {
        const where = `${endpoint.method} ${endpoint.path}`;

        expect(AI_CRITICALITIES, `${where} carries criticality "${endpoint.ai_criticality}"`).toContain(
          endpoint.ai_criticality as AiCriticality,
        );

        expect(typeof endpoint.ai_description, `${where} has a non-string description`).toBe('string');
        expect(endpoint.ai_description!.length, `${where} has an empty description`).toBeGreaterThan(0);
        // Plain text only: a description is prose the UI prints, never markup
        // and never something a locator could be built from.
        expect(endpoint.ai_description, `${where} smuggled markup into its description`).not.toContain('<');

        expect(typeof endpoint.ai_group, `${where} has a non-string group`).toBe('string');
        expect(endpoint.ai_group!.length, `${where} has an empty group`).toBeGreaterThan(0);
      }

      // The deterministic control carries no annotations at all — which is what
      // makes the comparison above a controlled experiment rather than a guess.
      for (const endpoint of controlImport.endpoints) {
        expect(endpoint.ai_description).toBeNull();
        expect(endpoint.ai_group).toBeNull();
        expect(endpoint.ai_criticality).toBeNull();
      }
    });
  });

  test('a later OpenAPI import outranks the collection without deleting it', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const { endpoints: fromCollection } = await importCollection(api, project.id);
    const collectionKeys = [...new Set(importedKeys(fromCollection))].sort();

    const spec = await api.discovery.importSpec(project.id, sampleFile(OPENAPI_SPEC));
    expect(spec.format).toBe('openapi3');
    expect(spec.endpoints_count).toBeGreaterThan(0);
    // The collection import already left an environment behind, so the second
    // import fills no void and creates nothing.
    expect(
      spec.environment_created,
      'a second import created another environment for the same project',
    ).toBeNull();
    expect((await api.projects.listEnvironments(project.id)).length).toBe(1);

    const after = await api.discovery.listEndpoints(project.id);
    const afterKeys = [...new Set(importedKeys(after))].sort();

    await test.step('fidelity precedence spec > traffic > dom > postman', async () => {
      // The higher-fidelity import owns its own endpoints…
      const specRows = after.filter((e) => e.source === 'spec');
      expect(specRows.length, 'the OpenAPI import produced no spec-sourced endpoint').toBeGreaterThan(0);

      // …and the lower-fidelity ones it says nothing about survive untouched.
      for (const key of collectionKeys) {
        expect(afterKeys, `${key} was deleted by an unrelated OpenAPI import`).toContain(key);
      }
      const survivors = after.filter((e) => e.source === COLLECTION_SOURCE);
      expect(survivors.length).toBe(collection.keys.length);

      // The two imports describe disjoint APIs, so the inventory is exactly
      // their union — nothing merged away, nothing duplicated.
      expect(after.length).toBe(collection.keys.length + specRows.length);
    });
  });

  test('a document in none of the supported formats is refused, actionably @negative', async ({
    api,
    project,
  }) => {
    // A perfectly well-formed JSON document that is simply not an API document:
    // it parses, so it reaches the format detector, and the detector must turn
    // it away rather than guess.
    const error = await expectApiError(
      api.discovery.importSpec(project.id, sampleFile(UNSUPPORTED_DOC)),
      { status: 422, code: 'invalid_spec' },
    );

    // The refusal must tell the user what WOULD be accepted (contract §1).
    const errors = error.errors.join(' | ').toLowerCase();
    expect(error.errors.length, 'the refusal carried no errors list').toBeGreaterThan(0);
    for (const format of ['openapi', 'postman']) {
      expect(errors, `the refusal never mentions ${format}`).toContain(format);
    }
  });
});

// --- the environment the import derives from the document ------------------------

/**
 * "I only added a Postman collection for the API connection" — and the New run
 * screen showed an empty environment picker. The base URL was in the document
 * all along, so these tests hold the product to deriving it instead of asking
 * the user to retype it, and to deriving NOTHING it cannot read off the file.
 */
test.describe('environment derived from an imported collection @critical @regression', () => {
  test('a project with no environment gets exactly one, whose base URL reconstructs the document', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    // The precondition is the whole licence for this behaviour: it fills a void.
    expect(
      await api.projects.listEnvironments(project.id),
      'the fresh project already had an environment — the test cannot prove a void was filled',
    ).toEqual([]);

    const { result, endpoints } = await importCollection(api, project.id);
    const created = result.environment_created;

    await test.step('the import echoes the environment it created, and imports as before', async () => {
      expect(result.format).toBe(COLLECTION_FORMAT);
      expect(result.endpoints_count).toBe(collection.keys.length);
      expect(
        created,
        'no environment was derived from a document that declares a base URL',
      ).not.toBeNull();
      expect(typeof created!.id, 'environment_created.id is not a string').toBe('string');
      expect(created!.id.length).toBeGreaterThan(0);
      expect(created!.base_url.length).toBeGreaterThan(0);
    });

    const environments = await api.projects.listEnvironments(project.id);
    const environment = environmentById(environments, created!.id);

    await test.step('exactly one environment exists, and it is the one the response names', async () => {
      expect(environments.length, 'the import created more than one environment').toBe(1);
      expect(environment, 'environment_created names an id the project does not have').toBeDefined();
      expect(environment!.project_id).toBe(project.id);
      expect(environment!.name).toBe(created!.name);
      expect(environment!.base_url).toBe(created!.base_url);
      // A derived environment is a safe, plain default: no auth is invented, and
      // TLS verification stays on. Credentials are the user's to add.
      expect(environment!.auth_type).toBe('none');
      expect(environment!.tls_strict).toBe(true);
      expect(environment!.auth_config_masked, 'the derived environment carries a secret').toBe(false);
    });

    await test.step('the name comes from the document, not from a placeholder', async () => {
      expect(created!.name).toContain(COLLECTION_TITLE_WORDS);
      expect(created!.name).toContain('(imported)');
      expect(
        created!.name,
        'the document has a title, so the fallback name is wrong here',
      ).not.toBe(FALLBACK_ENVIRONMENT_NAME);
      expect(
        created!.name.length,
        `the name exceeds the ${ENVIRONMENT_NAME_LIMIT}-character column`,
      ).toBeLessThanOrEqual(ENVIRONMENT_NAME_LIMIT);
    });

    // --- THE RECONSTRUCTION ASSERTION (the oracle is the file, again) ---------
    // A base URL that cannot rebuild the document's URLs is worse than none: the
    // run would fire requests at a host the user never named.
    await test.step('base_url + endpoint path reproduces the URLs the collection declares', async () => {
      const origin = new URL(collection.baseUrl).origin;
      expect(created!.base_url.startsWith(origin), 'a host the document never names').toBe(true);
      expect(created!.base_url, 'an unresolved {{variable}} survived into the base URL').not.toContain(
        '{{',
      );

      // Control: the oracle can fail.
      expect(collection.absoluteUrls).not.toContain(`${origin}/__traceo_fabricated__`);

      // One named endpoint, spelled out — the failure message points at a URL a
      // human can look up in the file.
      const named = TEMPLATED_KEYS[0];
      const endpoint = endpointByKey(endpoints, named);
      expect(endpoint, `${named} did not survive the import`).toBeDefined();
      expect(
        resolvedUrl(created!.base_url, endpoint!.path),
        `${named} does not reconstruct to the URL the collection declares`,
      ).toBe(collection.requests.find((r) => r.key === named)!.absoluteUrl);

      // …and then the whole inventory: the reconstructed set IS the document's
      // set. This holds whichever side of the split the importer put the base
      // URL's own path prefix on (`/calendar/v3`), which is the point.
      const reconstructed = [...new Set(resolvedUrls(created!.base_url, endpoints))].sort();
      expect(reconstructed).toEqual([...collection.absoluteUrls].sort());
    });

    await test.step('the collection variables travel, minus the base-url one', async () => {
      const variables = environmentVariables(environment!);
      expect(variables.calendarId, 'calendarId did not travel into the environment').toBe(
        collection.variables.calendarId,
      );
      expect(
        Object.keys(variables),
        'the base-url variable was duplicated into the variables map',
      ).not.toContain(collection.baseUrlKey);
      expect(variables).toEqual(suggestedVariables(collection));
    });

    await test.step('a second import of the same document creates nothing more', async () => {
      const again = await api.discovery.importSpec(project.id, sampleFile(COLLECTION));
      expect(again.endpoints_count).toBe(collection.keys.length);
      expect(
        again.environment_created,
        're-importing created a second environment for the same project',
      ).toBeNull();

      const after = await api.projects.listEnvironments(project.id);
      expect(after.length).toBe(1);
      expect(after[0].id).toBe(created!.id);
      expect(after[0].base_url).toBe(created!.base_url);
    });
  });

  test('an environment the user already owns is never touched or overwritten', async ({ api }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const lead = api.as('qa_lead');
    const project = await lead.projects.create(projectFactory());
    // Deliberately unlike the document: a different host, a different value for
    // the very variable the collection declares. Nothing here may move.
    const mine = await lead.projects.createEnvironment(project.id, {
      name: 'staging (mine)',
      base_url: 'https://staging.internal.example.test',
      variables: { calendarId: 'mine-not-the-documents' },
      tls_strict: false,
    });

    const { result } = await importCollection(api, project.id);
    expect(result.endpoints_count, 'the import itself must be unaffected').toBe(
      collection.keys.length,
    );
    expect(
      result.environment_created,
      'an environment was created for a project that already had one',
    ).toBeNull();

    const environments = await api.projects.listEnvironments(project.id);
    expect(environments.length, 'the import added an environment alongside the existing one').toBe(1);

    const after = environments[0];
    expect(after.id).toBe(mine.id);
    expect(after.name).toBe(mine.name);
    expect(after.base_url, "the user's base URL was overwritten with the document's").toBe(
      mine.base_url,
    );
    expect(after.base_url).not.toContain('googleapis');
    expect(after.tls_strict, 'an unrelated setting of the existing environment moved').toBe(false);
    expect(environmentVariables(after), "the user's variables were rewritten").toEqual({
      calendarId: 'mine-not-the-documents',
    });
  });

  test('credential-looking variables arrive as empty keys, with their values left behind', async ({
    api,
  }) => {
    const lead = api.as('qa_lead');
    const project = await lead.projects.create(projectFactory());

    const result = await api.discovery.importSpec(project.id, sampleFile(MINI_COLLECTION));
    expect(result.format).toBe(COLLECTION_FORMAT);
    expect(result.endpoints_count).toBe(mini.keys.length);

    const created = result.environment_created;
    expect(created, 'the synthetic collection declares a base URL, so one must be derived').not.toBeNull();
    // An ASCII title, so the naming rule is asserted as an equality here.
    expect(created!.name).toBe(`${mini.title} (imported)`);

    const environments = await api.projects.listEnvironments(project.id);
    expect(environments.length).toBe(1);
    const environment = environments[0];

    await test.step('the base URL still reconstructs this document too', async () => {
      const endpoints = await api.discovery.listEndpoints(project.id);
      const reconstructed = [...new Set(resolvedUrls(created!.base_url, endpoints))].sort();
      expect(reconstructed).toEqual([...mini.absoluteUrls].sort());
    });

    await test.step('plain variables carry values, credential-looking ones carry keys only', async () => {
      const variables = environmentVariables(environment);
      // Named explicitly first, so the set equality below cannot pass vacuously.
      expect(variables.tenantId).toBe('tenant-42');
      expect(variables.pageSize).toBe('50');
      for (const key of MINI_CREDENTIAL_KEYS) {
        expect(
          Object.keys(variables),
          `${key} was dropped instead of being carried as an empty key to fill`,
        ).toContain(key);
        expect(variables[key], `${key} carried its example value out of the document`).toBe('');
      }
      expect(variables).toEqual(suggestedVariables(mini));
    });

    await test.step('no credential value appears anywhere in what the API returned', async () => {
      const serialised = JSON.stringify({ result, environment, environments });
      for (const key of MINI_CREDENTIAL_KEYS) {
        const value = mini.variables[key];
        expect(value.length, `${key} has no value, so this check would be vacuous`).toBeGreaterThan(0);
        expect(serialised, `the example value of ${key} was copied out of the document`).not.toContain(
          value,
        );
      }
    });
  });
});

// --- the same import, driven through the UI --------------------------------------

test.describe('collection import through the endpoints page @critical @regression', () => {
  test('qa_lead imports the collection on the endpoints page and sees the format and rows', async ({
    api,
    asQaLead,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    // An "auto" project rather than the "manual" fixture: enrichment is gated on
    // that existing flag, and the AI columns cannot be observed on a page that
    // was never given anything to render. Nothing else auto-runs here — the
    // autopilot needs confirmed requirements, and this project has none.
    const project = await api.as('qa_lead').projects.create(projectFactory({ automation: 'auto' }));
    const endpoints = new EndpointsPage(asQaLead);

    await endpoints.goto(project.id);
    await expect(endpoints.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });
    await expect(endpoints.emptyState).toBeVisible();

    await test.step('the same control refuses a document it cannot read, and says what it takes', async () => {
      await endpoints.importSpecFromFile(samplePath(UNSUPPORTED_DOC));

      await expect(endpoints.importError).toBeVisible({ timeout: UI_IMPORT_TIMEOUT_MS });
      // The refusal is actionable on screen, not just in the API payload.
      await expect(endpoints.importErrorItems.filter({ hasText: /openapi/i }).first()).toBeVisible();
      await expect(endpoints.importErrorItems.filter({ hasText: /postman/i }).first()).toBeVisible();
      // Nothing was imported by a refused upload.
      await expect(endpoints.emptyState).toBeVisible();
    });

    // One control for every format — the user changes the file, not the flow.
    await endpoints.importSpecFromFile(samplePath(COLLECTION));

    await test.step('the page names the detected format', async () => {
      await expect(endpoints.formatBadgeFor(COLLECTION_FORMAT)).toBeVisible({
        timeout: UI_IMPORT_TIMEOUT_MS,
      });
    });

    await test.step('the inventory refreshes with the imported rows', async () => {
      // Import is synchronous — completion surfaces as the refreshed table.
      await expect(endpoints.rows).toHaveCount(collection.keys.length, {
        timeout: UI_IMPORT_TIMEOUT_MS,
      });
      await expect(endpoints.emptyState).toBeHidden();
      // Rows are addressed by entity data (the templated path), never by copy.
      await expect(endpoints.rowFor('/calendars/{calendarId}/acl/{ruleId}')).toBeVisible();
      await expect(endpoints.rowFor('/freeBusy')).toBeVisible();
    });

    await test.step('the derived environment is confirmed on screen, with a way to open it', async () => {
      // The project had no environment before this upload, so the import filled
      // that void and the page must say so — otherwise the user has no idea a
      // run is now possible.
      await expect(endpoints.importEnvironmentCreated).toBeVisible();

      const environments = await api.projects.listEnvironments(project.id);
      expect(environments.length, 'the UI import created no environment').toBe(1);
      const environment = environments[0];

      // Asserted against the API's own row — the line reports what exists.
      await expect(endpoints.importEnvironmentCreated).toContainText(environment.name);
      await expect(endpoints.importEnvironmentCreated).toContainText(environment.base_url);
      await expect(endpoints.importEnvironmentCreatedLink).toHaveAttribute(
        'href',
        routes.environments(project.id),
      );
    });

    await test.step('the enrichment counters are reported next to the import result', async () => {
      await expect(endpoints.enrichedBadge).toBeVisible();
      await expect(endpoints.enrichmentDiscardedBadge).toBeVisible();
    });

    await test.step('the AI columns render exactly the annotations the API holds', async () => {
      // The page is asserted against the API, not against a hard-coded number:
      // the columns are driven by the data, and a null annotation renders
      // nothing at all (a legitimate state, not a defect).
      const rows = await api.discovery.listEndpoints(project.id);
      const withGroup = rows.filter((e) => e.ai_group != null).length;
      const withCriticality = rows.filter((e) => e.ai_criticality != null).length;
      const withDescription = rows.filter((e) => e.ai_description != null).length;
      expect(withCriticality, 'nothing was enriched — the columns would be vacuous').toBeGreaterThan(0);

      await expect(endpoints.aiGroupCells).toHaveCount(withGroup);
      await expect(endpoints.aiCriticalityCells).toHaveCount(withCriticality);
      await expect(endpoints.aiDescriptionCells).toHaveCount(withDescription);

      // Criticality is read from data-state, never from the printed word (§6).
      const first = rows.find((e) => e.ai_criticality != null)!;
      await expect(
        endpoints.aiCriticalityCells.filter({ hasText: first.ai_criticality! }).first(),
      ).toHaveAttribute('data-state', first.ai_criticality!);
    });
  });
});

// --- the other end of the same story: a project that has no environment ----------

test.describe('the runs page with no environment @critical @regression', () => {
  test('a project with no environment says so instead of offering an empty picker', async ({
    api,
    asQaLead,
  }) => {
    // The defect this closes: with no environment the picker rendered as an
    // empty <select> — a control that offers nothing and explains nothing.
    // Nothing is imported here, so the project genuinely has no environment.
    const project = await api.as('qa_lead').projects.create(projectFactory());
    expect(await api.projects.listEnvironments(project.id)).toEqual([]);

    const runs = new RunsPage(asQaLead);
    await runs.goto(project.id);
    await expect(runs.root).toBeVisible({ timeout: FIRST_VISIT_TIMEOUT_MS });

    await expect(runs.environmentEmptyHint).toBeVisible();
    // The empty select is not merely hidden behind the hint — it is not rendered.
    await expect(runs.environmentSelect).toHaveCount(0);
    // …and the hint is actionable: it points at the page that fixes it.
    await expect(runs.environmentEmptyLink).toHaveAttribute(
      'href',
      routes.environments(project.id),
    );
  });
});
