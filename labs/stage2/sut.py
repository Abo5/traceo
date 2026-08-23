#!/usr/bin/env python3
"""MedLedger — Stage 2 system under test.

Same shape as Stage 1, harder defects: nothing here is a missing status code or a
missing header. Every planted fault needs the tester to reason about state, order,
encoding, time or arithmetic. Answer key in DEFECTS.md.
"""
import base64, json, re, sqlite3, threading, time, unicodedata, uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 9200
_lock = threading.Lock()
_conn = sqlite3.connect(":memory:", check_same_thread=False)
_conn.executescript("""
CREATE TABLE patients (id INTEGER PRIMARY KEY, email TEXT, full_name TEXT, role TEXT);
CREATE TABLE slots (id INTEGER PRIMARY KEY, starts_at TEXT, clinician TEXT, capacity INTEGER);
CREATE TABLE appointments (id INTEGER PRIMARY KEY, slot_id INTEGER, patient_id INTEGER,
                           notes VARCHAR(255), fee REAL, currency TEXT, created_at TEXT,
                           idem_key TEXT, status TEXT);
""")
_conn.execute("INSERT INTO patients VALUES (1,'ali@medledger.test','Ali Nasser','patient')")
_conn.execute("INSERT INTO patients VALUES (2,'nora@medledger.test','Nora Saleh','patient')")
_conn.execute("INSERT INTO patients VALUES (3,'clinic@medledger.test','Clinic Desk','staff')")
for i in range(1, 13):
    _conn.execute("INSERT INTO slots VALUES (?,?,?,?)",
                  (i, "2026-09-%02dT08:00:00+03:00" % i, "Dr. Faisal", 1))
for i in range(1, 12):
    _conn.execute("INSERT INTO appointments VALUES (?,?,?,?,?,?,?,?,?)",
                  (i, i, 1 + (i % 2), "routine review", 0.1 * (i % 4 + 1), "SAR",
                   "2026-08-1%dT09:00:00Z" % (i % 10), None, "booked"))
_conn.commit()

SESSIONS = {}   # token -> patient_id


def make_token(pid, ttl_s=3600):
    payload = {"sub": pid, "exp": int(time.time()) + ttl_s}
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    return "ml." + raw + ".sig"


def token_subject(tok):
    """D7: the exp claim is parsed and then never compared to the clock."""
    try:
        body = tok.split(".")[1]
        body += "=" * (-len(body) % 4)
        return json.loads(base64.urlsafe_b64decode(body))["sub"]
    except Exception:
        return None


INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MedLedger - Book an appointment</title>
<style>
 body{font-family:system-ui,Arial,sans-serif;background:#fbfbfc;margin:0;padding:32px;color:#1c2024}
 .wrap{max-width:820px;margin:0 auto}
 h1{font-size:22px;margin:0 0 6px}
 /* D-UI1: 4.42:1 on white - just under the 4.5:1 the rule asks for */
 .hint{color:#767676;background:#ffffff;font-size:13px;margin-bottom:20px}
 fieldset{border:1px solid #e3e6ea;border-radius:8px;padding:16px;background:#fff}
 legend{font-size:13px;color:#5b636c;padding:0 6px}
 label{display:block;font-size:13px;margin:12px 0 4px}
 .req:after{content:" *";color:#c0392b}
 input,select,textarea{width:100%;box-sizing:border-box;padding:9px;border:1px solid #d5dae0;
   border-radius:6px;font-size:14px;font-family:inherit}
 button{margin-top:14px;padding:10px 18px;border:0;border-radius:6px;background:#0b6b52;
   color:#fff;font-size:14px;cursor:pointer}
 .menu{position:relative;display:inline-block;margin-bottom:14px}
 .menu ul{display:none;position:absolute;list-style:none;margin:4px 0;padding:6px;
   background:#fff;border:1px solid #e3e6ea;border-radius:6px}
 .menu.open ul{display:block}
 dialog{border:0;border-radius:10px;padding:20px;box-shadow:0 6px 30px rgba(0,0,0,.2)}
 table{width:100%;border-collapse:collapse;margin-top:22px;background:#fff}
 td,th{padding:9px 10px;border-bottom:1px solid #eef0f3;font-size:14px;text-align:left}
 .status{font-size:13px;margin-top:10px;color:#0b6b52}
</style>
</head>
<body>
<div class="wrap">
  <h1>Book an appointment</h1>
  <p class="hint">Slots are released 30 days ahead. Demo sign-in: ali@medledger.test</p>

  <div class="menu" id="clinicianMenu">
    <!-- D-UI2: aria-expanded is written once and never updated when the menu opens -->
    <button id="clinicianToggle" aria-expanded="false" aria-controls="clinicianList"
            onclick="document.getElementById('clinicianMenu').classList.toggle('open')">
      Clinician: Dr. Faisal
    </button>
    <ul id="clinicianList"><li>Dr. Faisal</li><li>Dr. Maha</li></ul>
  </div>

  <form id="bookingForm" onsubmit="return book(event)">
   <fieldset>
    <legend>Appointment</legend>

    <!-- D-UI6: the for attribute names an id that does not exist on the page -->
    <label for="slot_select" class="req">Slot</label>
    <select id="slotId" name="slot_id"></select>

    <!-- D-UI7: marked required visually only - no required, no aria-required -->
    <label for="patientEmail" class="req">Your email</label>
    <input id="patientEmail" name="email" type="email" value="ali@medledger.test">

    <label for="notes">Notes</label>
    <!-- D9: the field advertises 5000 but the column stores 255 -->
    <textarea id="notes" name="notes" maxlength="5000" rows="3"></textarea>

    <!-- D-UI4: a positive tabindex drags this control to the front of the tab order -->
    <label for="fee">Fee</label>
    <input id="fee" name="fee" type="number" step="0.1" value="0.1" tabindex="1">

    <label for="qty">Sessions</label>
    <input id="qty" name="qty" type="number" value="3" min="1" max="10">

    <button id="bookBtn" type="submit">Confirm booking</button>
    <!-- D-UI5: the outcome is shown visually with no live region to announce it -->
    <div class="status" id="bookStatus"></div>
   </fieldset>
  </form>

  <!-- D-UI8: no caption, no scope on the header cells -->
  <table id="apptTable">
    <tr><th>Id</th><th>Slot</th><th>Fee</th><th>Booked at</th></tr>
    <tbody id="apptBody"></tbody>
  </table>
</div>
<script>
var TOKEN = '';
async function boot(){
  var r = await fetch('/api/auth/session', {method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({email:'ali@medledger.test'})});
  TOKEN = (await r.json()).token;
  var s = await (await fetch('/api/slots')).json();
  var sel = document.getElementById('slotId');
  (s.slots||[]).forEach(function(o){
    var op=document.createElement('option'); op.value=o.id;
    op.textContent=o.id+' - '+o.starts_at; sel.appendChild(op); });
  load();
}
async function load(){
  var d = await (await fetch('/api/appointments?page=1&limit=5&sort=id',
      {headers:{'Authorization':'Bearer '+TOKEN}})).json();
  var b=document.getElementById('apptBody'); b.innerHTML='';
  (d.appointments||[]).forEach(function(a){
    var tr=document.createElement('tr');
    tr.innerHTML='<td>'+a.id+'</td><td>'+a.slot_id+'</td><td>'+a.fee+'</td><td>'+a.created_at+'</td>';
    b.appendChild(tr); });
}
async function book(e){
  e.preventDefault();
  var body={slot_id:Number(slotId.value), email:patientEmail.value, notes:notes.value,
            fee:Number(fee.value), qty:Number(qty.value)};
  var r=await fetch('/api/appointments',{method:'POST',
     headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN,
              'Idempotency-Key': 'ui-fixed-key'},
     body: JSON.stringify(body)});
  var d=await r.json();
  document.getElementById('bookStatus').textContent =
     d.id ? ('Booked #'+d.id+' - total '+d.total) : (d.error||'failed');
  load();
  return false;
}
boot();
</script>
</body>
</html>"""


def appt_row(r):
    return {"id": r[0], "slot_id": r[1], "patient_id": r[2], "notes": r[3], "fee": r[4],
            "currency": r[5], "created_at": r[6], "status": r[8]}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, payload, ctype="application/json", extra=None):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        # D11: the budget is advertised on every response and never enforced
        self.send_header("X-RateLimit-Limit", "60")
        self.send_header("X-RateLimit-Remaining", "59")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}") if n else {}
        except Exception:
            return {}

    def _uid(self):
        a = self.headers.get("Authorization", "")
        return token_subject(a[7:]) if a.startswith("Bearer ") else None

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        p = u.path
        if p == "/":
            return self._send(200, INDEX_HTML.encode(), "text/html; charset=utf-8")
        if p == "/health":
            return self._send(200, {"status": "ok"})
        if p == "/openapi.json":
            import os
            fn = os.path.join(os.path.dirname(os.path.abspath(__file__)), "openapi.json")
            return self._send(200, open(fn, "rb").read())
        if p == "/api/slots":
            with _lock:
                rows = _conn.execute("SELECT * FROM slots ORDER BY id").fetchall()
            return self._send(200, {"slots": [{"id": r[0], "starts_at": r[1],
                                               "clinician": r[2], "capacity": r[3]} for r in rows]})

        if p == "/api/appointments":
            uid = self._uid()
            if not uid:
                return self._send(401, {"error": "unauthorised"})
            page = int(q.get("page", ["1"])[0])
            limit = min(int(q.get("limit", ["10"])[0]), 100)
            sort = q.get("sort", ["id"])[0]
            if sort not in ("id", "created_at", "fee"):
                return self._send(422, {"error": "sort must be id, created_at or fee"})
            # D1: the offset multiplies by page instead of (page - 1), so page 1
            # silently starts at the second page of data.
            offset = page * limit
            # D6: id is an INTEGER column cast to TEXT before ordering, so 10 < 9
            order = "CAST(id AS TEXT)" if sort == "id" else sort
            with _lock:
                rows = _conn.execute(
                    "SELECT * FROM appointments WHERE patient_id=? ORDER BY %s LIMIT ? OFFSET ?"
                    % order, (uid, limit, offset)).fetchall()
                total = _conn.execute("SELECT COUNT(*) FROM appointments WHERE patient_id=?",
                                      (uid,)).fetchone()[0]
            return self._send(200, {"appointments": [appt_row(r) for r in rows],
                                    "page": page, "limit": limit, "total": total})

        m = re.fullmatch(r"/api/appointments/(\d+)", p)
        if m:
            uid = self._uid()
            if not uid:
                return self._send(401, {"error": "unauthorised"})
            aid = int(m.group(1))
            with _lock:
                r = _conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone()
            if not r:
                return self._send(404, {"error": "not found"})
            if r[2] != uid:
                # D12: a row that exists but is not yours answers 403 while a row
                # that does not exist answers 404 — the pair enumerates the table.
                return self._send(403, {"error": "not your appointment"})
            return self._send(200, appt_row(r))
        return self._send(404, {"error": "no such route"})

    def do_POST(self):
        p = urlparse(self.path).path
        b = self._body()

        if p == "/api/auth/session":
            email = (b.get("email") or "").strip()
            # D4: the lookup is byte-exact, so Ali@... and ali@... are two people,
            # and an NFD-composed name never matches its NFC twin.
            with _lock:
                r = _conn.execute("SELECT * FROM patients WHERE email=?", (email,)).fetchone()
                if not r:
                    cur = _conn.execute(
                        "INSERT INTO patients (email, full_name, role) VALUES (?,?,?)",
                        (email, email.split("@")[0], "patient"))
                    _conn.commit()
                    pid = cur.lastrowid
                else:
                    pid = r[0]
            return self._send(200, {"token": make_token(pid), "patient_id": pid})

        if p == "/api/appointments":
            uid = self._uid()
            if not uid:
                return self._send(401, {"error": "unauthorised"})
            slot_id = b.get("slot_id")
            notes = str(b.get("notes") or "")
            fee = b.get("fee")
            qty = b.get("qty", 1)
            if slot_id is None or fee is None:
                return self._send(422, {"error": "slot_id and fee are required"})
            if not isinstance(qty, int) or qty < 1 or qty > 10:
                return self._send(422, {"error": "qty must be an integer between 1 and 10"})
            # D5: binary floating point, never rounded to the currency's minor unit
            total = float(fee) * qty
            # D2: the key is read, echoed back, and never used to deduplicate
            idem = self.headers.get("Idempotency-Key")
            # D3: a naive local timestamp is stamped with a Z as if it were UTC
            created = datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ")
            with _lock:
                # D10: capacity is read but never enforced, and there is no unique
                # index on slot_id, so two bookings for one slot both succeed.
                slot = _conn.execute("SELECT * FROM slots WHERE id=?", (slot_id,)).fetchone()
                if not slot:
                    return self._send(422, {"error": "unknown slot"})
                # D9: the column is VARCHAR(255) but SQLite does not enforce it, so
                # the app truncates by hand and then echoes back the FULL input.
                stored = notes[:255]
                cur = _conn.execute(
                    "INSERT INTO appointments (slot_id,patient_id,notes,fee,currency,created_at,"
                    "idem_key,status) VALUES (?,?,?,?,?,?,?,?)",
                    (slot_id, uid, stored, fee, "SAR", created, idem, "booked"))
                _conn.commit()
                aid = cur.lastrowid
            return self._send(201, {"id": aid, "slot_id": slot_id, "patient_id": uid,
                                    "notes": notes, "fee": fee, "qty": qty, "total": total,
                                    "currency": "SAR", "created_at": created,
                                    "idempotency_key": idem, "status": "booked"},
                              extra={"Location": "/api/appointments/%d" % aid})
        return self._send(404, {"error": "no such route"})

    def do_PATCH(self):
        m = re.fullmatch(r"/api/appointments/(\d+)", urlparse(self.path).path)
        if not m:
            return self._send(404, {"error": "no such route"})
        uid = self._uid()
        if not uid:
            return self._send(401, {"error": "unauthorised"})
        b = self._body()
        aid = int(m.group(1))
        with _lock:
            r = _conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone()
            if not r:
                return self._send(404, {"error": "not found"})
            if r[2] != uid:
                return self._send(403, {"error": "not your appointment"})
            # D8: an unknown field is accepted and dropped without a word, so a
            # client that misspells one is told its update succeeded.
            notes = b.get("notes", r[3])
            _conn.execute("UPDATE appointments SET notes=? WHERE id=?", (str(notes)[:255], aid))
            _conn.commit()
            r = _conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone()
        return self._send(200, appt_row(r))

    def do_PUT(self):
        m = re.fullmatch(r"/api/appointments/(\d+)", urlparse(self.path).path)
        if not m:
            return self._send(404, {"error": "no such route"})
        uid = self._uid()
        if not uid:
            return self._send(401, {"error": "unauthorised"})
        b = self._body()
        aid = int(m.group(1))
        with _lock:
            r = _conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone()
            if not r:
                return self._send(404, {"error": "not found"})
            if r[2] != uid:
                return self._send(403, {"error": "not your appointment"})
            # D8b: a full replace with a partial body silently blanks the rest.
            _conn.execute("UPDATE appointments SET slot_id=?, notes=?, fee=? WHERE id=?",
                          (b.get("slot_id"), str(b.get("notes") or "")[:255], b.get("fee"), aid))
            _conn.commit()
            r = _conn.execute("SELECT * FROM appointments WHERE id=?", (aid,)).fetchone()
        return self._send(200, appt_row(r))


if __name__ == "__main__":
    print("MedLedger SUT on http://127.0.0.1:%d" % PORT, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
