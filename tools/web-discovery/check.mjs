/**
 * Traceo browser-check sidecar — executes the cases a web-target scan generated.
 *
 * `discover.mjs` reads what a page IS. This script asserts what it DOES: it opens
 * the same URL in the same real browser and evaluates the DOM-level assertions
 * that `webtarget.form_cases` / `ui_cases_from_facts` / `performance_case` wrote.
 *
 * Why it has to exist: those assertions (`elements_present`, `validation_error`,
 * `pattern_enforced`, …) are meaningless to the HTTP execution engine, whose
 * evaluator ends in `return True, None, True  # unknown assertion types are
 * skipped, never failed`. Running them through that engine reports a green run in
 * which nothing was checked — worse than no run at all, because it is a green
 * badge over an unverified page.
 *
 * Contract
 *   node check.mjs --plan <file.json> [--timeout 30000] [--out <dir>]
 *                  [--step-wait 3000] [--step-wait-retry 6000]
 *                  [--artifacts <dir>]   record a video of the whole run and a
 *                                        screenshot of every non-passing case
 *
 *   plan  = {url, viewport, timeout_ms?, cases: [{id, checks: [step, ...]}]}
 *           where `step` is a stored TestStep: {request: {check, ...}, assertions: [...]}
 *
 *   stdout = exactly one JSON document:
 *     {ok: true, schema_version, url, final_url, elapsed_ms,
 *      results: [{case_id, outcome: passed|failed|errored|skipped, duration_ms,
 *                 assertions: [{type, outcome, expected, actual, message}],
 *                 failure: {message, expected, actual, selector} | null}]}
 *
 *   exit 0 = every case was evaluated (some may have failed — that is a result,
 *            not an error). 1 = the page could not be checked. 2 = bad arguments.
 *            3 = the browser is unavailable.
 *
 * A case whose checks this script does not understand is reported `skipped` with
 * a stated reason. It is never reported as passed: an unevaluated assertion must
 * never be able to masquerade as a verified one — that is the whole point here.
 */
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertAllowedUrl, tagged } from './ssrf.mjs';

const SCHEMA_VERSION = 1;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '..', '..');

const DEFAULTS = {
  viewport: '1280x800',
  timeout: 30000,      // hard ceiling for the initial navigation
  idleTimeout: 15000,
  settle: 2500,
  hydrate: 5000,
  perCase: 10000,      // ceiling for one case's interactions
  maxCases: 500,
  // Per-step response budget. Every step waits for the page to answer what the
  // previous action did before it asserts, because asserting on a page that has
  // not finished responding reports the application as broken when it is merely
  // slow — the single largest source of false failures in a browser suite.
  // It is a CEILING, not a sleep: a page that settles in 80ms costs 80ms.
  stepWait: 3000,
  // Budget for the RE-load between cases. The first load of a page pays the
  // full wait strategy; after that the document is warm and only the first
  // control has to exist again. Absent, this read as `undefined` and Playwright
  // substituted its own 30s default — in the one path that runs once per case.
  rehydrate: 1500,
  // Second chance for a case that failed or errored at the base budget. A slow
  // page and a broken one look identical in one attempt; they stop looking alike
  // when the slow one is given twice the time and then passes. A case that fails
  // at BOTH budgets is reported as it stands — that is a real defect, and
  // retrying it further would only bury it.
  stepWaitRetry: 6000,
};

// The live per-step budget. Module-level because every checker below applies it
// to its own element operations: a budget the step waits on but the click inside
// it ignores would be a budget in name only.
let STEP_WAIT = DEFAULTS.stepWait;

/**
 * Give the page up to `budget` ms to finish responding, and return the moment it
 * has — the budget is a ceiling, never a sleep.
 *
 * Stability is measured on the DOM rather than on the network. `networkidle`
 * looks like the obvious signal and is the wrong one here: a page holding any
 * long-lived connection — a dev server's HMR socket, a chat channel, an
 * analytics beacon, a poll — never reaches it, so every step would burn the
 * entire budget and a fast page would be billed as a slow one. Measured against
 * the real suite that mistake cost 2.08x wall-clock for no extra certainty.
 *
 * Two consecutive identical readings of the document's size mean the page has
 * stopped changing, which is what the next assertion actually depends on. A page
 * still rendering keeps changing and keeps its remaining budget; one that never
 * settles hits the ceiling and proceeds, because the budget bounds the wait and
 * the assertion decides the verdict.
 */
async function settle(page, budget = STEP_WAIT) {
  const deadline = Date.now() + budget;
  await page.waitForLoadState('domcontentloaded', { timeout: budget }).catch(() => {});
  let previous = -1;
  while (Date.now() < deadline) {
    const size = await page
      .evaluate(() => (document.body ? document.body.innerHTML.length : 0))
      .catch(() => -1);
    // -1 means the page is mid-navigation and cannot be read; that is a change,
    // not a stable state, so it must not be allowed to match a previous -1.
    if (size >= 0 && size === previous) return;
    previous = size;
    const left = deadline - Date.now();
    if (left <= 0) return;
    await page.waitForTimeout(Math.min(120, left));
  }
}

// --------------------------------------------------------------------------- output

/**
 * A case id is chosen by the backend and reaches us as data, so it is never
 * spliced into a filesystem path unsanitised: '../' in an id would otherwise
 * write the screenshot outside the artefacts directory.
 */
function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'case';
}

function emit(doc, exitCode) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  process.exitCode = exitCode;
}

function cleanMessage(text) {
  return String(text)
    // Anchored on the ESC byte, so an IPv6 literal in a message survives intact.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    // The Call log split MUST happen while the newlines are still newlines.
    .split(/\r?\nCall log:/)[0]
    .replace(/[\u0000-\u001f\u007f]/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
}

function fail(code, message, detail, exitCode = 1) {
  emit({
    ok: false,
    schema_version: SCHEMA_VERSION,
    error: { code, message: cleanMessage(message), ...(detail === undefined ? {} : { detail }) },
  }, exitCode);
}

process.on('uncaughtException', (err) => {
  fail('internal_error', String(err && err.message ? err.message : err));
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  fail('internal_error', String(err && err.message ? err.message : err));
  process.exit(1);
});

// --------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) throw new Error(`unexpected argument '${tok}'`);
    const eq = tok.indexOf('=');
    const key = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
    let val = eq === -1 ? undefined : tok.slice(eq + 1);
    if (val === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { val = next; i++; } else { val = 'true'; }
    }
    out[key.replace(/-/g, '_')] = val;
  }
  return out;
}

function asInt(raw, fallback, name) {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function parseViewport(raw) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(raw).trim().toLowerCase());
  if (!m) throw new Error(`--viewport must look like 1280x800 (got '${raw}')`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

// --------------------------------------------------------------------------- playwright

function loadPlaywright() {
  const roots = [
    process.env.TRACEO_PLAYWRIGHT_NODE_MODULES,
    path.join(REPO_ROOT, 'e2e', 'node_modules'),
    path.join(HERE, 'node_modules'),
    path.join(REPO_ROOT, 'node_modules'),
  ].filter(Boolean);

  const tried = [];
  for (const root of roots) {
    const entry = path.join(root, 'playwright', 'index.js');
    tried.push(entry);
    if (!fs.existsSync(entry)) continue;
    try {
      const require = createRequire(pathToFileURL(path.join(root, '_traceo_resolver.cjs')));
      return { pw: require(entry), from: root };
    } catch (err) {
      tried.push(`${entry} (load failed: ${err.message})`);
    }
  }
  try {
    const require = createRequire(import.meta.url);
    return { pw: require('playwright'), from: 'node resolution' };
  } catch { /* fall through */ }

  throw tagged('browser_check_unavailable',
    'Playwright is not installed. Install it with:  npm --prefix ' +
    path.join(REPO_ROOT, 'e2e') + ' install  &&  npx --prefix ' +
    path.join(REPO_ROOT, 'e2e') + ' playwright install chromium\nLooked in: ' + tried.join(', '), 3);
}

// --------------------------------------------------------------------------- helpers

/** Every assertion result travels in this shape, whatever produced it. */
function record(type, outcome, expected, actual, message, selector) {
  return {
    type,
    outcome,                       // passed | failed | skipped
    expected: expected === undefined ? null : expected,
    actual: actual === undefined ? null : actual,
    message: message ? String(message).slice(0, 600) : null,
    ...(selector ? { selector } : {}),
  };
}

/** Resolve a selector to exactly one element, or say why not. */
async function locate(page, selector) {
  const loc = page.locator(selector);
  const count = await loc.count();
  return { loc: loc.first(), count };
}

/**
 * Type into a field the way a user would, so the browser's own constraint
 * handling (maxlength truncation, pattern validity) is what we observe. `fill`
 * bypasses maxlength on some engines, which would make the check meaningless.
 */
async function typeInto(loc, value) {
  await loc.click({ timeout: STEP_WAIT }).catch(() => {});
  await loc.fill('').catch(() => {});
  await loc.type(String(value), { delay: 0, timeout: STEP_WAIT });
}

/** A plausible value for a field, from its type — never invented beyond that. */
function sampleFor(type) {
  switch (String(type || '').toLowerCase()) {
    case 'email': return 'traceo.check@example.com';
    case 'number': return '7';
    case 'tel': return '0500000000';
    case 'url': return 'https://example.com';
    case 'date': return '2026-01-01';
    case 'password': return 'TraceoCheck123!';
    default: return 'traceo';
  }
}

// --------------------------------------------------------------------------- checks

/** Every discovered selector resolves to exactly one visible element. */
async function checkElementsPresent(page, step, assertion) {
  const selectors = assertion.selectors || step.request?.selectors || [];
  const missing = [];
  const hidden = [];
  const ambiguous = [];
  for (const sel of selectors) {
    let found;
    try { found = await locate(page, sel); }
    catch (err) { missing.push(`${sel} (invalid selector: ${cleanMessage(err.message)})`); continue; }
    if (found.count === 0) { missing.push(sel); continue; }
    if (found.count > 1) ambiguous.push(`${sel} (matched ${found.count})`);
    const visible = await found.loc.isVisible().catch(() => false);
    if (!visible) hidden.push(sel);
  }
  const problems = [
    ...missing.map((s) => `absent: ${s}`),
    ...hidden.map((s) => `present but not visible: ${s}`),
    ...ambiguous.map((s) => `not unique: ${s}`),
  ];
  return record(
    'elements_present',
    problems.length ? 'failed' : 'passed',
    selectors,
    problems.length ? problems : `all ${selectors.length} present and visible`,
    problems.length ? problems.join('; ') : null,
    missing[0] || hidden[0] || null);
}

/**
 * Leave the required field empty, fill the rest, submit — the form must refuse.
 * "Refuse" is either the browser's own constraint validation, an aria-invalid /
 * error node the app rendered, or simply not navigating away.
 */
async function checkRequiredField(page, step) {
  const req = step.request || {};
  const emptySel = req.empty;
  const filled = req.filled || [];
  const formSel = req.form;
  if (!emptySel) return record('validation_error', 'skipped', null, null, 'no empty selector recorded');

  const urlBefore = page.url();

  for (const sel of filled) {
    try {
      const { loc, count } = await locate(page, sel);
      if (!count) continue;
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
      if (tag === 'select') { await loc.selectOption({ index: 1 }).catch(() => {}); continue; }
      const type = await loc.getAttribute('type').catch(() => null);
      if (['checkbox', 'radio'].includes(String(type))) { await loc.check().catch(() => {}); continue; }
      await typeInto(loc, sampleFor(type));
    } catch { /* a field we cannot fill is not this assertion's subject */ }
  }

  try {
    const { loc, count } = await locate(page, emptySel);
    if (!count) {
      return record('validation_error', 'failed', 'a validation error on the empty field',
        `the field ${emptySel} is not on the page`, `required field ${emptySel} was not found`, emptySel);
    }
    await loc.fill('').catch(() => {});
  } catch { /* fall through to submit */ }

  // Submit: prefer the form's own submit control, fall back to Enter.
  let submitted = false;
  if (formSel) {
    const submit = page.locator(`${formSel} [type=submit], ${formSel} button:not([type=button])`).first();
    if (await submit.count().then((c) => c > 0).catch(() => false)) {
      await submit.click({ timeout: STEP_WAIT }).catch(() => {});
      submitted = true;
    }
  }
  if (!submitted) {
    await page.locator(emptySel).first().press('Enter', { timeout: STEP_WAIT }).catch(() => {});
  }
  await settle(page);

  const navigated = page.url() !== urlBefore;

  // How did the page object? Any one of these is a pass.
  const evidence = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    const v = el.validity || {};
    const describedBy = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/).filter(Boolean)
      .map((id) => (document.getElementById(id)?.textContent || '').trim())
      .filter(Boolean);
    return {
      present: true,
      constraintInvalid: v.valueMissing === true || el.checkValidity?.() === false,
      ariaInvalid: el.getAttribute('aria-invalid') === 'true',
      validationMessage: el.validationMessage || '',
      describedBy,
    };
  }, emptySel).catch(() => ({ present: false }));

  const refused = Boolean(
    evidence.constraintInvalid || evidence.ariaInvalid ||
    (evidence.describedBy && evidence.describedBy.length) || !navigated);

  const how = evidence.constraintInvalid ? 'browser constraint validation'
    : evidence.ariaInvalid ? 'aria-invalid on the field'
      : (evidence.describedBy || []).length ? `error text: ${evidence.describedBy.join(' ')}`
        : 'the form did not navigate';

  return record(
    'validation_error',
    refused ? 'passed' : 'failed',
    'the form refuses submission while this required field is empty',
    refused ? how : `submitted anyway and navigated to ${page.url()}`,
    refused ? null
      : `The form accepted an empty ${emptySel} and submitted. A required field is not enforced.`,
    emptySel);
}

/** The field must not hold more characters than its own maxlength. */
async function checkMaxlength(page, step, assertion) {
  const sel = step.request?.selector || assertion.selector;
  const max = Number(step.request?.maxlength ?? assertion.expected);
  if (!sel || !Number.isFinite(max)) {
    return record('value_length_at_most', 'skipped', null, null, 'no selector/maxlength recorded');
  }
  const { loc, count } = await locate(page, sel);
  if (!count) {
    return record('value_length_at_most', 'failed', max, 'field not on the page',
      `${sel} was not found`, sel);
  }
  await typeInto(loc, 'a'.repeat(max + 5)).catch(() => {});
  const value = await loc.inputValue().catch(() => '');
  return record(
    'value_length_at_most',
    value.length <= max ? 'passed' : 'failed',
    max,
    value.length,
    value.length <= max ? null
      : `The field accepted ${value.length} characters despite maxlength=${max}.`,
    sel);
}

/** A value that violates the field's own pattern must be rejected. */
async function checkPattern(page, step, assertion) {
  const sel = step.request?.selector || assertion.selector;
  const pattern = step.request?.pattern || assertion.expected;
  if (!sel || !pattern) {
    return record('pattern_enforced', 'skipped', null, null, 'no selector/pattern recorded');
  }
  const { loc, count } = await locate(page, sel);
  if (!count) {
    return record('pattern_enforced', 'failed', pattern, 'field not on the page',
      `${sel} was not found`, sel);
  }
  // A string chosen to violate the pattern; if it happens to satisfy it we say
  // so rather than claiming a pass we did not earn.
  const probe = '((traceo-invalid))';
  await typeInto(loc, probe).catch(() => {});
  const state = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    return {
      valid: el.checkValidity ? el.checkValidity() : true,
      mismatch: el.validity ? el.validity.patternMismatch === true : false,
      value: el.value,
    };
  }, sel).catch(() => null);
  if (!state) return record('pattern_enforced', 'skipped', pattern, null, 'field unreadable', sel);
  const rejected = state.mismatch || state.valid === false;
  return record(
    'pattern_enforced',
    rejected ? 'passed' : 'failed',
    `values not matching ${pattern} are rejected`,
    rejected ? 'rejected' : `accepted ${JSON.stringify(state.value)}`,
    rejected ? null
      : `The field accepted a value that does not match its declared pattern ${pattern}.`,
    sel);
}

/**
 * Read how the page currently judges one field: the browser's own constraint
 * state plus anything the app rendered to say the value is wrong.
 */
async function fieldVerdict(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { present: false };
    const v = el.validity || {};
    const describedBy = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/).filter(Boolean)
      .map((id) => (document.getElementById(id)?.textContent || '').trim())
      .filter(Boolean);
    return {
      present: true,
      value: el.value,
      valid: el.checkValidity ? el.checkValidity() : true,
      ariaInvalid: el.getAttribute('aria-invalid') === 'true',
      message: el.validationMessage || '',
      describedBy,
      flags: {
        typeMismatch: v.typeMismatch === true,
        rangeUnderflow: v.rangeUnderflow === true,
        rangeOverflow: v.rangeOverflow === true,
        tooShort: v.tooShort === true,
        tooLong: v.tooLong === true,
        stepMismatch: v.stepMismatch === true,
        patternMismatch: v.patternMismatch === true,
        valueMissing: v.valueMissing === true,
      },
    };
  }, selector).catch(() => ({ present: false }));
}

/** Which declared rule the browser says this value broke, in words. */
function brokeWhat(flags) {
  if (!flags) return null;
  const names = {
    typeMismatch: 'the declared input type', rangeUnderflow: 'the declared minimum',
    rangeOverflow: 'the declared maximum', tooShort: 'the declared minimum length',
    tooLong: 'the declared maximum length', stepMismatch: 'the declared step',
    patternMismatch: 'the declared pattern', valueMissing: 'the required rule',
  };
  for (const [k, words] of Object.entries(names)) if (flags[k]) return words;
  return null;
}

/**
 * Type a concrete value into the field and see whether the page stands by the
 * rule it declared.
 *
 * A value that must be REJECTED is also submitted: a page that merely marks the
 * field invalid but submits anyway has not enforced anything, and that gap is
 * the defect worth finding. A value that must be ACCEPTED is never submitted —
 * submitting a valid form on someone's site would create data, and this runner
 * has no business doing that.
 */
async function checkValue(page, step, kind, opts) {
  const req = step.request || {};
  const sel = req.selector;
  const value = req.value ?? '';
  const expectRejected = (req.expect || 'rejected') === 'rejected';
  const declared = req.declared ? ` (${req.declared})` : '';
  if (!sel) return record(kind, 'skipped', null, null, 'no selector recorded');

  const { loc, count } = await locate(page, sel);
  if (!count) {
    return record(kind, 'failed', req.expect, 'field not on the page',
      `${sel} was not found`, sel);
  }

  await typeInto(loc, value).catch(() => {});
  let verdictNow = await fieldVerdict(page, sel);
  if (!verdictNow.present) return record(kind, 'skipped', req.expect, null, 'field unreadable', sel);

  const flaggedInvalid = verdictNow.valid === false || verdictNow.ariaInvalid ||
    (verdictNow.describedBy || []).length > 0;

  // The field may refuse the characters outright rather than flagging them:
  // <input type="number"> simply will not hold "abc". Nothing was entered, so
  // there is nothing to submit and nothing to complain about — that is the
  // constraint working, and reporting it as "no objection raised" would be
  // crying wolf. Whitespace probes are exempt: a required field that silently
  // drops spaces still has to say so.
  if (expectRejected && kind !== 'whitespace_rejected' &&
      String(value).trim() !== '' && String(verdictNow.value ?? '') === '') {
    return record(kind, 'passed', `rejected${declared}`,
      'the field would not accept the characters at all', null, sel);
  }

  if (!expectRejected) {
    // Accepted: the page must not object to a value its own declaration allows.
    const why = brokeWhat(verdictNow.flags);
    return record(
      kind,
      flaggedInvalid ? 'failed' : 'passed',
      `accepted${declared}`,
      flaggedInvalid
        ? `rejected: ${verdictNow.message || why || 'marked invalid'}`
        : 'accepted',
      flaggedInvalid
        ? `The field refused ${JSON.stringify(value)}, which its own declaration${declared} allows.`
        : null,
      sel);
  }

  // Rejected: does the page actually stop it, or only decorate it?
  const urlBefore = page.url();
  let submitted = false;
  if (req.form) {
    const submit = page.locator(`${req.form} [type=submit], ${req.form} button:not([type=button])`).first();
    if (await submit.count().then((c) => c > 0).catch(() => false)) {
      await submit.click({ timeout: STEP_WAIT }).catch(() => {});
      submitted = true;
    }
  }
  if (!submitted) await loc.press('Enter', { timeout: STEP_WAIT }).catch(() => {});
  await settle(page);
  const navigated = page.url() !== urlBefore;

  if (navigated) {
    await opts.reset();
    return record(kind, 'failed', `rejected${declared}`,
      `submitted with ${JSON.stringify(value)}`,
      `The form accepted ${JSON.stringify(value)} in ${sel} and submitted, though it declares${declared}.`,
      sel);
  }

  verdictNow = await fieldVerdict(page, sel);
  const stillFlagged = verdictNow.valid === false || verdictNow.ariaInvalid ||
    (verdictNow.describedBy || []).length > 0;
  const why = brokeWhat(verdictNow.flags);
  return record(
    kind,
    stillFlagged ? 'passed' : 'failed',
    `rejected${declared}`,
    stillFlagged ? `refused — ${verdictNow.message || why || 'marked invalid'}` : 'no objection raised',
    stillFlagged ? null
      : `The page did not navigate, but it raised no objection to ${JSON.stringify(value)} in ${sel} either — nothing tells the user the value is wrong.`,
    sel);
}

// --------------------------------------------------------------------------- functionality

/**
 * Submission safety.
 *
 * Submitting a valid form on someone's site CREATES DATA. So by default the
 * outbound request is intercepted and aborted: we assert the method, URL and
 * payload that WOULD have been sent, and nothing leaves the browser. That is
 * enough to know the form wired its submit up correctly.
 *
 * `plan.allow_submit` lets a real submission through, for a target the user has
 * told us is safe. A case that needs a real submit and cannot have one is
 * reported `skipped` with that reason — never `passed`, which would claim a
 * verification we did not perform.
 */
function armSubmitTrap(page, allowSubmit) {
  const seen = [];
  const handler = async (route) => {
    const req = route.request();
    const isNav = req.isNavigationRequest();
    const method = req.method();
    // Only the form's own submission is interesting: a navigation, or a
    // non-GET call. Page assets must go through untouched or the page breaks.
    if (!isNav && method === 'GET') return route.continue();
    seen.push({ method, url: req.url(), body: (req.postData() || '').slice(0, 2000) });
    if (allowSubmit) return route.continue();
    return route.abort('aborted');
  };
  return {
    seen,
    async on() { await page.route('**/*', handler); },
    async off() { await page.unroute('**/*', handler).catch(() => {}); },
  };
}

/** Put a value into one control, whatever kind it is. */
async function setField(page, item) {
  const loc = page.locator(item.selector).first();
  if ((await loc.count()) === 0) return false;
  const type = String(item.type || 'text');
  try {
    if (type === 'select') { await loc.selectOption(item.value); return true; }
    if (type === 'checkbox' || type === 'radio') { await loc.check(); return true; }
    // Date/time controls are segmented: typing characters into them does not
    // land a value, so they read back empty and the form looks unfillable.
    // fill() sets them the way the browser's own picker would.
    if (['date', 'time', 'datetime-local', 'month', 'week'].includes(type)) {
      await loc.fill(item.value);
      return true;
    }
    await typeInto(loc, item.value);
    return true;
  } catch { return false; }
}

/**
 * Fill every item, and report which ones verifiably hold the value afterwards.
 *
 * The read-back matters: a date or time input will not take typed text, and a
 * field hidden behind a conditional will not take anything at all. Treating
 * those as "filled" made the recovery check report them as CLEARED by the page
 * a moment later — a false accusation of data loss. Only what we know we set
 * can be checked for having survived.
 */
async function fillAll(page, fill) {
  const missed = [];
  const settled = [];
  for (const item of fill || []) {
    if (!(await setField(page, item))) { missed.push(item.selector); continue; }
    if (item.type === 'checkbox' || item.type === 'radio') { settled.push(item.selector); continue; }
    const now = await page.locator(item.selector).first().inputValue().catch(() => null);
    if (now === item.value) settled.push(item.selector);
    else missed.push(item.selector);
  }
  return { missed, settled };
}

/** Click the form's submit, or press Enter in it. */
async function submitForm(page, formSel) {
  const submit = page.locator(`${formSel} [type=submit], ${formSel} button:not([type=button])`).first();
  if (await submit.count().then((c) => c > 0).catch(() => false)) {
    await submit.click({ timeout: STEP_WAIT }).catch(() => {});
    return true;
  }
  await page.locator(`${formSel} input, ${formSel} textarea`).first()
    .press('Enter', { timeout: STEP_WAIT }).catch(() => {});
  return false;
}

/** Did the form go through? Navigation, an intercepted request, or the form gone. */
async function submissionOutcome(page, formSel, trap, urlBefore) {
  await settle(page);
  const navigated = page.url() !== urlBefore;
  const intercepted = trap.seen.length > 0;
  const formGone = (await page.locator(formSel).count().catch(() => 1)) === 0;
  return { navigated, intercepted, formGone, sent: trap.seen[0] || null,
           went: navigated || intercepted || formGone };
}

/** 1. HAPPY PATH — filled correctly, the form submits. */
async function checkHappyPath(page, step, opts) {
  const req = step.request || {};
  const formSel = req.form;
  const trap = armSubmitTrap(page, opts.allowSubmit);
  await trap.on();
  try {
    const { missed } = await fillAll(page, req.fill);
    if (missed.length) {
      return record('happy_path', 'failed', 'every field can be filled',
        `could not fill ${missed.join(', ')}`,
        `The form could not be completed: ${missed.join(', ')} would not take a value.`);
    }
    const urlBefore = page.url();
    await submitForm(page, formSel);
    const out = await submissionOutcome(page, formSel, trap, urlBefore);
    const how = out.sent ? `${out.sent.method} ${out.sent.url}`
      : out.navigated ? `navigated to ${page.url()}` : 'the form was replaced';
    return record(
      'happy_path',
      out.went ? 'passed' : 'failed',
      'the form submits when every field is valid',
      out.went ? how : 'nothing was sent and nothing changed',
      out.went ? null
        : 'Every field was filled with a value the form itself declares valid, and submitting did nothing — no request left the page and nothing on it changed.');
  } finally {
    // No reset here: the case loop reloads before the next case, and doing it
    // twice doubled the cost of the slowest checks on the page.
    await trap.off();
  }
}

/** 2. ERROR RECOVERY — refused, corrected, accepted, nothing lost. */
async function checkErrorRecovery(page, step, opts) {
  const req = step.request || {};
  const formSel = req.form;
  const emptySel = req.empty;
  const trap = armSubmitTrap(page, opts.allowSubmit);
  await trap.on();
  try {
    const { settled } = await fillAll(page, req.fill);
    const target = page.locator(emptySel).first();
    if ((await target.count()) === 0) {
      return record('error_recovery', 'failed', 'the field is on the page',
        `${emptySel} was not found`, `${emptySel} was not found`, emptySel);
    }
    await target.fill('').catch(() => {});

    const urlBefore = page.url();
    await submitForm(page, formSel);
    const first = await submissionOutcome(page, formSel, trap, urlBefore);
    if (first.went) {
      return record('error_recovery', 'failed',
        'refused while the required field is empty',
        'submitted anyway',
        `The form submitted with ${emptySel} empty, so there was nothing to recover from — the required rule is not enforced.`,
        emptySel);
    }

    // The rejection must not have eaten the rest of the form.
    const lost = [];
    for (const item of req.fill || []) {
      if (item.selector === emptySel) continue;
      if (item.type === 'checkbox' || item.type === 'radio') continue;
      if (!settled.includes(item.selector)) continue;   // never held it to begin with
      const now = await page.locator(item.selector).first().inputValue().catch(() => null);
      if (now !== null && now !== item.value) lost.push(item.selector);
    }
    if (lost.length) {
      return record('error_recovery', 'failed', 'the other fields keep their values',
        `cleared: ${lost.join(', ')}`,
        `After the submission was refused the page cleared ${lost.join(', ')}. The user has to type it all again.`,
        emptySel);
    }

    // Correct it and submit again.
    const original = (req.fill || []).find((f) => f.selector === emptySel);
    if (original) await setField(page, original);
    trap.seen.length = 0;
    const urlBefore2 = page.url();
    await submitForm(page, formSel);
    const second = await submissionOutcome(page, formSel, trap, urlBefore2);
    return record(
      'error_recovery',
      second.went ? 'passed' : 'failed',
      'accepted once the field is corrected',
      second.went ? 'accepted, other values intact' : 'still refused after correction',
      second.went ? null
        : `The form still refused after ${emptySel} was corrected, so there is no way through it.`,
      emptySel);
  } finally {
    // No reset here: the case loop reloads before the next case, and doing it
    // twice doubled the cost of the slowest checks on the page.
    await trap.off();
  }
}

/** 3. STATE — a required checkbox must gate the submit. */
async function checkSubmitGated(page, step, opts) {
  const req = step.request || {};
  const formSel = req.form;
  const gate = req.gate;
  const trap = armSubmitTrap(page, false);   // never let a gated submit through
  await trap.on();
  try {
    for (const item of req.fill || []) {
      if (item.selector === gate) continue;
      await setField(page, item);
    }
    await page.locator(gate).first().uncheck().catch(() => {});
    const urlBefore = page.url();
    await submitForm(page, formSel);
    const out = await submissionOutcome(page, formSel, trap, urlBefore);
    return record(
      'submit_gated',
      out.went ? 'failed' : 'passed',
      'blocked while the required box is unticked',
      out.went ? 'submitted anyway' : 'blocked',
      out.went ? `The form submitted with ${gate} unticked, though it is marked required.` : null,
      gate);
  } finally {
    // No reset here: the case loop reloads before the next case, and doing it
    // twice doubled the cost of the slowest checks on the page.
    await trap.off();
  }
}

/** 4. CONDITIONAL VISIBILITY — the same option shows the same fields. */
async function checkConditionalFields(page, step) {
  const req = step.request || {};
  const sel = req.selector;
  const watch = req.watch || [];
  const options = req.options || [];
  if (!sel || options.length < 2 || !watch.length) {
    return record('conditional_fields', 'skipped', null, null,
      'not enough recorded to compare');
  }
  const shown = async () => {
    const out = [];
    for (const w of watch) {
      const visible = await page.locator(w).first().isVisible().catch(() => false);
      if (visible) out.push(w);
    }
    return out.join('|');
  };
  const firstPass = {};
  for (const value of options) {
    await page.locator(sel).first().selectOption(value).catch(() => {});
    await page.waitForTimeout(250);
    firstPass[value] = await shown();
  }
  // Same option, same fields — a mapping that changes on a second pass is the bug.
  for (const value of options) {
    await page.locator(sel).first().selectOption(value).catch(() => {});
    await page.waitForTimeout(250);
    const again = await shown();
    if (again !== firstPass[value]) {
      return record('conditional_fields', 'failed', 'the same fields for the same option',
        `"${value}" showed a different set the second time`,
        `Choosing "${value}" in ${sel} showed one set of fields the first time and another the second.`,
        sel);
    }
  }
  const distinct = new Set(Object.values(firstPass)).size;
  return record('conditional_fields', 'passed', 'the same fields for the same option',
    distinct > 1 ? `${distinct} distinct field sets across ${options.length} options`
                 : 'the same fields for every option', null, sel);
}

/** 5. DEFAULTS — the page loads as discovery recorded it. */
/**
 * Field names whose value is SUPPOSED to change on every load.
 *
 * A CSRF token that came back identical would be the defect. Flagging its change
 * as "the page no longer loads as it did" was the runner's loudest false
 * positive on a real target — one of only two findings it produced on OrangeHRM,
 * and both were wrong (TR-014).
 */
const VOLATILE_FIELD = /(^|[_\-\[])(csrf|xsrf|_token|authenticity_token|nonce|state|timestamp|ts|request_id|session)([_\-\]]|$)/i;

function isVolatile(selector) {
  return VOLATILE_FIELD.test(String(selector || ''));
}

async function checkInitialState(page, step) {
  const all = (step.request || {}).defaults || [];
  const defaults = all.filter((d) => !isVolatile(d.selector));
  const ignored = all.length - defaults.length;
  if (!defaults.length) {
    return record('initial_state', 'skipped', null, null,
      ignored ? `only ${ignored} volatile field(s) recorded — nothing stable to compare`
        : 'no initial state recorded');
  }
  const drifted = [];
  for (const d of defaults) {
    const loc = page.locator(d.selector).first();
    if ((await loc.count()) === 0) { drifted.push(`${d.selector} is gone`); continue; }
    if (d.checked !== null && d.checked !== undefined) {
      const now = await loc.isChecked().catch(() => null);
      if (now !== null && now !== d.checked) {
        drifted.push(`${d.selector} starts ${now ? 'checked' : 'unchecked'}, was ${d.checked ? 'checked' : 'unchecked'}`);
      }
      continue;
    }
    const now = await loc.inputValue().catch(() => null);
    if (now !== null && now !== d.value) {
      drifted.push(`${d.selector} starts ${JSON.stringify(now)}, was ${JSON.stringify(d.value)}`);
    }
  }
  return record(
    'initial_state',
    drifted.length ? 'failed' : 'passed',
    'the recorded initial state',
    drifted.length ? drifted.join('; ')
      : `${defaults.length} control(s) unchanged`
        + (ignored ? ` (${ignored} volatile field(s) excluded)` : ''),
    drifted.length ? `The page no longer loads as it did: ${drifted.join('; ')}.` : null);
}

/** 6. NAVIGATION — every discovered link resolves. */
/**
 * Statuses that mean "you are a bot", not "this link is broken".
 *
 * LinkedIn answers 999 to any automated request and Facebook answers 400; both
 * were reported as defects in the product under test, which they are not. A
 * finding that names someone else's anti-bot policy costs the reader more than
 * it gives them (TR-014, NF-03).
 */
const BOT_WALL = new Set([401, 403, 405, 406, 429, 451, 503, 999]);

async function checkLinksResolve(page, step) {
  const links = (step.request || {}).links || [];
  if (!links.length) return record('links_resolve', 'skipped', null, null, 'no links recorded');

  // Off-origin links belong to somebody else's uptime. They are checked only
  // when the case asks for it, and never counted as a defect in this product.
  let origin = '';
  try { origin = new URL(page.url()).origin; } catch { /* keep the empty origin */ }
  const sameOrigin = (href) => {
    try { return new URL(href, page.url()).origin === origin; } catch { return false; }
  };
  const includeExternal = (step.request || {}).include_external === true;

  const broken = [];
  const blocked = [];
  const skippedExternal = [];
  for (const link of links) {
    if (!sameOrigin(link.href)) {
      if (!includeExternal) { skippedExternal.push(link.href); continue; }
    }
    try {
      const res = await page.request.get(link.href, { timeout: 10000, maxRedirects: 5 });
      const status = res.status();
      if (status < 400) continue;
      if (!sameOrigin(link.href) && BOT_WALL.has(status)) {
        blocked.push(`${status} ${link.href}`);
      } else {
        broken.push(`${status} ${link.href}`);
      }
    } catch (err) {
      (sameOrigin(link.href) ? broken : blocked).push(`unreachable ${link.href}`);
    }
  }

  const checked = links.length - skippedExternal.length;
  const notes = [];
  if (skippedExternal.length) notes.push(`${skippedExternal.length} external link(s) not checked`);
  if (blocked.length) notes.push(`${blocked.length} external link(s) behind bot protection: ${blocked.join('; ')}`);

  if (!checked) {
    return record('links_resolve', 'skipped', 'every link resolves', null,
      `every link on this page is off-origin${notes.length ? ` — ${notes.join('; ')}` : ''}`);
  }
  return record(
    'links_resolve',
    broken.length ? 'failed' : 'passed',
    'every link resolves',
    broken.length ? broken.join('; ')
      : `${checked} link(s) resolve${notes.length ? ` (${notes.join('; ')})` : ''}`,
    broken.length ? `These links do not resolve: ${broken.join('; ')}.` : null);
}

/** The measured load must sit inside the stated budget. */
function checkPageLoad(assertion, elapsedMs) {
  const budget = Number(assertion.expected_max ?? assertion.expected);
  if (!Number.isFinite(budget)) {
    return record('page_load_ms', 'skipped', null, elapsedMs, 'no budget recorded');
  }
  return record(
    'page_load_ms',
    elapsedMs <= budget ? 'passed' : 'failed',
    budget,
    elapsedMs,
    elapsedMs <= budget ? null
      : `The page took ${elapsedMs}ms to load against a ${budget}ms budget.`);
}

// --------------------------------------------------------------- design & a11y
//
// These used to be skipped wholesale: `skipDesign()` returned "measured from the
// screenshot, not the live DOM" for every one of them, so 68% of the cases the
// platform generated could never run and the case that HAD measured a failing
// 1.33:1 contrast was never executed (TR-008).
//
// Most of them can be measured live, and measuring live is strictly better: the
// discovery raster answers "what colour is this pixel", the DOM answers "what
// colour is this TEXT on ITS OWN background", which is the question WCAG asks
// (TR-010). Three of them genuinely cannot be reproduced from the DOM, and those
// are DECLARED unsupported rather than skipped in silence.

/** Facts derived from a raster projection profile. The DOM cannot reproduce them. */
const RASTER_ONLY = {
  surface_share: 'share is measured by counting screenshot pixels; the DOM can only '
    + 'estimate it, and an estimate reported as a pass or a fail would be a guess',
  alignment: 'alignment is derived from a raster projection profile, not from element boxes',
  spacing: 'the rhythm is derived from a raster projection profile, not from element boxes',
};

function unsupported(type) {
  // A distinct outcome from `skipped`: this is a standing statement about what
  // the runner can and cannot do, not a per-run accident. The backend excludes
  // it from coverage instead of counting it as a pass (H1/H6).
  return { ...record(type, 'unsupported', null, null, RASTER_ONLY[type]), permanent: true };
}

const hex = (rgb) => '#' + rgb.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('').toUpperCase();

function parseColour(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.slice(0, 3).map(Number);
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value).trim());
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(String(value));
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

/** WCAG 2.1 relative luminance and contrast ratio — the arithmetic in the spec. */
function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const near = (a, b, tol = 8) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= tol);

/**
 * Every visible text run on the page with the colours it is actually painted in.
 *
 * Walks up for the first non-transparent background, which is what the eye sees
 * and what the raster sampler could only approximate. Font size and weight come
 * back too, because WCAG's threshold is 3:1 for large text and 4.5:1 for the
 * rest — a checker that applies 4.5 to everything reports headings as failures.
 */
async function readTextStyles(page) {
  return page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const toRgb = (s) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(s || '');
      return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const backdrop = (el) => {
      let node = el;
      while (node && node !== document.documentElement) {
        const bg = toRgb(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0.1) return bg.rgb;
        node = node.parentElement;
      }
      const root = toRgb(getComputedStyle(document.body).backgroundColor);
      return root && root.a > 0.1 ? root.rgb : [255, 255, 255];
    };
    for (const el of document.querySelectorAll('*')) {
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join(' ')
        .trim();
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const ink = toRgb(cs.color);
      if (!ink || ink.a < 0.1) continue;
      const size = parseFloat(cs.fontSize) || 16;
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const surface = backdrop(el);
      const key = ink.rgb.join(',') + '|' + surface.join(',') + '|' + (size >= 18 || (size >= 14 && weight >= 700));
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ink: ink.rgb,
        surface,
        fontSize: size,
        fontWeight: weight,
        large: size >= 18.66 || (size >= 14 && weight >= 700),
        sample: text.slice(0, 60),
        tag: el.tagName.toLowerCase(),
      });
    }
    return out;
  });
}

/** Colour + geometry of every visible element, for the design-fact checks. */
async function readElementBoxes(page) {
  return page.evaluate(() => {
    const out = [];
    const toRgb = (s) => {
      const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?/i.exec(s || '');
      return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      const bg = toRgb(cs.backgroundColor);
      if (!bg || bg.a < 0.1) continue;
      out.push({
        colour: bg.rgb,
        box: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)],
        area: Math.round(b.width * b.height),
        tag: el.tagName.toLowerCase(),
      });
    }
    return out;
  });
}

async function checkContrastAA(page, step, assertion) {
  const expected = assertion.expected || step.request?.expected || {};
  const fact = String(step.request?.fact || '');
  const m = /contrast:(#[0-9A-Fa-f]{6})_on_(#[0-9A-Fa-f]{6})/.exec(fact);
  const styles = await readTextStyles(page);
  if (!styles.length) {
    return record('contrast_aa', 'skipped', expected, null, 'the page renders no visible text');
  }

  // The pair the case was written from, measured on the live page.
  let subject = null;
  if (m) {
    const ink = parseColour(m[1]);
    const surface = parseColour(m[2]);
    subject = styles.find((s) => near(s.ink, ink) && near(s.surface, surface));
    if (!subject) {
      return record('contrast_aa', 'skipped', expected, null,
        `${m[1]} on ${m[2]} is no longer painted on this page`);
    }
  } else {
    // No fact to anchor to: judge the page by its worst real pair.
    subject = styles.reduce((worst, s) => {
      const r = contrastRatio(s.ink, s.surface);
      return worst === null || r < worst.r ? { ...s, r } : worst;
    }, null);
  }

  const ratio = Math.round(contrastRatio(subject.ink, subject.surface) * 100) / 100;
  // WCAG 2.1: 3:1 for large text, 4.5:1 for the rest. Applying 4.5 to a heading
  // reports a conforming page as broken.
  const required = subject.large ? 3 : (Number(expected.min_ratio) || 4.5);
  const actual = {
    ratio,
    required,
    ink: hex(subject.ink),
    surface: hex(subject.surface),
    large_text: !!subject.large,
    font_px: subject.fontSize,
    sample: subject.sample,
  };
  return record('contrast_aa', ratio >= required ? 'passed' : 'failed',
    { min_ratio: required }, actual,
    ratio >= required ? null
      : `${hex(subject.ink)} on ${hex(subject.surface)} is ${ratio}:1, below the `
        + `${required}:1 WCAG AA minimum (text: "${subject.sample}")`);
}

async function checkElementPresent(page, step, assertion) {
  const expected = assertion.expected || step.request?.expected || {};
  const want = parseColour(expected.colour);
  if (!want) return record('element_present', 'skipped', expected, null, 'no colour recorded');
  const boxes = await readElementBoxes(page);
  const hit = boxes.find((b) => near(b.colour, want, 6));
  return record('element_present', hit ? 'passed' : 'failed', hex(want),
    hit ? { colour: hex(hit.colour), box: hit.box, tag: hit.tag } : null,
    hit ? null : `no visible element is painted ${hex(want)}`);
}

async function checkElementBox(page, step, assertion) {
  const expected = assertion.expected || step.request?.expected || {};
  const want = expected.box;
  const tol = Number(expected.tolerance ?? 2);
  if (!Array.isArray(want) || want.length < 4) {
    return record('element_box', 'skipped', expected, null, 'no box recorded');
  }
  const boxes = await readElementBoxes(page);
  const hit = boxes.find((b) => b.box.every((v, i) => Math.abs(v - want[i]) <= tol));
  if (hit) return record('element_box', 'passed', want, hit.box);
  // Report the nearest box: "no element there" is far less useful than "it moved".
  const nearest = boxes.reduce((best, b) => {
    const d = Math.abs(b.box[0] - want[0]) + Math.abs(b.box[1] - want[1])
      + Math.abs(b.box[2] - want[2]) + Math.abs(b.box[3] - want[3]);
    return best === null || d < best.d ? { box: b.box, tag: b.tag, d } : best;
  }, null);
  return record('element_box', 'failed', want, nearest && nearest.box,
    nearest ? `nearest element is ${nearest.tag} at ${nearest.box.join(',')} `
      + `(tolerance ${tol}px)` : 'the page has no comparable element');
}

async function checkSurfacePresent(page, step, assertion) {
  const expected = assertion.expected || step.request?.expected || {};
  const want = parseColour(expected.colour);
  if (!want) return record('surface_present', 'skipped', expected, null, 'no colour recorded');
  const boxes = await readElementBoxes(page);
  const hits = boxes.filter((b) => near(b.colour, want, 6));
  return record('surface_present', hits.length ? 'passed' : 'failed', hex(want),
    hits.length ? { count: hits.length, largest: Math.max(...hits.map((h) => h.area)) } : null,
    hits.length ? null : `${hex(want)} is not painted anywhere on this page`);
}

async function checkPaletteClosed(page, step, assertion) {
  const expected = assertion.expected || step.request?.expected || {};
  const allowed = (expected.allowed || []).map(parseColour).filter(Boolean);
  if (!allowed.length) {
    return record('palette_closed', 'skipped', expected, null, 'no palette recorded');
  }
  const boxes = await readElementBoxes(page);
  // Ignore slivers: a 1px hairline is an antialiasing artefact, not a new brand
  // colour, and reporting it would drown the finding that matters.
  const strangers = [];
  for (const b of boxes) {
    if (b.area < 400) continue;
    if (allowed.some((c) => near(c, b.colour, 10))) continue;
    if (!strangers.some((s) => near(s.colour, b.colour, 6))) {
      strangers.push({ colour: b.colour, box: b.box, tag: b.tag, area: b.area });
    }
  }
  strangers.sort((a, b) => b.area - a.area);
  const top = strangers.slice(0, 5).map((s) => `${hex(s.colour)} (${s.tag})`);
  return record('palette_closed', strangers.length ? 'failed' : 'passed',
    allowed.map(hex), top.length ? top : null,
    strangers.length ? `${strangers.length} surface colour(s) outside the design: ${top.join(', ')}` : null);
}

/**
 * Deterministic accessibility rules over the live DOM (TR-011).
 *
 * The crawler never recorded alt text, ARIA state, tabindex, id uniqueness or
 * table semantics, so a whole class of defect was not merely unchecked — it was
 * structurally invisible. None of these rules needs a model: each is a fact
 * about the document, and each names the element it is about so the finding is
 * actionable rather than a score.
 */
async function auditAccessibility(page) {
  return page.evaluate(() => {
    const findings = [];
    const describe = (el) => {
      const id = el.id ? `#${el.id}` : '';
      const name = el.getAttribute('name') ? `[name="${el.getAttribute('name')}"]` : '';
      return `${el.tagName.toLowerCase()}${id}${name}`;
    };
    const visible = (el) => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };

    // 1. duplicate ids — the DOM says getElementById returns the first, so the
    //    second element is unreachable by id and any label pointing at it is wrong
    const byId = new Map();
    for (const el of document.querySelectorAll('[id]')) {
      const list = byId.get(el.id) || [];
      list.push(el);
      byId.set(el.id, list);
    }
    for (const [id, list] of byId) {
      if (list.length > 1) {
        findings.push({
          rule: 'duplicate-id',
          element: `#${id}`,
          detail: `id "${id}" is used by ${list.length} elements (${list.map(describe).join(', ')})`,
        });
      }
    }

    // 2. every control needs a programmatic name
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!visible(el) || el.type === 'hidden') continue;
      const labelled = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`))
        || el.closest('label')
        || el.getAttribute('aria-label')
        || (el.getAttribute('aria-labelledby')
          && document.getElementById(el.getAttribute('aria-labelledby')));
      if (!labelled) {
        findings.push({
          rule: 'control-without-label',
          element: describe(el),
          detail: el.placeholder
            ? `only a placeholder ("${el.placeholder}") — a placeholder is not a label`
            : 'no label, no aria-label, no aria-labelledby',
        });
      }
    }

    // 3. a label pointing at an id that does not exist names nothing
    for (const label of document.querySelectorAll('label[for]')) {
      const target = label.getAttribute('for');
      if (target && !document.getElementById(target)) {
        findings.push({
          rule: 'label-for-missing-target',
          element: `label[for="${target}"]`,
          detail: `no element has id "${target}", so this label names nothing`,
        });
      }
    }

    // 4. images need alt; a decorative one carries an empty alt on purpose
    for (const img of document.querySelectorAll('img')) {
      if (!visible(img)) continue;
      if (!img.hasAttribute('alt')) {
        findings.push({
          rule: 'image-without-alt',
          element: describe(img) + ` src="${(img.getAttribute('src') || '').slice(0, 60)}"`,
          detail: 'no alt attribute — a decorative image needs alt="" explicitly',
        });
      }
    }

    // 5. the document must declare its language
    if (!document.documentElement.getAttribute('lang')) {
      findings.push({
        rule: 'html-without-lang',
        element: 'html',
        detail: 'the root element declares no language, so screen readers guess the pronunciation',
      });
    }

    // 6. a positive tabindex overrides document order for the whole page
    for (const el of document.querySelectorAll('[tabindex]')) {
      const value = parseInt(el.getAttribute('tabindex'), 10);
      if (value > 0) {
        findings.push({
          rule: 'positive-tabindex',
          element: describe(el),
          detail: `tabindex="${value}" pulls this control out of document order`,
        });
      }
    }

    // 7. a control that opens something must keep aria-expanded truthful
    for (const el of document.querySelectorAll('[aria-expanded]')) {
      const controlled = el.getAttribute('aria-controls');
      if (!controlled) continue;
      const target = document.getElementById(controlled);
      if (!target) {
        findings.push({
          rule: 'aria-controls-missing-target',
          element: describe(el),
          detail: `aria-controls="${controlled}" names no element`,
        });
        continue;
      }
      const shown = getComputedStyle(target).display !== 'none'
        && getComputedStyle(target).visibility !== 'hidden';
      const claims = el.getAttribute('aria-expanded') === 'true';
      if (shown !== claims) {
        findings.push({
          rule: 'aria-expanded-out-of-step',
          element: describe(el),
          detail: `aria-expanded="${claims}" while its target is ${shown ? 'visible' : 'hidden'}`,
        });
      }
    }

    // 8. a data table needs a caption and scoped headers to be readable at all
    for (const table of document.querySelectorAll('table')) {
      if (!visible(table)) continue;
      const headers = table.querySelectorAll('th');
      if (!headers.length) continue;             // a layout table, not a data table
      if (!table.querySelector('caption')) {
        findings.push({
          rule: 'table-without-caption',
          element: describe(table),
          detail: 'a data table with no caption cannot be identified out of context',
        });
      }
      const unscoped = Array.from(headers).filter((th) => !th.getAttribute('scope'));
      if (unscoped.length) {
        findings.push({
          rule: 'header-without-scope',
          element: describe(table),
          detail: `${unscoped.length} of ${headers.length} header cells carry no scope`,
        });
      }
    }

    // 9. a target smaller than 24x24 CSS px cannot be hit reliably (WCAG 2.2)
    for (const el of document.querySelectorAll('a[href], button, [role="button"], input[type="button"], input[type="submit"]')) {
      if (!visible(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.width < 24 || b.height < 24) {
        findings.push({
          rule: 'target-too-small',
          element: describe(el),
          detail: `${Math.round(b.width)}x${Math.round(b.height)} px, below the 24x24 minimum`,
        });
      }
    }

    // 10. a field marked required only by a visual asterisk is not marked at all
    for (const label of document.querySelectorAll('label')) {
      const marksRequired = /\*/.test(label.textContent || '')
        || /\*/.test(getComputedStyle(label, '::after').content || '');
      if (!marksRequired) continue;
      const target = label.getAttribute('for')
        ? document.getElementById(label.getAttribute('for'))
        : label.querySelector('input, select, textarea');
      if (!target) continue;
      if (!target.hasAttribute('required') && target.getAttribute('aria-required') !== 'true') {
        findings.push({
          rule: 'required-visually-only',
          element: describe(target),
          detail: 'the label marks it required with an asterisk, but the control does not',
        });
      }
    }

    return findings;
  });
}

async function checkAccessibility(page, step) {
  const findings = await auditAccessibility(page);
  if (!findings.length) {
    return record('a11y_audit', 'passed', 'no accessibility rule violated', { findings: 0 });
  }
  const byRule = {};
  for (const f of findings) (byRule[f.rule] = byRule[f.rule] || []).push(f);
  const summary = Object.entries(byRule)
    .map(([rule, list]) => `${rule} x${list.length}`)
    .join(', ');
  return record('a11y_audit', 'failed', 'no accessibility rule violated',
    { findings: findings.length, rules: Object.keys(byRule), detail: findings.slice(0, 25) },
    `${findings.length} accessibility finding(s): ${summary}`);
}

/** The submit must not have navigated: a rejected form stays where it is. */
async function checkNoNavigation(page, step, startUrl) {
  const now = page.url();
  const same = now.split('#')[0] === String(startUrl || '').split('#')[0];
  return record('no_navigation', same ? 'passed' : 'failed', startUrl, now,
    same ? null : `the page navigated to ${now} instead of reporting the error in place`);
}

// --------------------------------------------------------------------------- one case

async function runCase(page, kase, opts) {
  const started = Date.now();
  const assertions = [];
  let errored = null;

  // The budget for THIS attempt. Set per call rather than once at startup so the
  // retry pass can raise it without disturbing the cases running at the base one.
  STEP_WAIT = opts.stepWait || DEFAULTS.stepWait;

  for (const step of kase.checks || []) {
    const req = step.request || {};
    const check = String(req.check || '');
    const list = step.assertions || [];

    // Before the step reads anything, let the page finish reacting to whatever
    // the previous step (or the reset navigation) set in motion. Without this the
    // first step of every case races the page's own hydration, and the assertion
    // describes a half-built DOM.
    await settle(page).catch(() => {});

    try {
      if (check === 'elements_present') {
        assertions.push(await checkElementsPresent(page, step, list[0] || {}));
      } else if (check === 'required_field_enforced') {
        const before = page.url();
        assertions.push(await checkRequiredField(page, step));
        if (list.some((a) => String(a.type) === 'no_navigation')) {
          assertions.push(await checkNoNavigation(page, step, before));
        }
        // The submit may have navigated; put the page back for the next case.
        await opts.reset();
      } else if (check === 'maxlength_enforced') {
        assertions.push(await checkMaxlength(page, step, list[0] || {}));
      } else if (check === 'pattern_enforced') {
        assertions.push(await checkPattern(page, step, list[0] || {}));
      } else if (check === 'value_rejected' || check === 'value_accepted' ||
                 check === 'whitespace_rejected') {
        assertions.push(await checkValue(page, step, check, opts));
        if (check !== 'value_accepted') await opts.reset();
      } else if (check === 'happy_path') {
        assertions.push(await checkHappyPath(page, step, opts));
      } else if (check === 'error_recovery') {
        assertions.push(await checkErrorRecovery(page, step, opts));
      } else if (check === 'submit_gated') {
        assertions.push(await checkSubmitGated(page, step, opts));
      } else if (check === 'conditional_fields') {
        assertions.push(await checkConditionalFields(page, step));
      } else if (check === 'initial_state') {
        assertions.push(await checkInitialState(page, step));
      } else if (check === 'links_resolve') {
        assertions.push(await checkLinksResolve(page, step));
      } else if (check === 'page_load_ms') {
        assertions.push(checkPageLoad(list[0] || {}, opts.loadMs));
      } else if (check === 'contrast_aa') {
        assertions.push(await checkContrastAA(page, step, list[0] || {}));
      } else if (check === 'element_present') {
        assertions.push(await checkElementPresent(page, step, list[0] || {}));
      } else if (check === 'element_box') {
        assertions.push(await checkElementBox(page, step, list[0] || {}));
      } else if (check === 'surface_present') {
        assertions.push(await checkSurfacePresent(page, step, list[0] || {}));
      } else if (check === 'palette_closed') {
        assertions.push(await checkPaletteClosed(page, step, list[0] || {}));
      } else if (check === 'a11y_audit') {
        assertions.push(await checkAccessibility(page, step));
      } else if (RASTER_ONLY[check]) {
        // Declared, not forgotten: the backend excludes `unsupported` from the
        // coverage numbers instead of counting it as a pass (H1/H6).
        assertions.push(unsupported(check));
      } else if (list.length) {
        for (const a of list) {
          const t = String(a.type || 'unknown');
          assertions.push(RASTER_ONLY[t]
            ? unsupported(t)
            : record(t, 'skipped', a.expected, null, `no browser check implements '${t}'`));
        }
      } else {
        assertions.push(record(check || 'unknown', 'skipped', null, null,
          'the case records no assertion this runner understands'));
      }
    } catch (err) {
      errored = cleanMessage(err.message || err);
      assertions.push(record(check || 'unknown', 'skipped', null, null, `check errored: ${errored}`));
      break;
    }
  }

  const failed = assertions.find((a) => a.outcome === 'failed');
  const anyPassed = assertions.some((a) => a.outcome === 'passed');
  const anyUnsupported = assertions.some((a) => a.outcome === 'unsupported');
  // H1: nothing evaluated is never a pass. `unsupported` outranks `skipped`
  // because it is a permanent statement, not this run's accident.
  const outcome = errored ? 'errored'
    : failed ? 'failed'
      : anyPassed ? 'passed'
        : anyUnsupported ? 'unsupported'
          : 'skipped';

  return {
    case_id: kase.id,
    outcome,
    duration_ms: Date.now() - started,
    assertions,
    failure: failed
      ? {
        message: failed.message || `${failed.type} failed`,
        expected: failed.expected,
        actual: failed.actual,
        selector: failed.selector || null,
        assertion: failed.type,
      }
      : (errored ? { message: errored, expected: null, actual: null, selector: null, assertion: null } : null),
  };
}

// --------------------------------------------------------------------------- main

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { return fail('bad_arguments', err.message, undefined, 2); }

  if (!args.plan) return fail('bad_arguments', '--plan <file.json> is required', undefined, 2);

  let plan;
  try { plan = JSON.parse(fs.readFileSync(args.plan, 'utf8')); }
  catch (err) { return fail('bad_arguments', `cannot read --plan: ${err.message}`, undefined, 2); }

  const cases = Array.isArray(plan.cases) ? plan.cases.slice(0, DEFAULTS.maxCases) : [];
  if (!plan.url) return fail('bad_arguments', 'plan.url is required', undefined, 2);
  if (!cases.length) return fail('bad_arguments', 'plan.cases is empty', undefined, 2);

  // Artefacts are opt-in: without --artifacts the runner behaves exactly as
  // before, which keeps the plans that do not want a 20-minute recording cheap.
  const artifactsDir = args.artifacts || plan.artifacts_dir || null;
  let shotsDir = null;
  if (artifactsDir) {
    try {
      shotsDir = path.join(artifactsDir, 'shots');
      fs.mkdirSync(shotsDir, { recursive: true });
      fs.mkdirSync(path.join(artifactsDir, 'video'), { recursive: true });
    } catch (err) {
      return fail('bad_arguments', `cannot create --artifacts dir: ${err.message}`, undefined, 2);
    }
  }

  let viewport, timeout, stepWait, stepWaitRetry;
  try {
    viewport = parseViewport(plan.viewport || args.viewport || DEFAULTS.viewport);
    timeout = asInt(args.timeout, plan.timeout_ms || DEFAULTS.timeout, 'timeout');
    stepWait = asInt(args['step-wait'], plan.step_wait_ms || DEFAULTS.stepWait, 'step-wait');
    stepWaitRetry = asInt(args['step-wait-retry'],
      plan.step_wait_retry_ms || DEFAULTS.stepWaitRetry, 'step-wait-retry');
    // A retry budget at or below the base one would spend the extra pass proving
    // nothing, so it is raised rather than silently honoured as configured.
    if (stepWaitRetry <= stepWait) stepWaitRetry = stepWait * 2;
  } catch (err) { return fail('bad_arguments', err.message, undefined, 2); }

  // A full-viewport recording of a run with hundreds of cases is a very large
  // file. Halving each dimension quarters the pixel count while leaving layout,
  // navigation and error text readable, which is what the video is watched for.
  const videoSize = { width: Math.round(viewport.width / 2), height: Math.round(viewport.height / 2) };

  let target;
  try { target = await assertAllowedUrl(plan.url); }
  catch (err) { return fail(err.traceoCode || 'invalid_url', err.message, undefined, err.traceoExit || 1); }

  let pw;
  try { ({ pw } = loadPlaywright()); }
  catch (err) { return fail(err.traceoCode, err.message, undefined, err.traceoExit || 3); }

  const startedAll = Date.now();
  let browser = null;
  try {
    try {
      browser = await pw.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
    } catch (err) {
      return fail('browser_check_unavailable',
        'The Chromium browser binary is not installed. Install it with:  npx --prefix ' +
        path.join(REPO_ROOT, 'e2e') + ' playwright install chromium\nUnderlying error: ' + err.message,
        undefined, 3);
    }

    // One context, one page, one continuous video: every case in this plan runs
    // on the same page, so the recording is the whole run end to end rather than
    // a pile of clips that have to be stitched back together. Playwright writes
    // the file only on context.close(), which is why the close below is in a
    // finally and is awaited.
    const videoDir = artifactsDir ? path.join(artifactsDir, 'video') : null;
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      ...(videoDir ? { recordVideo: { dir: videoDir, size: videoSize } } : {}),
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 TraceoCheck/1.0',
    });
    const page = await context.newPage();

    let loadMs = 0;
    /** Pages already given the full wait strategy, and what it cost them. */
    const firstLoadFor = new Map();
    /**
     * Load (or reload) the target and wait for it to be interactive.
     *
     * The first load pays the full wait strategy — network idle, hydration,
     * fonts — because that is what makes an SPA readable at all. Every case
     * after it re-loads the SAME page, so it only waits for the first control to
     * exist. With one reset per case that difference is the run: paying the full
     * strategy 40+ times pushed a page of 43 cases past the timeout.
     */
    const reset = async (href = target.href) => {
      const t0 = Date.now();
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout });
      loadMs = Date.now() - t0;
      if (!firstLoadFor.has(href)) {
        await page.waitForLoadState('networkidle', { timeout: DEFAULTS.idleTimeout })
          .catch(() => page.waitForTimeout(DEFAULTS.settle));
        await page.waitForFunction(
          () => document.querySelectorAll('form, input, select, textarea, button, a[href]').length > 0,
          undefined, { timeout: DEFAULTS.hydrate }).catch(() => {});
        await page.waitForTimeout(150);
        // Recorded per page: a crawl's cases span several, and the load budget a
        // performance assertion is judged against has to be that page's own.
        firstLoadFor.set(href, Date.now() - t0);
        return;
      }
      await page.waitForFunction(
        () => document.querySelectorAll('form, input, select, textarea, button, a[href]').length > 0,
        undefined, { timeout: DEFAULTS.rehydrate }).catch(() => {});
      await page.waitForTimeout(60);
    };

    try { await reset(); }
    catch (err) {
      return fail('navigation_failed', `Could not load ${target.href}: ${err.message}`);
    }
    const results = [];
    // Grouped by page, and only by page: within a group the plan's order is
    // preserved. Ungrouped, a crawl's cases ping-pong between pages and every
    // one of them pays a cold load.
    const ordered = [...cases].sort((a, b) => String(a.url || '').localeCompare(String(b.url || '')));

    for (const kase of ordered) {
      // The page this case was derived from. Running it anywhere else asks
      // questions about elements that are not there — which reads as a wall of
      // failures rather than as the mistake it is.
      const href = kase.url || target.href;
      // Each case starts from a clean render — an earlier case that typed into a
      // field or submitted a form must not colour the next one's evidence.
      try { await reset(href); } catch { /* keep the current page; the case will report */ }
      const resetThis = () => reset(href);
      const base = {
        reset: resetThis,
        loadMs: firstLoadFor.get(href) ?? loadMs,
        allowSubmit: plan.allow_submit === true,
      };
      let result = await runCase(page, kase, { ...base, stepWait: stepWait });

      // One retry at the wider budget, and ONLY for a case that did not pass.
      // A pass is never re-run: it has already answered, and re-running it could
      // only turn a good result into a flaky one. The retry re-navigates first so
      // the second attempt starts from the same clean render as the first, making
      // the extra time the only difference between them.
      if (result.outcome === 'failed' || result.outcome === 'errored') {
        try { await resetThis(); } catch { /* the retry will report what it finds */ }
        const retried = await runCase(page, kase, { ...base, stepWait: stepWaitRetry });
        // The retry REPLACES the first verdict either way. If it passed, the
        // first failure was the clock, not the application. If it failed again,
        // its evidence is the better record: same defect, observed with twice the
        // patience, which is what makes the finding worth acting on.
        result = { ...retried, retried: true, retried_after: result.outcome,
          step_wait_ms: stepWaitRetry };
      } else {
        result = { ...result, step_wait_ms: stepWait };
      }

      // The screenshot is taken AFTER the verdict and BEFORE the next case's
      // reset, so it shows the page in the state the assertion actually judged.
      // Taken for every non-passing case, not only failures: an errored or
      // skipped case is exactly the one whose reason is hardest to reconstruct
      // from text, and the frame is often the whole explanation — a consent
      // banner over the form, a login screen, an empty render.
      if (shotsDir && result.outcome !== 'passed') {
        const file = `${safeName(kase.id)}.png`;
        try {
          await page.screenshot({ path: path.join(shotsDir, file), fullPage: false });
          result = { ...result, screenshot: file };
        } catch (err) {
          // A screenshot that cannot be taken must not sink the case's real
          // verdict, which is already decided; the report says it is missing.
          result = { ...result, screenshot_error: cleanMessage(err.message || err) };
        }
      }
      results.push(result);
    }

    const finalUrl = page.url();

    // Playwright flushes the recording on context close, and only then is the
    // file complete on disk — so the close has to happen BEFORE the document is
    // emitted, not in the finally that tears the browser down afterwards. The
    // Video handle is taken while the page is still open because it cannot be
    // obtained from a closed one.
    let videoFile = null;
    let videoError = null;
    if (videoDir) {
      const video = page.video();
      try {
        await context.close();
        if (video) {
          const src = await video.path();
          // Playwright names the file after an internal id; a fixed name is what
          // lets the backend serve it without recording the name anywhere.
          videoFile = 'run.webm';
          const dest = path.join(videoDir, videoFile);
          if (path.resolve(src) !== path.resolve(dest)) fs.renameSync(src, dest);
        }
      } catch (err) {
        // A recording that failed to save must not discard a run's results.
        videoFile = null;
        videoError = cleanMessage(err.message || err);
      }
    }

    emit({
      ok: true,
      schema_version: SCHEMA_VERSION,
      url: target.href,
      final_url: finalUrl,
      viewport: `${viewport.width}x${viewport.height}`,
      allow_submit: plan.allow_submit === true,
      step_wait_ms: stepWait,
      step_wait_retry_ms: stepWaitRetry,
      video: videoFile,
      ...(videoError ? { video_error: videoError } : {}),
      // The entry page's own first load — the summary figure has always meant
      // that page, and a crawl's other pages each keep theirs in firstLoadFor.
      load_ms: firstLoadFor.get(target.href) ?? loadMs,
      elapsed_ms: Date.now() - startedAll,
      results,
    }, 0);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

await main();
