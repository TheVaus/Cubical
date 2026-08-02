#!/usr/bin/env python3
"""symbol-anchors gate — implementation docs name code that still exists.

Convention, one line per invariant:

    **Anchors:** adopt_external_rename · validate_adopted · commit_rename

Every symbol must be found in the tracked source. Catches the failure mode the
no-comments rule creates: rationale that moved out of the code and then lost
track of it.

Known limit, stated in the principle too: this catches DELETED code, not
CHANGED code. A function that keeps its name and reverses its meaning passes.
"""
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

ANCHOR_LINE = re.compile(r"^\*\*Anchors:\*\*\s*(?P<body>.+?)\s*$", re.M)
SEP = re.compile(r"\s*[·,]\s*")
SYMBOL_OK = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

SOURCE_PREFIXES = ("crates/", "ui/src/", "design-system/src/")
SOURCE_SUFFIXES = (".rs", ".ts", ".tsx", ".sql")


def source_blob() -> str:
    parts = []
    for f in tracked(*SOURCE_PREFIXES, suffixes=SOURCE_SUFFIXES):
        parts.append(f.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(parts)


def run() -> int:
    gate = Gate("symbol-anchors", "implementation-anchors.md")
    blob = source_blob()
    word = {}

    docs = [f for f in tracked("docs/implementation/", suffixes=(".md",))]
    checked = 0
    for f in docs:
        text = f.read_text(encoding="utf-8", errors="replace")
        for m in ANCHOR_LINE.finditer(text):
            line_no = text[:m.start()].count("\n") + 1
            for raw in SEP.split(m.group("body")):
                sym = raw.strip().strip("`")
                if not sym:
                    continue
                if not SYMBOL_OK.match(sym):
                    gate.fail(f"{rel(f)}:{line_no}: anchor `{sym}` is not a bare "
                              f"symbol name. Use function/type/constant names, "
                              f"not paths or line numbers — line numbers drift.")
                    continue
                checked += 1
                if sym not in word:
                    word[sym] = re.search(rf"\b{re.escape(sym)}\b", blob) is not None
                if not word[sym]:
                    gate.fail(
                        f"{rel(f)}:{line_no}: anchor `{sym}` does not exist in "
                        f"the tracked source. Either the symbol was renamed or "
                        f"deleted and this doc now describes code that is gone — "
                        f"update the doc in the same commit as the code.")

    unanchored = [rel(f) for f in docs
                  if f.name != "README.md" and not ANCHOR_LINE.search(
                      f.read_text(encoding="utf-8", errors="replace"))]
    for r in unanchored:
        gate.warn(f"{r} has no **Anchors:** line — the gate cannot tell whether "
                  f"it still describes real code.")

    return gate.finish(f"{checked} anchors across {len(docs)} implementation "
                       f"docs all resolve to tracked source.")


main_guard(run)
