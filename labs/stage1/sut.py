#!/usr/bin/env python3
"""ShopDesk — Stage 1 system under test for Traceo.

A deliberately defective order-management app: HTML UI + JSON API, stdlib only.
Every defect is tagged in DEFECTS.md so a discovery run can be scored against it.
Nothing here is a real product; it exists to be found wrong.
"""
import json, re, sqlite3, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 9100
DB = ":memory:"
_lock = threading.Lock()
_conn = sqlite3.connect(DB, check_same_thread=False)
_conn.executescript("""
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password TEXT,
                    full_name TEXT, role TEXT, password_hash TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT UNIQUE, customer TEXT,
                     item TEXT, quantity INTEGER, unit_price REAL, total REAL,
                     status TEXT, owner_id INTEGER, created_at TEXT);
""")
_conn.execute("INSERT INTO users VALUES (1,'demo@shopdesk.test','Passw0rd!','Demo Buyer','user','h$1a2b3c')")
_conn.execute("INSERT INTO users VALUES (2,'boss@shopdesk.test','Sup3rSecret!','Ops Manager','admin','h$9f8e7d')")
for i, (ref, cust, item, q, p) in enumerate([
        ("ORD-1001", "Acme Ltd", "Blue Widget", 3, 19.99),
        ("ORD-1002", "Globex", "Red Widget", 1, 249.00),
        ("ORD-1009", "Initech", "Green Widget", 12, 4.25),
        ("ORD-1010", "Umbrella", "Black Widget", 2, 99.5)], start=1):
    _conn.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?)",
                  (i, ref, cust, item, q, p, q * p, "open", 1, "2026-08-20T10:0%d:00Z" % i))
_conn.commit()

TOKENS = {}   # token -> user_id

# ---------------------------------------------------------------- HTML -------
# UI defects live here. Tags: U1..U7 (see DEFECTS.md).
LOGIN_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShopDesk - Sign in</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;background:#f4f6f8;margin:0;padding:40px}
 .card{max-width:380px;margin:60px auto;background:#fff;padding:28px;border-radius:10px;
       box-shadow:0 1px 4px rgba(0,0,0,.12)}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:#8a9099;font-size:13px;margin-bottom:20px}
 label{display:block;font-size:13px;margin:14px 0 4px;color:#333}
 input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #cfd6dd;border-radius:6px;font-size:14px}
 /* U3: 1.19:1 contrast — the primary action is effectively invisible */
 button.primary{margin-top:18px;width:100%;padding:11px;border:0;border-radius:6px;
        background:#cdd3d9;color:#b9c0c8;font-size:15px;cursor:pointer}
 /* U7: 12x12 hit area, far under the 24px minimum */
 .dismiss{position:absolute;top:6px;right:6px;width:12px;height:12px;font-size:9px;
        line-height:12px;border:0;background:transparent;cursor:pointer;color:#555}
 .banner{position:relative;background:#eef4ff;border:1px solid #cfe0ff;padding:10px 22px 10px 10px;
        border-radius:6px;font-size:13px;color:#31507d}
 .err{color:#c0392b;font-size:13px;min-height:18px;margin-top:8px;white-space:pre-wrap}
</style>
</head>
<body>
<div class="card">
  <!-- U4: decorative-looking logo with no alt text and no role -->
  <img src="/static/logo.svg" width="120" height="28">
  <h1>Sign in to ShopDesk</h1>
  <div class="sub">Order management console</div>
  <form id="loginForm" onsubmit="return doLogin(event)">
    <label for="email">Email address</label>
    <!-- U6: type=text on an email field, no pattern, no required -->
    <input id="email" name="email" type="text" autocomplete="username">
    <!-- U2: no <label>, no aria-label, placeholder only -->
    <input id="password" name="password" type="password" placeholder="Password"
           autocomplete="current-password">
    <button class="primary" id="signin" type="submit">Sign in</button>
    <div class="err" id="loginError"></div>
  </form>
  <div class="banner" id="email">
    <!-- U1: this id duplicates the email input's id -->
    <button class="dismiss" onclick="this.parentNode.style.display='none'">x</button>
    Demo account: demo@shopdesk.test / Passw0rd!
  </div>
</div>
<script>
async function doLogin(e){
  e.preventDefault();
  var email = document.getElementById('email').value;
  var pw = document.getElementById('password').value;
  // F1/F2: no client-side validation at all - empty password and malformed
  // email are both submitted as-is.
  var r = await fetch('/api/auth/login', {method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({email: email, password: pw})});
  var d = await r.json();
  if (d.ok) { localStorage.setItem('token', d.token); location.href = '/orders'; }
  else { document.getElementById('loginError').textContent = d.error || 'Sign in failed'; }
  return false;
}
</script>
</body>
</html>"""

ORDERS_HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ShopDesk - Orders</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;background:#f4f6f8;margin:0;padding:24px}
 .wrap{max-width:900px;margin:0 auto}
 h1{font-size:22px}
 table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden}
 th,td{padding:10px 12px;text-align:left;font-size:14px;border-bottom:1px solid #eceff2}
 th{background:#fafbfc;color:#606771;font-size:12px;text-transform:uppercase}
 form.new{background:#fff;padding:16px;border-radius:8px;margin:20px 0;display:flex;
          gap:10px;flex-wrap:wrap;align-items:end}
 form.new div{display:flex;flex-direction:column}
 label{font-size:12px;color:#606771;margin-bottom:4px}
 input{padding:8px;border:1px solid #cfd6dd;border-radius:5px;font-size:14px}
 button{padding:9px 16px;border:0;border-radius:5px;background:#2f6fed;color:#fff;
        font-size:14px;cursor:pointer}
 .err{color:#c0392b;font-size:13px;white-space:pre-wrap;margin-top:10px}
</style>
</head>
<body>
<div class="wrap">
  <h1>Orders</h1>
  <a href="/logout" id="logout">Sign out</a>
  <form class="new" id="newOrder" onsubmit="return createOrder(event)">
    <div><label for="customer">Customer</label><input id="customer" name="customer"></div>
    <div><label for="item">Item</label><input id="item" name="item"></div>
    <!-- F3: no min attribute; negatives and zero are accepted -->
    <div><label for="quantity">Quantity</label><input id="quantity" name="quantity" type="number" value="1"></div>
    <div><label for="unit_price">Unit price</label><input id="unit_price" name="unit_price" type="number" step="0.01" value="0"></div>
    <!-- F4: never disabled; a double click posts twice -->
    <button id="createOrder" type="submit">Create order</button>
  </form>
  <div class="err" id="orderError"></div>
  <table id="ordersTable">
    <thead><tr><th>Ref</th><th>Customer</th><th>Item</th><th>Qty</th><th>Total</th><th>Status</th></tr></thead>
    <tbody id="ordersBody"></tbody>
  </table>
</div>
<script>
function tok(){ return localStorage.getItem('token') || ''; }
async function load(){
  var r = await fetch('/api/orders?limit=50', {headers:{'Authorization':'Bearer '+tok()}});
  var d = await r.json();
  var b = document.getElementById('ordersBody'); b.innerHTML='';
  (d.orders||[]).forEach(function(o){
    var tr = document.createElement('tr');
    tr.innerHTML = '<td>'+o.ref+'</td><td>'+o.customer+'</td><td>'+o.item+'</td>'+
                   '<td>'+o.quantity+'</td><td>'+o.total+'</td><td>'+o.status+'</td>';
    b.appendChild(tr);
  });
}
async function createOrder(e){
  e.preventDefault();
  var body = {customer: customer.value, item: item.value,
              quantity: Number(quantity.value), unit_price: Number(unit_price.value)};
  var r = await fetch('/api/orders', {method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok()},
      body: JSON.stringify(body)});
  var d = await r.json();
  // F5: the raw server detail is rendered straight into the page
  document.getElementById('orderError').textContent = d.error ? d.error : '';
  load();
  return false;
}
load();
</script>
</body>
</html>"""

LOGO_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="28">'
            '<rect width="120" height="28" fill="#2f6fed" rx="4"/>'
            '<text x="10" y="19" fill="#fff" font-family="Arial" font-size="14">ShopDesk</text></svg>')

# ----------------------------------------------------------------- API -------
def row_to_order(r):
    return {"id": r[0], "ref": r[1], "customer": r[2], "item": r[3], "quantity": r[4],
            "unit_price": r[5], "total": r[6], "status": r[7], "owner_id": r[8],
            "created_at": r[9]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # -- plumbing ------------------------------------------------------------
    def _send(self, code, payload, ctype="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # A7: wildcard origin together with credentials, and no security headers
        # (no X-Content-Type-Options, no X-Frame-Options, no CSP, no HSTS).
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Server", "ShopDesk/1.4.2 (Python/3.13 sqlite3/3.45)")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def _user(self):
        auth = self.headers.get("Authorization", "")
        tid = auth[7:] if auth.startswith("Bearer ") else ""
        return TOKENS.get(tid)

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    # -- GET -----------------------------------------------------------------
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path

        if p == "/" or p == "/login":
            return self._send(200, LOGIN_HTML.encode(), "text/html; charset=utf-8")
        if p == "/orders":
            # F6: no Cache-Control, so the page is restorable after sign-out
            return self._send(200, ORDERS_HTML.encode(), "text/html; charset=utf-8")
        if p == "/logout":
            self.send_response(302)
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if p == "/static/logo.svg":
            return self._send(200, LOGO_SVG.encode(), "image/svg+xml")
        if p == "/openapi.json":
            return self._send(200, OPENAPI)

        if p == "/api/orders":
            # A5: limit is neither bounded nor type-checked
            limit = q.get("limit", ["20"])[0]
            offset = q.get("offset", ["0"])[0]
            try:
                sql = "SELECT * FROM orders ORDER BY id LIMIT %s OFFSET %s" % (int(limit), int(offset))
            except ValueError as exc:
                # A3-style: a bad query parameter becomes a 500 with the raw text
                return self._send(500, {"error": "ValueError: %s" % exc})
            with _lock:
                rows = _conn.execute(sql).fetchall()
            return self._send(200, {"orders": [row_to_order(r) for r in rows],
                                    "count": len(rows)})

        m = re.fullmatch(r"/api/orders/(\d+)", p)
        if m:
            with _lock:
                r = _conn.execute("SELECT * FROM orders WHERE id=?", (int(m.group(1)),)).fetchone()
            if not r:
                return self._send(404, {"error": "not found"})
            return self._send(200, row_to_order(r))

        m = re.fullmatch(r"/api/users/(\d+)", p)
        if m:
            # A2: no authentication and no ownership check — straight IDOR.
            # A6: the row is returned whole, password and hash included.
            with _lock:
                r = _conn.execute("SELECT * FROM users WHERE id=?", (int(m.group(1)),)).fetchone()
            if not r:
                return self._send(404, {"error": "not found"})
            return self._send(200, {"id": r[0], "email": r[1], "password": r[2],
                                    "full_name": r[3], "role": r[4], "password_hash": r[5]})

        if p == "/api/me":
            uid = self._user()
            if not uid:
                return self._send(401, {"error": "unauthorised"})
            with _lock:
                r = _conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
            return self._send(200, {"id": r[0], "email": r[1], "password": r[2],
                                    "full_name": r[3], "role": r[4]})

        if p == "/health":
            return self._send(200, {"status": "ok"})
        return self._send(404, {"error": "no such route"})

    # -- POST ----------------------------------------------------------------
    def do_POST(self):
        u = urlparse(self.path)
        p = u.path
        body = self._body()

        if p == "/api/auth/login":
            email = (body.get("email") or "").strip()
            pw = body.get("password")
            with _lock:
                r = _conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            # F1: an empty/absent password authenticates whenever the email exists
            if r and (pw is None or pw == "" or pw == r[2]):
                t = uuid.uuid4().hex
                TOKENS[t] = r[0]
                return self._send(200, {"ok": True, "token": t,
                                        "user": {"id": r[0], "email": r[1],
                                                 "password": r[2], "role": r[4]}})
            # A1: a failed sign-in is reported with HTTP 200
            return self._send(200, {"ok": False, "error": "Invalid email or password"})

        if p == "/api/orders":
            # A8-adjacent: creating an order needs no token at all
            cust = body.get("customer")
            item = body.get("item")
            qty = body.get("quantity")
            price = body.get("unit_price")
            # A3: a missing field raises, and the traceback text is the response
            try:
                total = float(qty) * float(price)   # A4: negatives sail through
            except Exception as exc:
                return self._send(500, {
                    "error": "TypeError: %s\n  File \"/srv/shopdesk/api.py\", line 214, in create_order\n"
                             "    total = float(qty) * float(price)" % exc})
            ref = "ORD-%d" % (1000 + int(time.time() * 1000) % 9000)
            with _lock:
                try:
                    cur = _conn.execute(
                        "INSERT INTO orders (ref,customer,item,quantity,unit_price,total,status,owner_id,created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (ref, cust, item, qty, price, total, "open", 1,
                         time.strftime("%Y-%m-%dT%H:%M:%SZ")))
                    _conn.commit()
                except sqlite3.IntegrityError as exc:
                    # F5: the database error is handed to the browser verbatim
                    return self._send(500, {"error": "sqlite3.IntegrityError: %s" % exc})
            with _lock:
                r = _conn.execute("SELECT * FROM orders WHERE id=?", (cur.lastrowid,)).fetchone()
            # A9: a creation answers 200, never 201, and sets no Location header
            return self._send(200, row_to_order(r))

        return self._send(404, {"error": "no such route"})

    # -- DELETE --------------------------------------------------------------
    def do_DELETE(self):
        m = re.fullmatch(r"/api/orders/(\d+)", urlparse(self.path).path)
        if m:
            # A8: no token required, and a missing row still answers 200 deleted
            with _lock:
                _conn.execute("DELETE FROM orders WHERE id=?", (int(m.group(1)),))
                _conn.commit()
            return self._send(200, {"deleted": True, "id": int(m.group(1))})
        return self._send(404, {"error": "no such route"})


OPENAPI = json.loads(open(__file__.replace("sut.py", "openapi.json")).read()) \
    if __import__("os").path.exists(__file__.replace("sut.py", "openapi.json")) else {}

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("ShopDesk SUT on http://127.0.0.1:%d" % PORT, flush=True)
    srv.serve_forever()
