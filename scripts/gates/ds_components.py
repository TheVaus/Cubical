#!/usr/bin/env python3
"""ds-components gate — raw HTML controls in ui/src stay within budget.

A ratchet, not a ban. Budgets live in scripts/ds-raw-controls.json, which is
the single source both this gate and docs/architecture/ui.md 11.6 read.

Fails on: a file over budget, a new file using a raw control, or a budget
entry for a file that no longer exists (so the allowlist cannot rot).
Does not fail when a count drops — it tells you to ratchet.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "ds-raw-controls.json"


def run() -> int:
    gate = Gate("ds-components", "design-system.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    controls = cfg["controls"]
    budgets = cfg["budgets"]
    pat = {t: re.compile(rf"<{t}(?=[\s/>])") for t in controls}

    seen: dict[str, dict[str, int]] = {}
    for f in tracked("ui/src/", suffixes=(".tsx", ".jsx")):
        r = rel(f)
        if ".test." in r:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        counts = {t: len(pat[t].findall(text)) for t in controls}
        counts = {t: n for t, n in counts.items() if n}
        if counts:
            seen[r] = counts

    for r, counts in sorted(seen.items()):
        allowed = budgets.get(r)
        if allowed is None:
            detail = ", ".join(f"{n}x <{t}>" for t, n in sorted(counts.items()))
            gate.fail(
                f"{r}: raw controls ({detail}) in a file with no budget. "
                f"Read design-system/INVENTORY.md first — the component probably "
                f"exists. If it genuinely does not, add a budget entry to "
                f"scripts/ds-raw-controls.json saying why.")
            continue
        for t, n in sorted(counts.items()):
            cap = allowed.get(t, 0)
            if n > cap:
                gate.fail(
                    f"{r}: {n}x <{t}> exceeds its budget of {cap}. "
                    f"Use the design-system component "
                    f"(see design-system/INVENTORY.md), or raise the budget "
                    f"deliberately in scripts/ds-raw-controls.json and say why.")
            elif n < cap:
                gate.warn(
                    f"{r}: <{t}> is down to {n} from a budget of {cap} — "
                    f"ratchet scripts/ds-raw-controls.json down to {n}.")

    for r in sorted(budgets):
        if not (ROOT / r).exists():
            gate.fail(f"scripts/ds-raw-controls.json budgets {r}, "
                      f"which no longer exists — remove the entry.")
        elif r not in seen:
            gate.warn(f"{r} has a budget but no raw controls left — "
                      f"remove its entry from scripts/ds-raw-controls.json.")

    total = sum(sum(c.values()) for c in seen.values())
    return gate.finish(f"{total} raw controls across {len(seen)} files, all within budget.")


main_guard(run)
