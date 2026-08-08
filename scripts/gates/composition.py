#!/usr/bin/env python3
"""composition gate — ui/src stays a set of feature-owned components.

Two checks, because either alone is trivially satisfied:

  1. A per-file size ratchet over tracked non-test ui/src/**/*.{ts,tsx}.
     Budgets live in scripts/component-budgets.json, which is the single
     source both this gate and docs/architecture/ui.md 11.7 read.

  2. A shell rule on App.tsx: a cap on how much state it may declare, and a
     ban on importing the IPC surface directly. The size cap alone does not
     stop App.tsx re-absorbing features — a feature can be added in far fewer
     lines than a cap notices. It cannot be added without an IPC call.

Fails on: a file over budget, a file over the default cap with no budget, a
budget entry naming a file that no longer exists, the shell declaring more
state than its cap, or the shell importing a forbidden module unwaived.
Does not fail when a count drops — it tells you to ratchet.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "component-budgets.json"

# Bare identifier, not `name(`: a generic type argument sits between the two
# (createSignal<FileEntry[]>([])) and matching across it needs balanced angle
# brackets, which a regex cannot do.
REACTIVE = re.compile(r"\bcreate(?:Signal|Store)\b")
IMPORT_LINE = re.compile(r"^\s*(?:import|export)\s|^\s*[\w{},\s]+\}\s*from\s")


def import_sources(text: str) -> set[str]:
    return set(re.findall(r"""^\s*import\s[^;]*?from\s+["']([^"']+)["']""",
                          text, re.M))


def check_sizes(gate: Gate, cfg: dict) -> tuple[int, int]:
    budgets = cfg["budgets"]
    default = cfg["default_max_lines"]

    seen: dict[str, int] = {}
    for f in tracked("ui/src/", suffixes=(".ts", ".tsx")):
        r = rel(f)
        if ".test." in r:
            continue
        seen[r] = len(f.read_text(encoding="utf-8", errors="replace")
                      .splitlines())

    for r, n in sorted(seen.items()):
        entry = budgets.get(r)
        if entry is None:
            if n > default:
                gate.fail(
                    f"{r}: {n} lines exceeds the default cap of {default} and "
                    f"has no budget. Split it into a feature-owned component, "
                    f"or add an entry to scripts/component-budgets.json saying "
                    f"why it is one cohesive thing.")
            continue
        cap = entry["max_lines"]
        if n > cap:
            gate.fail(
                f"{r}: {n} lines exceeds its budget of {cap}. Split it, or "
                f"raise the budget deliberately in "
                f"scripts/component-budgets.json and say why.")
        elif n < cap:
            gate.warn(f"{r}: down to {n} lines from a budget of {cap} — "
                      f"ratchet scripts/component-budgets.json down to {n}.")

    for r in sorted(budgets):
        if not (ROOT / r).exists():
            gate.fail(f"scripts/component-budgets.json budgets {r}, which no "
                      f"longer exists — remove the entry.")
        elif seen.get(r, 0) <= default:
            gate.warn(f"{r} is under the default cap of {default} — remove its "
                      f"entry from scripts/component-budgets.json.")

    return len(seen), sum(seen.values())


def check_shell(gate: Gate, cfg: dict) -> None:
    shell = cfg["shell"]
    path = ROOT / shell["file"]
    if not path.exists():
        gate.fail(f"scripts/component-budgets.json names {shell['file']} as "
                  f"the shell, but it does not exist.")
        return

    text = path.read_text(encoding="utf-8", errors="replace")
    r = shell["file"]

    body = [ln for ln in text.splitlines() if not IMPORT_LINE.match(ln)]
    found = len(REACTIVE.findall("\n".join(body)))
    cap = shell["max_reactive_declarations"]
    if found > cap:
        gate.fail(
            f"{r}: declares {found} signals/stores, over its cap of {cap}. "
            f"The shell composes features; it does not hold their state. Put "
            f"the new state in the feature that reads it.")
    elif found < cap:
        gate.warn(f"{r}: down to {found} signals/stores from a cap of {cap} — "
                  f"ratchet scripts/component-budgets.json down to {found}.")

    waived = shell.get("waived_imports", {})
    sources = import_sources(text)
    for forbidden in shell["forbidden_imports"]:
        if forbidden not in sources:
            if forbidden in waived:
                gate.warn(
                    f"{r} no longer imports {forbidden} — drop it from "
                    f"waived_imports in scripts/component-budgets.json so the "
                    f"ban starts being enforced.")
            continue
        entry = waived.get(forbidden)
        if entry is None:
            gate.fail(
                f"{r}: imports {forbidden}. The shell wires features together; "
                f"features call IPC. Move the call into the feature that needs "
                f"it, or waive it deliberately in "
                f"scripts/component-budgets.json with an issue.")
        else:
            gate.warn(
                f"{r}: still imports {forbidden} (waived, issue "
                f"#{entry['issue']}). {entry['note']}")


def run() -> int:
    gate = Gate("composition", "component-composition.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    files, total = check_sizes(gate, cfg)
    check_shell(gate, cfg)
    return gate.finish(f"{files} files, {total} lines in ui/src, all within "
                       f"budget.")


main_guard(run)
