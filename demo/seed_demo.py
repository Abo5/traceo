#!/usr/bin/env python3
"""Seed the Traceo demo end-to-end.

Prerequisites (run from repo root):
  1. Backend up:   cd backend && uvicorn app.main:app --port 8000
  2. Demo SUT up:  cd demo/sut && uvicorn main:app --port 9000
Then:              python3 demo/seed_demo.py

Logs in as demo@traceo.sa (falls back to registering org "شركة نجم البرمجيات"),
creates the "منصة الطلبات — الحكومية" project, uploads the Arabic requirements
document, imports the OpenAPI spec, generates + approves test cases, executes a
run against the SUT and prints a traceability summary.
"""
import json
import sys
import time
from pathlib import Path

try:
    import httpx
except ImportError:
    print("ERROR: httpx is required — pip install httpx", file=sys.stderr)
    sys.exit(1)

BASE = "http://localhost:8000/v1"
DEMO_DIR = Path(__file__).resolve().parent
REQ_DOC = DEMO_DIR / "sample_requirements_ar.md"
SPEC_FILE = DEMO_DIR / "sample_openapi.yaml"

DEMO_EMAIL = "demo@traceo.sa"
DEMO_PASSWORD = "Demo1234!"
ORG_NAME = "شركة نجم البرمجيات"
PROJECT_NAME = "منصة الطلبات — الحكومية"


# ------------------------------------------------------------------ helpers
def die(msg: str):
    print(f"\nERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def check(resp: httpx.Response, *codes: int, what: str = "request") -> dict:
    if resp.status_code not in codes:
        die(f"{what} failed: HTTP {resp.status_code} — {resp.text[:600]}")
    try:
        return resp.json() if resp.content else {}
    except ValueError:
        return {}


def items_of(payload):
    """Normalize list endpoints that may return a bare list or a wrapped object."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "rows", "results", "data", "test_cases", "requirements",
                    "endpoints", "runs", "environments", "documents"):
            if isinstance(payload.get(key), list):
                return payload[key]
    return []


def poll_job(client: httpx.Client, job_id: str, what: str, timeout: float = 300.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = check(client.get(f"{BASE}/jobs/{job_id}"), 200, what=f"poll {what} job")
        status = job.get("status")
        if status == "completed":
            return job
        if status == "failed":
            die(f"{what} job failed: {job.get('error')}")
        time.sleep(0.5)
    die(f"{what} job {job_id} did not finish within {int(timeout)}s")


def step(msg: str):
    print(f"==> {msg}")


# ------------------------------------------------------------------ flow
def main():
    for f in (REQ_DOC, SPEC_FILE):
        if not f.exists():
            die(f"missing demo asset: {f}")

    with httpx.Client(timeout=30.0) as anon:
        try:
            anon.get("http://localhost:8000/health")
        except httpx.HTTPError as e:
            die(f"backend is not reachable on localhost:8000 — start it first ({e})")

        step(f"Logging in as {DEMO_EMAIL}")
        r = anon.post(f"{BASE}/auth/login", json={"email": DEMO_EMAIL, "password": DEMO_PASSWORD})
        if r.status_code == 200:
            token = r.json().get("token") or r.json().get("access_token")
        else:
            step(f"Login failed ({r.status_code}) — registering org {ORG_NAME}")
            data = check(anon.post(f"{BASE}/auth/register", json={
                "org_name": ORG_NAME, "name": "نواف القحطاني",
                "email": DEMO_EMAIL, "password": DEMO_PASSWORD,
            }), 200, 201, what="register")
            token = data.get("token") or data.get("access_token")
        if not token:
            die("no auth token in login/register response")

    with httpx.Client(timeout=60.0, headers={"Authorization": f"Bearer {token}"}) as c:
        step(f"Creating project: {PROJECT_NAME}")
        proj = check(c.post(f"{BASE}/projects", json={"name": PROJECT_NAME, "language": "ar"}),
                     200, 201, what="create project")
        pid = proj.get("id") or (proj.get("project") or {}).get("id")
        if not pid:
            die(f"project id missing from response: {proj}")

        step("Configuring 'staging' environment -> http://localhost:9000/api/v2")
        env = check(c.post(f"{BASE}/projects/{pid}/environments", json={
            "name": "staging", "base_url": "http://localhost:9000/api/v2",
            "auth_type": "bearer", "auth_config": {"token": "demo-token"},
        }), 200, 201, what="create environment")
        env_id = env.get("id") or (env.get("environment") or {}).get("id")
        if not env_id:
            die(f"environment id missing from response: {env}")

        step(f"Uploading requirements document: {REQ_DOC.name}")
        with REQ_DOC.open("rb") as fh:
            data = check(c.post(f"{BASE}/projects/{pid}/documents",
                                files={"file": (REQ_DOC.name, fh, "text/markdown")}),
                         200, 201, 202, what="upload document")
        poll_job(c, data.get("job_id") or die("no job_id from document upload"),
                 "requirements parse")

        step("Confirming all extracted requirements")
        check(c.post(f"{BASE}/projects/{pid}/requirements/confirm_all"),
              200, 201, 204, what="confirm_all")
        reqs = items_of(check(c.get(f"{BASE}/projects/{pid}/requirements"),
                              200, what="list requirements"))
        confirmed = [q for q in reqs if q.get("state") == "confirmed"]
        if not confirmed:
            die("no confirmed requirements after confirm_all")

        step(f"Importing OpenAPI spec: {SPEC_FILE.name}")
        with SPEC_FILE.open("rb") as fh:
            spec_resp = check(c.post(f"{BASE}/projects/{pid}/api-specs",
                                     files={"file": (SPEC_FILE.name, fh, "application/yaml")}),
                              200, 201, 202, what="import spec")
        if spec_resp.get("warnings"):
            print(f"    spec warnings: {spec_resp['warnings']}")

        step("Generating test cases (depth=standard)")
        gen = check(c.post(f"{BASE}/projects/{pid}/generate", json={"depth": "standard"}),
                    200, 202, what="trigger generation")
        gen_job = poll_job(c, gen.get("job_id") or die("no job_id from generate"), "generation")
        gen_result = gen_job.get("result") or {}
        generated = gen_result.get("generated", 0)
        discarded = gen_result.get("discarded", 0)
        unmappable = gen_result.get("unmappable") or []
        if not generated:
            die(f"generation produced 0 cases (result: {json.dumps(gen_result)[:400]})")

        step("Approving all draft test cases")
        drafts = items_of(check(c.get(f"{BASE}/projects/{pid}/test-cases",
                                      params={"state": "draft"}), 200, what="list drafts"))
        draft_ids = [t["id"] for t in drafts if t.get("id")]
        if not draft_ids:
            die("no draft test cases found to approve")
        check(c.post(f"{BASE}/test-cases/bulk", json={"ids": draft_ids, "action": "approve"}),
              200, 201, 204, what="bulk approve")

        step("Starting a run against staging (the demo SUT)")
        run_resp = check(c.post(f"{BASE}/projects/{pid}/runs",
                                json={"environment_id": env_id}),
                         200, 202, what="start run")
        run_id = run_resp.get("run_id") or run_resp.get("id")
        if not run_id:
            die(f"run id missing from response: {run_resp}")
        if run_resp.get("job_id"):
            poll_job(c, run_resp["job_id"], "execution")
        # Confirm the run record itself reached a terminal state.
        deadline = time.time() + 300
        run = {}
        while time.time() < deadline:
            run = check(c.get(f"{BASE}/runs/{run_id}"), 200, what="poll run")
            if run.get("state") in ("completed", "aborted", "cancelled"):
                break
            time.sleep(0.5)
        if run.get("state") == "aborted":
            die(f"run aborted: {run.get('abort_reason')} — is the SUT up on localhost:9000?")
        if run.get("state") != "completed":
            die(f"run did not complete (state={run.get('state')})")
        counts = run.get("counts") or {}

        step("Fetching traceability matrix")
        trace = check(c.get(f"{BASE}/projects/{pid}/traceability"), 200, what="traceability")
        coverage = trace.get("coverage_pct", 0)
        gaps = trace.get("gaps") or []

    # ------------------------------------------------------------ summary
    rows = [
        ("Project", PROJECT_NAME),
        ("Requirements confirmed", str(len(confirmed))),
        ("Test cases generated", str(generated)),
        ("Discarded by grounding gate", str(discarded)),
        ("Unmappable requirements", str(len(unmappable))),
        ("Approved test cases", str(len(draft_ids))),
        ("Run state", str(run.get("state"))),
        ("  passed", str(counts.get("passed", "?"))),
        ("  failed", str(counts.get("failed", "?"))),
        ("  errored", str(counts.get("errored", "?"))),
        ("Coverage", f"{coverage}%"),
        ("Traceability gaps", str(len(gaps))),
    ]
    width = max(len(k) for k, _ in rows) + 2
    print("\n" + "=" * (width + 20))
    print("TRACEO DEMO SEED — SUMMARY")
    print("=" * (width + 20))
    for k, v in rows:
        print(f"{k:<{width}}{v}")
    print("=" * (width + 20))
    if counts.get("failed"):
        print("Note: failures are expected — the demo SUT contains two intentional bugs")
        print("      (11-digit phone accepted; dispatched orders cancellable).")
    print("Done.")


if __name__ == "__main__":
    main()
