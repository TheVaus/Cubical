#!/usr/bin/env python3
"""ds-colours gate — colour literals in ui/src stay within budget.

A ratchet, not a ban. Budgets live in scripts/ds-color-literals.json, which is
the single source both this gate and docs/principles/design-system.md read.

design-system/src/styles/tokens.css owns every colour. ui/ spends tokens via
var(); a hex or rgb()/hsl() literal in ui/src is drift unless it is a runtime
fallback for a surface that cannot read CSS variables.

Fails on: a file over budget, a new file carrying a literal, or a budget entry
for a file that no longer exists. Does not fail when a count drops.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "ds-color-literals.json"

LITERAL = re.compile(
    r"#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b"
    r"|\brgba?\(\s*\d"
    r"|\bhsla?\(\s*\d")


def run() -> int:
    gate = Gate("ds-colours", "design-system.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    budgets = cfg["budgets"]

    seen: dict[str, int] = {}
    for f in tracked("ui/src/", suffixes=(".css", ".ts", ".tsx")):
        r = rel(f)
        if ".test." in r:
            continue
        n = len(LITERAL.findall(f.read_text(encoding="utf-8", errors="replace")))
        if n:
            seen[r] = n

    for r, n in sorted(seen.items()):
        allowed = budgets.get(r)
        if allowed is None:
            gate.fail(
                f"{r}: {n} colour literal(s) in a file with no budget. Use a "
                f"token from design-system/src/styles/tokens.css via var(). If "
                f"the surface genuinely cannot read CSS variables, add a budget "
                f"entry to scripts/ds-color-literals.json saying why.")
            continue
        cap = allowed["count"]
        if n > cap:
            gate.fail(
                f"{r}: {n} colour literals exceeds its budget of {cap}. Add the "
                f"colour to design-system/src/styles/tokens.css and spend it "
                f"through var(), or raise the budget deliberately in "
                f"scripts/ds-color-literals.json and say why.")
        elif n < cap:
            gate.warn(
                f"{r}: down to {n} colour literals from a budget of {cap} — "
                f"ratchet scripts/ds-color-literals.json down to {n}.")

    for r in sorted(budgets):
        if not (ROOT / r).exists():
            gate.fail(f"scripts/ds-color-literals.json budgets {r}, "
                      f"which no longer exists — remove the entry.")
        elif r not in seen:
            gate.warn(f"{r} has a budget but no colour literals left — "
                      f"remove its entry from scripts/ds-color-literals.json.")

    total = sum(seen.values())
    return gate.finish(
        f"{total} colour literals across {len(seen)} files, all within budget.")


main_guard(run)
