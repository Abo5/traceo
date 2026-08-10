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
} from '../api/discovery.repository';
import type { Endpoint, ImportSpecResult, TestCase } from '../api/types';
import { AI_CRITICALITIES, SPEC_FORMATS, type AiCriticality } from '../constants/states';
import { test, expect } from '../fixtures';
import { expectApiError } from '../helpers/expect-api-error';
import { readPostmanCollection, serverRelative } from '../helpers/postman-collection';
import { sampleFile, samplePath } from '../helpers/test-data';
import { EndpointsPage } from '../pages/endpoints.page';
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
