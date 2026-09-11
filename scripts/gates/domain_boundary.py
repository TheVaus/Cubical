#!/usr/bin/env python3
"""domain-boundary gate — a block cannot drag another block down with it.

Three checks over the census in scripts/domain-boundaries.json, one per place
a dependency can be written:

  1. Crates. A substrate crate may not depend on a block crate, and a block
     may not depend on another domain's block.
  2. cubical-engine command modules. Same rule one level down, because the
     engine crate is a shell and check 1 cannot see inside it. A module that
     lives beside `commands/` but belongs to one domain (`engine_support`)
     counts as that domain's, so moving a block's handle out of `commands/`
     does not hide the edges to it.
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
    r"""(?:^\s*(?:import|export)\s[^;]*?from\s+|^\s*import\s+|\bimport\s*\(\s*)"""
    r"""["'](\.[^"']+)["']""", re.M)
ENGINE_USE = re.compile(r"\bcrate::commands::([a-z_]+)")
ENGINE_USE_GROUP = re.compile(r"\bcrate::commands::\{([^}]*)\}")
ENGINE_SUPPORT_USE = re.compile(r"\bcrate::([a-z_]+)")
ENGINE_SUPPORT_GROUP = re.compile(r"\buse\s+crate::\{([^}]*)\}")
GROUP_HEAD = re.compile(r"^\s*([a-z_]+)")


def production_lines(text: str) -> list[tuple[int, str]]:
    """Numbered lines outside any `#[cfg(test)]` item.

    Brace-depth tracked rather than "break at the first #[cfg(test)]": that
    assumed the test module comes last, and commands/graph.rs disproves it with
    a `#[cfg(test)] fn` inside an impl 124 lines above its `mod tests`. Breaking
    there stopped scanning the file's real code silently, which is the failure
    mode a gate must not have.

    Braces inside string literals can skew the depth. An unbalanced one makes
    the gate include test lines (a visible false positive) or skip a few real
    ones; it is counted rather than parsed because the alternative is a Rust
    parser, and the previous heuristic was strictly worse.
    """
    out: list[tuple[int, str]] = []
    depth = 0
    skip_from: int | None = None
    opened = False
    for n, line in enumerate(text.splitlines(), 1):
        if skip_from is None and line.strip().startswith("#[cfg(test)]"):
            skip_from = depth
            opened = "{" in line
            depth += line.count("{") - line.count("}")
            item = line.strip()[len("#[cfg(test)]"):]
            if not opened and ";" in item:
                skip_from = None
            continue
        closed = line.count("}")
        depth += line.count("{") - closed
        if skip_from is not None:
            opened = opened or "{" in line
            if opened and depth <= skip_from and closed:
                skip_from = None
            elif not opened and ";" in line and depth <= skip_from:
                skip_from = None
            continue
        out.append((n, line))
    return out


def production_text(text: str) -> str:
    """The file with every test-only line blanked, line count preserved.

    Matching the whole text rather than line by line is what lets a `use`
    group that spans several lines be seen at all.
    """
    keep = dict(production_lines(text))
    return "\n".join(keep.get(n, "")
                     for n in range(1, len(text.splitlines()) + 1))


def engine_edges(text: str) -> list[tuple[int, str]]:
    """(line, module) for every `crate::commands::x` or `crate::x` it names."""
    prod = production_text(text)
    found: list[tuple[int, str]] = []

    def line_of(pos: int) -> int:
        return prod.count("\n", 0, pos) + 1

    for m in ENGINE_USE.finditer(prod):
        found.append((line_of(m.start()), "commands::" + m.group(1)))
    for m in ENGINE_USE_GROUP.finditer(prod):
        for part in m.group(1).split(","):
            head = GROUP_HEAD.match(part)
            if head and head.group(1) != "self":
                found.append((line_of(m.start()), "commands::" + head.group(1)))
    for m in ENGINE_SUPPORT_USE.finditer(prod):
        found.append((line_of(m.start()), m.group(1)))
    for m in ENGINE_SUPPORT_GROUP.finditer(prod):
        for part in m.group(1).split(","):
            head = GROUP_HEAD.match(part)
            if head:
                found.append((line_of(m.start()), head.group(1)))
    return found


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


TEST_MOD = re.compile(r"^\s*#\[cfg\(test\)\]\s*\n\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([a-z_0-9]+)\s*;", re.M)


def test_only_modules(files: list[Path]) -> set[Path]:
    """Files declared as `#[cfg(test)] mod x;` in their parent module.

    production_lines only sees a `#[cfg(test)]` item inside the file it reads;
    a module whose whole file is test-gated at its declaration looks like
    production code from inside. The principle exempts test code, so the gate
    has to find these rather than grandfather a fixture as if it shipped.
    """
    out: set[Path] = set()
    for f in files:
        if f.name not in ("mod.rs",) and f.parent.name != "commands":
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        base = f.parent if f.name == "mod.rs" else f.parent / f.stem
        for name in TEST_MOD.findall(text):
            for cand in (base / f"{name}.rs", base / name / "mod.rs"):
                out.add(cand)
    return out


def check_engine_modules(gate: Gate, cfg: dict) -> None:
    """Commands and the domain-owned modules beside them, as sources and targets.

    A module outside `commands/` that belongs to one domain is listed in
    `engine_support`; it is checked as a source too, because the watcher and
    the scan dispatcher live there and are substrate, and a support module that
    is only ever a target is one whose own edges nobody reads.
    """
    table = cfg["engine_modules"]
    allowed = cfg["engine_allowed"]
    support = {k: v for k, v in cfg.get("engine_support", {}).items()
               if k != "_"}
    root = "crates/cubical-engine/src/"
    prefix = root + "commands/"
    files = tracked(prefix, suffixes=(".rs",))
    test_only = test_only_modules(files)
    sources: list[tuple[Path, str, tuple[str, str]]] = []
    for f in files:
        if f in test_only:
            continue
        parts = rel(f)[len(prefix):].split("/")
        src_name = parts[0] if len(parts) > 1 else parts[0][:-len(".rs")]
        if src_name == "mod":
            continue
        sources.append((f, src_name, classify(table, src_name)))
    for f in tracked(root, suffixes=(".rs",)):
        parts = rel(f)[len(root):].split("/")
        name = parts[0] if len(parts) > 1 else parts[0][:-len(".rs")]
        if name in support:
            sources.append((f, name, classify(support, name)))
    for f, src_name, src in sources:
        text = f.read_text(encoding="utf-8", errors="replace")
        for n, target in engine_edges(text):
            if target.startswith("commands::"):
                dst_name = target[len("commands::"):]
                dst = classify(table, dst_name)
            elif target in support:
                dst_name = target
                dst = classify(support, target)
            else:
                continue
            if dst_name == src_name:
                continue
            why = verdict(src, dst)
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
        # Whole text, not line by line: a braced import puts `from` several
        # lines below `import`, so a per-line match sees neither half. The
        # class is negated rather than dotted precisely so it spans newlines.
        for m in UI_IMPORT.finditer(text):
            target = posixpath.normpath(
                posixpath.join(posixpath.dirname(r), m.group(1)))
            dst_name = ui_domain(target)
            if dst_name is None or dst_name == src_name:
                continue
            why = verdict(src, classify(table, dst_name))
            if why and f"{src_name} -> {dst_name}" not in allowed:
                n = text.count("\n", 0, m.start()) + 1
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
