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
};

// --------------------------------------------------------------------------- output

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
  await loc.click({ timeout: 2000 }).catch(() => {});
  await loc.fill('').catch(() => {});
  await loc.type(String(value), { delay: 0, timeout: 4000 });
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
      await submit.click({ timeout: 3000 }).catch(() => {});
      submitted = true;
    }
  }
  if (!submitted) {
    await page.locator(emptySel).first().press('Enter', { timeout: 3000 }).catch(() => {});
  }
  await page.waitForTimeout(700);

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
      await submit.click({ timeout: 3000 }).catch(() => {});
      submitted = true;
    }
  }
  if (!submitted) await loc.press('Enter', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(600);
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
    await submit.click({ timeout: 4000 }).catch(() => {});
    return true;
  }
  await page.locator(`${formSel} input, ${formSel} textarea`).first()
    .press('Enter', { timeout: 3000 }).catch(() => {});
  return false;
}

/** Did the form go through? Navigation, an intercepted request, or the form gone. */
async function submissionOutcome(page, formSel, trap, urlBefore) {
  await page.waitForTimeout(450);
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
async function checkInitialState(page, step) {
  const defaults = (step.request || {}).defaults || [];
  if (!defaults.length) {
    return record('initial_state', 'skipped', null, null, 'no initial state recorded');
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
    drifted.length ? drifted.join('; ') : `${defaults.length} control(s) unchanged`,
    drifted.length ? `The page no longer loads as it did: ${drifted.join('; ')}.` : null);
}

/** 6. NAVIGATION — every discovered link resolves. */
async function checkLinksResolve(page, step) {
  const links = (step.request || {}).links || [];
  if (!links.length) return record('links_resolve', 'skipped', null, null, 'no links recorded');
  const broken = [];
  for (const link of links) {
    try {
      const res = await page.request.get(link.href, { timeout: 10000, maxRedirects: 5 });
      if (res.status() >= 400) broken.push(`${res.status()} ${link.href}`);
    } catch (err) {
      broken.push(`unreachable ${link.href}`);
    }
  }
  return record(
    'links_resolve',
    broken.length ? 'failed' : 'passed',
    'every link resolves',
    broken.length ? broken.join('; ') : `${links.length} link(s) resolve`,
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

/**
 * Design/a11y facts were measured from the discovery screenshot, not from the
 * live DOM, so this script cannot re-derive them. Saying so is the correct
 * outcome; claiming a pass would be a fabricated verification.
 */
function skipDesign(type) {
  return record(type, 'skipped', null, null,
    'design facts are measured from the discovery screenshot, not the live DOM');
}

// --------------------------------------------------------------------------- one case

async function runCase(page, kase, opts) {
  const started = Date.now();
  const assertions = [];
  let errored = null;

  for (const step of kase.checks || []) {
    const req = step.request || {};
    const check = String(req.check || '');
    const list = step.assertions || [];

    try {
      if (check === 'elements_present') {
        assertions.push(await checkElementsPresent(page, step, list[0] || {}));
      } else if (check === 'required_field_enforced') {
        assertions.push(await checkRequiredField(page, step));
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
      } else if (list.length) {
        for (const a of list) {
          const t = String(a.type || 'unknown');
          assertions.push(['contrast', 'design', 'a11y'].some((k) => t.includes(k))
            ? skipDesign(t)
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
  const outcome = errored ? 'errored'
    : failed ? 'failed'
      : anyPassed ? 'passed'
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

  let viewport, timeout;
  try {
    viewport = parseViewport(plan.viewport || args.viewport || DEFAULTS.viewport);
    timeout = asInt(args.timeout, plan.timeout_ms || DEFAULTS.timeout, 'timeout');
  } catch (err) { return fail('bad_arguments', err.message, undefined, 2); }

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

    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 TraceoCheck/1.0',
    });
    const page = await context.newPage();

    let loadMs = 0;
    /** Load (or reload) the target and wait for it to be interactive. */
    let firstLoadDone = false;
    /**
     * Load (or reload) the target and wait for it to be interactive.
     *
     * The first load pays the full wait strategy — network idle, hydration,
     * fonts — because that is what makes an SPA readable at all. Every case
     * after it re-loads the SAME page, so it only waits for the first control to
     * exist. With one reset per case that difference is the run: paying the full
     * strategy 40+ times pushed a page of 43 cases past the timeout.
     */
    const reset = async () => {
      const t0 = Date.now();
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
      loadMs = Date.now() - t0;
      if (!firstLoadDone) {
        await page.waitForLoadState('networkidle', { timeout: DEFAULTS.idleTimeout })
          .catch(() => page.waitForTimeout(DEFAULTS.settle));
        await page.waitForFunction(
          () => document.querySelectorAll('form, input, select, textarea, button, a[href]').length > 0,
          undefined, { timeout: DEFAULTS.hydrate }).catch(() => {});
        await page.waitForTimeout(150);
        firstLoadDone = true;
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

    const firstLoadMs = loadMs;
    const results = [];
    for (const kase of cases) {
      // Each case starts from a clean render — an earlier case that typed into a
      // field or submitted a form must not colour the next one's evidence.
      try { await reset(); } catch { /* keep the current page; the case will report */ }
      results.push(await runCase(page, kase, {
        reset, loadMs: firstLoadMs, allowSubmit: plan.allow_submit === true }));
    }

    emit({
      ok: true,
      schema_version: SCHEMA_VERSION,
      url: target.href,
      final_url: page.url(),
      viewport: `${viewport.width}x${viewport.height}`,
      allow_submit: plan.allow_submit === true,
      load_ms: firstLoadMs,
      elapsed_ms: Date.now() - startedAll,
      results,
    }, 0);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

await main();
