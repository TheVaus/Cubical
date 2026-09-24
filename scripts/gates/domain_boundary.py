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
     does not hide the edges to it. A workspace crate such a module names
     (`cubical_search::…`) is an edge to that crate's census entry, because
     check 1 sees only the engine's manifest, and the engine is shell.
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
import posixpath
import re
import sys
import tomllib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import Gate, main_guard, rel, tracked  # noqa: E402
from _census import (  # noqa: E402
    ALWAYS_ON, classify, engine_files, entries, load_census,
    production_text, ui_files, ui_domain, workspace_crates)

UI_IMPORT = re.compile(
    r"""(?:^\s*(?:import|export)\s[^;]*?from\s+|^\s*import\s+|\bimport\s*\(\s*)"""
    r"""["'](\.[^"']+)["']""", re.M)
ENGINE_USE = re.compile(r"\bcrate::commands::([a-z_]+)")
ENGINE_SUPPORT_USE = re.compile(r"\bcrate::([a-z_]+)")
ENGINE_GROUP = re.compile(r"\bcrate::(commands::)?\{")
CRATE_PATH = re.compile(r"\b(cubical_[a-z_]+)\s*::")
CRATE_USE = re.compile(r"\buse\s+(cubical_[a-z_]+)\b")
GROUP_HEAD = re.compile(r"^\s*([a-z_]+)")


def braced(text: str, open_pos: int) -> str:
    """The body of the brace group opening at `open_pos`, nesting respected."""
    depth = 0
    for i in range(open_pos, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_pos + 1:i]
    return text[open_pos + 1:]


def top_level_parts(body: str) -> list[str]:
    """`body` split on the commas that are not inside a nested group."""
    parts: list[str] = []
    depth = 0
    start = 0
    for i, ch in enumerate(body):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "," and depth == 0:
            parts.append(body[start:i])
            start = i + 1
    parts.append(body[start:])
    return parts


def group_targets(body: str, in_commands: bool) -> list[str]:
    """Module targets named by a `crate::{…}` or `crate::commands::{…}` group.

    A `commands::x` inside a `crate::{…}` group is resolved to the command
    module rather than read as a module called `commands`: reading only the
    head of each part is what let `use crate::{commands::graph::X, …}` in a
    substrate module through while `use crate::commands::graph::X` failed.
    """
    out: list[str] = []
    for part in top_level_parts(body):
        head = GROUP_HEAD.match(part)
        if not head or head.group(1) == "self":
            continue
        name = head.group(1)
        if in_commands:
            out.append("commands::" + name)
            continue
        if name != "commands":
            out.append(name)
            continue
        rest = part[head.end():].lstrip()
        if not rest.startswith("::"):
            continue
        rest = rest[2:].lstrip()
        if rest.startswith("{"):
            out.extend(group_targets(braced(rest, 0), True))
        else:
            sub = GROUP_HEAD.match(rest)
            if sub and sub.group(1) != "self":
                out.append("commands::" + sub.group(1))
    return out


def engine_edges(text: str) -> list[tuple[int, str]]:
    """(line, target) for every engine module or workspace crate a file names.

    A target is `commands::x`, a bare `x` for `crate::x`, or `crate:cubical-x`
    for a workspace crate named by path (`cubical_x::…`) or by `use cubical_x`.
    The crate form exists because the crate check reads Cargo manifests, and
    the engine's manifest is the shell's: a substrate command module writing
    `use cubical_search::…` compiled against a block and no check saw it.
    """
    prod = production_text(text)
    found: list[tuple[int, str]] = []

    def line_of(pos: int) -> int:
        return prod.count("\n", 0, pos) + 1

    for m in ENGINE_USE.finditer(prod):
        found.append((line_of(m.start()), "commands::" + m.group(1)))
    for m in ENGINE_SUPPORT_USE.finditer(prod):
        found.append((line_of(m.start()), m.group(1)))
    for m in ENGINE_GROUP.finditer(prod):
        body = braced(prod, m.end() - 1)
        for target in group_targets(body, bool(m.group(1))):
            found.append((line_of(m.start()), target))
    for pattern in (CRATE_PATH, CRATE_USE):
        for m in pattern.finditer(prod):
            crate = m.group(1).replace("_", "-")
            found.append((line_of(m.start()), "crate:" + crate))
    return found


def verdict(src: tuple[str, str], dst: tuple[str, str]) -> str | None:
    """Why this edge is illegal, or None if it is fine.

    Plumbing is held to substrate's rule in both directions: anything may
    import it, and it may import only substrate and plumbing.
    """
    src_class, src_domain = src
    dst_class, dst_domain = dst
    if src_domain == dst_domain:
        return None
    if src_class == "shell":
        return None
    if dst_class in ALWAYS_ON:
        return None
    if dst_class == "shell":
        return (f"a {src_class} depends on the shell — the composition root "
                f"wires features together, it is not a library they call into")
    if src_class == "plumbing":
        return (f"engine plumbing depends on the {dst_domain} block — every "
                f"engine module imports plumbing, so this puts the block under "
                f"all of them")
    if src_class == "substrate":
        return (f"substrate depends on the {dst_domain} block — substrate is "
                f"always on, so this makes the block always on too")
    return (f"the {src_domain} block depends on the {dst_domain} block — "
            f"either failing now takes the other with it")


def check_crates(gate: Gate, cfg: dict) -> None:
    table = entries(cfg["crates"])
    allowed = cfg["crate_allowed"]
    workspace = workspace_crates()
    for f in tracked("crates/", suffixes=("Cargo.toml",)):
        crate = rel(f).split("/")[1]
        manifest = tomllib.loads(f.read_text(encoding="utf-8"))
        deps: set[str] = set()
        for section in ("dependencies", "dev-dependencies"):
            deps |= set(manifest.get(section, {}))
        for dep in sorted(d for d in deps if d in workspace and d != crate):
            why = verdict(classify(table, crate), classify(table, dep))
            if why and f"{crate} -> {dep}" not in allowed:
                gate.fail(f"{rel(f)}: {why}. Declare it in "
                          f"scripts/domain-boundaries.json with the issue that "
                          f"tracks removing it, or route it through the shell.")


def check_engine_modules(gate: Gate, cfg: dict) -> None:
    """Every engine module, as a source and as a target.

    Commands are classed by `engine_modules`. The modules beside them are
    classed by `engine_support` and have no default: an unlisted one fails,
    because skipping it is how `plugins` and `state` hid their edges while the
    census called them shell.
    """
    table = entries(cfg["engine_modules"])
    support = entries(cfg["engine_support"])
    allowed = cfg["engine_allowed"]
    crates = entries(cfg["crates"])
    workspace = workspace_crates()
    sources, unlisted = engine_files(cfg)
    for r in unlisted:
        gate.fail(f"{r}: an engine module beside commands/ that the census "
                  f"does not class. Add it to `engine_support` in "
                  f"scripts/domain-boundaries.json as shell, plumbing, or the "
                  f"domain it belongs to.")
    for f, _, src_name, src in sources:
        text = f.read_text(encoding="utf-8", errors="replace")
        seen: set[tuple[int, str]] = set()
        for n, target in engine_edges(text):
            if (n, target) in seen:
                continue
            seen.add((n, target))
            via = ""
            if target.startswith("crate:"):
                dst_name = target[len("crate:"):]
                if dst_name not in workspace:
                    continue
                dst = classify(crates, dst_name)
                via = f" (names the {dst_name} crate)"
            elif target.startswith("commands::"):
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
                gate.fail(f"{rel(f)}:{n}: {why}{via}.")


def check_ui(gate: Gate, cfg: dict) -> None:
    table = entries(cfg["ui_domains"])
    allowed = cfg["ui_allowed"]
    for f, src_name, src in ui_files(cfg):
        r = rel(f)
        text = f.read_text(encoding="utf-8", errors="replace")
        # Whole text, not line by line: a braced import puts `from` several
        # lines below `import`, so a per-line match sees neither half. The
        # class is negated rather than dotted precisely so it spans newlines.
        for m in UI_IMPORT.finditer(text):
            target = posixpath.normpath(
                posixpath.join(posixpath.dirname(r), m.group(1)))
            dst_name = ui_domain(target, table)
            if dst_name is None or dst_name == src_name:
                continue
            why = verdict(src, classify(table, dst_name))
            if why and f"{src_name} -> {dst_name}" not in allowed:
                n = text.count("\n", 0, m.start()) + 1
                gate.fail(f"{r}:{n}: {why}.")


def run() -> int:
    gate = Gate("domain-boundary", "domain-scoped-dependencies.md")
    cfg = load_census()
    check_crates(gate, cfg)
    check_engine_modules(gate, cfg)
    check_ui(gate, cfg)
    return gate.finish(
        f"no block depends on another domain's block "
        f"({len(cfg['crate_allowed'])} crate, {len(cfg['engine_allowed'])} "
        f"engine, {len(cfg['ui_allowed'])} ui edges grandfathered).")


main_guard(run)
