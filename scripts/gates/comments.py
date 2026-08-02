#!/usr/bin/env python3
"""comments gate — source carries no explanatory comments.

Rust: no `///` or `//!`.  TS/TSX: no `/**` JSDoc blocks.
Baseline is 0 violations, so this is a pure ratchet.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import Gate, main_guard, rel, tracked  # noqa: E402

RUST_DOC = re.compile(r"^\s*(///|//!)")
JSDOC = re.compile(r"/\*\*")

# Comment-shaped lines the toolchain READS. Removing them breaks the build or
# drops tests to the wrong environment. Owned by principles/no-comments.md.
PRAGMAS = (
    "@vitest-environment",
    "<reference types=",
)


def is_pragma(line: str) -> bool:
    return any(p in line for p in PRAGMAS)


def run() -> int:
    gate = Gate("comments", "no-comments.md")

    for f in tracked("crates/", suffixes=(".rs",)):
        for n, line in enumerate(f.read_text(encoding="utf-8", errors="replace")
                                 .splitlines(), 1):
            if RUST_DOC.match(line) and not is_pragma(line):
                gate.fail(f"{rel(f)}:{n}: doc-comment — move it to docs/implementation/")

    for f in tracked("ui/src/", "design-system/src/",
                     suffixes=(".ts", ".tsx", ".js", ".jsx")):
        text = f.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            if JSDOC.search(line) and not is_pragma(line):
                gate.fail(f"{rel(f)}:{n}: JSDoc block — move it to docs/implementation/")

    return gate.finish("no doc-comments in crates/, ui/src/ or design-system/src/.")


main_guard(run)
