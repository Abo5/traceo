/**
 * Component inventory — S2 of docs/SECURITY_TESTING_PLAN.md (@regression).
 *
 * The plan's single most important design decision (§2): **without an SBOM, a
 * CVE feed is news about other people's software.** A CVE becomes actionable
 * only when it matches something the target actually runs, so the inventory is
 * the precondition of the whole CVE track — and the inventory is only worth
 * anything if it is LITERAL. What this spec holds the parsers to:
 *
 *   1. WHAT THE FILE SAYS, AND ONLY THAT. The oracle is the fixture itself:
 *      `helpers/component-manifests.ts` re-derives the declared inventory in the
 *      test process and the two sets are diffed (§6 — the oracle must not be the
 *      system under test). A CycloneDX document's `metadata.component` is the
 *      subject of the SBOM, not a dependency, and must not appear as one.
 *   2. A VERSION IS NEVER INVENTED. `requests>=2.31.0` and a bare `pyyaml` are
 *      declarations without a version: they arrive with `version: null` and are
 *      counted as `unpinned`. A parser that resolves a range has fabricated the
 *      one field the CVE match depends on — the failure mode §2 exists to stop.
 *   3. THE SAME MANIFEST TWICE IS THE SAME INVENTORY. The unique index on
 *      (project, name, version, ecosystem) makes re-upload an upsert, not a
 *      duplicate — otherwise every re-import inflates the coverage denominator.
 *   4. AN UNKNOWN FILE IS REFUSED, ACTIONABLY. 422
 *      `unsupported_component_format` with an `errors` list that NAMES the
 *      supported formats — mirroring the spec importer's `invalid_spec`, and
 *      cross-checked here: each accepted upload's detected `format` must be one
 *      of the names that refusal advertises.
 *
 * The parsers are pure and offline: no network, no model, nothing to stub.
 */
import { componentKey, componentKeys } from '../api/components.repository';
import type { Component } from '../api/types';
import { test, expect } from '../fixtures';
import { COMPONENT_SOURCES } from '../constants/states';
import {
  CYCLONEDX_SBOM,
  NPM_LOCKFILE,
  PIP_REQUIREMENTS,
  UNSUPPORTED_MANIFEST,
  cycloneDxComponents,
  cycloneDxSubject,
  declaredKey,
  declaredKeys,
  packageLockComponents,
  requirementsComponents,
  unpinned,
} from '../helpers/component-manifests';
import { expectApiError } from '../helpers/expect-api-error';
import { sampleFile } from '../helpers/test-data';

/** Upload + parse job, no fan-out and no model — but still a job (§16). */
const IMPORT_TEST_TIMEOUT_MS = 90_000;

/** Every component row must be internally coherent, whatever the manifest was. */
function expectWellFormed(component: Component): void {
  expect(component.name.trim().length, `component ${component.id} has no name`).toBeGreaterThan(0);
  expect(
    typeof component.version === 'string' || component.version === null,
    `component ${component.name} has a version that is neither a string nor null`,
  ).toBe(true);
  expect(String(component.ecosystem ?? '').length, `${component.name} has no ecosystem`).toBeGreaterThan(0);
  expect(COMPONENT_SOURCES, `${component.name} has an unknown source`).toContain(component.source);
}

test.describe('component inventory @regression', () => {
  test('a CycloneDX SBOM yields exactly the components the document declares', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const declared = cycloneDxComponents();
    expect(declared.length, 'the reference SBOM declares nothing').toBeGreaterThan(0);

    const result = await api.components.importAndWait(project.id, sampleFile(CYCLONEDX_SBOM));

    expect(result.format.length, 'the import reported no detected format').toBeGreaterThan(0);
    expect(result.added, 'the SBOM was parsed into a different number of components').toBe(
      declared.length,
    );
    expect(result.updated).toBe(0);
    expect(result.unpinned, 'an SBOM pins every version — none may arrive unpinned').toBe(0);
    expect(result.total).toBe(declared.length);

    const components = await api.components.list(project.id);
    components.forEach(expectWellFormed);

    // --- THE DIFF: the document is the oracle, character for character --------
    expect(componentKeys(components).sort()).toEqual(declaredKeys(declared).sort());

    // The subject of the SBOM is the application itself, not one of its
    // dependencies: importing it as a component would inflate the inventory
    // with the very system under test.
    const subject = cycloneDxSubject();
    expect(
      componentKeys(components),
      `the SBOM's own metadata.component (${declaredKey(subject)}) was imported as a dependency`,
    ).not.toContain(declaredKey(subject));

    // An SBOM is the highest-fidelity source (§2) and must be recorded as such.
    for (const component of components) {
      expect(component.source, `${component.name} did not come from the SBOM`).toBe('sbom');
    }
  });

  test('a package-lock.json yields every installed package, nested copies included', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const declared = packageLockComponents();
    expect(declared.length).toBeGreaterThan(0);

    const result = await api.components.importAndWait(project.id, sampleFile(NPM_LOCKFILE));

    expect(result.added).toBe(declared.length);
    expect(result.total).toBe(declared.length);
    expect(result.unpinned, 'a lockfile pins every version by definition').toBe(0);

    const components = await api.components.list(project.id);
    components.forEach(expectWellFormed);
    expect(componentKeys(components).sort()).toEqual(declaredKeys(declared).sort());

    // The root entry ("") of the packages map is the project itself.
    expect(
      components.map((c) => c.name),
      'the lockfile\'s own root package was imported as a dependency',
    ).not.toContain('orders-web');

    // A scoped package keeps its scope, and two versions of the same package
    // are two rows — collapsing them would silently drop a vulnerable copy.
    expect(components.map((c) => c.name)).toContain('@types/node');
    const msVersions = components.filter((c) => c.name === 'ms').map((c) => c.version);
    expect(msVersions.sort(), 'a nested duplicate of `ms` was merged away').toEqual(['2.0.0', '2.1.2']);

    for (const component of components) {
      expect(component.source, `${component.name} did not come from a lockfile`).toBe('lockfile');
    }

    await test.step('re-importing the same manifest updates rather than duplicates', async () => {
      const again = await api.components.importAndWait(project.id, sampleFile(NPM_LOCKFILE));
      expect(again.added, 'a re-import added rows the unique index should have caught').toBe(0);
      expect(again.total).toBe(declared.length);
      expect((await api.components.list(project.id)).length).toBe(declared.length);
    });
  });

  test('an unpinned requirements.txt line is recorded with a null version, never guessed', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const declared = requirementsComponents();
    const unpinnedDeclarations = unpinned(declared);
    expect(
      unpinnedDeclarations.length,
      'the reference manifest carries no unpinned line to prove the rule with',
    ).toBeGreaterThan(0);

    const result = await api.components.importAndWait(project.id, sampleFile(PIP_REQUIREMENTS));

    expect(result.added).toBe(declared.length);
    expect(result.total).toBe(declared.length);
    expect(
      result.unpinned,
      `the manifest has ${unpinnedDeclarations.length} unpinned declarations`,
    ).toBe(unpinnedDeclarations.length);

    const components = await api.components.list(project.id);
    components.forEach(expectWellFormed);
    expect(componentKeys(components).sort()).toEqual(declaredKeys(declared).sort());

    await test.step('every unpinned declaration arrives with version null', async () => {
      for (const declaration of unpinnedDeclarations) {
        const row = components.find((c) => c.name === declaration.name);
        expect(row, `${declaration.name} was dropped instead of recorded`).toBeDefined();
        expect(
          row!.version,
          `${declaration.name} is not pinned in the manifest, yet arrived as "${row!.version}" — ` +
            `a resolved range is an invented version (plan §2)`,
        ).toBeNull();

        // A missing version is only auditable if the row says WHY it is missing.
        expect(
          String(row!.unpinned_reason ?? '').trim().length,
          `${declaration.name} has no version and no reason for it`,
        ).toBeGreaterThan(0);
      }
    });

    await test.step('a pinned row carries no unpinned reason', async () => {
      for (const row of components.filter((c) => c.version !== null)) {
        expect(
          row.unpinned_reason ?? null,
          `${row.name} is pinned at ${row.version} yet explains an absent version`,
        ).toBeNull();
      }
    });

    await test.step('every pinned declaration keeps the manifest\'s exact version', async () => {
      for (const declaration of declared.filter((d) => d.version !== null)) {
        const row = components.find((c) => c.name === declaration.name);
        expect(row, `${declaration.name} was dropped`).toBeDefined();
        expect(row!.version).toBe(declaration.version);
      }
    });
  });

  test('a file in none of the supported manifest formats is refused, actionably @negative', async ({
    api,
    project,
  }) => {
    // Well-formed JSON that is simply not an inventory: it parses, so it reaches
    // the format detector, and the detector must turn it away rather than guess
    // an ecosystem or a version out of prose.
    const error = await expectApiError(
      api.components.importManifest(project.id, sampleFile(UNSUPPORTED_MANIFEST)),
      { status: 422, code: 'unsupported_component_format' },
    );

    expect(error.errors.length, 'the refusal carried no list of supported formats').toBeGreaterThan(0);
    const advertised = error.errors.join(' | ').toLowerCase();
    for (const format of ['cyclonedx', 'spdx', 'package-lock', 'requirements', 'go.sum', 'poetry']) {
      expect(advertised, `the refusal never mentions ${format}`).toContain(format);
    }

    expect((await api.components.list(project.id)).length, 'a refused file still wrote rows').toBe(0);
  });

  test('the detected format of an accepted manifest is one the refusal advertises', async ({
    api,
    project,
  }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    // The two sides of the detector must agree: what it ACCEPTS and what it says
    // it accepts. A format name that appears in neither list is undocumented.
    const refusal = await expectApiError(
      api.components.importManifest(project.id, sampleFile(UNSUPPORTED_MANIFEST)),
      { status: 422, code: 'unsupported_component_format' },
    );
    const advertised = refusal.errors.join(' | ').toLowerCase();

    for (const manifest of [CYCLONEDX_SBOM, NPM_LOCKFILE, PIP_REQUIREMENTS]) {
      const result = await api.components.importAndWait(project.id, sampleFile(manifest));
      expect(
        advertised,
        `${manifest} was accepted as format "${result.format}", which the refusal never names`,
      ).toContain(result.format.toLowerCase());
    }
  });

  test('a component can be removed from the inventory', async ({ api, project }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    await api.components.importAndWait(project.id, sampleFile(CYCLONEDX_SBOM));
    const before = await api.components.list(project.id);
    expect(before.length).toBeGreaterThan(0);

    const victim = before[0];
    await api.components.remove(victim.id);

    const after = await api.components.list(project.id);
    expect(after.map((c) => c.id), 'the deleted component is still listed').not.toContain(victim.id);
    expect(
      componentKeys(after),
      `${componentKey(victim.name, victim.version)} survived its deletion`,
    ).not.toContain(componentKey(victim.name, victim.version));
    expect(after.length).toBe(before.length - 1);
  });
});

/**
 * Capability gating (backend/app/security.py PERMISSIONS): uploading and
 * deleting an inventory is `import_spec` (admin|qa_lead|qa_engineer), reading it
 * is `view`. The server refuses on its own.
 */
test.describe('component inventory permission gating @permission @regression', () => {
  test('a viewer cannot import a manifest @negative', async ({ api, project }) => {
    await expectApiError(
      api.as('viewer').components.importManifest(project.id, sampleFile(CYCLONEDX_SBOM)),
      { status: 403, code: 'forbidden' },
    );
    expect((await api.components.list(project.id)).length).toBe(0);
  });

  test('a viewer can read the inventory (capability "view")', async ({ api, project }) => {
    test.setTimeout(IMPORT_TEST_TIMEOUT_MS);

    const declared = cycloneDxComponents();
    await api.components.importAndWait(project.id, sampleFile(CYCLONEDX_SBOM));

    const asViewer = await api.as('viewer').components.list(project.id);
    expect(componentKeys(asViewer).sort()).toEqual(declaredKeys(declared).sort());
  });
});
