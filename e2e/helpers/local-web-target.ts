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
  /**
   * Which session cookie the request carried. Only the AUTHENTICATED fixture
   * issues one; the single-page fixture leaves this undefined.
   */
  session?: SessionState;
  /**
   * Field NAMES of a form submission — a POST body's keys, or the query keys of
   * a GET-method form. NEVER the values: one of them is the password, and a
   * credential that reaches a test report is a credential that reaches a log.
   */
  submittedFields?: string[];
  /**
   * For a login submission: whether it carried the fixture's credentials. The
   * boolean is the whole record — the credentials themselves are never stored.
   */
  credentialsAccepted?: boolean;
  /**
   * WHICH account an accepted sign-in used: the operator's, or the one the page
   * prints on itself. Two accounts with different rules about what may be
   * reported, so the log has to say which one was used — never what it was.
   */
  credentialSource?: CredentialSource;
  /** Status the fixture answered with — how "visited" is told from "bounced". */
  status?: number;
}

/** Whether a request carried the session cookie this fixture issued. */
export type SessionState = 'valid' | 'unknown' | 'none';

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
 * Bind the first free port of the window; throws with the window in the message
 * when every port is taken (a diagnostic, not a hang).
 */
async function bind(server: http.Server): Promise<number> {
  for (let port = PORT_RANGE.first; port <= PORT_RANGE.last; port += 1) {
    const bound = await listen(server, port);
    if (bound !== null) return bound;
  }
  throw new Error(
    `local web target: no free port in ${PORT_RANGE.first}-${PORT_RANGE.last} ` +
      `(3002/8002 are the owner's stack and are never used here)`,
  );
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

  const origin = `http://127.0.0.1:${await bind(server)}`;
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

// --- the AUTHENTICATED fixture --------------------------------------------------
//
// THE SAFETY RULE THE CRAWL IS HELD TO, stated here exactly as it is stated in
// the sidecar, the backend and docs/WEB_TARGETS.md:
//
//     The crawler submits THE LOGIN FORM ONLY, once, with the credentials the
//     user supplied. It submits no other form, ever. It clicks no control whose
//     accessible name or href matches logout / sign out / delete / remove /
//     destroy / reset / deactivate / terminate. It stays on the login URL's
//     origin. It follows links only.
//
// Every clause of it is a NEGATIVE about the outside world, and a discovery
// report cannot be its own witness for a negative. So this server is the
// witness: it records the method, the path, the session cookie and the FIELD
// NAMES of anything submitted to it, and the spec asserts against that log.
// Values are never recorded — one of them is the password.

const CRAWL_PAGE_FILE = 'web-target-crawl-page.html';

/** The session cookie the fixture issues on a correct sign-in. */
const SESSION_COOKIE = 'traceo_fixture_session';

/**
 * The fixture's credentials. They are the suite's own secret and exist only in
 * this process: the spec asserts they appear in no payload, no job error and no
 * stored target, so the password needs to be a string that could not plausibly
 * turn up by accident.
 */
export const CRAWL_CREDENTIALS = Object.freeze({
  username: 'crawl_admin',
  password: 'Loopback-Session-9f2c-never-logged',
});

/**
 * The OTHER account — the one the login page PRINTS ON ITSELF when the fixture
 * is started with `publishCredentials`. The pair is deliberately the pair the
 * motivating target publishes, because that is the shape a crawler has to cope
 * with: two visible lines reading "Username : Admin" and "Password : admin123"
 * beside the form.
 *
 * It is a DIFFERENT pair from CRAWL_CREDENTIALS on purpose. A page-published
 * credential is a fact about the page and may be reported; an operator's
 * credential is a secret and may not. Two distinct pairs are what let the suite
 * assert both sentences at once instead of one of them at a time.
 */
export const PUBLISHED_CREDENTIALS = Object.freeze({
  username: 'Admin',
  password: 'admin123',
});

/** Where a credential the fixture accepted came from — never a value. */
export type CredentialSource = 'user' | 'page';

/** The marker the page reserves for the server to write the published pair into. */
const FLAGS_MARKER = '/*__TRACEO_FIXTURE_FLAGS__*/';

/** The login page — where a crawl of this fixture starts. */
const LOGIN_PATH = '/login';

/** The pages behind the login. The first is the post-login landing page. */
export const CRAWL_PAGE_PATHS = Object.freeze([
  '/app/dashboard',
  '/app/profile',
  '/app/orders',
  '/app/settings',
]);

/**
 * Controls the crawl must never activate, each present on EVERY page the
 * fixture serves (login included). `/logout` and `/reset-password` are links —
 * a crawler that "follows links only" would follow them if it did not read
 * their names — and `/api/account` is what the Delete button calls.
 */
export const CRAWL_FORBIDDEN_PATHS = Object.freeze(['/logout', '/reset-password', '/api/account']);

/**
 * Every field name the fixture's forms carry. A submission is detected by these
 * names, so a form sent by GET (which would arrive as a query string and not as
 * a body) is caught by the same oracle as one sent by POST.
 */
const CRAWL_FIELD_NAMES = Object.freeze([
  'username',
  'password',
  'dashboard-term',
  'profile-email',
  'profile-phone',
  'orders-reference',
  'orders-note',
  'settings-locale',
]);

/** JSON the pages behind the login fetch. `/api/v2/session` is on EVERY page. */
const CRAWL_JSON_ROUTES: Record<string, unknown> = {
  // No response body names the fixture's username: the spec asserts the
  // username appears nowhere in what Traceo stores, and a body that echoed it
  // would make a real leak indistinguishable from the fixture's own data.
  '/api/v2/session': { user: 'fixture-account', roles: ['admin'] },
  '/api/v2/summary': { open_orders: 3, overdue: 1 },
  '/api/v2/settings': { locale: 'en', theme: 'dark' },
  '/api/v2/orders': { items: [{ id: 1042, status: 'open' }], page: 1 },
  '/api/v2/orders/1042': { id: 1042, status: 'open', total: 149.5 },
  '/api/v2/customers/3f0f8e2c-4d1a-4a53-9f4b-6a2c9b7e1d55': {
    id: '3f0f8e2c-4d1a-4a53-9f4b-6a2c9b7e1d55',
    name: 'Alice Hartley',
  },
};

export interface AuthenticatedWebTarget {
  /** The login page — the URL a WebTarget is created against. */
  readonly loginUrl: string;
  readonly origin: string;
  /** Credentials the crawl is expected to be given. */
  readonly username: string;
  readonly password: string;
  /**
   * The account this instance's login page prints on itself, or null when it
   * prints none. A published credential is a fact about the page: the spec is
   * allowed to find it in the served bytes, and uses that to prove the
   * leak detector is capable of finding a password at all.
   */
  readonly published: { username: string; password: string } | null;
  /** Absolute URLs of the pages behind the login, landing page first. */
  readonly pageUrls: readonly string[];
  readonly requests: readonly RecordedRequest[];

  /** Submissions of the login form — must be exactly one for a whole crawl. */
  loginSubmissions(): RecordedRequest[];
  /** EVERY form submission the server saw, by body keys or by GET query keys. */
  submissions(): RecordedRequest[];
  /** Requests whose method is neither GET nor HEAD. */
  mutatingRequests(): RecordedRequest[];
  /** Requests that reached a control the safety rule forbids. */
  forbiddenActivations(): RecordedRequest[];
  requestsTo(path: string): RecordedRequest[];
  /** Requests for anything behind the login that carried NO valid session. */
  unauthenticatedBehindLogin(): RecordedRequest[];
  /** Page paths that were actually served (200) — what the crawl really saw. */
  visitedPagePaths(): string[];
  /** The served bytes of any page — the "no form in the HTML" proof. */
  servedHtml(): string;
  close(): Promise<void>;
}

/** Read the fixture's session cookie out of a Cookie header. */
function sessionOf(header: string | undefined, issued: ReadonlySet<string>): SessionState {
  if (!header) return 'none';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name !== SESSION_COOKIE) continue;
    return issued.has(rest.join('=')) ? 'valid' : 'unknown';
  }
  return 'none';
}

/** Read a request body, capped — a fixture must not be a memory sink. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 16_384) req.destroy();
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** Which of the fixture's field names a set of submitted keys contains. */
function fieldNamesIn(keys: Iterable<string>): string[] {
  return [...new Set([...keys].filter((key) => CRAWL_FIELD_NAMES.includes(key)))].sort();
}

/**
 * Which account a submission carried, or `null` if it carried neither. The
 * server knows this and the crawl's own report does not get to be its only
 * witness: `credentials_source: "page"` in a job result is only believable if
 * the pair that arrived on the wire really was the pair the page printed.
 */
function credentialSourceOf(form: URLSearchParams): CredentialSource | null {
  const username = form.get('username');
  const password = form.get('password');
  if (username === CRAWL_CREDENTIALS.username && password === CRAWL_CREDENTIALS.password) {
    return 'user';
  }
  if (username === PUBLISHED_CREDENTIALS.username && password === PUBLISHED_CREDENTIALS.password) {
    return 'page';
  }
  return null;
}

/**
 * Write the published pair into the page, or leave the marker as the inert
 * comment it is. The values are injected rather than hard-coded in the HTML so
 * that the page and this module cannot drift: a fixture whose printed password
 * stopped matching the one the server accepts would fail as "the crawler read
 * it wrong", which is the most expensive kind of wrong test.
 */
function withFlags(html: string, publishCredentials: boolean): string {
  if (!publishCredentials) return html;
  if (!html.includes(FLAGS_MARKER)) {
    throw new Error(`local web target: ${CRAWL_PAGE_FILE} no longer carries ${FLAGS_MARKER}`);
  }
  return html.replace(
    FLAGS_MARKER,
    `window.__TRACEO_PUBLISHED_CREDENTIALS__ = ${JSON.stringify(PUBLISHED_CREDENTIALS)};`,
  );
}

export interface AuthenticatedTargetOptions {
  /**
   * Print an account on the login page, the way a demo environment does.
   * Default OFF: a login page that publishes nothing is the ordinary case, and
   * it is the one that must end in `login_required` rather than in a crawl of
   * the logged-out product.
   */
  publishCredentials?: boolean;
}

/**
 * Start the authenticated fixture: a client-rendered login page, a session
 * cookie issued only on the correct credentials, four linked pages behind it —
 * each with its OWN form and its own field ids — and the forbidden controls on
 * every one of them.
 *
 * A plain GET of any page returns markup with no form, no input and no button:
 * the crawler has to render every page in a browser, not only the first, or it
 * has nothing to log in with and nothing to follow.
 */
export async function startAuthenticatedWebTarget(
  options: AuthenticatedTargetOptions = {},
): Promise<AuthenticatedWebTarget> {
  const publishCredentials = options.publishCredentials === true;
  const published = publishCredentials ? { ...PUBLISHED_CREDENTIALS } : null;
  const html = withFlags(fs.readFileSync(samplePath(CRAWL_PAGE_FILE), 'utf8'), publishCredentials);
  const requests: RecordedRequest[] = [];
  const issued = new Set<string>();

  const server = http.createServer((req, res) => {
    void (async () => {
      const method = (req.method ?? 'GET').toUpperCase();
      const url = req.url ?? '/';
      const [path, query = ''] = url.split('?');
      const record: RecordedRequest = {
        method,
        url,
        path,
        session: sessionOf(req.headers.cookie, issued),
      };
      requests.push(record);

      // Everything is uncacheable: two crawls in one run must both render.
      res.setHeader('Cache-Control', 'no-store');

      const answer = (status: number, headers: http.OutgoingHttpHeaders, body: string) => {
        record.status = status;
        res.writeHead(status, headers);
        res.end(body);
      };
      const page = () => answer(200, { 'Content-Type': 'text/html; charset=utf-8' }, html);
      const json = (status: number, body: unknown) =>
        answer(status, { 'Content-Type': 'application/json' }, JSON.stringify(body));

      // A GET-method form arrives as a query string, so the submission oracle
      // reads query keys as well as body keys — otherwise a crawler could
      // submit a form and be recorded as having merely navigated.
      const queryFields = fieldNamesIn(new URLSearchParams(query).keys());
      if (queryFields.length > 0) record.submittedFields = queryFields;

      if (method === 'POST' && path === LOGIN_PATH) {
        const submitted = new URLSearchParams(await readBody(req));
        record.submittedFields = fieldNamesIn(submitted.keys());
        // The published pair only works on an instance that published it:
        // otherwise a crawler could "guess" the demo account of a site that
        // never offered one and the fixture would call the guess a fact.
        const source = credentialSourceOf(submitted);
        const accepted = source === 'user' || (source === 'page' && publishCredentials);
        record.credentialsAccepted = accepted;
        if (accepted && source) record.credentialSource = source;

        if (!accepted) {
          // Answered AT THE LOGIN URL and with the password field still on the
          // page, so all three of the crawler's success probes must come back
          // negative. A redirect elsewhere would let "the URL left the login
          // page" fire on a rejected sign-in.
          page();
          return;
        }
        const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        issued.add(token);
        answer(
          303,
          {
            'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`,
            Location: CRAWL_PAGE_PATHS[0],
          },
          '',
        );
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        // Recorded above and refused here. Reaching this branch IS the failure
        // the safety assertions look for: a form other than the login form was
        // submitted, or the Delete button was clicked.
        if (record.submittedFields === undefined) {
          record.submittedFields = fieldNamesIn(new URLSearchParams(await readBody(req)).keys());
        }
        json(405, { code: 'method_not_allowed', method, path });
        return;
      }

      if (path === LOGIN_PATH) {
        page();
        return;
      }

      if (path === '/logout') {
        // A crawl must never get here. If it does, the log says so — and the
        // session is destroyed, which makes the damage visible in the pages
        // that follow rather than silent.
        issued.clear();
        answer(303, { Location: LOGIN_PATH }, '');
        return;
      }

      if (record.session !== 'valid') {
        // Everything except the login page needs the cookie. A crawl that
        // never logged in therefore leaves a trail of bounced requests rather
        // than quietly reporting the logged-out product as the product.
        if (path.startsWith('/api/')) {
          json(401, { code: 'unauthenticated', path });
          return;
        }
        answer(303, { Location: LOGIN_PATH }, '');
        return;
      }

      if (CRAWL_PAGE_PATHS.includes(path)) {
        page();
        return;
      }

      const body = CRAWL_JSON_ROUTES[path];
      if (body !== undefined) {
        json(200, body);
        return;
      }

      json(404, { code: 'not_found', path });
    })();
  });

  const origin = `http://127.0.0.1:${await bind(server)}`;
  const behindLogin = (r: RecordedRequest) => r.path !== LOGIN_PATH && r.path !== '/logout';

  return {
    loginUrl: `${origin}${LOGIN_PATH}`,
    origin,
    username: CRAWL_CREDENTIALS.username,
    password: CRAWL_CREDENTIALS.password,
    published,
    pageUrls: CRAWL_PAGE_PATHS.map((path) => `${origin}${path}`),
    requests,

    loginSubmissions: () =>
      requests.filter((r) => r.path === LOGIN_PATH && r.credentialsAccepted !== undefined),
    submissions: () => requests.filter((r) => (r.submittedFields ?? []).length > 0),
    mutatingRequests: () => requests.filter((r) => r.method !== 'GET' && r.method !== 'HEAD'),
    forbiddenActivations: () =>
      requests.filter((r) => CRAWL_FORBIDDEN_PATHS.some((p) => r.path === p)),
    requestsTo: (path: string) => requests.filter((r) => r.path === path),
    unauthenticatedBehindLogin: () =>
      requests.filter((r) => behindLogin(r) && r.session !== 'valid'),
    visitedPagePaths: () => [
      ...new Set(
        requests
          .filter((r) => r.status === 200 && CRAWL_PAGE_PATHS.includes(r.path))
          .map((r) => r.path),
      ),
    ],
    servedHtml: () => html,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
