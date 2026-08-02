#!/usr/bin/env python3
"""dependency-boundary gate — the layering holds.

Three checks:

  1. Tauri appears only in cubical-app. Every other crate stays buildable and
     testable without the desktop app harness, which is what keeps a second
     frontend (the CLI) and a future mobile shell from being a rewrite.
  2. ui/ reaches Tauri only through its typed IPC surface (ui/src/api/).
     Type-only imports are erased at compile time and do not count.
  3. No crate depends on a crate above it in the layering.

Replaces the hand-maintained inventory that used to live in
docs/migration-touchpoints.md — a list nothing checked.
"""
import json
import re
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "dependency-boundary.json"

# Lower number = lower layer. A crate may depend on strictly lower layers only.
LAYERS = {
    "cubical-ast": 0,
    "cubical-index": 0,
    "cubical-search": 1,
    "cubical-query": 1,
    "cubical-sync": 1,
    "cubical-core": 2,
    "cubical-engine": 3,
    "cubical-ipc": 4,
    "cubical-app": 5,
    "cubical-cli": 5,
}

TAURI_IMPORT = re.compile(r"""(?<!import type )from\s+["'](@tauri-apps/[^"']+)["']""")
TYPE_ONLY = re.compile(r"^\s*import\s+type\s")


def run() -> int:
    gate = Gate("dependency-boundary", "crate-separation.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))

    # ---- 1. Tauri stays inside cubical-app ----
    for f in tracked("crates/", suffixes=("Cargo.toml",)):
        crate = rel(f).split("/")[1]
        manifest = tomllib.loads(f.read_text(encoding="utf-8"))
        deps = set()
        for section in ("dependencies", "dev-dependencies", "build-dependencies"):
            deps |= set(manifest.get(section, {}))
        tauri = {d for d in deps if d == "tauri" or d.startswith("tauri-")}
        if tauri and crate not in cfg["tauri_crates"]:
            gate.fail(f"{rel(f)}: {crate} depends on {sorted(tauri)}. "
                      f"Only {cfg['tauri_crates']} may depend on Tauri — every "
                      f"other crate stays buildable without the app harness.")

    for f in tracked("crates/", suffixes=(".rs",)):
        crate = rel(f).split("/")[1]
        if crate in cfg["tauri_crates"]:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            if "tauri::" in line:
                gate.fail(f"{rel(f)}:{n}: `tauri::` outside "
                          f"{cfg['tauri_crates']} — route it through cubical-ipc.")

    # ---- 2. ui/ reaches Tauri only through ui/src/api/ ----
    for f in tracked("ui/src/", suffixes=(".ts", ".tsx")):
        r = rel(f)
        if r.startswith(tuple(cfg["ipc_surface"])) or ".test." in r:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            m = TAURI_IMPORT.search(line)
            if not m or TYPE_ONLY.match(line):
                continue
            if f"{r}:{m.group(1)}" in cfg["ui_exceptions"]:
                continue
            gate.fail(
                f"{r}:{n}: imports {m.group(1)} outside the typed IPC surface "
                f"({', '.join(cfg['ipc_surface'])}). Add a command to "
                f"cubical-ipc and call it through ui/src/api/ipc.ts, or declare "
                f"the exception in scripts/dependency-boundary.json.")

    # ---- 3. layering ----
    for f in tracked("crates/", suffixes=("Cargo.toml",)):
        crate = rel(f).split("/")[1]
        if crate not in LAYERS:
            gate.fail(f"{crate} has no entry in LAYERS "
                      f"(scripts/gates/dependency_boundary.py) — place it in the "
                      f"layering before adding dependencies to it.")
            continue
        manifest = tomllib.loads(f.read_text(encoding="utf-8"))
        deps = set()
        for section in ("dependencies", "dev-dependencies"):
            deps |= set(manifest.get(section, {}))
        for d in sorted(deps & set(LAYERS)):
            if d == crate:
                continue
            if LAYERS[d] >= LAYERS[crate]:
                gate.fail(f"{crate} (layer {LAYERS[crate]}) depends on {d} "
                          f"(layer {LAYERS[d]}) — that is sideways or upward. "
                          f"Dependencies point down only.")

    return gate.finish("Tauri confined to the app crate, ui/ routed through the "
                       "IPC surface, crate layering intact.")


main_guard(run)
