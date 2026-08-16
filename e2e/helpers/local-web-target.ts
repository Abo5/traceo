/**
 * A hermetic web target — the page `web-target.spec.ts` points Traceo at.
 *
 * WHY A LOCAL SERVER AND NOT THE PUBLIC INTERNET (§8, §10). The feature was
 * motivated by a real URL (the OrangeHRM demo login), but a suite that browses
 * to a third-party host is not a suite: it fails when someone else deploys,
 * it leaks the run's timing into a stranger's logs, and it cannot be run on a
 * build node without egress. So the spec serves its OWN page on loopback,
 * with the one property that actually matters for this feature — the markup is
 * built by script, so the form exists only after a browser rendered it.
 *
 * The server is also the SAFETY ORACLE. It records every request it receives,
 * which is the only way to prove the negative the contract demands: discovery
 * navigates and reads, and never submits a form or clicks a destructive
 * control. An assertion on "no POST/DELETE ever arrived" is checkable here and
 * nowhere else — the discovery report cannot be its own witness.
 *
 * Ports: 8010–8030 (the owner's live stack on 3002/8002 is never touched, and
 * 9000 belongs to the demo SUT).
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { samplePath } from './test-data';

/** The port window this helper may bind — deliberately away from every other stack. */
const PORT_RANGE = { first: 8010, last: 8030 };

const PAGE_FILE = 'web-target-page.html';

/** One request the page (or anything else) actually sent to the target. */
export interface RecordedRequest {
  method: string;
  /** Path with its query string, as received. */
  url: string;
  /** Path only — the comparable half. */
  path: string;
}

export interface LocalWebTarget {
  /** Absolute URL of the rendered page — what a WebTarget is created against. */
  readonly url: string;
  readonly origin: string;
  /** Every request the server received, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  /** Requests whose method is neither GET nor HEAD — must stay empty (SAFETY). */
  mutatingRequests(): RecordedRequest[];
  requestsTo(path: string): RecordedRequest[];
  close(): Promise<void>;
}

/** JSON bodies the page's fetch() calls resolve against — fixed, offline data. */
const JSON_ROUTES: Record<string, unknown> = {
  '/api/v2/orders': { items: [{ id: 1042, status: 'pending' }], page: 1 },
  '/api/v2/orders/1042': { id: 1042, status: 'pending', total: 149.5 },
  '/api/v2/customers/3f0f8e2c-4d1a-4a53-9f4b-6a2c9b7e1d55': {
    id: '3f0f8e2c-4d1a-4a53-9f4b-6a2c9b7e1d55',
    name: 'Alice Hartley',
  },
};

/**
 * Bind one port. Resolves the port on success and `null` when it is taken (the
 * caller tries the next one); any OTHER error rejects — a suite that quietly
 * swallowed, say, a permissions failure would spend its budget scanning ports
 * that were never going to work.
 */
function listen(server: http.Server, port: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null);
      else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start the target. Binds the first free port of the window; throws with the
 * window in the message when every port is taken (a diagnostic, not a hang).
 */
export async function startLocalWebTarget(): Promise<LocalWebTarget> {
  const html = fs.readFileSync(samplePath(PAGE_FILE));
  const requests: RecordedRequest[] = [];

  const server = http.createServer((req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = req.url ?? '/';
    const path = url.split('?')[0];
    requests.push({ method, url, path });

    // Everything is uncacheable: two discoveries in one run must both render.
    res.setHeader('Cache-Control', 'no-store');

    if (method !== 'GET' && method !== 'HEAD') {
      // Recorded above and refused here. Reaching this branch IS the failure
      // the safety assertion looks for — discovery must never submit anything.
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'method_not_allowed', method, path }));
      return;
    }

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const body = JSON_ROUTES[path];
    if (body !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', path }));
  });

  let bound: number | null = null;
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last && bound === null; port += 1) {
    bound = await listen(server, port);
  }
  if (bound === null) {
    throw new Error(
      `local web target: no free port in ${PORT_RANGE.first}-${PORT_RANGE.last} ` +
        `(3002/8002 are the owner's stack and are never used here)`,
    );
  }

  const origin = `http://127.0.0.1:${bound}`;
  return {
    url: `${origin}/`,
    origin,
    requests,
    mutatingRequests: () => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'),
    requestsTo: (path: string) => requests.filter((r) => r.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
