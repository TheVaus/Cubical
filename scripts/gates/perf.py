#!/usr/bin/env python3
"""perf gate — the measured benchmarks stay inside their budgets.

Opt-in by default: a 10k-note cold scan takes minutes, so running it on every
`check.sh` would make the gate too slow to run, which is the surest way to stop
people running the gate. Enable with CUBICAL_PERF=1.

    CUBICAL_PERF=1 python3 scripts/gates/perf.py                       # every benchmark
    CUBICAL_PERF=1 python3 scripts/gates/perf.py --benchmark scan --size 10000
    CUBICAL_PERF=1 python3 scripts/gates/perf.py --benchmark graph_layout

The gate refuses to assert on a machine below the declared class rather than
scaling the budget by a guess — see scripts/perf-budget.json for why.
"""
import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard  # noqa: E402

CONFIG = ROOT / "scripts" / "perf-budget.json"
OWNER = "docs/architecture/foundation.md §1 (commitment 2)"


def measure(gate, name, spec, size, cores, under_class):
    budget = next((b for b in spec["budgets"] if b["size"] == size), None)
    if budget is None:
        sizes = ", ".join(str(b["size"]) for b in spec["budgets"])
        gate.fail(f"{name}: no budget declared for {size} "
                  f"{spec['size_noun']} (have: {sizes}) — add one to "
                  f"scripts/perf-budget.json and to {OWNER}.")
        return

    runs = budget["runs"]
    invocations = runs if spec["gate_repeats"] else 1
    pattern = re.compile(spec["median_pattern"], re.M)
    samples = []

    for _ in range(invocations):
        with tempfile.TemporaryDirectory(prefix="cubical-perf-") as tmp:
            args = [a.format(tmpdir=tmp, size=size, runs=runs)
                    for a in spec["args"]]
            proc = subprocess.run(
                ["cargo", "run", "--release", "-q",
                 "-p", spec["crate"], "--example", spec["example"], "--"] + args,
                cwd=ROOT, capture_output=True, text=True,
            )
        if proc.returncode != 0:
            gate.fail(f"{spec['example']} failed to run:\n"
                      + (proc.stderr or proc.stdout).strip()[-1500:])
            return
        print(proc.stdout.strip())
        m = pattern.search(proc.stdout)
        if not m:
            gate.fail(f"could not parse a median from {spec['example']} output "
                      f"— the harness output format changed; update "
                      f"scripts/perf-budget.json's median_pattern.")
            return
        samples.append(float(m.group(1)))

    median = statistics.median(samples)
    cap = budget["max_median_secs"]
    noun = spec["size_noun"]
    label = spec["label"]

    if under_class:
        print(f"\nperf: {median:.2f} s median at {size} {noun} on a {cores}-core "
              f"machine (below class — REPORTED, NOT ASSERTED against {cap} s).")
        return

    if median > cap:
        gate.fail(f"{label} median {median:.2f} s at {size} {noun} exceeds the "
                  f"budget of {cap} s. The bar ratchets down, never up — do not "
                  f"raise it to make this pass. Bar, method and current "
                  f"medians: {OWNER}.")
    elif median < cap * 0.75:
        gate.warn(f"{label} median {median:.2f} s is well under the {cap} s "
                  f"budget — ratchet scripts/perf-budget.json and {OWNER} down.")
    else:
        print(f"perf: {label} median {median:.2f} s at {size} {noun}, "
              f"within the {cap} s budget.")


def run() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", default=None,
                    help="which benchmark to measure (default: all)")
    ap.add_argument("--size", type=int, default=None)
    ap.add_argument("--notes", type=int, default=None,
                    help="deprecated alias for --size")
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
        print("      Roughly a third of the scan budget is Tantivy, which "
              "scales with min(cores, 8), so asserting the budget here would "
              "flake rather than detect anything.")
        print(f"      Measure on a machine of the dev class. Bar owned by {OWNER}.")
        return 0

    if args.benchmark is not None and args.benchmark not in cfg["benchmarks"]:
        known = ", ".join(cfg["benchmarks"])
        gate.fail(f"unknown benchmark {args.benchmark!r} (have: {known}).")
        return gate.finish("")

    names = [args.benchmark] if args.benchmark else list(cfg["benchmarks"])
    size = args.size if args.size is not None else args.notes
    if size is not None and len(names) > 1:
        gate.fail("--size applies to a single benchmark — pass --benchmark too.")
        return gate.finish("")

    for name in names:
        spec = cfg["benchmarks"][name]
        measure(gate, name, spec, size or spec["default_size"], cores, under_class)

    return gate.finish(f"measured: {', '.join(names)}.")


main_guard(run)
