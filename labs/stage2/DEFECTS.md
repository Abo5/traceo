# Stage 2 — MedLedger answer key (12 API + 8 UI planted defects)

None of these is a missing status code or a missing header. Each needs the tester to
reason about state, ordering, encoding, time or arithmetic.

## API / logic
| id | endpoint | defect |
|----|----------|--------|
| D1 | GET /api/appointments | offset = `page * limit` instead of `(page-1) * limit` — page 1 silently skips the first `limit` rows |
| D2 | POST /api/appointments | `Idempotency-Key` is read and echoed but never deduplicates; a replay books twice |
| D3 | POST /api/appointments | `created_at` is a naive LOCAL clock reading stamped with `Z` |
| D4 | POST /api/auth/session | email match is byte-exact — `Ali@…` and `ali@…` become two patients; NFD never matches NFC |
| D5 | POST /api/appointments | `total = fee * qty` in binary float — 0.1x3 returns 0.30000000000000004 |
| D6 | GET /api/appointments?sort=id | id is cast to TEXT before ordering, so "10" sorts before "9" |
| D7 | every authenticated route | the token's `exp` claim is parsed and never compared to the clock — an expired token works forever |
| D8 | PATCH /api/appointments/{id} | an unknown field is dropped in silence and the call reports success |
| D8b | PUT /api/appointments/{id} | a partial body blanks every field it omits |
| D9 | POST /api/appointments | `notes` is truncated to 255 on write and the response echoes the FULL input — the client is told a lie |
| D10 | POST /api/appointments | slot `capacity` is read and never enforced; two bookings for one slot both succeed |
| D11 | all | `X-RateLimit-Remaining` is advertised on every response and never decrements or enforces |
| D12 | GET /api/appointments/{id} | 403 for a row that exists but is not yours vs 404 for one that does not — an enumeration oracle |

## UI
| id | where | defect |
|----|-------|--------|
| D-UI1 | `.hint` | #767676 on #FFFFFF is 4.42:1 — just under the 4.5:1 rule |
| D-UI2 | clinician menu | `aria-expanded` is written once and never updated when the menu opens |
| D-UI4 | fee input | `tabindex="1"` drags the control to the front of the tab order |
| D-UI5 | booking status | the outcome is shown visually with no live region to announce it |
| D-UI6 | slot label | `for="slot_select"` names an id that does not exist (the select is `#slotId`) |
| D-UI7 | email + slot labels | marked required with a visual `*` only — no `required`, no `aria-required` |
| D-UI8 | appointments table | no `<caption>`, no `scope` on the header cells |
| D-UI9 | notes textarea | advertises `maxlength="5000"` while the store keeps 255 |
