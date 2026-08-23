#!/usr/bin/env python3
"""labs/measure.py — the honesty meter.

Reads the Traceo database after a run and prints, per test type, how many cases
were GENERATED, how many reached an executor, and how many were CONCLUSIVE — a
case with at least one assertion actually evaluated.

The last column is the one that matters: a case whose every assertion was
skipped is reported by the product today as `passed`. Here it is counted as what
it is. See docs/REMEDIATION_PLAN_AR.md — invariant H1, gate QG3.

Exit code is 1 when a --require threshold is not met, so CI can gate on it.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

TYPES = ("functional", "api", "ui", "performance", "security")

# The scan tags each requirement with the track it came from; the case row does
# NOT persist its test type (TR-016), so the track is recovered from the
# requirement's external id. Delete this function the day test_type is stored.
_SUFFIX = (("-API", "api"), ("-SEC", "security"), ("-UI", "ui"), ("-PERF", "performance"))
_TECHNIQUE = {"security": "security", "design": "ui", "a11y": "ui",
              "performance": "performance", "edge_case": "functional"}


def track_of(external_id: str | None, technique: str | None) -> str:
    ext = external_id or ""
    for suffix, track in _SUFFIX:
        if ext.endswith(suffix):
            return track
    if re.search(r"-(F\d+|NAV)$", ext):
        return "functional"
    return _TECHNIQUE.get(technique or "", "functional")


def load(db_path: Path, project_id: str | None):
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    where, args = ("", ())
    if project_id:
        where, args = ("WHERE tc.project_id = ?", (project_id,))

    cases: dict[str, dict] = {}
    for row in db.execute(f"""
        SELECT tc.id, tc.project_id, tc.technique, r.external_id AS ext
        FROM test_cases tc
        LEFT JOIN requirement_test_cases rtc ON rtc.test_case_id = tc.id
        LEFT JOIN requirements r ON r.id = rtc.requirement_id
        {where}""", args):
        cases.setdefault(row["id"], {
            "project": row["project_id"],
            "track": track_of(row["ext"], row["technique"]),
        })

    # A case may run in several runs; keep the most informative execution.
    results: dict[str, dict] = {}
    for row in db.execute("SELECT test_case_id, outcome, evidence FROM test_results"):
        if row["test_case_id"] not in cases:
            continue
        outcomes = [a.get("outcome") for step in json.loads(row["evidence"] or "[]")
                    for a in (step.get("assertions") or [])]
        current = {
            "outcome": row["outcome"],
            "evaluated": sum(1 for o in outcomes if o != "skipped"),
        }
        previous = results.get(row["test_case_id"])
        if previous is None or current["evaluated"] > previous["evaluated"]:
            results[row["test_case_id"]] = current
    return cases, results


def report(cases: dict, results: dict) -> dict:
    rows, totals = {}, [0, 0, 0, 0, 0]
    for track in TYPES:
        ids = [i for i, c in cases.items() if c["track"] == track]
        ran = [i for i in ids if i in results]
        row = [
            len(ids),
            len(ran),
            sum(1 for i in ran if results[i]["evaluated"] > 0),
            sum(1 for i in ran if results[i]["evaluated"] == 0
                and results[i]["outcome"] == "passed"),
            sum(1 for i in ran if results[i]["outcome"] == "failed"),
        ]
        rows[track] = row
        totals = [a + b for a, b in zip(totals, row)]
    return {"rows": rows, "totals": totals}


def render(data: dict) -> None:
    head = ("test type", "generated", "executed", "conclusive", "FAKE PASS", "failed")
    print(f"{head[0]:<14}{head[1]:>10}{head[2]:>10}{head[3]:>12}{head[4]:>11}{head[5]:>8}")
    print("-" * 65)
    for track in TYPES:
        g, e, c, f, x = data["rows"][track]
        share = f"{c / g * 100:.0f}%" if g else "—"
        print(f"{track:<14}{g:>10}{e:>10}{c:>12}{f:>11}{x:>8}   {share} conclusive")
    print("-" * 65)
    g, e, c, f, x = data["totals"]
    print(f"{'TOTAL':<14}{g:>10}{e:>10}{c:>12}{f:>11}{x:>8}")
    if g:
        print(f"\nconclusive share : {c / g * 100:.1f}%   (invariant H6 counts only these)")
    if f:
        print(f"FAKE PASS        : {f} case(s) reported passed with zero assertions "
              f"evaluated — invariant H1 is broken.")
    else:
        print("FAKE PASS        : 0  ✓ invariant H1 holds")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="backend/traceo.db", type=Path)
    ap.add_argument("--project", help="limit to one project id")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--require-no-fake-pass", action="store_true",
                    help="exit 1 if any case passed with zero assertions evaluated (QG3)")
    ap.add_argument("--require-conclusive", type=float, metavar="RATIO",
                    help="exit 1 if the conclusive share is below RATIO, e.g. 0.95")
    ap.add_argument("--track", choices=TYPES, help="apply --require-* to one track only")
    args = ap.parse_args()

    if not args.db.is_file():
        print(f"no database at {args.db}", file=sys.stderr)
        return 2

    data = report(*load(args.db, args.project))
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        render(data)

    generated, _, conclusive, fake, _ = (data["rows"][args.track] if args.track
                                         else data["totals"])
    failed = False
    if args.require_no_fake_pass and fake:
        print(f"\nFAIL: {fake} fake pass(es) — QG3", file=sys.stderr)
        failed = True
    if args.require_conclusive is not None:
        share = conclusive / generated if generated else 0.0
        if share < args.require_conclusive:
            print(f"\nFAIL: conclusive share {share:.1%} < required "
                  f"{args.require_conclusive:.0%}", file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
