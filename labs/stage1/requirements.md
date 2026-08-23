# ShopDesk — Software Requirements (v1.4)

## 1. Authentication

**REQ-AUTH-01** A sign-in request with an unknown email or a wrong password must be
answered with HTTP 401 and a generic message. The response must not say which of the
two was wrong.

**REQ-AUTH-02** A password is mandatory. A sign-in request whose password is absent,
empty or shorter than 8 characters must be refused with HTTP 422 and must never
issue a token.

**REQ-AUTH-03** No response of any endpoint may contain a password, a password hash
or any other credential field.

**REQ-AUTH-04** The email field must be validated before submission. A value that is
not a valid email address must produce a visible field-level error and must not reach
the server.

## 2. Orders

**REQ-ORD-01** Creating an order requires a valid bearer token. Without one the API
must answer HTTP 401.

**REQ-ORD-02** A successful order creation must answer HTTP 201 and carry a Location
header naming the new order.

**REQ-ORD-03** Quantity is an integer between 1 and 999 inclusive. A quantity of 0,
a negative quantity or a non-integer must be refused with HTTP 422.

**REQ-ORD-04** A create request missing any required field must be refused with HTTP
422 and a short message. The platform must never answer 5xx for a malformed request.

**REQ-ORD-05** No error response may expose an internal detail — no stack trace, no
source file path, no database driver text, no server version.

**REQ-ORD-06** The create button must be disabled from the moment it is pressed until
the request settles, so one intent creates exactly one order.

## 3. Listing

**REQ-LIST-01** `limit` accepts an integer between 1 and 100. A larger value, a
negative value or a non-integer must be refused with HTTP 422.

**REQ-LIST-02** Listing orders requires a valid bearer token; without one the API must
answer HTTP 401.

## 4. Authorisation

**REQ-AUTHZ-01** A user may read only their own profile. Reading another user's
profile must be refused with HTTP 403.

**REQ-AUTHZ-02** Deleting an order requires a valid bearer token. Deleting an order
that does not exist must answer HTTP 404. A successful delete answers HTTP 204.

## 5. Interface and accessibility

**REQ-UI-01** Every input control must have a programmatically associated label. A
placeholder is not a label.

**REQ-UI-02** Text and its background must meet WCAG 2.1 AA contrast — 4.5:1 for body
text, 3:1 for large text and for the boundary of an interactive control.

**REQ-UI-03** Every id in the document must be unique.

**REQ-UI-04** Every image must carry an alt attribute; a decorative image carries an
empty one.

**REQ-UI-05** The root html element must declare its language.

**REQ-UI-06** An interactive target must be at least 24x24 CSS pixels.

## 6. Transport and headers

**REQ-SEC-01** `Access-Control-Allow-Origin: *` must never be sent together with
`Access-Control-Allow-Credentials: true`.

**REQ-SEC-02** Every response must carry `X-Content-Type-Options: nosniff` and
`X-Frame-Options: DENY`, and must not disclose the server product or version.

**REQ-SEC-03** A page that shows account data must send `Cache-Control: no-store` so
it is not restorable after sign-out.
