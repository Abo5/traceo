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
 * THE SAFETY RULE
 * ---------------
 * Stated here, in README.md and in docs/WEB_TARGETS.md in exactly these words:
 *
 *     The crawler submits THE LOGIN FORM ONLY, once, with the credentials the
 *     user supplied. It submits no other form, ever. It clicks no control whose
 *     accessible name or href matches logout / sign out / delete / remove /
 *     destroy / reset / deactivate / terminate. It stays on the login URL's
 *     origin. It follows links only.
 *
 * Without --username/--password nothing is ever typed or clicked at all, which is
 * byte-for-byte the behaviour this script had before authenticated crawling
 * existed. Request BODIES are never recorded (a page can POST credentials or
 * tokens during boot); only the method, URL, resource type, status and whether a
 * body existed are kept.
 *
 * A crawl that cannot PROVE it logged in fails with code "login_failed" and
 * crawls nothing. Crawling anonymously and reporting success would silently
 * describe the logged-out product — the one outcome worse than no result.
 *
 * CREDENTIALS
 * -----------
 * The password is read from $TRACEO_CRAWL_PASSWORD in preference to --password,
 * because argv is world-readable through `ps`. Neither credential is ever written
 * to stdout, to the JSON, to a screenshot filename or into an error message: the
 * password is additionally scrubbed out of every string in the emitted document
 * as a last line of defence. A leaked password in a job log is a real incident.
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
 *                     [--username U] [--password P] [--login-url <url>]
 *                     [--username-selector S] [--password-selector S] [--submit-selector S]
 *                     [--max-pages 1] [--max-depth 2]
 *
 * EXIT CODES
 *   0  success            stdout = the discovery document ({"ok": true, ...})
 *   1  target failed      stdout = {"ok": false, "error": {...}} — nav/timeout/HTTP/login
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
  maxRequests: 500,      // per page, not per run
  maxControls: 800,
  maxConsole: 100,
  // A default of 1 would mean the tool does nothing useful until somebody asks it
  // to. It can see the links; it should follow them.
  maxPages: 25,
  maxDepth: 2,
  maxSkipped: 300,
  loginWait: 15000,      // how long to wait for post-login state to be observable
};

const MAX_PAGES_CAP = 50;

// Full-page screenshots are clipped because the consumer of screen.png is
// modules/imageio.py — a pure-Python PNG decoder. A 20000px-tall capture is
// perfectly valid PNG and takes minutes to decode; the design facts that matter
// live above the fold anyway. Clipping is recorded in the output, never silent.

// --------------------------------------------------------------------------- output

/**
 * Strings that must never appear in anything this process writes. Only the
 * password is registered: it is ours, it is secret, and a page legitimately
 * containing it is not a case worth preserving. The username is deliberately NOT
 * registered — a signed-in application puts the user's name in its own menus and
 * headings (OrangeHRM's left menu literally contains "Admin"), and blanking those
 * would corrupt the transcript the whole feature is grounded on. Instead the
 * username is simply never authored into any field this script writes.
 */
const SECRETS = [];

/**
 * Matching is anchored to token edges, not to raw substrings. A one-character
 * password would otherwise rewrite "unresolvable_host" into
 * "unresolva[redacted]le_host" and the transcript this whole feature is grounded
 * on would be quietly corrupted by a weak password. Token edges keep both
 * promises at once: `?password=admin123&x`, `Password : admin123` and a bare
 * value in page text are all caught, while the same letters buried inside
 * another word are left alone.
 */
function registerSecret(value) {
  const s = String(value ?? '');
  if (!s || SECRETS.some((r) => r.raw === s)) return;
  const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  SECRETS.push({
    raw: s,
    patterns: Array.from(new Set([escaped, JSON.stringify(s).slice(1, -1)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')]))
      .map((p) => new RegExp(`(?<![A-Za-z0-9_-])${p}(?![A-Za-z0-9_-])`, 'g')),
  });
}

/** Replace every registered secret, in both raw and JSON-escaped spelling. */
function scrub(text) {
  let out = String(text);
  for (const secret of SECRETS) {
    for (const pattern of secret.patterns) out = out.replace(pattern, '[redacted]');
  }
  return out;
}

/** The single serialiser: stdout and the on-disk copy must be identically scrubbed. */
function serialize(doc) {
  return scrub(JSON.stringify(doc, null, 2));
}

/** Print exactly one JSON document and stop. Nothing else may reach stdout. */
function emit(doc, exitCode) {
  process.stdout.write(serialize(doc) + '\n');
  process.exitCode = exitCode;
}

// --------------------------------------------------------------------------- the safety rule

/**
 * THE SAFETY RULE (identical wording in README.md and docs/WEB_TARGETS.md):
 *
 *   The crawler submits THE LOGIN FORM ONLY, once, with the credentials the user
 *   supplied. It submits no other form, ever. It clicks no control whose
 *   accessible name or href matches logout / sign out / delete / remove /
 *   destroy / reset / deactivate / terminate. It stays on the login URL's origin.
 *   It follows links only.
 *
 * Matching is a case-insensitive SUBSTRING test rather than a word test on
 * purpose: "resetPassword", "/users/42/deleteConfirm" and "Deactivate account"
 * must all be refused, and over-skipping a harmless link costs a page while
 * under-skipping costs the user's data.
 */
const FORBIDDEN_CONTROL_WORDS = [
  'logout', 'log out', 'log-out', 'signout', 'sign out', 'sign-out',
  'delete', 'remove', 'destroy', 'reset', 'deactivate', 'terminate',
];

function forbiddenWord(name, href) {
  const hay = `${name || ''} ${href || ''}`.toLowerCase();
  return FORBIDDEN_CONTROL_WORDS.find((w) => hay.includes(w)) || null;
}

/** Crawl identity: same page, different fragment, is the same page. */
function crawlKey(raw) {
  const u = new URL(raw);
  u.hash = '';
  return u.href;
}

/** Login identity: ?error=1 appended by a rejected login is NOT a new page. */
function pathKey(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(raw);
  }
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

/** For flags with a hard ceiling: --max-pages 51 is a mistake, not a request to clamp. */
function asRange(raw, fallback, name, min, max) {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== String(raw).trim() || n < min || n > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
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
      // The state the control STARTS in. Without this a "loads with the
      // documented defaults" case would have nothing to compare against, and
      // the only honest alternative is not to write one.
      value: (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')
        ? String(el.value ?? '').slice(0, 300) : null,
      checked: (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(type))
        ? el.checked === true : null,
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

// --------------------------------------------------------------------------- login

/**
 * The two observable facts that distinguish "signed in" from "still on the login
 * page". Sampled once BEFORE the submit and again after, because only a CHANGE
 * proves anything: a login page that ships a hidden "Sign out" in its shell would
 * otherwise certify itself.
 */
/* c8 ignore start */
function probeLoginState() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };
  const LOGOUT = /log\s*-?\s*out|sign\s*-?\s*out/i;
  let logout = null;
  const sel = 'a[href], button, [role=button], [role=link], [role=menuitem]';
  for (const el of document.querySelectorAll(sel)) {
    const name = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    const href = el.getAttribute('href') || '';
    if (LOGOUT.test(name) || LOGOUT.test(href)) { logout = (name || href).slice(0, 120); break; }
  }
  return {
    logout_control: logout,
    visible_password_fields:
      Array.from(document.querySelectorAll('input[type=password]')).filter(visible).length,
    // The same elements the hydration gate waits for. A page showing none of
    // them has rendered nothing yet, and "the password field is gone" says
    // nothing about a page that has no fields of any kind.
    interactive_elements:
      document.querySelectorAll('form, input, select, textarea, button, a[href]').length,
  };
}
/* c8 ignore stop */

/**
 * Credentials a demo or sandbox environment PRINTS ON ITS OWN LOGIN PAGE.
 *
 * Measured on the owner's target: the login screen renders
 *     Username : Admin
 *     Password : admin123
 * as ordinary visible text. Reading it is not guessing — the value came from the
 * rendered page, which is the same grounding rule every other fact here obeys.
 *
 * Only LEAF elements are read: an ancestor's textContent is the concatenation of
 * its children, which would happily produce "Password : Admin" out of two
 * unrelated lines. A value containing whitespace is rejected because that is
 * prose, not a credential, and both halves must be found or neither is used.
 */
/* c8 ignore start */
function harvestPublishedCredentials() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return false;
    const st = window.getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) !== 0;
  };
  const USER_RE = /(?:^|[\s(])(?:user\s*name|username|user\s*id|user|login|account)\s*[:=]\s*([^\s,;)]{1,64})/i;
  const PASS_RE = /(?:^|[\s(])(?:pass\s*word|password|passcode|pwd|pass)\s*[:=]\s*([^\s,;)]{1,64})/i;
  const out = { username: null, password: null, evidence: [] };
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length) continue;
    if (!visible(el)) continue;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 200) continue;
    if (!out.username) {
      const m = USER_RE.exec(text);
      if (m) { out.username = m[1]; out.evidence.push(text.slice(0, 120)); }
    }
    if (!out.password) {
      const m = PASS_RE.exec(text);
      if (m) { out.password = m[1]; out.evidence.push(text.slice(0, 120)); }
    }
    if (out.username && out.password) break;
  }
  return out;
}
/* c8 ignore stop */

/**
 * Pick the login fields out of an already-extracted DOM document rather than
 * re-implementing selector generation inside the page: every selector here has
 * already been proven unique by extractDom, which is what makes it safe to fill.
 *
 * Rule (contract): the first VISIBLE form containing an input[type=password];
 * its username field is the nearest preceding text/email input. SPAs that emit no
 * <form> at all are handled from orphan_fields by the same rule, reported as a
 * different `detection` so the operator can see which one applied.
 */
const USERNAME_TYPES = new Set(['text', 'email', 'tel', 'search', 'url']);

function detectLoginFields(dom) {
  const fromFields = (fields, detection, form) => {
    const pwIndex = fields.findIndex((f) => f.type === 'password');
    if (pwIndex < 0) return null;
    let user = null;
    for (let i = pwIndex - 1; i >= 0; i--) {
      if (USERNAME_TYPES.has(fields[i].type)) { user = fields[i]; break; }
    }
    if (!user) return null;
    // A "Reset" button inside the login form is exactly the control the safety
    // rule forbids, so the submit is chosen from the survivors, never blindly.
    const submits = (form ? form.submits : []).filter((s) => !forbiddenWord(s.name, null));
    const submit = submits.find((s) => s.type === 'submit') || submits[0] || null;
    return {
      detection,
      username_selector: user.selector,
      password_selector: fields[pwIndex].selector,
      submit_selector: submit ? submit.selector : null,
      form_selector: form ? form.selector : null,
    };
  };

  for (const form of dom.forms) {
    if (!form.visible) continue;
    const found = fromFields(form.fields, 'first_password_form', form);
    if (found) return found;
  }
  // Only after every <form> has been rejected: a formless password field is a
  // weaker signal and must not win over a real form on the same page.
  return fromFields(dom.orphan_fields, 'orphan_password_field', null);
}

// --------------------------------------------------------------------------- main

async function main() {
  const started = Date.now();
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (err) { return fail('invalid_arguments', err.message, undefined, 2); }

  if (args.help || args.h) {
    return fail('invalid_arguments',
      'usage: node discover.mjs --url <url> --out <dir> [--viewport 1280x800] [--timeout 30000] ' +
      '[--username U] [--password P | $TRACEO_CRAWL_PASSWORD] [--login-url <url>] ' +
      '[--username-selector S] [--password-selector S] [--submit-selector S] ' +
      '[--max-pages 1] [--max-depth 2]',
      undefined, 2);
  }
  if (!args.url) return fail('invalid_arguments', '--url is required.', undefined, 2);
  if (!args.out) return fail('invalid_arguments', '--out is required.', undefined, 2);

  let viewport, timeout, idleTimeout, settle, hydrate, fullPage, maxHeight, maxRequests;
  let maxPages, maxDepth, loginWait;
  try {
    viewport = parseViewport(args.viewport || DEFAULTS.viewport);
    timeout = asInt(args.timeout, DEFAULTS.timeout, 'timeout');
    idleTimeout = asInt(args.idle_timeout, Math.min(DEFAULTS.idleTimeout, timeout), 'idle-timeout');
    settle = asInt(args.settle, DEFAULTS.settle, 'settle');
    hydrate = asInt(args.hydrate, DEFAULTS.hydrate, 'hydrate');
    maxHeight = asInt(args.max_height, DEFAULTS.maxHeight, 'max-height');
    maxRequests = asInt(args.max_requests, DEFAULTS.maxRequests, 'max-requests');
    fullPage = asBool(args.full_page, DEFAULTS.fullPage);
    maxPages = asRange(args.max_pages, DEFAULTS.maxPages, 'max-pages', 1, MAX_PAGES_CAP);
    // 0 is legal and means "the entry page only" — a depth flag that cannot say
    // that would force the caller to fake it with --max-pages 1.
    maxDepth = asRange(args.max_depth, DEFAULTS.maxDepth, 'max-depth', 0, 10);
    loginWait = asInt(args.login_wait, DEFAULTS.loginWait, 'login-wait');
  } catch (err) { return fail('invalid_arguments', err.message, undefined, 2); }

  // --- credentials. The env var wins over argv because argv is readable by any
  // process on the host through `ps`; the backend passes them this way.
  const envPassword = process.env.TRACEO_CRAWL_PASSWORD;
  const username = String(
    args.username !== undefined ? args.username : (process.env.TRACEO_CRAWL_USERNAME || ''));
  const password = String(
    envPassword !== undefined && envPassword !== '' ? envPassword
      : (args.password !== undefined ? args.password : ''));
  registerSecret(password);

  if (Boolean(username) !== Boolean(password)) {
    return fail('invalid_arguments',
      'Signing in needs both a username and a password (--username with --password or ' +
      '$TRACEO_CRAWL_PASSWORD).', undefined, 2);
  }
  // Credentials are OPTIONAL: a page that shows a password field is a login page
  // whether or not anybody said so, and it may publish its own demo credentials.
  // --login-url and the selectors therefore stand on their own.
  const wantLogin = Boolean(username && password);
  const selectorArgs = ['username_selector', 'password_selector', 'submit_selector']
    .filter((k) => args[k] !== undefined);
  if (selectorArgs.length && !(args.username_selector && args.password_selector)) {
    return fail('invalid_arguments',
      '--username-selector and --password-selector must be given together.', undefined, 2);
  }

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

  let loginTarget = null;
  if (args.login_url !== undefined) {
    try { loginTarget = await assertAllowedUrl(String(args.login_url)); }
    catch (err) {
      return fail(err.traceoCode || 'invalid_url', err.message, undefined, err.traceoExit || 1,
        { url: String(args.login_url) });
    }
    // "It stays on the login URL's origin" is only a meaningful promise if the
    // two URLs share one origin to begin with.
    if (loginTarget.origin !== target.origin) {
      return fail('invalid_arguments',
        '--login-url must be on the same origin as --url.', undefined, 2);
    }
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
    // `activeRequests` / `activeConsole` are swapped per visited page, so each
    // page's record owns exactly the traffic and the errors that page produced.
    let activeRequests = [];
    let activeConsole = [];
    let pageTruncated = false;
    let requestsTruncated = false;
    const byRequest = new Map();
    const downloads = new Set();

    const record = (req) => {
      if (activeRequests.length >= maxRequests) {
        pageTruncated = true;
        requestsTruncated = true;
        return null;
      }
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
        // credentials, and after this change one of them certainly does.
        has_post_data: Boolean(req.postData && req.postData() !== null),
        content_type: headers['content-type'] || null,
        started_ms: Date.now() - started,
        duration_ms: null,
        from_cache: false,
        redirected_from: req.redirectedFrom() ? req.redirectedFrom().url() : null,
      };
      activeRequests.push(entry);
      byRequest.set(req, entry);
      return entry;
    };

    page.on('request', (req) => { try { record(req); } catch { /* never break the run */ } });
    page.on('response', async (resp) => {
      // Content-Disposition is the authoritative "this link is a file, not a
      // page" signal. The download EVENT is not enough on its own: with request
      // interception in place Chromium aborts the navigation without always
      // raising it, and a link that was never a page must not be reported as a
      // broken one.
      try {
        const dispo = resp.headers()['content-disposition'] || '';
        if (/attachment/i.test(dispo)) downloads.add(resp.url());
      } catch { /* headers are best-effort */ }
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

    const pushConsole = (item) => {
      if (activeConsole.length < DEFAULTS.maxConsole) activeConsole.push(item);
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
    // The URL is remembered so the crawl can report WHY that link was not a page.
    page.on('download', (d) => { downloads.add(d.url()); d.cancel().catch(() => {}); });
    page.on('dialog', (d) => { d.dismiss().catch(() => {}); });

    /**
     * Load one page and describe it. Returns {ok:true, record} or {ok:false,
     * code, message} — the caller decides whether that is fatal (the first page)
     * or a skip (any later page).
     *
     * `screenshotName: null` is used for the login page: it is the vehicle, not a
     * crawled page, and it never appears in `pages`.
     */
    const visitPage = async (requestedUrl, { depth, index, screenshotName }) => {
      const t0 = Date.now();
      activeRequests = [];
      activeConsole = [];
      pageTruncated = false;
      const downloadsBefore = downloads.size;

      // domcontentloaded first so an SPA that never idles still gets its DOM read;
      // the idle wait is layered on top and is allowed to fail.
      let response;
      try {
        response = await page.goto(requestedUrl, { waitUntil: 'domcontentloaded', timeout });
      } catch (err) {
        // A link that serves an attachment aborts the navigation, and Chromium
        // raises the download event a beat AFTER goto() has already rejected —
        // so the abort has to be given a moment to explain itself, or every
        // download is misfiled as a broken link.
        for (let i = 0; i < 8 && downloads.size === downloadsBefore && /abort/i.test(err.message); i++) {
          await page.waitForTimeout(100);
        }
        if (downloads.size > downloadsBefore) {
          return { ok: false, code: 'download', message: `${requestedUrl} served a download.` };
        }
        const timedOut = /timeout/i.test(err.message);
        return {
          ok: false,
          code: timedOut ? 'navigation_timeout' : 'navigation_failed',
          message: `Could not load ${requestedUrl}: ${err.message}`,
          detail: blockedNavigations.length ? { blocked_navigations: blockedNavigations } : undefined,
        };
      }
      if (downloads.size > downloadsBefore) {
        return { ok: false, code: 'download', message: `${requestedUrl} served a download.` };
      }
      if (!response) {
        return { ok: false, code: 'navigation_failed', message: `No response for ${requestedUrl}.` };
      }

      // The final URL's host is re-checked: a redirect chain is the classic way to
      // land a "public" URL on an internal address.
      try { await assertAllowedUrl(page.url()); }
      catch (err) {
        return { ok: false, code: err.traceoCode || 'ssrf_blocked',
          message: `Target redirected to a disallowed address: ${err.message}` };
      }

      const status = response.status();
      if (status >= 400) {
        return { ok: false, code: 'http_error', status,
          message: `${requestedUrl} returned HTTP ${status} ${response.statusText()}.`,
          detail: { status, final_url: page.url() } };
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
        return { ok: false, code: 'extraction_failed', message: `DOM extraction failed: ${err.message}` };
      }

      // --- screenshot. Written before the JSON so a document that names a PNG can
      // always be trusted to have it on disk. The file is named after the page's
      // INDEX, never after anything the user typed.
      let shotPath = null;
      const shotMeta = { clipped: false, width: viewport.width, height: 0, bytes: 0 };
      if (screenshotName) {
        shotPath = path.join(outDir, screenshotName);
        try {
          const docHeight = Math.max(dom.document_height || 0, viewport.height);
          const clipped = fullPage && docHeight > maxHeight;
          const opts = { path: shotPath, animations: 'disabled', caret: 'hide', scale: 'css', type: 'png' };
          if (!fullPage) {
            opts.fullPage = false;
            shotMeta.height = viewport.height;
          } else if (clipped) {
            // fullPage + clip crops the FULL-PAGE raster, so the layout is never
            // disturbed. Resizing the viewport instead would re-run the page's
            // media queries and change every design fact the crop is taken for.
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
          return { ok: false, code: 'screenshot_failed',
            message: `Could not capture ${shotPath}: ${err.message}` };
        }
      }

      const finalUrl = page.url();
      return {
        ok: true,
        record: {
          index,
          url: requestedUrl,
          final_url: finalUrl,
          redirected: finalUrl !== requestedUrl,
          depth,
          status,
          title: dom.title,
          elapsed_ms: Date.now() - t0,
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
          links: [],
          requests: activeRequests,
          requests_truncated: pageTruncated,
          console_errors: activeConsole,
          counts: {
            forms: dom.forms.length,
            fields: dom.forms.reduce((n, f) => n + f.fields.length, 0),
            orphan_fields: dom.orphan_fields.length,
            controls: dom.controls.length,
            requests: activeRequests.length,
            xhr: activeRequests.filter((r) => r.resource_type === 'xhr' || r.resource_type === 'fetch').length,
            console_errors: activeConsole.length,
          },
          page: {
            element_count: dom.element_count,
            html_bytes: dom.html_bytes,
            document_height: dom.document_height,
          },
        },
      };
    };

    // ----------------------------------------------------------------- sign in
    // NOBODY HAS TO SAY THAT A PAGE NEEDS A SIGN-IN. A visible form containing an
    // input[type=password] IS a login page, decided from the DOM the browser
    // rendered — the same grounding rule every other fact here obeys. Supplied
    // credentials are an override, not a prerequisite.
    const MAX_REAUTH = 3;
    let credentials = wantLogin ? { username, password, source: 'user' } : null;
    let credentialEvidence = [];
    let login = null;
    let loginPage = null;      // pathKey of the login page, once one has been seen
    let submissions = 0;       // login-form submissions; no other form is ever submitted
    let reauths = 0;
    let crawlEntry = target.href;

    const explicitFields = args.username_selector ? {
      detection: 'explicit_selectors',
      username_selector: String(args.username_selector),
      password_selector: String(args.password_selector),
      submit_selector: args.submit_selector ? String(args.submit_selector) : null,
      form_selector: null,
    } : null;

    const loginFailed = (reason, message, finalUrl) => fail('login_failed', message, { reason }, 1, {
      url: target.href,
      login: {
        attempted: submissions > 0,
        succeeded: false,
        final_url: finalUrl || null,
        strategy: null,
        credentials_source: credentials ? credentials.source : null,
        credentials_evidence: credentials && credentials.source === 'page' ? credentialEvidence : [],
        login_form_submissions: submissions,
        // Both spellings: the consumers read `reauthenticated`, and a version skew
        // between this script and either backend must not silently report zero.
        reauthenticated: reauths,
        reauthentications: reauths,
        error: { code: 'login_failed', reason, message: cleanMessage(message) },
      },
      elapsed_ms: Date.now() - started,
    });

    /**
     * Sign in on the page the browser is showing right now. `record` is that
     * page's already-extracted DOM, so every selector used here is one extractDom
     * has already proven unique.
     */
    const signIn = async (record) => {
      const fields = explicitFields || detectLoginFields(record);
      if (!fields) {
        return { ok: false, reason: 'form_not_found', message:
          `No login form was found at ${record.final_url}: no visible form contains a password ` +
          'field with a preceding text or email field. Pass --username-selector and ' +
          '--password-selector to say where the fields are.' };
      }

      if (!credentials) {
        // Order of authority: what the user supplied, then what the page publishes
        // about itself. There is no third source — a guess is not a credential.
        let published = null;
        try { published = await page.evaluate(harvestPublishedCredentials); }
        catch { /* an unreadable page simply publishes nothing */ }
        if (published && published.username && published.password) {
          registerSecret(published.password);
          credentials = {
            username: published.username, password: published.password, source: 'page',
          };
          credentialEvidence = published.evidence || [];
        } else {
          return { ok: false, reason: 'no_credentials', message:
            `${record.final_url} asks for a sign-in and publishes no credentials of its own. ` +
            'Supplying a username and password would unlock the pages behind it; only the ' +
            'public surface was crawled.' };
        }
      }

      const beforeUrl = page.url();
      let before;
      try {
        before = await page.evaluate(probeLoginState);
        // THE ONE FORM THIS SCRIPT EVER SUBMITS. Playwright's fill() never echoes
        // the value it typed into its own error messages, and emit() scrubs the
        // password out of the document regardless.
        const fillTimeout = Math.min(timeout, 15000);
        await page.fill(fields.username_selector, credentials.username, { timeout: fillTimeout });
        await page.fill(fields.password_selector, credentials.password, { timeout: fillTimeout });
        submissions++;
        if (fields.submit_selector) {
          await page.click(fields.submit_selector, { timeout: fillTimeout });
        } else {
          // No submit control survived the forbidden-name filter (or there was
          // none): Enter in the password field submits the form without clicking
          // anything the safety rule refuses to click.
          await page.press(fields.password_selector, 'Enter');
        }
      } catch (err) {
        return { ok: false, reason: 'submit_failed', message:
          `The login form could not be filled or submitted: ${cleanMessage(err.message)}` };
      }

      // --- proof. Any ONE of the three is enough; which one fired is reported,
      // because "how do you know it worked" must be answerable from the document.
      const observe = async () => {
        const after = await page.evaluate(probeLoginState);
        return {
          // Compared on origin+path: an app that re-renders the login page as
          // /login?error=1 has not signed anybody in.
          url_left_login: pathKey(page.url()) !== pathKey(beforeUrl),
          logout_control: Boolean(after.logout_control) && !before.logout_control,
          // A RE-RENDERING PAGE HAS NO FIELDS OF ANY KIND, and that is not the
          // same thing as a page that no longer asks for a password. Measured on
          // the owner's target with a wrong password: the app re-mounts its
          // login form to show the error, and during the re-mount the DOM is
          // empty — which satisfied this check on its own and turned a rejected
          // sign-in into a reported success. Requiring the page to have
          // rendered SOMETHING is what tells "signed in" apart from "not
          // finished drawing".
          password_field_gone: before.visible_password_fields > 0
            && after.visible_password_fields === 0
            && after.interactive_elements > 0,
        };
      };
      const firstTrue = (c) => ['url_left_login', 'logout_control', 'password_field_gone']
        .find((k) => c[k]) || null;

      const deadline = Date.now() + loginWait;
      let strategy = null;
      let checks = { url_left_login: false, logout_control: false, password_field_gone: false };
      while (Date.now() < deadline) {
        await page.waitForTimeout(250);
        try { checks = await observe(); }
        catch { continue; }  // a navigation was in flight; the next tick lands after it
        const candidate = firstTrue(checks);
        if (!candidate) continue;

        // A PROOF THAT STOPS BEING TRUE WAS NEVER A PROOF. Measured on the
        // owner's target with a wrong password: the app re-renders the login
        // form to show its error, and while it re-mounts the password field is
        // momentarily absent from the DOM. That transient alone satisfied
        // `password_field_gone`, so a rejected sign-in was reported as a
        // successful one and the logged-out product was crawled as if it were
        // the application. Re-observing after the page settles is what tells a
        // sign-in apart from a re-render.
        // Bounded on purpose: what has to finish is the app's re-render, which
        // is sub-second. Waiting for a full network idle here would spend the
        // whole idle budget on a landing page that never idles (the owner's
        // dashboard embeds YouTube) and buy no extra certainty.
        try { await page.waitForLoadState('networkidle', { timeout: Math.min(idleTimeout, 3000) }); }
        catch { /* a busy landing page is not a failure; the re-check decides */ }
        await page.waitForTimeout(750);
        let confirmed;
        try { confirmed = await observe(); }
        catch { continue; }
        const held = firstTrue(confirmed);
        if (held) { checks = confirmed; strategy = held; break; }
        // It did not hold. Keep watching until the deadline: a genuine sign-in
        // that is merely slow still gets to prove itself.
        checks = confirmed;
      }

      if (!strategy) {
        // Says nothing about WHICH credential was wrong, for the same reason
        // identity.py returns a generic 401, and carries neither of them.
        return { ok: false, reason: 'proof_not_observed', message:
          'The credentials were rejected by the target: after submitting the login form the ' +
          'page did not leave the login URL, no sign-out control appeared and the password ' +
          `field was still there ${loginWait}ms later.` };
      }

      try { await page.waitForLoadState('networkidle', { timeout: idleTimeout }); }
      catch { /* the proof already fired; a busy landing page is not a failure */ }

      return {
        ok: true, strategy, checks, detection: fields.detection,
        final_url: page.url(), login_url: beforeUrl,
      };
    };

    const markSignedIn = (out) => {
      loginPage = pathKey(out.login_url);
      login = {
        attempted: true,
        succeeded: true,
        final_url: out.final_url,
        strategy: out.strategy,
        error: null,
        credentials_source: credentials.source,
        // The evidence is the page's own printed line. The password inside it is
        // scrubbed on the way out, so what survives is "Password : [redacted]" —
        // enough to audit WHERE the credential came from, not what it was.
        credentials_evidence: credentials.source === 'page' ? credentialEvidence : [],
        login_url: out.login_url,
        detection: out.detection,
        checks: out.checks,
        login_form_submissions: submissions,
        // Both spellings: the consumers read `reauthenticated`, and a version skew
        // between this script and either backend must not silently report zero.
        reauthenticated: reauths,
        reauthentications: reauths,
        message: credentials.source === 'page'
          ? 'Signed in using the credentials this page publishes.'
          : 'Signed in using the credentials supplied.',
      };
    };

    /** A sign-in is needed and none can be had. Not a failure — a finding. */
    const markLoginRequired = (record, message) => {
      loginPage = pathKey(record.final_url);
      login = {
        attempted: false,
        succeeded: false,
        final_url: null,
        strategy: null,
        error: { code: 'login_required', message: cleanMessage(message) },
        credentials_source: null,
        credentials_evidence: [],
        login_url: record.final_url,
        detection: null,
        checks: null,
        login_form_submissions: 0,
        // Both spellings: the consumers read `reauthenticated`, and a version skew
        // between this script and either backend must not silently report zero.
        reauthenticated: 0,
        reauthentications: 0,
        message: 'This page requires a sign-in and no credentials were available, so only the ' +
          'public surface was crawled.',
      };
    };

    // --login-url points at the sign-in page explicitly; --url stays the crawl root.
    if (loginTarget) {
      const landed = await visitPage(loginTarget.href, { depth: 0, index: -1, screenshotName: null });
      if (!landed.ok) {
        return fail(landed.code, landed.message, landed.detail, 1, {
          url: target.href, final_url: page.url(), elapsed_ms: Date.now() - started,
        });
      }
      const out = await signIn(landed.record);
      if (out.ok) markSignedIn(out);
      else if (out.reason === 'no_credentials') markLoginRequired(landed.record, out.message);
      else return loginFailed(out.reason, out.message, page.url());
    }

    // ----------------------------------------------------------------- crawl
    let crawlOrigin = new URL(crawlEntry).origin;
    const pages = [];
    const skipped = [];
    const seen = new Set([crawlKey(crawlEntry)]);
    const queue = [{ url: crawlEntry, depth: 0 }];
    const addSkip = (url, reason, match) => {
      if (skipped.length >= DEFAULTS.maxSkipped) return;
      if (skipped.some((s) => s.url === url && s.reason === reason)) return;
      skipped.push(match ? { url, reason, match } : { url, reason });
    };

    /**
     * Judge every link on a page. Nothing is ever clicked, so each candidate is
     * decided as a URL: the forbidden-name rule is applied to the accessible name
     * AND the href before a link can enter the queue.
     *
     * `follow: false` describes a page's links without queueing any of them. The
     * login page is described that way — the document should still say what it
     * links to, but that graph is the logged-out product's.
     */
    const describeLinks = (record, depth, { follow = true } = {}) => {
      const nextDepth = depth + 1;
      const links = [];
      const decided = new Set();
      for (const control of record.controls) {
        if (!control.href) continue;
        let u;
        try { u = new URL(control.href); } catch { u = null; }
        const key = u ? crawlKey(u.href) : `raw:${control.href}`;
        if (decided.has(key)) continue;
        decided.add(key);

        const link = {
          url: u ? u.href : control.href,
          name: control.name,
          selector: control.selector,
          same_origin: Boolean(u) && u.origin === crawlOrigin,
          decision: 'skipped',
          reason: null,
          match: null,
        };
        const word = forbiddenWord(control.name, link.url);
        if (!u) { link.reason = 'invalid_url'; }
        else if (u.protocol !== 'http:' && u.protocol !== 'https:') { link.reason = 'non_http_scheme'; }
        else if (u.origin !== crawlOrigin) { link.reason = 'cross_origin'; }
        else if (word) { link.reason = 'forbidden_control'; link.match = word; }
        else if (seen.has(key)) { link.decision = 'duplicate'; link.reason = null; }
        else if (!follow) { link.reason = 'pre_login'; }
        else if (nextDepth > maxDepth) { link.reason = 'max_depth'; }
        else if (pages.length + queue.length >= maxPages) { link.reason = 'max_pages'; }
        else {
          link.decision = 'queued';
          seen.add(key);
          queue.push({ url: u.href, depth: nextDepth });
        }
        // A link left behind by design is not a link the crawl refused: reporting
        // every pre-login link as "skipped" would bury the safety and budget
        // skips the reader is actually reading that list for.
        if (link.decision === 'skipped' && link.reason !== 'pre_login') {
          addSkip(link.url, link.reason, link.match);
        }
        links.push(link);
      }
      return links;
    };

    while (queue.length && pages.length < maxPages) {
      const item = queue.shift();
      const index = pages.length;
      const shotName = index === 0 ? 'screen.png' : `page-${String(index).padStart(2, '0')}.png`;
      let res = await visitPage(item.url, { depth: item.depth, index, screenshotName: shotName });

      if (!res.ok) {
        // The FIRST page failing is the whole run failing: that is what this
        // script has always done, and an empty success is indistinguishable from
        // a page with nothing on it.
        if (index === 0) {
          return fail(res.code, res.message, res.detail, 1, {
            url: target.href,
            final_url: page.url(),
            ...(res.status === undefined ? {} : { http_status: res.status }),
            ...(login ? { login } : {}),
            elapsed_ms: Date.now() - started,
          });
        }
        addSkip(item.url, res.code);
        continue;
      }

      // A page is a login page because of its SHAPE, never because of its URL:
      // an SPA that signs in without navigating leaves the URL unchanged, and
      // trusting the URL there would send the crawl back to re-authenticate on a
      // page that is now showing the product. The remembered URL only NARROWS
      // that test, so a "change your password" page behind the sign-in — a real
      // password form on a URL the login was never at — is crawled instead of
      // being typed into.
      const isLoginPage = Boolean(detectLoginFields(res.record))
        && (!loginPage || pathKey(res.record.final_url) === loginPage);

      // A sign-in is needed and cannot be made. Every link out of that page leads
      // behind the wall, so following them would request the product's pages
      // anonymously and record whatever the redirect served — the login screen,
      // over and over, counted as pages of the application.
      let followLinks = true;
      if (isLoginPage && login && !login.succeeded) {
        if (index > 0) { addSkip(item.url, 'login_required'); continue; }
        followLinks = false;
      }

      if (isLoginPage && !login) {
        // A record's request list stays live until the next page is loaded, and
        // signing in loads one: without this mark the login page would be
        // charged for every request the LANDING page boots — on the real target
        // that was 41 extra requests, including third-party embeds the login
        // page never touches.
        const requestMark = res.record.requests.length;
        const out = await signIn(res.record);
        if (out.ok) {
          markSignedIn(out);
          // The login page IS a crawled page. It is the URL the user named, so
          // dropping it would leave the one address he typed absent from his own
          // result: no screenshot of the logged-out surface, and no requirement
          // for the sign-in form — the single most important form an
          // authenticated product has. Its record was captured BEFORE the
          // credentials were typed, and it is kept rather than re-visited,
          // because re-visiting it while signed in redirects to the landing page
          // and would silently record that page twice under the login URL.
          // What the login page itself did, plus what the SUBMISSION caused: the
          // form post and the navigation it triggers. Everything the landing page
          // then boots is that page's, and is captured when the crawl visits it.
          const causedByLogin = res.record.requests.slice(requestMark).filter(
            (r) => (r.method !== 'GET' && r.method !== 'HEAD') || (r.is_navigation && r.main_frame));
          res.record.requests.length = requestMark;
          res.record.requests.push(...causedByLogin);
          res.record.counts.requests = res.record.requests.length;
          res.record.counts.xhr = res.record.requests.filter(
            (r) => r.resource_type === 'xhr' || r.resource_type === 'fetch').length;
          res.record.links = describeLinks(res.record, item.depth, { follow: false });
          pages.push(res.record);
          seen.add(crawlKey(res.record.final_url));
          // The frontier restarts at whatever signing in landed on: the login
          // page's own links describe the logged-out product, and following them
          // would spend the page budget on the surface the sign-in exists to
          // leave behind.
          crawlEntry = out.final_url;
          crawlOrigin = new URL(crawlEntry).origin;
          queue.length = 0;
          seen.add(crawlKey(crawlEntry));
          queue.push({ url: crawlEntry, depth: item.depth });
          continue;
        }
        if (out.reason === 'no_credentials') {
          markLoginRequired(res.record, out.message);
          // Same reason as the guard above: the way past this page is not
          // available, so its links are described and left alone. The public
          // surface is what a visitor can reach without an account, and from a
          // sign-in screen that is the sign-in screen.
          followLinks = false;
        } else return loginFailed(out.reason, out.message, page.url());
      } else if (isLoginPage && login && login.succeeded) {
        // The session was lost mid-crawl. Re-authenticate and carry on rather than
        // reporting a live page as dead. Capped, so a session that can never be
        // held cannot turn the crawl into a login loop.
        if (reauths >= MAX_REAUTH) { addSkip(item.url, 'session_lost'); continue; }
        reauths++;
        const out = await signIn(res.record);
        if (!out.ok) return loginFailed(out.reason, out.message, page.url());
        markSignedIn(out);
        const again = await visitPage(item.url, { depth: item.depth, index, screenshotName: shotName });
        if (!again.ok || pathKey(again.record.final_url) === loginPage) {
          addSkip(item.url, 'session_lost');
          continue;
        }
        res = again;
      }

      // Credentials were supplied for a target that never shows a login form.
      // Crawling on would quietly describe the logged-out product, which is the
      // one outcome worse than no result at all.
      if (index === 0 && wantLogin && !login) {
        return loginFailed('form_not_found',
          `Credentials were supplied but ${res.record.final_url} has no visible form containing ` +
          'a password field. Point --url or --login-url at the sign-in page, or pass ' +
          '--username-selector and --password-selector.', res.record.final_url);
      }

      pages.push(res.record);
      seen.add(crawlKey(res.record.final_url));

      res.record.links = describeLinks(res.record, item.depth, { follow: followLinks });
    }

    // Only reachable when the entry page was a login page whose post-login target
    // could not be loaded. Reporting an empty success would be the silent
    // zero-result import this tool exists to prevent.
    if (!pages.length) {
      return fail('navigation_failed', `Nothing could be crawled from ${crawlEntry}.`, undefined, 1, {
        url: target.href, final_url: page.url(),
        ...(login ? { login } : {}), elapsed_ms: Date.now() - started,
      });
    }

    // ----------------------------------------------------------------- document
    // page[0] IS the top-level page: every key that existed before this file grew
    // a crawler still describes exactly the first page crawled.
    const first = pages[0];
    // One plain sentence, so the result reads as a report rather than as a
    // configuration to be corrected.
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const tally = `${plural(pages.length, 'page')} (${plural(skipped.length, 'link')} skipped)`;
    const summary = !login
      ? `No sign-in was needed; crawled ${tally}.`
      : login.succeeded
        ? `${login.credentials_source === 'page'
          ? 'Signed in using the credentials this page publishes'
          : 'Signed in using the credentials supplied'}, then crawled ${tally}.`
        : 'This target requires a sign-in and no credentials were available, so only its public '
          + `surface was crawled: ${tally}.`;
    const doc = {
      ok: true,
      schema_version: SCHEMA_VERSION,
      url: target.href,
      final_url: first.final_url,
      redirected: first.final_url !== target.href,
      http_status: first.status,
      title: first.title,
      viewport: { width: viewport.width, height: viewport.height, device_scale_factor: 1 },
      elapsed_ms: first.elapsed_ms,
      screenshot: first.screenshot,
      screenshot_width: first.screenshot_width,
      screenshot_height: first.screenshot_height,
      screenshot_bytes: first.screenshot_bytes,
      screenshot_clipped: first.screenshot_clipped,
      wait_strategy: first.wait_strategy,
      wait_notes: first.wait_notes,
      headings: first.headings,
      lang: first.lang,
      dir: first.dir,
      description: first.description,
      forms: first.forms,
      orphan_fields: first.orphan_fields,
      controls: first.controls,
      requests: first.requests,
      requests_truncated: requestsTruncated,
      console_errors: first.console_errors,
      blocked_navigations: blockedNavigations,
      counts: first.counts,
      page: first.page,
      login,
      pages,
      crawl: {
        requested_max_pages: maxPages,
        max_depth: maxDepth,
        visited: pages.length,
        skipped,
        origin: crawlOrigin,
        entry_url: crawlEntry,
        credentials_source: login && login.succeeded ? login.credentials_source : null,
        summary,
      },
      engine: {
        tool: 'traceo/web-discovery',
        playwright_version: pwVersion,
        playwright_from: pwFrom,
        node_version: process.version,
        finished_at: new Date().toISOString(),
        total_elapsed_ms: Date.now() - started,
      },
    };

    // A copy on disk beside the screenshots: the backend job keeps the raw
    // transcript next to the artefacts it describes, which is what makes a
    // generated case auditable months later. Written through the same scrubber as
    // stdout — a secret that only leaks to a file is still leaked.
    try { fs.writeFileSync(path.join(outDir, 'discovery.json'), serialize(doc)); }
    catch { /* stdout is the contract; the copy is a convenience */ }

    emit(doc, 0);
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

await main();
