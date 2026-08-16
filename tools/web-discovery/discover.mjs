#!/usr/bin/env node
/**
 * Traceo web-discovery sidecar.
 *
 * WHY THIS EXISTS
 * ---------------
 * Traceo's other importers read a declared artefact (OpenAPI, Postman, HAR) and
 * are pure functions of that file. A *web target* has no such artefact: the only
 * statement of what the application does is the running application. And for the
 * class of target the owner actually pointed at — a Vue/React SPA — the server
 * HTML states nothing at all. Measured, not guessed:
 *
 *     GET https://opensource-demo.orangehrmlive.com/web/index.php/auth/login
 *     -> 3453 bytes, 0 <form>, 0 <input>, 0 <button>
 *
 * Every field on that page is created by client JavaScript after hydration.
 * Server-side HTML parsing therefore discovers NOTHING, which is why this script
 * drives a real browser. A run that reports zero forms on an SPA is a bug in the
 * wait strategy, never evidence that the page is empty.
 *
 * WHAT IT PRODUCES
 * ----------------
 * ONE JSON document on stdout (never a stack trace, never partial output) plus a
 * full-page PNG on disk. It is the grounding source for the web-target job: the
 * backend may only generate cases that quote a selector, a captured request or a
 * design fact that appears in this document. Nothing here is inferred, scored or
 * embellished — it is a transcript of what the browser saw.
 *
 * DISCOVERY ONLY — THIS SCRIPT IS READ-ONLY AGAINST THE TARGET
 * ------------------------------------------------------------
 * It navigates, waits, reads the DOM and screenshots. It never submits a form,
 * never clicks, never types, never follows a control. The only traffic the target
 * receives is the traffic its own page load generates. Request BODIES are never
 * recorded (a page can POST credentials or tokens during boot); only the method,
 * URL, resource type, status and whether a body existed are kept.
 *
 * SAFETY
 * ------
 * http/https only, and the host must be public. Private, loopback, link-local,
 * CGNAT, multicast, reserved and cloud-metadata addresses are refused — the same
 * rule discovery.py::_assert_public_host applies to spec URLs — unless
 * TRACEO_ALLOW_PRIVATE_TARGETS=1 is set for local development. The guard runs on
 * the URL before navigation AND on every main-frame navigation the page attempts,
 * so a public URL cannot redirect the browser onto an internal host.
 *
 * USAGE
 *   node discover.mjs --url <url> --out <dir> [--viewport 1280x800] [--timeout 30000]
 *
 * EXIT CODES
 *   0  success            stdout = the discovery document ({"ok": true, ...})
 *   1  target failed      stdout = {"ok": false, "error": {...}} — nav/timeout/HTTP
 *   2  bad invocation     stdout = {"ok": false, "error": {...}} — arguments/paths
 *   3  environment        stdout = {"ok": false, "error": {"code":
 *                         "browser_discovery_unavailable", ...}} — playwright or
 *                         the chromium binary is not installed
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { promises as dns } from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

const SCHEMA_VERSION = 1;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.resolve(HERE, '..', '..');

// --------------------------------------------------------------------------- defaults

const DEFAULTS = {
  viewport: '1280x800',
  timeout: 30000,        // hard ceiling for the initial navigation
  idleTimeout: 15000,    // how long we are willing to wait for network idle
  settle: 2500,          // fallback quiet period when idle is never reached
  hydrate: 5000,         // wait for the first interactive element to be rendered
  fullPage: true,
  maxHeight: 4000,       // full-page screenshots are clipped here (see below)
  maxRequests: 500,
  maxControls: 800,
  maxConsole: 100,
};

// Full-page screenshots are clipped because the consumer of screen.png is
// modules/imageio.py — a pure-Python PNG decoder. A 20000px-tall capture is
// perfectly valid PNG and takes minutes to decode; the design facts that matter
// live above the fold anyway. Clipping is recorded in the output, never silent.

// --------------------------------------------------------------------------- output

/** Print exactly one JSON document and stop. Nothing else may reach stdout. */
function emit(doc, exitCode) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  process.exitCode = exitCode;
}

/**
 * `error.message` is shown to a human in the Traceo UI. Playwright's messages
 * arrive wrapped in ANSI colour codes and a multi-line "Call log:" trace, which
 * renders as mojibake in a web page. Strip the escapes, keep the first line of
 * the actual reason, and drop the trace.
 */
function cleanMessage(text) {
  return String(text)
    // Anchored on the ESC byte, so an IPv6 literal such as [2606:4700::1111]
    // appearing in a message is left intact.
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    // The Call log split MUST happen while the newlines are still newlines:
    // flattening control characters first would leave the trace glued on.
    .split(/\r?\nCall log:/)[0]
    .replace(/[\u0000-\u001f\u007f]/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 1000);
}

function fail(code, message, detail, exitCode = 1, extra = {}) {
  emit({
    ok: false,
    schema_version: SCHEMA_VERSION,
    error: { code, message: cleanMessage(message), ...(detail === undefined ? {} : { detail }) },
    ...extra,
  }, exitCode);
}

// A crash anywhere still has to look like a result, not like a stack trace.
process.on('uncaughtException', (err) => {
  fail('internal_error', String(err && err.message ? err.message : err), undefined, 1);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  fail('internal_error', String(err && err.message ? err.message : err), undefined, 1);
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

function asBool(raw, fallback) {
  if (raw === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

function parseViewport(raw) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(raw).trim().toLowerCase());
  if (!m) throw new Error(`--viewport must look like 1280x800 (got '${raw}')`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

// --------------------------------------------------------------------------- SSRF guard

const ALLOW_PRIVATE = process.env.TRACEO_ALLOW_PRIVATE_TARGETS === '1';

/** IPv4 ranges that must never be reachable from a user-supplied target URL. */
function ipv4Blocked(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'malformed';
  const [a, b] = o;
  if (a === 0) return 'unspecified';                                    // 0.0.0.0/8
  if (a === 10) return 'private';                                       // 10/8
  if (a === 127) return 'loopback';                                     // 127/8
  if (a === 169 && b === 254) {
    return ip === '169.254.169.254' ? 'cloud-metadata' : 'link-local';  // 169.254/16
  }
  if (a === 172 && b >= 16 && b <= 31) return 'private';                // 172.16/12
  if (a === 192 && b === 168) return 'private';                         // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-nat';           // 100.64/10
  if (a === 192 && b === 0 && o[2] === 0) return 'reserved';            // 192.0.0/24
  if (a === 198 && (b === 18 || b === 19)) return 'benchmark';          // 198.18/15
  if (a >= 224 && a <= 239) return 'multicast';                         // 224/4
  if (a >= 240) return 'reserved';                                      // 240/4
  return null;
}

/** Expand an IPv6 literal to its 8 groups so prefixes can be tested numerically. */
function ipv6Groups(ip) {
  let s = ip.split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  let tail = [];
  if (v4) {
    const o = v4[1].split('.').map(Number);
    tail = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    s = s.slice(0, v4.index).replace(/:$/, '') || '::';
    if (!s.endsWith(':')) s += ':';
    s += '0:0';
  }
  const [head, rest] = s.split('::');
  const left = head ? head.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : [];
  const right = rest ? rest.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : [];
  const groups = rest === undefined
    ? left
    : [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill(0), ...right];
  if (v4) { groups.splice(groups.length - 2, 2, ...tail); }
  while (groups.length < 8) groups.push(0);
  return groups.slice(0, 8);
}

function ipv6Blocked(ip) {
  const g = ipv6Groups(ip);
  if (g.some((n) => !Number.isFinite(n))) return 'malformed';
  const allZero = g.every((n) => n === 0);
  if (allZero) return 'unspecified';                                          // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return 'loopback';    // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — judge by the embedded v4.
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return ipv4Blocked(v4);
  }
  const first = g[0];
  if ((first & 0xfe00) === 0xfc00) return 'unique-local';                      // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return 'link-local';                        // fe80::/10
  if ((first & 0xff00) === 0xff00) return 'multicast';                         // ff00::/8
  return null;
}

function ipBlocked(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return 'malformed';
}

/**
 * Resolve `hostname` and refuse it when ANY resolved address is non-public.
 * Mirrors discovery.py::_assert_public_host. Throws a tagged error the caller
 * turns into the JSON error document.
 */
async function assertPublicHost(rawHostname) {
  if (!rawHostname) throw tagged('invalid_url', 'URL has no host.');
  // URL.hostname keeps the brackets on an IPv6 literal ("[::1]"), and net.isIP
  // rejects the bracketed form — without this strip every IPv6 target would miss
  // the numeric guard entirely and be handed to DNS instead.
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const literal = net.isIP(hostname) ? [hostname] : null;
  let addresses = literal;
  if (!addresses) {
    try {
      const infos = await dns.lookup(hostname, { all: true, verbatim: true });
      addresses = infos.map((i) => i.address);
    } catch {
      throw tagged('unresolvable_host', `Cannot resolve host '${hostname}'.`);
    }
  }
  if (!addresses.length) throw tagged('unresolvable_host', `Cannot resolve host '${hostname}'.`);
  if (ALLOW_PRIVATE) return addresses;
  for (const addr of addresses) {
    const why = ipBlocked(addr);
    if (why) {
      throw tagged('ssrf_blocked',
        `Host '${hostname}' resolves to ${addr} (${why}). Set TRACEO_ALLOW_PRIVATE_TARGETS=1 ` +
        'to allow private targets in local development.');
    }
  }
  return addresses;
}

function tagged(code, message, exitCode = 1) {
  const err = new Error(message);
  err.traceoCode = code;
  err.traceoExit = exitCode;
  return err;
}

async function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw tagged('invalid_url', `'${raw}' is not a valid URL.`, 2); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw tagged('invalid_url', `Only http/https URLs are allowed (got '${u.protocol}').`, 2);
  }
  await assertPublicHost(u.hostname);
  return u;
}

// --------------------------------------------------------------------------- playwright

/**
 * Resolve Playwright without requiring an install in this directory. The repo
 * already ships it under e2e/node_modules for the E2E suite; one copy, one
 * version, nothing to keep in sync.
 */
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
      let version = null;
      try { version = require(path.join(root, 'playwright', 'package.json')).version; }
      catch { /* version is informational only */ }
      return { pw: require(entry), from: root, version };
    } catch (err) {
      tried.push(`${entry} (load failed: ${err.message})`);
    }
  }
  try {
    const require = createRequire(import.meta.url);
    return { pw: require('playwright'), from: 'node resolution', version: null };
  } catch { /* fall through to the unavailable error */ }

  throw tagged('browser_discovery_unavailable',
    'Playwright is not installed. Install it with:  npm --prefix ' +
    path.join(REPO_ROOT, 'e2e') + ' install  &&  npx --prefix ' +
    path.join(REPO_ROOT, 'e2e') + ' playwright install chromium\nLooked in: ' +
    tried.join(', '), 3);
}

// --------------------------------------------------------------------------- in-page extraction

/**
 * Everything below runs INSIDE the page. It is one string-free function so
 * Playwright can serialise it; it must not reference anything from module scope.
 *
 * Selector policy, in order: a unique #id, a unique [data-testid], a unique
 * [name] within a form, then a structural :nth-of-type path. Every selector is
 * verified unique before it is returned — a generated case quotes these
 * verbatim, so a selector that matches two elements would be a lie.
 */
/* c8 ignore start */
function extractDom(limits) {
  const uniq = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch { return false; }
  };
  const esc = (v) => (window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&'));
  const attrSel = (name, value) => `[${name}="${String(value).replace(/["\\]/g, '\\$&')}"]`;

  function structural(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      const tag = node.tagName.toLowerCase();
      if (node.id && uniq(`#${esc(node.id)}`)) { parts.unshift(`#${esc(node.id)}`); break; }
      let idx = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(idx > 1 || (node.parentElement &&
        node.parentElement.querySelectorAll(`:scope > ${tag}`).length > 1)
        ? `${tag}:nth-of-type(${idx})` : tag);
      node = node.parentElement;
      if (node === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ');
  }

  function selectorFor(el) {
    if (el.id && uniq(`#${esc(el.id)}`)) return `#${esc(el.id)}`;
    const testid = el.getAttribute('data-testid');
    if (testid && uniq(attrSel('data-testid', testid))) return attrSel('data-testid', testid);
    const name = el.getAttribute('name');
    if (name) {
      const tag = el.tagName.toLowerCase();
      const cand = `${tag}${attrSel('name', name)}`;
      if (uniq(cand)) return cand;
    }
    const s = structural(el);
    return s || el.tagName.toLowerCase();
  }

  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);

  /** Approximation of the accessible-name computation, in spec precedence order. */
  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 200);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map((id) => document.getElementById(id)).filter(Boolean).map(textOf);
      if (parts.join(' ').trim()) return parts.join(' ').trim().slice(0, 200);
    }
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase())) {
      if (el.value) return String(el.value).slice(0, 200);
    }
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'image') {
      const alt = el.getAttribute('alt');
      if (alt) return alt.slice(0, 200);
    }
    const text = textOf(el);
    if (text) return text;
    const img = el.querySelector('img[alt], svg title');
    if (img) {
      const alt = img.getAttribute ? (img.getAttribute('alt') || textOf(img)) : textOf(img);
      if (alt && alt.trim()) return alt.trim().slice(0, 200);
    }
    const title = el.getAttribute('title');
    if (title && title.trim()) return title.trim().slice(0, 200);
    return '';
  }

  /** The field's visible label — never the placeholder, which is reported separately. */
  function labelFor(el) {
    // A hidden input has no label by construction. Guessing one from its
    // surroundings is how a CSRF token ends up documented as "Username".
    if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'hidden') return null;
    if (el.id) {
      const lbl = document.querySelector(`label[for="${String(el.id).replace(/["\\]/g, '\\$&')}"]`);
      if (lbl) { const t = textOf(lbl); if (t) return t; }
    }
    const wrap = el.closest('label');
    if (wrap) {
      const clone = wrap.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
      const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 200);
    }
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim().slice(0, 200);
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const parts = labelledby.split(/\s+/)
        .map((id) => document.getElementById(id)).filter(Boolean).map(textOf);
      const joined = parts.join(' ').trim();
      if (joined) return joined.slice(0, 200);
    }
    // Component libraries (OrangeHRM's oxd-*, MUI, AntD) render a <label> that is
    // a SIBLING of the input's wrapper, with no `for`. Walk up a few ancestors,
    // stopping at the first that owns more than this one field — past that
    // boundary any label found belongs to a different field, and a wrong label is
    // worse than no label.
    let node = el.parentElement;
    for (let depth = 0; node && depth < 4 && node !== document.body; depth++) {
      if (node.querySelectorAll(FIELD_SEL).length > 1) break;
      const cand = node.querySelector('label, [class*="label" i]');
      if (cand && !cand.contains(el)) {
        const t = textOf(cand);
        if (t && t.length <= 60) return t;
      }
      node = node.parentElement;
    }
    return null;
  }

  const intAttr = (el, name) => {
    const raw = el.getAttribute(name);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };

  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  };

  const FIELD_SEL = 'input, select, textarea';
  const SKIP_TYPES = new Set(['submit', 'button', 'reset', 'image']);

  /**
   * The heading a human would use to name this form — it becomes the title of the
   * functional Requirement, so a wrong one is worse than none.
   *
   * A form's own <legend>/<h*> wins. Otherwise: the nearest heading BEFORE the
   * form in document order, accepted only when no other <form> sits between them.
   * That last clause is the whole point — on a page with a signup form under an
   * <h1> and a search box below it, the search box must not inherit "Create an
   * account".
   */
  const flow = Array.from(document.querySelectorAll('form, h1, h2, h3, h4, h5, h6'));
  function headingForForm(form) {
    const own = form.querySelector('legend, h1, h2, h3, h4, h5, h6');
    if (own) return textOf(own) || null;
    for (let i = flow.indexOf(form) - 1; i >= 0; i--) {
      const node = flow[i];
      if (node.tagName === 'FORM') return null;
      if (node.contains(form)) continue;
      const t = textOf(node);
      if (t) return t;
    }
    return null;
  }

  function describeField(el) {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    const field = {
      selector: selectorFor(el),
      name: el.getAttribute('name') || null,
      id: el.getAttribute('id') || null,
      type,
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      placeholder: el.getAttribute('placeholder') || null,
      label: labelFor(el),
      maxlength: intAttr(el, 'maxlength'),
      pattern: el.getAttribute('pattern') || null,
      // --- beyond the required nine, all read straight off the element ---
      tag,
      minlength: intAttr(el, 'minlength'),
      min: el.getAttribute('min') || null,
      max: el.getAttribute('max') || null,
      step: el.getAttribute('step') || null,
      autocomplete: el.getAttribute('autocomplete') || null,
      inputmode: el.getAttribute('inputmode') || null,
      disabled: el.hasAttribute('disabled'),
      readonly: el.hasAttribute('readonly'),
      multiple: el.hasAttribute('multiple'),
      visible: isVisible(el),
      box: box(el),
      options: null,
    };
    if (tag === 'select') {
      field.options = Array.from(el.options).slice(0, 50).map((o) => ({
        value: o.value, label: (o.textContent || '').trim().slice(0, 120),
      }));
    }
    return field;
  }

  const forms = Array.from(document.forms).map((form, index) => {
    const fields = Array.from(form.querySelectorAll(FIELD_SEL))
      .filter((el) => !(el.tagName === 'INPUT' && SKIP_TYPES.has((el.type || '').toLowerCase())))
      .map(describeField);
    const submits = Array.from(form.querySelectorAll(
      'button, input[type=submit], input[type=button], input[type=image], [role=button]'))
      .map((el) => ({ selector: selectorFor(el), name: accessibleName(el) || null,
        type: (el.getAttribute('type') || (el.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase() }));
    return {
      index,
      selector: selectorFor(form),
      name: form.getAttribute('name') || null,
      id: form.getAttribute('id') || null,
      action: form.getAttribute('action') ? new URL(form.getAttribute('action'), location.href).href : null,
      method: (form.getAttribute('method') || 'get').toUpperCase(),
      novalidate: form.hasAttribute('novalidate'),
      // A <form> rarely has an accessible name; its nearest heading is what a
      // human would call it, and it is what the functional Requirement is titled after.
      heading: headingForForm(form),
      visible: isVisible(form),
      field_count: fields.length,
      required_fields: fields.filter((f) => f.required).map((f) => f.name || f.selector),
      fields,
      submits,
    };
  });

  const inForm = new Set();
  forms.forEach((f) => f.fields.forEach((x) => inForm.add(x.selector)));
  // Fields that belong to no <form> at all. Plenty of SPAs never emit a <form>
  // element; reporting them separately keeps `forms` honest while still giving
  // the backend every selector on the page.
  const orphan_fields = Array.from(document.querySelectorAll(FIELD_SEL))
    .filter((el) => !el.form)
    .filter((el) => !(el.tagName === 'INPUT' && SKIP_TYPES.has((el.type || '').toLowerCase())))
    .map(describeField)
    .filter((f) => !inForm.has(f.selector))
    .slice(0, limits.maxControls);

  const CONTROL_SEL = [
    'a[href]', 'button', 'input[type=submit]', 'input[type=button]', 'input[type=reset]',
    'input[type=image]', '[role=button]', '[role=link]', '[role=menuitem]', '[role=tab]',
  ].join(', ');

  const seenControls = new Set();
  const controls = [];
  for (const el of document.querySelectorAll(CONTROL_SEL)) {
    if (controls.length >= limits.maxControls) break;
    const selector = selectorFor(el);
    if (seenControls.has(selector)) continue;
    seenControls.add(selector);
    const tag = el.tagName.toLowerCase();
    const explicitRole = el.getAttribute('role');
    const role = explicitRole || (tag === 'a' ? 'link'
      : tag === 'button' ? 'button'
      : tag === 'input' ? 'button' : tag);
    const href = el.getAttribute('href');
    controls.push({
      selector,
      role,
      // null means the control genuinely has NO accessible name — an icon-only
      // link, for instance. That is a real finding, not missing data.
      name: accessibleName(el) || null,
      href: href ? (() => { try { return new URL(href, location.href).href; } catch { return href; } })() : null,
      tag,
      type: el.getAttribute('type') || null,
      disabled: el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
      visible: isVisible(el),
      form: el.form ? selectorFor(el.form) : null,
      box: box(el),
    });
  }

  // h1..h6: component libraries routinely style a page title as an <h5>
  // (OrangeHRM's login title is one), so stopping at h3 loses the page's own name.
  const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
    .slice(0, 60)
    .map((h) => ({ level: Number(h.tagName[1]), text: textOf(h) }))
    .filter((h) => h.text);

  const langAttr = document.documentElement.getAttribute('lang');
  const desc = document.querySelector('meta[name="description"]');

  return {
    title: document.title || '',
    headings,
    lang: langAttr || null,
    dir: document.documentElement.getAttribute('dir') || null,
    description: desc ? (desc.getAttribute('content') || '').slice(0, 300) : null,
    forms,
    orphan_fields,
    controls,
    document_height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    element_count: document.querySelectorAll('*').length,
    html_bytes: document.documentElement.outerHTML.length,
  };
}
/* c8 ignore stop */

// --------------------------------------------------------------------------- main

async function main() {
  const started = Date.now();
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { return fail('invalid_arguments', err.message, undefined, 2); }

  if (args.help || args.h) {
    return fail('invalid_arguments',
      'usage: node discover.mjs --url <url> --out <dir> [--viewport 1280x800] [--timeout 30000]',
      undefined, 2);
  }
  if (!args.url) return fail('invalid_arguments', '--url is required.', undefined, 2);
  if (!args.out) return fail('invalid_arguments', '--out is required.', undefined, 2);

  let viewport, timeout, idleTimeout, settle, hydrate, fullPage, maxHeight, maxRequests;
  try {
    viewport = parseViewport(args.viewport || DEFAULTS.viewport);
    timeout = asInt(args.timeout, DEFAULTS.timeout, 'timeout');
    idleTimeout = asInt(args.idle_timeout, Math.min(DEFAULTS.idleTimeout, timeout), 'idle-timeout');
    settle = asInt(args.settle, DEFAULTS.settle, 'settle');
    hydrate = asInt(args.hydrate, DEFAULTS.hydrate, 'hydrate');
    maxHeight = asInt(args.max_height, DEFAULTS.maxHeight, 'max-height');
    maxRequests = asInt(args.max_requests, DEFAULTS.maxRequests, 'max-requests');
    fullPage = asBool(args.full_page, DEFAULTS.fullPage);
  } catch (err) { return fail('invalid_arguments', err.message, undefined, 2); }

  const outDir = path.resolve(String(args.out));
  try { fs.mkdirSync(outDir, { recursive: true }); }
  catch (err) {
    return fail('output_unwritable', `Cannot create --out directory '${outDir}': ${err.message}`,
      undefined, 2);
  }

  let target;
  try { target = await assertAllowedUrl(String(args.url)); }
  catch (err) {
    return fail(err.traceoCode || 'invalid_url', err.message, undefined, err.traceoExit || 1,
      { url: String(args.url) });
  }

  let pw, pwFrom, pwVersion;
  try { ({ pw, from: pwFrom, version: pwVersion } = loadPlaywright()); }
  catch (err) { return fail(err.traceoCode, err.message, undefined, err.traceoExit || 3); }

  let browser = null;
  try {
    try {
      browser = await pw.chromium.launch({
        headless: true,
        args: ['--disable-dev-shm-usage', '--no-sandbox'],
      });
    } catch (err) {
      return fail('browser_discovery_unavailable',
        'The Chromium browser binary is not installed. Install it with:  npx --prefix ' +
        path.join(REPO_ROOT, 'e2e') + ' playwright install chromium\nUnderlying error: ' + err.message,
        undefined, 3);
    }

    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: false,
      reducedMotion: 'reduce',
      // A plain desktop Chrome UA: some SPAs serve a degraded shell to unknown
      // agents, and a degraded shell has fewer fields, which would silently
      // under-report the surface.
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 TraceoDiscovery/1.0',
    });

    // Kill animation before the first frame so the screenshot is deterministic:
    // a mid-transition capture changes the palette and every design fact with it.
    await context.addInitScript(() => {
      const css = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;' +
        'animation-iteration-count:1!important;transition-duration:0s!important;' +
        'transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}';
      const apply = () => {
        const style = document.createElement('style');
        style.setAttribute('data-traceo', 'no-animation');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      };
      if (document.head) apply();
      else document.addEventListener('DOMContentLoaded', apply, { once: true });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(timeout);

    // --- SSRF guard #2: the page must not be able to walk the browser onto an
    // internal host via a redirect or a client-side location change.
    const hostVerdict = new Map();
    const blockedNavigations = [];
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) {
        return route.continue().catch(() => {});
      }
      let host;
      try { host = new URL(req.url()).hostname; } catch { return route.continue().catch(() => {}); }
      const proto = (() => { try { return new URL(req.url()).protocol; } catch { return ''; } })();
      if (proto !== 'http:' && proto !== 'https:') {
        blockedNavigations.push({ url: req.url(), reason: 'non-http-scheme' });
        return route.abort('blockedbyclient').catch(() => {});
      }
      if (!hostVerdict.has(host)) {
        try { await assertPublicHost(host); hostVerdict.set(host, null); }
        catch (err) { hostVerdict.set(host, err.traceoCode || 'ssrf_blocked'); }
      }
      const verdict = hostVerdict.get(host);
      if (verdict) {
        blockedNavigations.push({ url: req.url(), reason: verdict });
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });

    // --- the XHR/fetch inventory. Every request the page makes, in order.
    const requests = [];
    const byRequest = new Map();
    let requestsTruncated = false;

    const record = (req) => {
      if (requests.length >= maxRequests) { requestsTruncated = true; return null; }
      let parsed = null;
      try { parsed = new URL(req.url()); } catch { /* data: / blob: URLs */ }
      const headers = req.headers();
      const entry = {
        method: req.method(),
        url: req.url(),
        resource_type: req.resourceType(),
        status: null,
        status_text: null,
        ok: null,
        failure: null,
        host: parsed ? parsed.host : null,
        scheme: parsed ? parsed.protocol.replace(':', '') : null,
        path: parsed ? parsed.pathname : null,
        query_keys: parsed ? Array.from(new Set(parsed.searchParams.keys())).slice(0, 40) : [],
        is_navigation: req.isNavigationRequest(),
        main_frame: req.frame() === page.mainFrame(),
        // Bodies are deliberately NOT recorded — a boot-time POST can carry
        // credentials. Only the fact that a body existed and its media type.
        has_post_data: Boolean(req.postData && req.postData() !== null),
        content_type: headers['content-type'] || null,
        started_ms: Date.now() - started,
        duration_ms: null,
        from_cache: false,
        redirected_from: req.redirectedFrom() ? req.redirectedFrom().url() : null,
      };
      requests.push(entry);
      byRequest.set(req, entry);
      return entry;
    };

    page.on('request', (req) => { try { record(req); } catch { /* never break the run */ } });
    page.on('response', async (resp) => {
      const entry = byRequest.get(resp.request());
      if (!entry) return;
      entry.status = resp.status();
      entry.status_text = resp.statusText() || null;
      entry.ok = resp.ok();
      // No server address means the response never left the browser: a cache hit.
      try { entry.from_cache = (await resp.serverAddr()) === null; } catch { /* ignore */ }
    });
    page.on('requestfinished', (req) => {
      const entry = byRequest.get(req);
      if (entry) entry.duration_ms = Date.now() - started - entry.started_ms;
    });
    page.on('requestfailed', (req) => {
      const entry = byRequest.get(req);
      if (!entry) return;
      entry.failure = (req.failure() && req.failure().errorText) || 'failed';
      entry.duration_ms = Date.now() - started - entry.started_ms;
    });

    const consoleErrors = [];
    const pushConsole = (item) => {
      if (consoleErrors.length < DEFAULTS.maxConsole) consoleErrors.push(item);
    };
    page.on('console', (msg) => {
      if (msg.type() !== 'error' && msg.type() !== 'warning') return;
      const loc = msg.location() || {};
      pushConsole({
        type: msg.type(),
        text: String(msg.text()).slice(0, 500),
        url: loc.url || null,
        line: typeof loc.lineNumber === 'number' ? loc.lineNumber : null,
      });
    });
    page.on('pageerror', (err) => {
      pushConsole({ type: 'pageerror', text: String(err && err.message ? err.message : err).slice(0, 500),
        url: null, line: null });
    });
    // A page must never be able to hand us a file: nothing is downloaded, ever.
    page.on('download', (d) => { d.cancel().catch(() => {}); });
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

    // --- navigate. domcontentloaded first so an SPA that never idles still gets
    // its DOM read; the idle wait is layered on top and is allowed to fail.
    let response;
    try {
      response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout });
    } catch (err) {
      const timedOut = /timeout/i.test(err.message);
      return fail(timedOut ? 'navigation_timeout' : 'navigation_failed',
        `Could not load ${target.href}: ${err.message}`,
        blockedNavigations.length ? { blocked_navigations: blockedNavigations } : undefined,
        1, { url: target.href, elapsed_ms: Date.now() - started });
    }

    if (!response) {
      return fail('navigation_failed', `No response for ${target.href}.`, undefined, 1,
        { url: target.href, elapsed_ms: Date.now() - started });
    }

    // The final URL's host is re-checked: a redirect chain is the classic way to
    // land a "public" URL on an internal address.
    try { await assertAllowedUrl(page.url()); }
    catch (err) {
      return fail(err.traceoCode || 'ssrf_blocked',
        `Target redirected to a disallowed address: ${err.message}`, undefined, 1,
        { url: target.href, final_url: page.url(), elapsed_ms: Date.now() - started });
    }

    const status = response.status();
    if (status >= 400) {
      return fail('http_error', `${target.href} returned HTTP ${status} ${response.statusText()}.`,
        { status, final_url: page.url() }, 1,
        { url: target.href, final_url: page.url(), http_status: status,
          elapsed_ms: Date.now() - started });
    }

    // --- wait strategy, in three layers. Each is optional; none may abort the run.
    let waitStrategy = 'networkidle';
    const waitNotes = [];
    try {
      await page.waitForLoadState('networkidle', { timeout: idleTimeout });
    } catch {
      // Long-polling, analytics beacons and websockets keep some pages busy for
      // ever. Fall back to a fixed quiet period rather than failing the run.
      waitStrategy = 'domcontentloaded+settle';
      waitNotes.push(`network never idled within ${idleTimeout}ms; settled ${settle}ms instead`);
      await page.waitForTimeout(settle);
    }
    // Hydration gate: the whole reason this sidecar exists. An SPA's server HTML
    // has no controls at all, so we wait for the first one to be rendered before
    // reading the DOM. Timing out here is reported, not fatal — a genuinely
    // control-free page is a legal (if boring) result.
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('form, input, select, textarea, button, a[href]').length > 0,
        undefined, { timeout: hydrate });
    } catch {
      waitNotes.push(`no form/input/button/link appeared within ${hydrate}ms`);
    }
    try { await page.evaluate(() => document.fonts && document.fonts.ready); }
    catch { waitNotes.push('document.fonts.ready unavailable'); }
    // One frame for layout to settle after fonts swap in.
    await page.waitForTimeout(250);

    let dom;
    try {
      dom = await page.evaluate(extractDom, { maxControls: DEFAULTS.maxControls });
    } catch (err) {
      return fail('extraction_failed', `DOM extraction failed: ${err.message}`, undefined, 1,
        { url: target.href, final_url: page.url(), elapsed_ms: Date.now() - started });
    }

    // --- screenshot. Written before the JSON so a document that names screen.png
    // can always be trusted to have it on disk.
    const shotPath = path.join(outDir, 'screen.png');
    let shotMeta = { path: shotPath, clipped: false, width: viewport.width, height: 0, bytes: 0 };
    try {
      const docHeight = Math.max(dom.document_height || 0, viewport.height);
      const clipped = fullPage && docHeight > maxHeight;
      const opts = { path: shotPath, animations: 'disabled', caret: 'hide', scale: 'css', type: 'png' };
      if (!fullPage) {
        opts.fullPage = false;
        shotMeta.height = viewport.height;
      } else if (clipped) {
        // fullPage + clip crops the FULL-PAGE raster, so the layout is never
        // disturbed. Resizing the viewport instead would re-run the page's media
        // queries and change every design fact the crop is taken for.
        opts.fullPage = true;
        opts.clip = { x: 0, y: 0, width: viewport.width, height: maxHeight };
        shotMeta.clipped = true;
        shotMeta.height = maxHeight;
      } else {
        opts.fullPage = true;
        shotMeta.height = docHeight;
      }
      await page.screenshot(opts);
      shotMeta.bytes = fs.statSync(shotPath).size;
    } catch (err) {
      return fail('screenshot_failed', `Could not capture ${shotPath}: ${err.message}`, undefined, 1,
        { url: target.href, final_url: page.url(), elapsed_ms: Date.now() - started });
    }

    const finalUrl = page.url();
    const elapsed = Date.now() - started;

    const doc = {
      ok: true,
      schema_version: SCHEMA_VERSION,
      url: target.href,
      final_url: finalUrl,
      redirected: finalUrl !== target.href,
      http_status: status,
      title: dom.title,
      viewport: { width: viewport.width, height: viewport.height, device_scale_factor: 1 },
      elapsed_ms: elapsed,
      screenshot: shotPath,
      screenshot_width: shotMeta.width,
      screenshot_height: shotMeta.height,
      screenshot_bytes: shotMeta.bytes,
      screenshot_clipped: shotMeta.clipped,
      wait_strategy: waitStrategy,
      wait_notes: waitNotes,
      headings: dom.headings,
      lang: dom.lang,
      dir: dom.dir,
      description: dom.description,
      forms: dom.forms,
      orphan_fields: dom.orphan_fields,
      controls: dom.controls,
      requests,
      requests_truncated: requestsTruncated,
      console_errors: consoleErrors,
      blocked_navigations: blockedNavigations,
      counts: {
        forms: dom.forms.length,
        fields: dom.forms.reduce((n, f) => n + f.fields.length, 0),
        orphan_fields: dom.orphan_fields.length,
        controls: dom.controls.length,
        requests: requests.length,
        xhr: requests.filter((r) => r.resource_type === 'xhr' || r.resource_type === 'fetch').length,
        console_errors: consoleErrors.length,
      },
      page: {
        element_count: dom.element_count,
        html_bytes: dom.html_bytes,
        document_height: dom.document_height,
      },
      engine: {
        tool: 'traceo/web-discovery',
        playwright_version: pwVersion,
        playwright_from: pwFrom,
        node_version: process.version,
        finished_at: new Date().toISOString(),
      },
    };

    // A copy on disk beside the screenshot: the backend job keeps the raw
    // transcript next to the artefact it describes, which is what makes a
    // generated case auditable months later.
    try { fs.writeFileSync(path.join(outDir, 'discovery.json'), JSON.stringify(doc, null, 2)); }
    catch { /* stdout is the contract; the copy is a convenience */ }

    emit(doc, 0);
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

await main();
