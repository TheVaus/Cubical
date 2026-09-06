#!/usr/bin/env python3
"""domain-boundary gate — a block cannot drag another block down with it.

Three checks over the census in scripts/domain-boundaries.json, one per place
a dependency can be written:

  1. Crates. A substrate crate may not depend on a block crate, and a block
     may not depend on another domain's block.
  2. cubical-engine command modules. Same rule one level down, because the
     engine crate is a shell and check 1 cannot see inside it.
  3. ui/src domains. Same rule again on the frontend.

The rule is edges, not sizes. A wide module is not a violation; a module that
makes an unrelated feature's failure your failure is. `dependency_boundary.py`
answers "may this layer call down to that one" — this gate answers "may these
two features know about each other at all", which layering cannot express
because two blocks sit on the same layer by construction.

Fails on a new edge only. Every pre-existing edge is grandfathered in the
config with the issue that tracks removing it, so the gate landed green and
the paydown list is the config diff.
"""
import json
import posixpath
import re
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "domain-boundaries.json"

UI_IMPORT = re.compile(
    r"""^\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']""", re.M)
ENGINE_USE = re.compile(r"\bcrate::commands::([a-z_]+)")


def classify(cfg_table: dict, name: str) -> tuple[str, str]:
    entry = cfg_table.get(name)
    if entry is None:
        return ("block", name)
    return (entry["class"], entry["domain"])


def verdict(src: tuple[str, str], dst: tuple[str, str]) -> str | None:
    """Why this edge is illegal, or None if it is fine."""
    src_class, src_domain = src
    dst_class, dst_domain = dst
    if src_domain == dst_domain:
        return None
    if src_class == "shell":
        return None
    if dst_class == "substrate":
        return None
    if dst_class == "shell":
        return (f"a {src_class} depends on the shell — the composition root "
                f"wires features together, it is not a library they call into")
    if src_class == "substrate":
        return (f"substrate depends on the {dst_domain} block — substrate is "
                f"always on, so this makes the block always on too")
    return (f"the {src_domain} block depends on the {dst_domain} block — "
            f"either failing now takes the other with it")


def check_crates(gate: Gate, cfg: dict) -> None:
    table = cfg["crates"]
    allowed = cfg["crate_allowed"]
    for f in tracked("crates/", suffixes=("Cargo.toml",)):
        crate = rel(f).split("/")[1]
        manifest = tomllib.loads(f.read_text(encoding="utf-8"))
        deps: set[str] = set()
        for section in ("dependencies", "dev-dependencies"):
            deps |= set(manifest.get(section, {}))
        for dep in sorted(d for d in deps if d in table and d != crate):
            why = verdict(classify(table, crate), classify(table, dep))
            if why and f"{crate} -> {dep}" not in allowed:
                gate.fail(f"{rel(f)}: {why}. Declare it in "
                          f"scripts/domain-boundaries.json with the issue that "
                          f"tracks removing it, or route it through the shell.")


def check_engine_modules(gate: Gate, cfg: dict) -> None:
    table = cfg["engine_modules"]
    allowed = cfg["engine_allowed"]
    prefix = "crates/cubical-engine/src/commands/"
    for f in tracked(prefix, suffixes=(".rs",)):
        parts = rel(f)[len(prefix):].split("/")
        src_name = parts[0] if len(parts) > 1 else parts[0][:-len(".rs")]
        if src_name == "mod":
            continue
        src = classify(table, src_name)
        text = f.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            # Everything from the first `#[cfg(test)]` on is test code, which
            # may reach anywhere — the same exemption the ui check gives
            # `.test.` files. Rust convention puts that module last; a gate
            # that policed test wiring would be enforcing a rule nobody has.
            if line.lstrip().startswith("#[cfg(test)]"):
                break
            for dst_name in ENGINE_USE.findall(line):
                if dst_name == src_name:
                    continue
                why = verdict(src, classify(table, dst_name))
                if why and f"{src_name} -> {dst_name}" not in allowed:
                    gate.fail(f"{rel(f)}:{n}: {why}.")


def ui_domain(path: str) -> str | None:
    """Domain of a ui/src path. A directory is a domain; so is a bare file.

    posixpath, not Path: these are repo-relative keys with forward slashes,
    and Path would resolve them against the filesystem root on Windows.
    """
    if not path.startswith("ui/src/"):
        return None
    head = path[len("ui/src/"):].split("/")[0]
    for suffix in (".tsx", ".ts"):
        if head.endswith(suffix):
            return head[: -len(suffix)]
    return head


def check_ui(gate: Gate, cfg: dict) -> None:
    table = cfg["ui_domains"]
    allowed = cfg["ui_allowed"]
    for f in tracked("ui/src/", suffixes=(".ts", ".tsx")):
        r = rel(f)
        if ".test." in r:
            continue
        src_name = ui_domain(r)
        src = classify(table, src_name)
        text = f.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            for spec in UI_IMPORT.findall(line):
                target = posixpath.normpath(
                    posixpath.join(posixpath.dirname(r), spec))
                dst_name = ui_domain(target)
                if dst_name is None or dst_name == src_name:
                    continue
                why = verdict(src, classify(table, dst_name))
                if why and f"{src_name} -> {dst_name}" not in allowed:
                    gate.fail(f"{r}:{n}: {why}.")


def run() -> int:
    gate = Gate("domain-boundary", "domain-scoped-dependencies.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    check_crates(gate, cfg)
    check_engine_modules(gate, cfg)
    check_ui(gate, cfg)
    return gate.finish(
        f"no block depends on another domain's block "
        f"({len(cfg['crate_allowed'])} crate, {len(cfg['engine_allowed'])} "
        f"engine, {len(cfg['ui_allowed'])} ui edges grandfathered).")


main_guard(run)
