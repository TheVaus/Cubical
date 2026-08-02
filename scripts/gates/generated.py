#!/usr/bin/env python3
"""generated gate — every generated artifact reproduces byte-identically.

Runs each generator with --check, which regenerates in memory and compares
against the tracked file. Nothing is written, so the gate is safe to run on a
dirty tree and in CI.
"""
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard  # noqa: E402

GENERATORS = (
    ("scripts/gen_repo_layout.py", "docs/generated/repo-layout.md"),
    ("scripts/gen_ipc_surface.py", "docs/generated/ipc-surface.md"),
    ("scripts/gen_ds_inventory.py", "design-system/INVENTORY.md"),
    ("scripts/gen_principles_readme.py", "docs/principles/README.md"),
)

BANNER = "do not edit"


def run() -> int:
    gate = Gate("generated", "generated-artifacts.md")

    for script, artifact in GENERATORS:
        proc = subprocess.run(
            [sys.executable, script, "--check"],
            cwd=ROOT, capture_output=True, text=True,
        )
        if proc.returncode != 0:
            detail = (proc.stdout + proc.stderr).strip().splitlines()
            gate.fail(f"{artifact} is stale or its generator errored — "
                      f"run `python3 {script}` and commit the result"
                      + (f" [{detail[-1]}]" if detail else ""))

        path = ROOT / artifact
        if not path.exists():
            gate.fail(f"{artifact} is missing — run `python3 {script}`")
        elif BANNER not in path.read_text(encoding="utf-8",
                                          errors="replace").split("\n", 1)[0]:
            gate.fail(f"{artifact}: first line is not the do-not-edit banner")

    return gate.finish(f"all {len(GENERATORS)} artifacts reproduce byte-identically.")


main_guard(run)
