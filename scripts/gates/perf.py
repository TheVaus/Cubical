#!/usr/bin/env python3
"""perf gate — the cold scan stays inside its measured budget.

Opt-in by default: a 10k-note cold scan takes minutes, so running it on every
`check.sh` would make the gate too slow to run, which is the surest way to stop
people running the gate. Enable with CUBICAL_PERF=1.

    CUBICAL_PERF=1 python3 scripts/gates/perf.py              # 1k bar
    CUBICAL_PERF=1 python3 scripts/gates/perf.py --notes 10000

The gate refuses to assert on a machine below the declared class rather than
scaling the budget by a guess — see scripts/perf-budget.json for why.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard  # noqa: E402

CONFIG = ROOT / "scripts" / "perf-budget.json"
MEDIAN = re.compile(r"^open\+scan\s*:.*?median\s+([0-9.]+)\s*s", re.M)
OWNER = "docs/architecture/foundation.md §1 (commitment 2)"


def run() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--notes", type=int, default=None)
    ap.add_argument("--force", action="store_true",
                    help="measure even below the declared machine class "
                         "(reports, never asserts)")
    args = ap.parse_args()

    gate = Gate("perf", "performance.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    if not os.environ.get("CUBICAL_PERF"):
        print("perf: skipped — set CUBICAL_PERF=1 to measure. "
              f"The bar is owned by {OWNER}.")
        return 0

    cores = os.cpu_count() or 1
    under_class = cores < cfg["min_cores"]
    if under_class and not args.force:
        print(f"perf: NOT MEASURED — this machine has {cores} cores, below the "
              f"declared class of {cfg['min_cores']} "
              f"({cfg['reference_machine']}).")
        print("      Roughly a third of the budget is Tantivy, which scales "
              "with min(cores, 8), so asserting the budget here would flake "
              "rather than detect anything.")
        print(f"      Measure on a machine of the dev class. Bar owned by {OWNER}.")
        return 0

    notes = args.notes or cfg["default_notes"]
    budget = next((b for b in cfg["budgets"] if b["notes"] == notes), None)
    if budget is None:
        sizes = ", ".join(str(b["notes"]) for b in cfg["budgets"])
        gate.fail(f"no budget declared for {notes} notes (have: {sizes}) — "
                  f"add one to scripts/perf-budget.json and to {OWNER}.")
        return gate.finish("")

    with tempfile.TemporaryDirectory(prefix="cubical-perf-") as tmp:
        proc = subprocess.run(
            ["cargo", "run", "--release", "-q", "-p", "cubical-core",
             "--example", "scan_bench", "--",
             tmp, str(notes), str(budget["runs"])],
            cwd=ROOT, capture_output=True, text=True,
        )
    if proc.returncode != 0:
        gate.fail("scan_bench failed to run:\n"
                  + (proc.stderr or proc.stdout).strip()[-1500:])
        return gate.finish("")

    print(proc.stdout.strip())
    m = MEDIAN.search(proc.stdout)
    if not m:
        gate.fail("could not parse a median from scan_bench output — the "
                  "harness output format changed; update scripts/gates/perf.py.")
        return gate.finish("")

    median = float(m.group(1))
    cap = budget["max_median_secs"]
    if under_class:
        print(f"\nperf: {median:.2f} s median at {notes} notes on a {cores}-core "
              f"machine (below class — REPORTED, NOT ASSERTED against {cap} s).")
        return 0
    if median > cap:
        gate.fail(f"cold open+scan median {median:.2f} s at {notes} notes "
                  f"exceeds the budget of {cap} s. The bar ratchets down, never "
                  f"up — do not raise it to make this pass. Bar, method and "
                  f"current medians: {OWNER}.")
    elif median < cap * 0.75:
        gate.warn(f"median {median:.2f} s is well under the {cap} s budget — "
                  f"ratchet scripts/perf-budget.json and {OWNER} down.")

    return gate.finish(f"cold open+scan median {median:.2f} s at {notes} notes, "
                       f"within the {cap} s budget.")


main_guard(run)
