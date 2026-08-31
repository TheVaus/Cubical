#!/usr/bin/env python3
"""techstack gate — a new runtime dependency is a doc change first.

Compares the runtime dependency set against the declared set in
scripts/techstack-declared.json. Adding a dependency that is not declared
fails, with a message pointing at the architecture section that must describe
it and the reason it was chosen.

Build-time tooling is not a runtime dependency: devDependencies are ignored
entirely, which is what "no Node runtime in the shipped product" means.

The second half runs the comparison the other way: every bare-specifier import
in ui/src and design-system/src must name a package its own manifest declares.
Without it a package imported but declared nowhere is invisible here, because
the declaration check only ever reads manifests.

Known limit, stated plainly: this proves a dependency was *declared*, not that
the declaration says anything useful. It makes the addition impossible to do
silently; it cannot make the prose good. That part is review.
"""
import json
import re
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "techstack-declared.json"
STACK_DOC = "docs/architecture/foundation.md §2"

SRC_ROOTS = {"ui/src": "ui/package.json",
             "design-system/src": "design-system/package.json"}
ALIASES = ("@ds/",)
SPECIFIER = re.compile(r"""(?:\bfrom|\bimport)\s*\(?\s*['"]([^'"]+)['"]""")


def package_of(specifier: str) -> str:
    parts = specifier.split("/")
    return "/".join(parts[:2]) if specifier.startswith("@") else parts[0]


def check_imports(gate: Gate) -> None:
    for root, manifest in SRC_ROOTS.items():
        pkg = json.loads((ROOT / manifest).read_text(encoding="utf-8"))
        available = set(pkg.get("dependencies", {})) | set(
            pkg.get("devDependencies", {}))
        seen: dict[str, str] = {}
        for path in tracked(root, suffixes=(".ts", ".tsx")):
            for specifier in SPECIFIER.findall(
                    path.read_text(encoding="utf-8")):
                if specifier.startswith((".", "/", "node:")):
                    continue
                if specifier.startswith(ALIASES):
                    continue
                seen.setdefault(package_of(specifier), rel(path))
        for name in sorted(seen.keys() - available):
            gate.fail(f"`{name}` is imported by {seen[name]} but {manifest} "
                      f"does not declare it — it resolves today only because "
                      f"another package hoists it. Add it to {manifest}, and "
                      f"if it is a runtime dependency describe it in "
                      f"{STACK_DOC} and add it to "
                      f"scripts/techstack-declared.json.")


def run() -> int:
    gate = Gate("techstack", "techstack.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    declared_rust = set(cfg["rust"])
    declared_npm = set(cfg["npm"])

    actual_rust: set[str] = set()
    ws = tomllib.loads((ROOT / "Cargo.toml").read_text(encoding="utf-8"))
    actual_rust |= set(ws.get("workspace", {}).get("dependencies", {}))
    for manifest in sorted((ROOT / "crates").glob("*/Cargo.toml")):
        crate = tomllib.loads(manifest.read_text(encoding="utf-8"))
        actual_rust |= set(crate.get("dependencies", {}))
        for target in crate.get("target", {}).values():
            actual_rust |= set(target.get("dependencies", {}))

    actual_npm: set[str] = set()
    for pkg in cfg["npm_manifests"]:
        actual_npm |= set(
            json.loads((ROOT / pkg).read_text(encoding="utf-8"))
            .get("dependencies", {}))

    for name in sorted(actual_rust - declared_rust):
        gate.fail(f"Rust runtime dependency `{name}` is not declared. "
                  f"Describe it in {STACK_DOC} — what it is for and why it was "
                  f"chosen — then add it to scripts/techstack-declared.json.")
    for name in sorted(actual_npm - declared_npm):
        gate.fail(f"npm runtime dependency `{name}` is not declared. "
                  f"Describe it in {STACK_DOC}, then add it to "
                  f"scripts/techstack-declared.json. If it is build-time "
                  f"tooling, it belongs in devDependencies instead.")

    for name in sorted(declared_rust - actual_rust):
        gate.warn(f"`{name}` is declared but no crate depends on it — "
                  f"remove it from scripts/techstack-declared.json and from "
                  f"{STACK_DOC}.")
    for name in sorted(declared_npm - actual_npm):
        gate.warn(f"`{name}` is declared but no package depends on it — "
                  f"remove it from scripts/techstack-declared.json and from "
                  f"{STACK_DOC}.")

    check_imports(gate)

    return gate.finish(f"{len(actual_rust)} Rust and {len(actual_npm)} npm "
                       f"runtime dependencies, all declared; every bare import "
                       f"in ui/src and design-system/src is in a manifest.")


main_guard(run)
