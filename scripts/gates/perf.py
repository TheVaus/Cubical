#!/usr/bin/env python3
"""perf gate — the measured benchmarks stay inside their measured budgets.

Opt-in by default: a 10k-note cold scan takes minutes, so running it on every
`check.sh` would make the gate too slow to run, which is the surest way to stop
people running the gate. Enable with CUBICAL_PERF=1.

    CUBICAL_PERF=1 python3 scripts/gates/perf.py                          # 1k scan bar
    CUBICAL_PERF=1 python3 scripts/gates/perf.py --size 10000
    CUBICAL_PERF=1 python3 scripts/gates/perf.py --benchmark graph_layout

Which benchmarks exist, how to drive them and what they may cost is declared in
scripts/perf-budget.json; this file knows how to run one, not which ones there
are. --notes is kept as an alias for --size so existing invocations still work.

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
OWNER = "docs/architecture/foundation.md §1 (commitment 2)"


def run() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", default="scan")
    ap.add_argument("--size", "--notes", dest="size", type=int, default=None)
    ap.add_argument("--force", action="store_true",
                    help="measure even below the declared machine class "
                         "(reports, never asserts)")
    args = ap.parse_args()

    gate = Gate("perf", "performance.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    bench = cfg["benchmarks"].get(args.benchmark)
    if bench is None:
        known = ", ".join(sorted(cfg["benchmarks"]))
        gate.fail(f"no benchmark named `{args.benchmark}` (have: {known}) — "
                  f"declare it in scripts/perf-budget.json and in {OWNER}.")
        return gate.finish("")

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
        print("      The budgets are wall-clock and core-sensitive, so "
              "asserting them here would flake rather than detect anything.")
        print(f"      Measure on a machine of the dev class. Bar owned by {OWNER}.")
        return 0

    unit = bench.get("unit", "items")
    label = bench.get("label", args.benchmark)
    size = args.size or bench["default_size"]
    budget = next((b for b in bench["budgets"] if b["size"] == size), None)
    if budget is None:
        sizes = ", ".join(str(b["size"]) for b in bench["budgets"])
        gate.fail(f"no budget declared for {size} {unit} on `{args.benchmark}` "
                  f"(have: {sizes}) — add one to scripts/perf-budget.json and "
                  f"to {OWNER}.")
        return gate.finish("")

    with tempfile.TemporaryDirectory(prefix="cubical-perf-") as tmp:
        argv = [a.format(tmpdir=tmp, size=size, runs=budget["runs"])
                for a in bench["args"]]
        proc = subprocess.run(
            ["cargo", "run", "--release", "-q", "-p", bench["crate"],
             "--example", bench["example"], "--", *argv],
            cwd=ROOT, capture_output=True, text=True,
        )
    if proc.returncode != 0:
        gate.fail(f"{bench['example']} failed to run:\n"
                  + (proc.stderr or proc.stdout).strip()[-1500:])
        return gate.finish("")

    print(proc.stdout.strip())
    m = re.search(bench["median_pattern"], proc.stdout, re.M)
    if not m:
        gate.fail(f"could not parse a median from {bench['example']} output — "
                  f"the harness output format changed; update "
                  f"`median_pattern` in scripts/perf-budget.json.")
        return gate.finish("")

    median = float(m.group(1))
    cap = budget["max_median_secs"]
    if under_class:
        print(f"\nperf: {median:.2f} s median at {size} {unit} on a {cores}-core "
              f"machine (below class — REPORTED, NOT ASSERTED against {cap} s).")
        return 0
    if median > cap:
        gate.fail(f"{label} median {median:.2f} s at {size} {unit} exceeds the "
                  f"budget of {cap} s. The bar ratchets down, never up — do not "
                  f"raise it to make this pass. Bar, method and current "
                  f"medians: {OWNER}.")
    elif median < cap * 0.75:
        gate.warn(f"median {median:.2f} s is well under the {cap} s budget — "
                  f"ratchet scripts/perf-budget.json and {OWNER} down.")

    return gate.finish(f"{label} median {median:.2f} s at {size} {unit}, "
                       f"within the {cap} s budget.")


main_guard(run)
