# Stage 1 — ShopDesk answer key (21 planted defects)

Scoring: a defect counts as FOUND when a Traceo artefact (web-target case, generated
API case, executed result, insight or security finding) names the same element/endpoint
AND states the same wrong behaviour. Naming the endpoint alone is a MISS.

## UI (7)
| id | where | defect |
|----|-------|--------|
| U1 | `/` login | `id="email"` is used twice — on the banner div and on the email input |
| U2 | `/` login | password input has no label, no aria-label; placeholder only |
| U3 | `/` login | primary "Sign in" button #b9c0c8 on #cdd3d9 — 1.19:1 contrast (WCAG needs 4.5:1) |
| U4 | `/` login | `<img src="/static/logo.svg">` has no alt attribute |
| U5 | `/`, `/orders` | `<html>` has no `lang` attribute |
| U6 | `/` login | email field is `type="text"`, no `pattern`, no `required` |
| U7 | `/` login | banner dismiss button is a 12x12 px hit target (min 24x24) |

## Functional (6)
| id | where | defect |
|----|-------|--------|
| F1 | login | an empty password authenticates whenever the email exists |
| F2 | login | `notanemail` is submitted unvalidated; no field-level error is shown |
| F3 | `/orders` create | quantity accepts 0 and negatives — no `min` attribute, no server check |
| F4 | `/orders` create | submit button is never disabled; a double click creates two orders |
| F5 | `/orders` | raw server text (`sqlite3.IntegrityError`, `TypeError` + file path) is rendered in the page |
| F6 | `/orders` | no `Cache-Control`; the page is restorable from bfcache after sign-out |

## API (8)
| id | endpoint | defect |
|----|----------|--------|
| A1 | POST /api/auth/login | invalid credentials answer **HTTP 200** with `{"ok":false}` — spec says 401 |
| A2 | GET /api/users/{id} | no auth, no ownership check — IDOR onto any profile |
| A3 | POST /api/orders | a missing required field answers **500** with a traceback — spec says 422 |
| A4 | POST /api/orders | `quantity: -5` is accepted and yields a negative total — spec says minimum 1 |
| A5 | GET /api/orders | `limit` is unbounded (spec max 100); `limit=abc` answers **500** |
| A6 | POST /api/auth/login, GET /api/users/{id}, GET /api/me | the response body carries `password` / `password_hash` |
| A7 | all | `Access-Control-Allow-Origin: *` together with `Allow-Credentials: true`; no CSP, no X-Content-Type-Options, no X-Frame-Options; `Server` header leaks versions |
| A8 | DELETE /api/orders/{id} | no auth, and a non-existent id answers **200 deleted** — spec says 401/404/204 |

## Contract drift also present
- POST /api/orders answers 200, never 201, and sets no `Location` header.
- GET /api/orders requires no token although the spec marks it `bearerAuth`.
