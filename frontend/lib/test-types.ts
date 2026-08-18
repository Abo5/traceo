"use client";

/**
 * The five kinds of testing Traceo performs — the frontend's single copy.
 *
 * `backend/app/testtypes.py` and `backend-go/internal/testtypes` are the source
 * of truth; this mirrors their order and vocabulary so a value the UI offers is
 * always one the backend accepts. A type the UI shows and the backend rejects is
 * indistinguishable, from the user's side, from a broken product.
 *
 * Two descriptions per type, because they are read in two different moments:
 * `scope` answers "what does picking this commit my project to?" when the
 * project is being set up, and `hint` answers "what will this do to the page I
 * am pointing at?" on the discovery screen.
 */

export type TestType = "functional" | "api" | "ui" | "performance" | "security";

export const TEST_TYPES: readonly TestType[] = [
  "functional",
  "api",
  "ui",
  "performance",
  "security",
] as const;

export const TEST_TYPE_META: Record<
  TestType,
  { label: string; scope: string; hint: string }
> = {
  functional: {
    label: "Functional",
    scope: "Requirements and the cases that prove the product does what it says.",
    hint: "Writes one requirement per form found on the page, plus cases carrying that form's field selectors verbatim.",
  },
  api: {
    label: "API",
    scope: "Endpoints from a spec, a collection, captured traffic or a rendered page.",
    hint: "Turns every XHR/fetch the page issued into an endpoint, with concrete ids templated the way spec imports are.",
  },
  ui: {
    label: "UI",
    scope: "The design as a requirement source: palette, layout and contrast.",
    hint: "Reads the screenshot for palette, surface and contrast facts, then writes UI cases bound to those fact ids.",
  },
  performance: {
    label: "Performance",
    scope: "Stated budgets, measured against a recorded baseline.",
    hint: "Uses the measured load time as the baseline and asserts the page keeps loading inside that budget.",
  },
  security: {
    label: "Security",
    scope: "The catalogued weakness classes over whatever endpoints are known.",
    hint: "Runs the S0 security builders over the endpoints discovered from the captured requests.",
  },
};

/** Canonical order, de-duplicated — the same normalisation both backends apply. */
export function normaliseTypes(values: readonly string[] | null | undefined): TestType[] {
  const wanted = new Set((values ?? []).map((v) => String(v).trim().toLowerCase()));
  return TEST_TYPES.filter((t) => wanted.has(t));
}

/**
 * The types a project is for. An empty or absent list means "nothing was said",
 * which reads as all five — exactly as the backends read it, so the UI never
 * shows a project as narrower than the server treats it.
 */
export function projectTestTypes(project: { test_types?: string[] | null } | null | undefined): TestType[] {
  const known = normaliseTypes(project?.test_types);
  return known.length > 0 ? known : [...TEST_TYPES];
}
