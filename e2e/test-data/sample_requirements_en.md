# Orders Platform — Requirements Specification

### Authentication

REQ-001: The customer shall be able to log in with a mobile number and a password through the POST /auth/login endpoint.
- Valid credentials must return 200 with a session access_token.
- Wrong mobile number or password must return 401 without disclosing which field was wrong.
- The login endpoint is the only one that does not require prior authentication.

REQ-002: The mobile number shall start with 05 and be exactly 10 digits long.
- The pattern ^05[0-9]{8}$ applies to the phone field when creating a customer via POST /customers and when logging in.
- A 9-digit or 11-digit number must be rejected with 422 (invalid phone rejected).
- The number 0512345678 is an example of an accepted value.

REQ-003: The customer email address shall be a well-formed address.
- The email field of customer creation is validated against the email format.
- An address that does not match the format must be rejected with 422.

REQ-004: The customer age shall be between 18 and 120 years.
- An age below 18 must be rejected with 422 when creating a customer (customers age minimum).
- An age above 120 must be rejected with 422 (age maximum).
- The values 18 and 120 are accepted because the bounds are inclusive.

### Orders

REQ-005: A new order shall contain at least one item when created via POST /orders.
- An empty items list must be rejected with 422 and the error code empty_items.
- Every item carries an sku and a qty.

REQ-006: The order total shall be greater than zero when an order is created.
- Zero or any negative total must be rejected with 422 (invalid total).
- Any positive value such as 149.50 is accepted.

REQ-007: An order shall be cancellable before dispatch only, via POST /orders/{id}/cancel.
- An order in state pending or confirmed is cancelled successfully and returns 200.
- A dispatched or delivered order must be refused with 409 (not cancellable).
- An unknown order returns 404.

REQ-008: The orders list GET /orders shall support filtering by order status.
- The allowed states are pending, confirmed, dispatched, delivered, cancelled.
- Any other unknown status must be rejected with 422 (invalid status).

REQ-009: Pagination of the orders list shall start at page 1 through the page parameter.
- The value 0 or any negative page must be rejected with 422 (invalid page).
- The response includes both an items array and a page number.

### Invoices

REQ-010: An invoice retrieved through GET /invoices/{id} shall return the customer name intact in UTF-8.
- The customer_name field is returned without corrupting any character, including non-ASCII names.
- The rendered_direction field is returned as ltr for every invoice.
- An unknown invoice returns 404.

REQ-011: An authorised employee shall be able to fetch a customer by id via GET /customers/{id}.
- A known id returns 200 with the full customer record (id, name, phone, email, age).
- An unknown id returns 404 (customer not found).

REQ-012: Bearer authentication shall be mandatory on every endpoint except the login endpoint /auth/login.
- The customers, orders and invoices endpoints are all protected and require an Authorization header.
- The access token issued by login is used on every subsequent request.

### Non-functional

REQ-013: The system shall respond to any API request within 2 seconds under normal load.
- The 95th percentile response time for the customers and orders endpoints must not exceed 2000 ms.
- Response time is measured at the API gateway, excluding client network latency.

REQ-014: The system shall reject any unauthenticated request with HTTP 401.
- A request without a Bearer token to customers, orders or invoices returns 401 (unauthenticated).
- The 401 response body includes a machine-readable error code.
