# MedLedger — Software Requirements (v2.0)

## 1. Sessions
**REQ-SES-01** Email identity is case-insensitive and Unicode-normalised to NFC before
lookup. `Ali@medledger.test` and `ali@medledger.test` are the same patient, and a name
written in NFD must match its NFC twin.
**REQ-SES-02** A session token carries an `exp` claim. Every authenticated endpoint must
compare `exp` against the current time and answer HTTP 401 once it has passed.

## 2. Listing
**REQ-LST-01** `page` is 1-based. `page=1` must return the FIRST record; it must never
skip a page of data.
**REQ-LST-02** `sort=id` orders numerically. Appointment 9 must come before appointment 10.
**REQ-LST-03** The `total` field must equal the number of records the caller can reach by
paging, so `page`, `limit` and `total` are consistent with each other.

## 3. Booking
**REQ-BKG-01** `Idempotency-Key` makes a booking exactly-once. Replaying a request with a
key already seen must return the ORIGINAL appointment and must not create a second row.
**REQ-BKG-02** A slot may not be booked beyond its `capacity`. The over-booking attempt
must be refused with HTTP 409.
**REQ-BKG-03** `total` is `fee x qty` rounded to two decimals, the minor unit of SAR. A
binary-floating-point artefact such as 0.30000000000000004 is a defect.
**REQ-BKG-04** `created_at` is a true UTC instant. A local clock reading with a `Z`
suffix is a defect.
**REQ-BKG-05** `notes` is limited to 255 characters. A longer value must be refused with
HTTP 422. The platform must never store a truncated value and echo back the full input.

## 4. Updating
**REQ-UPD-01** PATCH is a partial update over a closed set of fields. An unknown or
misspelled field must be refused with HTTP 422, never dropped in silence.
**REQ-UPD-02** PUT is a full replace. Every required field must be present or the request
is refused with HTTP 422; PUT must never blank a field by omission.

## 5. Authorisation and disclosure
**REQ-AZ-01** Reading an appointment that belongs to another patient and reading one that
does not exist must be indistinguishable — both answer HTTP 404. A 403 on the first tells
an attacker the record exists.
**REQ-AZ-02** A rate limit that is advertised must be enforced. If `X-RateLimit-Remaining`
is published, it must decrement per request and the API must answer HTTP 429 at zero.

## 6. Interface and accessibility
**REQ-UI-01** A label's `for` attribute must name an element that exists on the page.
**REQ-UI-02** Body text must meet WCAG 2.1 AA contrast of 4.5:1 against its background.
**REQ-UI-03** A control that opens a menu must keep `aria-expanded` in step with the
menu's real state.
**REQ-UI-04** Tab order follows document order. No element may carry a positive `tabindex`.
**REQ-UI-05** A field that is required must be marked programmatically with `required` or
`aria-required`, not with a visual asterisk alone.
**REQ-UI-06** A status message produced by an action must be announced to assistive
technology through a live region.
**REQ-UI-07** A data table must carry a caption and `scope` on its header cells.
**REQ-UI-08** A field's advertised `maxlength` must equal what the store actually keeps.
