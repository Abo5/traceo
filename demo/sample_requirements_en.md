# Statement of Requirements

### Authentication

REQ-001: The customer shall be able to sign in with a phone number and a password through POST /auth/login.
- Valid credentials return 200 together with an access_token valid for the session.
- A wrong phone number or password returns 401 without disclosing which one was wrong.
- login is the only operation that does not require prior authentication.

REQ-002: The phone number shall start with 05 and consist of exactly 10 digits.
- The pattern ^05[0-9]{8}$ applies to the phone field when creating a customer through POST /customers and when signing in.
- A 9-digit or 11-digit number is rejected with 422 (invalid phone rejected).
- 0512345678 is an example of an accepted phone number.

REQ-003: The customer email address shall be well formed.
- The email field on customers creation is validated against the email format.
- Any address that does not match the format is rejected with 422.

REQ-004: The customer age shall be between 18 and 120.
- An age below 18 is rejected with 422 when creating the customer (customers age minimum).
- An age above 120 is rejected with 422 (age maximum).
- Both 18 and 120 are accepted because the bounds are inclusive.

### Orders

REQ-005: A new order shall contain at least one item when created through POST /orders.
- An empty items list is rejected with 422 and the error code empty_items.
- Every item carries the item code sku and the quantity qty.

REQ-006: The order total shall be greater than zero when creating the order through orders.
- Zero or any negative value is rejected with 422 (invalid total).
- Any positive value such as 149.50 is accepted.

REQ-007: An order shall be cancellable only before dispatch, through POST /orders/{id}/cancel.
- An order in state pending or confirmed is cancelled successfully and returns 200.
- A dispatched or delivered order cannot be cancelled and returns 409 (not cancellable).
- An order that does not exist returns 404.

REQ-008: The order list GET /orders shall support filtering by order status.
- The allowed values are: pending, confirmed, dispatched, delivered, cancelled.
- Any other, unknown status is rejected with 422 (invalid status).

REQ-009: Pagination of the orders list shall start at 1 through the page parameter.
- A page value of 0 or any negative value is rejected with 422 (invalid page).
- The response includes both the items and the page fields.

### Invoices

REQ-010: The invoice returned by GET /invoices/{id} shall preserve the customer name exactly as stored, whatever script it uses.
- The customer_name field is returned as UTF-8 with no character loss or substitution.
- The encoding field reports utf-8 for every invoice.
- An invoice that does not exist returns 404.

REQ-011: An authorised member of staff shall be able to fetch a customer by id through GET /customers/{id}.
- A known id returns 200 with the complete customer record (id, name, phone, email, age).
- An unknown id returns 404 (customer not found).

REQ-012: Bearer authentication shall be mandatory on every operation except sign-in at /auth/login.
- The customers, orders and invoices operations are all protected and require an Authorization header.
- The access token issued by login is used on every subsequent request.

### Annex

REQ-013: The system shall respond to any API request within 2 seconds under normal load.
- The 95th percentile response time for the customers and orders endpoints must not exceed 2000 ms.
- Response time is measured at the API gateway, excluding client network latency.

REQ-014: The system shall reject any unauthenticated request with HTTP 401.
- A request without a Bearer token to customers, orders or invoices returns 401 (unauthenticated).
- The 401 response body includes a machine-readable error code.
