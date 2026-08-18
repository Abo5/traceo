"""Orders Platform — Demo System Under Test for Traceo.

A self-contained e-commerce orders platform mounted under /api/v2.
Run from demo/sut:  uvicorn main:app --port 9000

INTENTIONAL BUGS (for demo bug-discovery):
  1. POST /api/v2/customers accepts 11-digit phone numbers starting with 05
     (spec says exactly 10 digits: ^05[0-9]{8}$) — returns 201 instead of 422.
  2. POST /api/v2/orders/{id}/cancel succeeds (200) for orders in state
     'dispatched' — spec says dispatched orders must return 409.
"""
import re
import uuid

from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Orders Platform (Demo SUT)", version="2.0.0")

DEMO_PHONE = "0512345678"
DEMO_PASSWORD = "demo"
ORDER_STATUSES = {"pending", "confirmed", "dispatched", "delivered", "cancelled"}

# ---------------------------------------------------------------- seed data
CUSTOMERS: dict[str, dict] = {
    "CUST-001": {"id": "CUST-001", "name": "Alice Hartley", "phone": "0512345678",
                 "email": "alice@example.com", "age": 34},
    "CUST-002": {"id": "CUST-002", "name": "Bruno Oliveira", "phone": "0559876543",
                 "email": "bruno@example.com", "age": 27},
    "CUST-003": {"id": "CUST-003", "name": "José Ångström", "phone": "0533334444",
                 "email": "jose@example.com", "age": 45},
}

ORDERS: dict[str, dict] = {
    "ORD-1001": {"id": "ORD-1001", "customer_id": "CUST-001", "status": "pending",
                 "items": [{"sku": "SKU-11", "qty": 2}], "total": 149.50},
    "ORD-1002": {"id": "ORD-1002", "customer_id": "CUST-001", "status": "confirmed",
                 "items": [{"sku": "SKU-42", "qty": 1}], "total": 89.00},
    "ORD-1003": {"id": "ORD-1003", "customer_id": "CUST-002", "status": "dispatched",
                 "items": [{"sku": "SKU-77", "qty": 3}], "total": 320.75},
    "ORD-1004": {"id": "ORD-1004", "customer_id": "CUST-003", "status": "delivered",
                 "items": [{"sku": "SKU-05", "qty": 1}], "total": 59.99},
    "ORD-1005": {"id": "ORD-1005", "customer_id": "CUST-002", "status": "cancelled",
                 "items": [{"sku": "SKU-90", "qty": 5}], "total": 410.00},
}

INVOICES: dict[str, dict] = {
    # The non-ASCII name is deliberate: it is what the UTF-8 round-trip
    # requirement (REQ-010) is checked against.
    "INV-2001": {"id": "INV-2001", "customer_name": "José Ångström", "total": 59.99,
                 "encoding": "utf-8"},
    "INV-2002": {"id": "INV-2002", "customer_name": "José Ångström", "total": 320.75,
                 "encoding": "utf-8"},
}


# ---------------------------------------------------------------- helpers
def _err(status: int, code: str, message: str):
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def require_token(authorization: str = Header(default="")):
    """Any non-empty bearer token is accepted on protected routes."""
    if not authorization.startswith("Bearer ") or not authorization.removeprefix("Bearer ").strip():
        _err(401, "unauthenticated", "A Bearer token is required")


# ---------------------------------------------------------------- schemas
class LoginIn(BaseModel):
    phone: str
    password: str


class CustomerIn(BaseModel):
    name: str
    phone: str
    email: str
    age: int


class OrderIn(BaseModel):
    customer_id: str
    items: list
    total: float


# ---------------------------------------------------------------- routers
public = APIRouter(prefix="/api/v2")
secured = APIRouter(prefix="/api/v2", dependencies=[Depends(require_token)])


@public.post("/auth/login")
def login(body: LoginIn):
    if body.phone == DEMO_PHONE and body.password == DEMO_PASSWORD:
        return {"access_token": f"sut-{uuid.uuid4().hex}"}
    _err(401, "invalid_credentials", "Phone number or password is incorrect")


@secured.post("/customers", status_code=201)
def create_customer(body: CustomerIn):
    valid_phone = re.fullmatch(r"05[0-9]{8}", body.phone)
    # INTENTIONAL BUG #1: 11-digit phones starting with 05 are wrongly accepted.
    buggy_phone = re.fullmatch(r"05[0-9]{9}", body.phone)
    if not (valid_phone or buggy_phone):
        _err(422, "invalid_phone", "Phone number must match the format 05XXXXXXXX")
    if body.age < 18 or body.age > 120:
        _err(422, "invalid_age", "Age must be between 18 and 120")
    if "@" not in body.email:
        _err(422, "invalid_email", "Email address is not valid")
    cid = f"CUST-{uuid.uuid4().hex[:6].upper()}"
    customer = {"id": cid, "name": body.name, "phone": body.phone,
                "email": body.email, "age": body.age}
    CUSTOMERS[cid] = customer
    return customer


@secured.get("/customers/{customer_id}")
def get_customer(customer_id: str):
    customer = CUSTOMERS.get(customer_id)
    if not customer:
        _err(404, "not_found", "Customer not found")
    return customer


@secured.get("/orders")
def list_orders(status: str | None = None, page: int = 1):
    if status is not None and status not in ORDER_STATUSES:
        _err(422, "invalid_status",
             f"Order status must be one of: {', '.join(sorted(ORDER_STATUSES))}")
    if page < 1:
        _err(422, "invalid_page", "Page number must be 1 or greater")
    items = [o for o in ORDERS.values() if status is None or o["status"] == status]
    return {"items": items, "page": page}


@secured.post("/orders", status_code=201)
def create_order(body: OrderIn):
    if not body.items:
        _err(422, "empty_items", "An order must contain at least one item")
    if body.total <= 0:
        _err(422, "invalid_total", "Order total must be greater than zero")
    oid = f"ORD-{uuid.uuid4().hex[:6].upper()}"
    order = {"id": oid, "customer_id": body.customer_id, "status": "pending",
             "items": body.items, "total": body.total}
    ORDERS[oid] = order
    return order


@secured.post("/orders/{order_id}/cancel")
def cancel_order(order_id: str):
    order = ORDERS.get(order_id)
    if not order:
        _err(404, "not_found", "Order not found")
    # INTENTIONAL BUG #2: 'dispatched' orders are wrongly cancellable (should be 409).
    if order["status"] in ("pending", "confirmed", "dispatched"):
        order["status"] = "cancelled"
        return {"id": order["id"], "status": "cancelled", "message": "Order cancelled"}
    _err(409, "not_cancellable", f"An order in state {order['status']} cannot be cancelled")


@secured.get("/invoices/{invoice_id}")
def get_invoice(invoice_id: str):
    invoice = INVOICES.get(invoice_id)
    if not invoice:
        _err(404, "not_found", "Invoice not found")
    return invoice


app.include_router(public)
app.include_router(secured)


@app.get("/health")
def health():
    return {"status": "ok", "app": "Orders Platform"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, port=9000)
