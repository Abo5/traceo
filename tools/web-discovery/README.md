# Traceo web-discovery sidecar

`discover.mjs` renders a URL in a real browser and prints one JSON document describing
everything the page actually is: its forms and fields, its buttons and links, every network
request it made, and a PNG screenshot on disk. When the page asks for a sign-in it signs in
and describes the pages behind it too.

It is the grounding source for the **web target** feature. Both backends (Python and Go)
shell out to this one script — there is a single crawler, so the two ports differ only in
their API surface and persistence, never in what they discover.

---

## Why a browser is mandatory

The owner's example target is a Vue SPA. Measured, not assumed:

```
$ curl -s https://opensource-demo.orangehrmlive.com/web/index.php/auth/login | wc -c
3450
$ ... | grep -c '<form'    -> 0
$ ... | grep -c '<input'   -> 0
$ ... | grep -c '<button'  -> 0
```

Server-side HTML parsing discovers **nothing** on that page. Every field is created by
client JavaScript after hydration. The same script through a browser finds 1 form, 3
fields, 6 controls and 13 requests.

**If a run reports zero forms on an SPA, the wait strategy is wrong — the page is not
empty.** See "Wait strategy" below before concluding otherwise.

---

## Usage

```bash
node discover.mjs --url <url> --out <dir> [--viewport 1280x800] [--timeout 30000]
                  [--username U] [--password P] [--login-url <url>]
                  [--username-selector S] [--password-selector S] [--submit-selector S]
                  [--max-pages 25] [--max-depth 2]
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | *required* | http/https target |
| `--out` | *required* | directory for `screen.png`, `page-NN.png` and `discovery.json` (created if absent) |
| `--viewport` | `1280x800` | `WIDTHxHEIGHT`; `deviceScaleFactor` is always 1 |
| `--timeout` | `30000` | ceiling for the initial navigation, ms |
| `--idle-timeout` | `15000` | how long to wait for network idle before falling back |
| `--settle` | `2500` | quiet period used when idle is never reached |
| `--hydrate` | `5000` | wait for the first form/input/button/link to render |
| `--full-page` | `true` | `--full-page 0` captures the viewport only |
| `--max-height` | `4000` | full-page captures are clipped to this height (see below) |
| `--max-requests` | `500` | request-inventory cap **per page**; sets `requests_truncated` |
| `--max-pages` | `25` | pages to crawl, `1..50`; outside that range is exit 2, never a clamp |
| `--max-depth` | `2` | link depth from the entry page; `0` means the entry page alone |
| `--username` | — | sign-in username (or `$TRACEO_CRAWL_USERNAME`) |
| `--password` | — | sign-in password — **prefer `$TRACEO_CRAWL_PASSWORD`**, argv is visible to `ps` |
| `--login-url` | — | where the sign-in form lives, when it is not `--url`; must share `--url`'s origin |
| `--username-selector` `--password-selector` | — | override field detection; must be given together |
| `--submit-selector` | — | override the submit control; without it, Enter in the password field |
| `--login-wait` | `15000` | how long to wait for post-login state before calling it a rejection |

Playwright is resolved, in order, from `$TRACEO_PLAYWRIGHT_NODE_MODULES`,
`<repo>/e2e/node_modules`, `./node_modules`, `<repo>/node_modules`, then normal Node
resolution. **There is no `package.json` here on purpose** — the repo already installs
Playwright for the E2E suite, and a second copy would be a second version to keep in sync.

### Exit codes

| Code | Meaning | stdout |
|---|---|---|
| `0` | success | `{"ok": true, ...}` |
| `1` | the target failed — navigation, timeout, non-2xx, blocked redirect | `{"ok": false, "error": {...}}` |
| `2` | bad invocation — arguments, URL syntax, unwritable `--out` | `{"ok": false, "error": {...}}` |
| `3` | environment — Playwright or the Chromium binary is missing | `{"ok": false, "error": {"code": "browser_discovery_unavailable", ...}}` |

**stdout is always exactly one JSON document, never a stack trace.** `uncaughtException`
and `unhandledRejection` are both trapped and rendered as error documents. Diagnostics
never go to stdout.

Error codes: `invalid_arguments`, `invalid_url`, `unresolvable_host`, `ssrf_blocked`,
`output_unwritable`, `navigation_failed`, `navigation_timeout`, `http_error`,
`extraction_failed`, `screenshot_failed`, `browser_discovery_unavailable`,
`login_failed`, `internal_error`.

`login_failed` is exit 1 and carries a `login` object alongside the error. It means a sign-in
was **attempted and could not be proven**, and nothing was crawled — crawling on would have
described the logged-out product while reporting success. `login_required` is *not* an error
code: it is the `login.error.code` on a **successful** run where the target wanted a sign-in
and no credentials existed, and it says so in `crawl.summary` rather than pretending the
public surface was the whole application.

The backend job maps exit 3 / `browser_discovery_unavailable` straight through to its own
`browser_discovery_unavailable` failure. It must never turn a failed run into an empty
success — a silent zero-result import is indistinguishable from a page with nothing on it,
and that is exactly the confusion this tool exists to remove.

---

## Safety

> **The crawler submits THE LOGIN FORM ONLY, once, with the credentials the user supplied.
> It submits no other form, ever. It clicks no control whose accessible name or href matches
> logout / sign out / delete / remove / destroy / reset / deactivate / terminate. It stays on
> the login URL's origin. It follows links only.**

That is the whole rule, and it is stated in exactly these words here, at the top of
`discover.mjs`, and in `docs/WEB_TARGETS.md`. With no sign-in in play the script types
nothing and clicks nothing at all: it navigates, waits, reads the DOM and screenshots, which
is byte-for-byte what it did before it could crawl. Downloads are cancelled and dialogs are
dismissed.

Matching against the forbidden list is a case-insensitive **substring** test on both the
accessible name and the href, so `resetPassword`, `/users/42/deleteConfirm` and
`Deactivate account` are all refused. Over-skipping costs a page; under-skipping costs the
user's data. Every refusal is listed in `crawl.skipped` with the word that matched, and in
the page's own `links` array — the crawl can be audited without re-running it.

**Request bodies are never recorded.** A page can POST credentials or tokens during boot,
so only the method, URL, resource type, status and a `has_post_data` flag are kept.

**SSRF.** http/https only; the host must be public. Private, loopback, link-local, CGNAT,
multicast, reserved and cloud-metadata addresses are refused — the same rule
`backend/app/modules/discovery.py::_assert_public_host` applies to spec URLs — unless
`TRACEO_ALLOW_PRIVATE_TARGETS=1` is set. Both IPv4 and IPv6 are covered, including
IPv4-mapped forms such as `::ffff:127.0.0.1`.

The guard runs **twice**: on the URL before navigation, and on every main-frame navigation
the page attempts, so a public URL cannot redirect the browser onto an internal host.
Blocked attempts are listed in `blocked_navigations` rather than being hidden.

Known limitation: the guard resolves DNS itself and the browser resolves again, so a
determined DNS-rebinding attacker has a window. Treat targets as untrusted content, which
they are regardless.

---

## Signing in

**Nobody has to declare that a page needs a sign-in.** A visible form containing an
`input[type=password]` *is* a login page, and that is decided from the DOM the browser
rendered — the same grounding rule every other fact here obeys. Credentials are an
*override*, not a prerequisite.

### Where the credentials come from, in order of authority

1. **What the user supplied** — `--username` with `--password`, or `$TRACEO_CRAWL_USERNAME`
   with `$TRACEO_CRAWL_PASSWORD`. The env var wins over argv, because argv is readable by
   any process on the host through `ps`; that is how the backend passes them.
2. **What the page publishes about itself.** Demo and sandbox environments routinely print
   their credentials on the login screen. The owner's target renders, as ordinary visible
   text:

   ```
   Username : Admin
   Password : admin123
   ```

   Reading that is not guessing — the value came from the rendered page. Only **leaf**
   elements are read (an ancestor's `textContent` is the concatenation of its children, which
   would happily invent `Password : Admin` out of two unrelated lines), values containing
   whitespace are rejected as prose, and **both** halves must be found or neither is used.
   The lines that were read are kept in `login.credentials_evidence`, with the password
   scrubbed: `"Password : [redacted]"` is enough to audit *where* a credential came from
   without recording *what* it was.
3. **Neither** — the run does **not** fail and does **not** pretend the public surface is the
   whole application. `login.error.code` is `login_required`, the message says that supplying
   credentials would unlock the pages behind it, and the crawl covers what is reachable
   logged out.

`login.credentials_source` is `"user"`, `"page"` or `null`, and `login.message` says which in
plain words. "Signed in using the credentials this page publishes" reads very differently
from "Signed in", and the difference matters to anyone auditing the run.

### Finding the fields

`--username-selector` + `--password-selector` (+ optional `--submit-selector`) override
everything. Otherwise: the **first visible form containing an `input[type=password]`**, whose
username field is the **nearest preceding** text/email/tel/search/url input. A page that emits
no `<form>` at all is handled from `orphan_fields` by the same rule and reports
`detection: "orphan_password_field"` so the weaker signal is visible.

The selectors are taken from the extraction pass, which has already proven each one matches
exactly one element — filling a selector that matched two would be typing a password into
something nobody looked at. The submit control is chosen from the form's own submits after
the forbidden-name filter has run, so a "Reset" button next to "Sign in" is never the one
clicked; when nothing survives, Enter in the password field submits the form without clicking
anything.

### Proving it worked

Three checks, sampled every 250ms up to `--login-wait`. Any **one** is enough, and
`login.strategy` names the one that fired while `login.checks` shows all three:

| `strategy` | Means |
|---|---|
| `url_left_login` | the URL's **origin+path** changed — `?error=1` on the same path is not a sign-in |
| `logout_control` | a logout/sign-out control **appeared** that was not in the DOM before the submit |
| `password_field_gone` | the page had a visible password field before and has none now |

`logout_control` and `password_field_gone` are compared against a probe taken **before** the
submit, because only a *change* proves anything: a login page shipping a hidden "Sign out" in
its shell would otherwise certify itself.

If none fires, the run **fails** with `login_failed` and crawls nothing. The message says the
credentials were rejected and deliberately does **not** say which of the two was wrong — the
same reason `identity.py` returns a generic 401 — and carries neither of them.

### Losing the session mid-crawl

**A page is a login page because of its SHAPE, never because of its URL.** An SPA that signs
in without navigating leaves the URL unchanged, and trusting the URL there would send the
crawl straight back to re-authenticate on a page that is now showing the product. Once a
login page has been seen, its URL only *narrows* the test — so a "change your password" page
behind the sign-in, a real password form on a URL the login was never at, is crawled instead
of being typed into.

A crawled page that lands back on the login page is a lost session, not a dead page. The
crawler re-authenticates in place and re-fetches that page, up to 3 times per run
(`login.reauthenticated`), so a short-lived cookie does not turn half the application into
`navigation_failed`. Past that cap the page is skipped with reason `session_lost`, because a
session that can never be held would otherwise turn the crawl into a login loop.

### Credential handling

The password is never written to stdout, to the JSON, to a screenshot filename, or into an
error message. Screenshots are named after the page **index** (`screen.png`, `page-01.png`),
never after anything the user typed. As a last line of defence, every registered password is
substituted out of the serialised document — stdout and the on-disk copy go through the same
scrubber, since a secret that leaks only to a file is still leaked. Request **bodies** are
never recorded, which is what keeps the login POST itself out of the inventory.

The substitution is anchored to **token edges**, not to raw substrings. `?password=admin123&x`,
`Password : admin123` and a bare value in page text are all caught, while a one-character
password cannot rewrite `unresolvable_host` into `unresolva[redacted]le_host` and quietly
corrupt the transcript the whole feature is grounded on. Matching is case-exact for the same
reason.

The **username** is deliberately not scrubbed. A signed-in application puts the user's name in
its own menus and headings — OrangeHRM's left menu literally contains "Admin" — and blanking
those would corrupt the transcript the whole feature is grounded on. The username is instead
simply never authored into any field this script writes. Honest limit: a target that echoes
the username into its own URLs will have it appear in that page's `requests`.

---

## Crawling

Breadth-first from the post-login landing page (or from `--url` when no sign-in happened),
**same origin only**, unique by URL without the fragment, bounded by `--max-pages` and
`--max-depth`.

* The login page **is a crawled page**, and it is `pages[0]`: it is the URL the operator
  named, it carries the sign-in form, and its screenshot is the only record of the logged-out
  surface. Its record is captured *before* the credentials are typed and is kept rather than
  re-visited — re-visiting it while signed in only redirects to the landing page. It spends
  one of `--max-pages`.
* Its own links are **described but not followed**: they belong to the logged-out product, so
  the frontier restarts from wherever signing in landed. Those links carry
  `reason: "pre_login"` and are left out of `crawl.skipped`, which is reserved for links
  refused for a safety or budget reason. The same rule applies when a sign-in is *needed* and
  no credentials could be had (`login_required`): the way past the page is not available, so
  the public surface is the page itself.
* The login page's `requests` are its own boot traffic plus what the SUBMISSION caused (the
  form post and the navigation it triggers). Everything the landing page then boots belongs to
  the landing page — without that cut the login page was charged for 41 extra requests on the
  owner's target, third-party embeds included.
* Only `<a href>`-style controls are candidates. Nothing is clicked, so every candidate is
  judged as a URL: forbidden name/href, non-http(s) scheme, cross-origin, already seen, past
  `--max-depth`, past `--max-pages`.
* Anything that triggers a **download** is cancelled and skipped with reason `download`.
* The first page failing is the whole run failing — an empty success is indistinguishable
  from a page with nothing on it. Any later page failing is a `crawl.skipped` entry.
* One full-page PNG per page: `screen.png` for page 0, `page-01.png`, `page-02.png`, …

Every decision is recorded twice: per page in `pages[].links` (`decision`,
`reason`, `match`) and per run in `crawl.skipped`.

---

## Wait strategy

Three layers, in order. Each may fail without failing the run; what happened is always
reported in `wait_strategy` and `wait_notes`.

1. `goto(..., waitUntil: 'domcontentloaded')` — so an SPA that never idles still gets read.
2. `waitForLoadState('networkidle')`. If it times out, `wait_strategy` becomes
   `domcontentloaded+settle` and a fixed `--settle` quiet period is used instead.
   Long-pollers, analytics beacons and websockets keep some pages busy for ever; that is
   not a reason to fail. *(Verified: a page polling every 250ms yields
   `domcontentloaded+settle`, still extracts its form, and captures all 23 polls.)*
3. **Hydration gate** — wait for the first `form, input, select, textarea, button, a[href]`
   to exist. This is the layer that makes SPAs work. Timing out here is recorded in
   `wait_notes`, not fatal: a genuinely control-free page is a legal result.

Then `document.fonts.ready` and a 250ms layout settle, because a font swapping in after
the capture changes every colour and box in the design facts.

Animation is disabled before the first frame via an init script
(`animation-duration:0s; transition-duration:0s; caret-color:transparent`), plus
`reducedMotion: 'reduce'` and `animations: 'disabled'` on the capture. A mid-transition
screenshot would put colours in the palette that the design never had.

---

## The screenshot

`<out>/screen.png` for page 0, then `<out>/page-01.png`, `<out>/page-02.png`, … — one
full-page capture per crawled page, at the requested viewport, `deviceScaleFactor: 1`. The
files are named after the page **index** so that nothing a user typed can reach a filename.

It is clipped to `--max-height` (default 4000px) and `screenshot_clipped` says so. The
consumer is `backend/app/modules/imageio.py`, a pure-Python PNG decoder: a 30000px-tall
Wikipedia capture is valid PNG but costs ~20s to decode and well over a minute to turn into
design facts, and the facts that matter are above the fold. Clipping uses
`fullPage: true` + `clip`, which crops the full-page raster — the viewport is never
resized, so the page's media queries never re-run and the layout being described is the
layout that was measured.

Verified end to end on the OrangeHRM login capture: `imageio.read_png` decodes the output,
`design.design_facts` produces **42 facts** (palette, surface, element, alignment, spacing,
contrast), and `design.ui_cases` turns those into **77 UI cases**, each carrying the fact id
it came from (`steps[0].fact`, e.g. `surface:#FFFFFF`). The `ui` track works against this
output as-is.

---

## Output shape

`<out>/discovery.json` holds a copy of the same document, beside the screenshot it
describes, so a generated case stays auditable months later.

```jsonc
{
  "ok": true,
  "schema_version": 1,
  "url": "https://…/auth/login",        // as requested
  "final_url": "https://…/auth/login",  // after redirects
  "redirected": false,
  "http_status": 200,
  "title": "OrangeHRM",
  "viewport": { "width": 1280, "height": 800, "device_scale_factor": 1 },
  "elapsed_ms": 3999,                   // performance track's observed baseline
  "screenshot": "/abs/path/screen.png",
  "screenshot_width": 1280, "screenshot_height": 800,
  "screenshot_bytes": 60488, "screenshot_clipped": false,
  "wait_strategy": "networkidle",       // or "domcontentloaded+settle"
  "wait_notes": [],
  "headings": [ { "level": 5, "text": "Login" } ],
  "lang": null, "dir": null, "description": null,

  "forms": [{
    "index": 0,
    "selector": "#app > div … > form",  // verified unique
    "name": null, "id": null,
    "action": "https://…/auth/validate", // absolute, or null
    "method": "POST",
    "novalidate": true,
    "heading": "Login",                  // nearest preceding heading, no form between
    "visible": true,
    "field_count": 3,
    "required_fields": ["username"],     // name, or selector when unnamed
    "fields": [{
      // the nine the contract names:
      "selector": "input[name=\"username\"]",
      "name": "username", "id": null, "type": "text",
      "required": false, "placeholder": "Username", "label": "Username",
      "maxlength": null, "pattern": null,
      // read straight off the element, all nullable:
      "tag": "input", "minlength": null, "min": null, "max": null, "step": null,
      "autocomplete": null, "inputmode": null,
      "disabled": false, "readonly": false, "multiple": false,
      "visible": true, "box": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "options": null                    // [{value,label}] for <select>, else null
    }],
    "submits": [{ "selector": "…> button", "name": "Login", "type": "submit" }]
  }],

  "orphan_fields": [ /* same field shape; inputs belonging to NO <form> */ ],

  "controls": [{
    "selector": "#danger",
    "role": "button",                    // explicit role, else derived from the tag
    "name": "Delete everything",         // ACCESSIBLE name; null = genuinely unnamed
    "href": "https://…",                 // absolute, null for non-links
    "tag": "button", "type": null, "disabled": false, "visible": true,
    "form": "#signup",                   // owning form selector, or null
    "box": { "x": 0, "y": 0, "w": 0, "h": 0 }
  }],

  "requests": [{
    "method": "GET",
    "url": "https://…/core/i18n/messages", // absolute
    "resource_type": "xhr",                // xhr|fetch|document|script|stylesheet|image|font|…
    "status": 200, "status_text": "OK", "ok": true,
    "failure": null,                       // error text when the request failed
    "host": "…", "scheme": "https",
    "path": "/web/index.php/core/i18n/messages",  // pre-templating; see below
    "query_keys": [],
    "is_navigation": false, "main_frame": true,
    "has_post_data": false, "content_type": null,   // bodies are NEVER captured
    "started_ms": 812, "duration_ms": 96,
    "from_cache": false,
    "redirected_from": null                // previous URL in a redirect chain
  }],
  "requests_truncated": false,

  "console_errors": [{ "type": "error", "text": "…", "url": "…", "line": 42 }],
  "blocked_navigations": [],               // SSRF guard hits, if any

  "counts": { "forms": 1, "fields": 3, "orphan_fields": 0,
              "controls": 6, "requests": 13, "xhr": 1, "console_errors": 0 },
  "page": { "element_count": 0, "html_bytes": 0, "document_height": 800 },

  // --- null when no sign-in was ever involved -------------------------------
  "login": {
    "attempted": true, "succeeded": true,
    "final_url": "https://…/dashboard/index",
    "strategy": "url_left_login",          // which proof fired
    "error": null,                         // {code, reason, message} otherwise
    "credentials_source": "page",          // "user" | "page" | null
    "credentials_evidence": ["Username : Admin", "Password : [redacted]"],
    "login_url": "https://…/auth/login",
    "detection": "first_password_form",    // explicit_selectors | orphan_password_field
    "checks": { "url_left_login": true, "logout_control": false,
                "password_field_gone": true },
    "login_form_submissions": 1,           // no other form is ever submitted
    "reauthenticated": 0,
    "message": "Signed in using the credentials this page publishes."
  },

  // --- every page crawled; pages[0] mirrors the top-level fields above -------
  "pages": [{
    "index": 0, "depth": 0,
    "url": "https://…/dashboard/index",    // as requested by the crawl
    "final_url": "https://…/dashboard/index",
    "redirected": false, "status": 200,
    "title": "OrangeHRM", "elapsed_ms": 4751,
    "screenshot": "/abs/path/screen.png",  // page-01.png, page-02.png, … after that
    "screenshot_width": 1280, "screenshot_height": 800,
    "screenshot_bytes": 60488, "screenshot_clipped": false,
    "wait_strategy": "networkidle", "wait_notes": [],
    "headings": [], "lang": null, "dir": null, "description": null,
    "forms": [], "orphan_fields": [], "controls": [],
    "links": [{ "url": "https://…/auth/logout", "name": "Logout",
                "selector": "…", "same_origin": true,
                "decision": "skipped",     // queued | duplicate | skipped
                "reason": "forbidden_control", "match": "logout" }],
    "requests": [], "requests_truncated": false, "console_errors": [],
    "counts": { }, "page": { }
  }],

  "crawl": {
    "requested_max_pages": 25, "max_depth": 2,
    "visited": 22,
    "skipped": [{ "url": "https://…/auth/logout", "reason": "forbidden_control",
                  "match": "logout" }],
    "origin": "https://opensource-demo.orangehrmlive.com",
    "entry_url": "https://…/dashboard/index",
    "credentials_source": "page",
    "summary": "Signed in using the credentials this page publishes, then crawled 22 pages (3 links skipped)."
  },

  "engine": { "tool": "traceo/web-discovery", "playwright_version": "1.62.1",
              "playwright_from": "…", "node_version": "v24.18.0",
              "finished_at": "2026-08-12T…Z", "total_elapsed_ms": 78210 }
}
```

`crawl.skipped[].reason` is one of `forbidden_control`, `cross_origin`, `non_http_scheme`,
`invalid_url`, `max_depth`, `max_pages`, `download`, `session_lost`, or the failure code of a
page that could not be loaded (`navigation_failed`, `navigation_timeout`, `http_error`,
`ssrf_blocked`, `extraction_failed`, `screenshot_failed`).

**`pages[0]` IS the top-level page.** Every key that existed before this script grew a crawler
still means exactly what it meant: it describes the first page crawled. Two consequences worth
stating plainly:

- Top-level `requests`, `console_errors` and `counts` are **page 0's**, not the run's. A
  consumer that wants the whole crawl concatenates `pages[].requests` and deduplicates.
- Top-level `elapsed_ms` is page 0's own load-and-settle time (the performance track's
  baseline). The wall time of the whole run is `engine.total_elapsed_ms`.
- With a sign-in, top-level `url` is still the URL that was *requested* while `final_url` is
  the post-login landing page, so `redirected` is `true`.

### Notes for the backend

- **`path` is raw, not templated.** Concrete ids are left in place; templating is the
  importer's job, so run it through `collections.template_segment` exactly as HAR does
  (`template_ids=True`) and endpoints stay consistent with every other import. Endpoint
  rows from this source are `source="dom"`, which ranks below `spec` and `traffic` in
  `discovery.FIDELITY` — a web-target run must never overwrite spec-derived endpoints.
- **Filter before you persist.** `requests` is the complete inventory including fonts,
  images and stylesheets. The `api` track wants `resource_type in ("xhr", "fetch")`;
  `counts.xhr` is pre-computed.
- **`orphan_fields` is not a form.** Plenty of SPAs never emit a `<form>` element. These
  fields are reported so no selector is lost, but they are deliberately excluded from
  `forms` and from `counts.forms`, and the contract's "a Requirement per discovered FORM"
  means `forms` only.
- **`null` means absent, not unknown.** A control with `"name": null` has no accessible
  name — that is a real a11y finding, not missing data.
- **Selectors are verified unique** at extraction time (`querySelectorAll(...).length === 1`),
  preferring `#id`, then `[data-testid]`, then `tag[name=…]`, then a structural
  `:nth-of-type` path. Functional cases can quote them verbatim.
- **Labels are never invented.** `label` comes from `label[for]`, a wrapping `<label>`,
  `aria-label`/`aria-labelledby`, or a component-library label in an ancestor that owns
  this field alone. `placeholder` is reported separately and never promoted to a label.
  Hidden inputs always get `"label": null` — guessing is how a CSRF token ends up
  documented as "Username".

---

## Observed results

Run from this tree; local fixtures need `TRACEO_ALLOW_PRIVATE_TARGETS=1`.

| Target | Result |
|---|---|
| OrangeHRM login (Vue SPA) | exit 0 · **1 form, 3 fields, 6 controls, 13 requests, 1 xhr**, 0 console errors · `wait_strategy: networkidle` · ~4.0s · form action `POST /web/index.php/auth/validate`, heading "Login", fields `_token`(hidden) / `username` / `password` with labels resolved · screenshot → 42 design facts |
| **OrangeHRM, NO credentials given at all, `--max-pages 12 --max-depth 2`** | exit 0 · read `Username : Admin` / `Password : …` off the login screen and signed in · `credentials_source: "page"`, `credentials_evidence: ["Username : Admin", "Password : [redacted]"]`, `strategy: url_left_login`, `login_form_submissions: 1` · **12 pages** — dashboard, admin, pim, leave, time, recruitment, my-details, performance, directory, maintenance, claim, buzz · **12 forms, 42 fields, 576 controls, 300 requests, 78 xhr** · 13 links skipped (`cross_origin`, `max_pages`) · 12 PNGs, 3.8 MB · 51.5s · **0 occurrences of the password** in stdout or `discovery.json` |
| **OrangeHRM, `--username Admin` + `$TRACEO_CRAWL_PASSWORD`, same budget** | exit 0 · the identical 12 pages, `credentials_source: "user"` |
| **OrangeHRM, no flags at all** (`--max-pages` defaults to 25) | exit 0 · **22 pages** — the 12 modules plus 10 employee sub-tabs · 16 forms, 56 fields, 1006 controls, 139 xhr · 3 skipped (all `cross_origin`) · 76.5s |
| Loopback fixture: client-rendered login, session cookie, 3 linked pages each with a form, a `Logout` link, a `Delete account` link, a `Reset password` link, a CSV download, a `mailto:` and an external link | exit 0 · **4 pages** (`/app/home`, `/app/alpha`, `/app/beta`, `/app/gamma`) · the server's own request log records **1 POST in the whole run**, to `/login`; **0** POSTs to any other form action; **0** fetches of `/app/logout`, `/app/delete/7` or `/app/reset-password`; **0** behind-login GETs without the session cookie · skipped: `forbidden_control`×3 (matching `logout`, `delete`, `reset`), `non_http_scheme` (`mailto:`), `cross_origin`, `download` (the CSV) |
| Same fixture, wrong password | exit 1 · `login_failed`, `reason: proof_not_observed`, `login_form_submissions: 1`, 0 pages · message names neither credential and the password appears 0 times · the server logs that one POST and nothing else |
| Same fixture, login page publishing nothing, no credentials | exit 0 · `login.error.code: login_required`, `attempted: false`, public surface crawled (1 page) · the server received **0** POSTs |
| Same fixture, password set to `Alpha` — a word every page prints as link text | exit 0 · **0** raw `Alpha` survive, **9** `[redacted]` markers appear, page 0's link names read `[redacted] \| Beta \| Gamma \| …`; the same crawl under a different password leaves all **5** intact and `/app/alpha` in the URLs is untouched in both. The scrubber is token-anchored and case-exact, and is demonstrably capable of failing |
| `--max-pages 0`, `--max-pages 51`, `--max-pages 2.5` | exit 2 · `invalid_arguments`, "must be an integer between 1 and 50" |
| `--max-depth -1` | exit 2 · `invalid_arguments`, "must be an integer between 0 and 10" |
| `--password` without `--username`; `--username-selector` without `--password-selector`; `--login-url` on another origin | exit 2 · `invalid_arguments` for each |
| Static multi-form page | exit 0 · 2 forms, 5 fields, 5 controls · `required_fields: ["email","pw"]`, `maxlength: 120`, `pattern: ^\S{8,}$`, select options captured · second form correctly gets `heading: null` rather than inheriting the first form's `<h1>` |
| 302 → `/landed` | exit 0 · `redirected: true`, `final_url` is the landing page, both hops in `requests` with `redirected_from` set |
| 404 | exit 1 · `http_error`, `http_status: 404` |
| Long-poller (never idles) | exit 0 · `wait_strategy: domcontentloaded+settle`, form still extracted, 23 poll XHRs captured |
| `--timeout 150` | exit 1 · `navigation_timeout` |
| Wikipedia (29954px doc) | exit 0 · clipped to 4000px, `screenshot_clipped: true`, `controls` capped at 800 |
| `file:///etc/passwd` | exit 2 · `invalid_url` |
| `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0` | exit 1 · `ssrf_blocked` (`loopback`, `private`, `private`, `cloud-metadata`, `carrier-nat`, `unspecified`) |
| `[::1]`, `[fd00::1]`, `[fe80::1]`, `[ff02::1]`, `[::ffff:127.0.0.1]` | exit 1 · `ssrf_blocked` (`loopback`, `unique-local`, `link-local`, `multicast`, `loopback`) |
| `[2606:4700:4700::1111]` | guard passes — public IPv6 is not blocked |
| Playwright absent | exit 3 · `browser_discovery_unavailable` naming the install command |

---

## Limitations

- Only the **main frame's** DOM is extracted. Requests from sub-frames are still captured
  and flagged with `main_frame: false`.
- Elements inside **closed shadow roots** are not visible to `querySelectorAll` and are not
  reported.
- The crawl follows **links only**. A page reachable only by clicking a button, submitting a
  filter or opening a JS-driven menu is not discovered, because reaching it would mean
  activating a control — which the safety rule forbids for good reason.
- **Same origin only.** An application split across two hostnames is described as one of them.
- Credentials read off the page are only as trustworthy as the page. A staging site that
  publishes real credentials publishes them to this crawler too; that is a property of the
  site, not of the tool.
- A **hidden** logout control cannot be seen: OrangeHRM renders its logout link only after the
  user menu is opened, which is why `login.checks.logout_control` is `false` there and the
  URL/password proofs carry the run.
- Re-authentication is capped at 3 per run. An application that expires its session faster
  than a page takes to load will report `session_lost` skips rather than loop. It also means
  the login form can be submitted **more than once in a run**; in a run where the session
  holds, `login_form_submissions` is exactly 1 and `reauthenticated` is 0.
- **Breadth-first with a page budget describes breadth, not depth.** With `--max-pages 12` on
  OrangeHRM the twelve module landing pages are reached and the employee's ten sub-tabs are
  listed in `crawl.skipped` with reason `max_pages`. What was left out is always stated, never
  silently dropped.
- The accessible-name computation is a good approximation of the spec algorithm, not a
  conformant implementation.
