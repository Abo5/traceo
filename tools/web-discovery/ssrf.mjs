/**
 * Traceo sidecar SSRF guard — the single copy of the target-URL policy.
 *
 * Both sidecars take a URL that a user typed, so both must refuse to reach
 * loopback, private, link-local, carrier-NAT, multicast and cloud-metadata
 * addresses. This module exists so there is exactly ONE such policy: a second
 * copy would be a second thing to update when a range is added, and the copy
 * nobody remembered is the hole.
 *
 * Mirrors backend `discovery.py::_assert_public_host`. `discover.mjs` still
 * carries its own inlined copy of these functions (it predates this module and
 * is covered by e2e/tests/web-target.spec.ts); when that file is next touched,
 * point it here and delete the inlined block.
 *
 * TRACEO_ALLOW_PRIVATE_TARGETS=1 lifts the guard so the stack can be aimed at a
 * local application under test — the same escape hatch the backend uses.
 */
import { promises as dns } from 'node:dns';
import net from 'node:net';

const ALLOW_PRIVATE = process.env.TRACEO_ALLOW_PRIVATE_TARGETS === '1';

/** Tagged error: the caller turns `traceoCode` into the JSON error document. */
export function tagged(code, message, exitCode = 1) {
  const err = new Error(message);
  err.traceoCode = code;
  err.traceoExit = exitCode;
  return err;
}

/** IPv4 ranges that must never be reachable from a user-supplied target URL. */
export function ipv4Blocked(ip) {
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
export function ipv6Groups(ip) {
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

export function ipv6Blocked(ip) {
  const g = ipv6Groups(ip);
  if (g.some((n) => !Number.isFinite(n))) return 'malformed';
  if (g.every((n) => n === 0)) return 'unspecified';                          // ::
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

export function ipBlocked(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return ipv4Blocked(ip);
  if (kind === 6) return ipv6Blocked(ip);
  return 'malformed';
}

/** Resolve `hostname` and refuse it when ANY resolved address is non-public. */
export async function assertPublicHost(rawHostname) {
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

export async function assertAllowedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw tagged('invalid_url', `'${raw}' is not a valid URL.`, 2); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw tagged('invalid_url', `Only http/https URLs are allowed (got '${u.protocol}').`, 2);
  }
  await assertPublicHost(u.hostname);
  return u;
}
