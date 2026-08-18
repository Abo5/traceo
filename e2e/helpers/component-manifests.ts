/**
 * Component-manifest readers — the INDEPENDENT ORACLE of the component
 * inventory spec (§6: the oracle must not be the system under test).
 *
 * The backend parses an uploaded SBOM or lockfile into `Component` rows. To
 * prove it neither invented nor dropped anything, the spec needs a second,
 * trustworthy answer to "what is actually in this file?" — so this module
 * re-derives the expected inventory from the fixture in the test process. It
 * mirrors only the parsing rules the assertions depend on, and it never calls
 * the API.
 *
 * Rules mirrored from the contract (S2.1, deterministic, no network):
 * - CycloneDX: `components[]` — and ONLY that array. `metadata.component` is
 *   the subject of the SBOM, not a dependency of it, so the fixture carries one
 *   and this oracle excludes it.
 * - package-lock v2/v3: the `packages` map, keyed by install path. The root
 *   entry (`""`) is the project itself and is excluded; the name is the segment
 *   after the LAST `node_modules/`, so a scoped package keeps its `@scope/`
 *   prefix and a nested copy is its own (name, version) pair.
 * - requirements.txt: `name==version` only. A range (`>=`, `~=`, `<`) and a
 *   bare name are UNPINNED — recorded with a null version, never resolved.
 *
 * Nothing here mutates the fixture: `e2e/test-data/` is reference data (§8).
 */
import * as fs from 'node:fs';
import { samplePath } from './test-data';

/** One declaration a manifest makes: a name, and a version only when pinned. */
export interface DeclaredComponent {
  name: string;
  /** null when the manifest does not pin an exact version. */
  version: string | null;
}

/** The fixtures this oracle reads, by their file names in `e2e/test-data/`. */
export const CYCLONEDX_SBOM = 'sbom.cyclonedx.json';
export const NPM_LOCKFILE = 'package-lock.json';
export const PIP_REQUIREMENTS = 'requirements.txt';
/** Valid, well-formed, and none of the supported manifests — the 422 path. */
export const UNSUPPORTED_MANIFEST = 'not-a-component-manifest.json';

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(samplePath(name), 'utf8')) as Record<string, unknown>;
}

/** `components[]` of a CycloneDX document — the dependencies, not the subject. */
export function cycloneDxComponents(name: string = CYCLONEDX_SBOM): DeclaredComponent[] {
  const doc = readJson(name);
  const components = Array.isArray(doc.components) ? doc.components : [];
  return components.map((raw) => {
    const c = raw as Record<string, unknown>;
    return { name: String(c.name), version: c.version == null ? null : String(c.version) };
  });
}

/** The subject of the SBOM — present in the fixture, and NOT a dependency. */
export function cycloneDxSubject(name: string = CYCLONEDX_SBOM): DeclaredComponent {
  const meta = (readJson(name).metadata ?? {}) as Record<string, unknown>;
  const subject = (meta.component ?? {}) as Record<string, unknown>;
  return { name: String(subject.name), version: subject.version == null ? null : String(subject.version) };
}

/** Installed packages of a v2/v3 `package-lock.json`, root entry excluded. */
export function packageLockComponents(name: string = NPM_LOCKFILE): DeclaredComponent[] {
  const packages = (readJson(name).packages ?? {}) as Record<string, unknown>;
  const out: DeclaredComponent[] = [];
  for (const [installPath, raw] of Object.entries(packages)) {
    if (installPath === '') continue; // the project itself, not a dependency
    const entry = (raw ?? {}) as Record<string, unknown>;
    const segments = installPath.split('node_modules/');
    const pkgName = segments[segments.length - 1];
    if (!pkgName) continue;
    out.push({ name: pkgName, version: entry.version == null ? null : String(entry.version) });
  }
  return out;
}

/**
 * Declarations of a `requirements.txt`, keeping the file's own honesty: a line
 * that does not pin with `==` yields `version: null`.
 */
export function requirementsComponents(name: string = PIP_REQUIREMENTS): DeclaredComponent[] {
  const text = fs.readFileSync(samplePath(name), 'utf8');
  const out: DeclaredComponent[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    const pinned = line.match(/^([A-Za-z0-9._-]+)\s*==\s*([^\s;#]+)$/);
    if (pinned) {
      out.push({ name: pinned[1], version: pinned[2] });
      continue;
    }
    const unpinned = line.match(/^([A-Za-z0-9._-]+)/);
    if (unpinned) out.push({ name: unpinned[1], version: null });
  }
  return out;
}

/** Declarations the manifest does NOT pin — the rows that must arrive null. */
export function unpinned(declared: DeclaredComponent[]): DeclaredComponent[] {
  return declared.filter((d) => d.version === null);
}

/** "name@version" identity; an unpinned declaration reads as `name@null`. */
export function declaredKey(component: DeclaredComponent): string {
  return `${component.name}@${component.version ?? 'null'}`;
}

/** The declarations as a comparable set of keys — the diff the spec asserts on. */
export function declaredKeys(declared: DeclaredComponent[]): string[] {
  return declared.map(declaredKey);
}
