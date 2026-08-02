#!/usr/bin/env python3
"""Shared plumbing for the gate scripts in this directory.

Every gate reports failures through `Gate`, which prints the owning principle
file with the failure. A gate that says "no" trains an agent to route around
it; one that says "no, and here is the rule" redirects.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], text=True).strip())


def tracked(*prefixes: str, suffixes: tuple[str, ...] = ()) -> list[Path]:
    """Tracked files under any of `prefixes`, optionally filtered by suffix.

    Tracked-only on purpose: ui/dist/ is a build artifact left in the tree and
    a filesystem walk drowns in minified bundles.
    """
    out = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True)
    files = []
    for line in out.splitlines():
        if not line:
            continue
        if prefixes and not line.startswith(prefixes):
            continue
        if suffixes and not line.endswith(suffixes):
            continue
        files.append(ROOT / line)
    return files


def rel(p: Path) -> str:
    return str(p.relative_to(ROOT))


class Gate:
    def __init__(self, name: str, principle: str):
        self.name = name
        self.principle = principle
        self.fails: list[str] = []
        self.warns: list[str] = []

    def fail(self, message: str) -> None:
        self.fails.append(message)

    def warn(self, message: str) -> None:
        self.warns.append(message)

    def finish(self, ok_message: str) -> int:
        for w in self.warns:
            print(f"  warn: {w}")
        if not self.fails:
            print(f"{self.name}: {ok_message}")
            return 0
        print(f"{self.name} FAILED — the rule is docs/principles/{self.principle}")
        for f in self.fails:
            print(f"  - {f}")
        print(f"\nRead docs/principles/{self.principle} before changing this. "
              f"If the rule is wrong, change the rule and its gate together; "
              f"do not route around the gate.")
        return 1


def main_guard(fn) -> None:
    sys.exit(fn())
