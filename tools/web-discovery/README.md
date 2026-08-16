# Traceo web-discovery sidecar

`discover.mjs` renders a URL in a real browser and prints one JSON document describing
everything the page actually is: its forms and fields, its buttons and links, every network
request it made, and a PNG screenshot on disk.

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
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | *required* | http/https target |
| `--out` | *required* | directory for `screen.png` and `discovery.json` (created if absent) |
| `--viewport` | `1280x800` | `WIDTHxHEIGHT`; `deviceScaleFactor` is always 1 |
| `--timeout` | `30000` | ceiling for the initial navigation, ms |
| `--idle-timeout` | `15000` | how long to wait for network idle before falling back |
| `--settle` | `2500` | quiet period used when idle is never reached |
| `--hydrate` | `5000` | wait for the first form/input/button/link to render |
| `--full-page` | `true` | `--full-page 0` captures the viewport only |
| `--max-height` | `4000` | full-page captures are clipped to this height (see below) |
| `--max-requests` | `500` | request-inventory cap; sets `requests_truncated` |

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
`internal_error`.

The backend job maps exit 3 / `browser_discovery_unavailable` straight through to its own
`browser_discovery_unavailable` failure. It must never turn a failed run into an empty
success — a silent zero-result import is indistinguishable from a page with nothing on it,
and that is exactly the confusion this tool exists to remove.

---

## Safety

This script is **read-only against the target**. It navigates, waits, reads the DOM and
screenshots. It never submits a form, never clicks a control, never types, never follows a
link. The only traffic the target sees is the traffic its own page load generates.
Downloads are cancelled and dialogs are dismissed.

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

`<out>/screen.png`, full-page, at the requested viewport, `deviceScaleFactor: 1`.

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
  "engine": { "tool": "traceo/web-discovery", "playwright_version": "1.62.1",
              "playwright_from": "…", "node_version": "v24.18.0",
              "finished_at": "2026-08-12T…Z" }
}
```

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
- One page, no crawling. Discovery does not follow links — that would mean navigating an
  application while logged out and is a separate decision.
- The accessible-name computation is a good approximation of the spec algorithm, not a
  conformant implementation.
