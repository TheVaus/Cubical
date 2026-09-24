#!/usr/bin/env python3
"""The domain census, read the same way by every gate that reads it.

scripts/domain-boundaries.json classes every crate, engine module and ui/src
domain. domain_boundary.py checks the edges between them and domain_names.py
checks the names substrate spells; both must agree on which file is which
class, so the classifier lives here once rather than twice.

Four classes. `substrate`, `block` and `shell` are the rule's own
(docs/principles/domain-scoped-dependencies.md). `plumbing` is the engine's
connective tissue — its state, error, plugin registry and wire types — which
every engine module imports, so it cannot be shell (that would fail them all)
and is not a domain a user could switch off. It is held to substrate's rule:
anything may import it, it may import only substrate and plumbing, and it may
not name a block.
"""
import json
import re
from pathlib import Path

from _common import ROOT, rel, tracked

CENSUS = ROOT / "scripts" / "domain-boundaries.json"
ENGINE_ROOT = "crates/cubical-engine/src/"
COMMANDS = ENGINE_ROOT + "commands/"
ALWAYS_ON = ("substrate", "plumbing")


def load_census() -> dict:
    return json.loads(CENSUS.read_text(encoding="utf-8"))


def entries(table: dict) -> dict:
    """A census table without its `_` commentary key."""
    return {k: v for k, v in table.items() if k != "_"}


def classify(table: dict, name: str) -> tuple[str, str]:
    """(class, domain) of `name` in `table`; unlisted is a block of its own.

    Unlisted-is-block is the fence: a new crate, command module or ui/src
    directory can depend on substrate from its first commit and on nothing
    else, and nothing always-on may depend on it.
    """
    entry = table.get(name)
    if entry is None:
        return ("block", name)
    return (entry["class"], entry["domain"])


def workspace_crates() -> set[str]:
    """Directory names under crates/ that hold a tracked Cargo.toml."""
    return {rel(f).split("/")[1] for f in tracked("crates/", suffixes=("Cargo.toml",))}


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


def engine_module(path: str, under: str) -> str:
    """The module a file under `under` belongs to: its first path segment."""
    parts = path[len(under):].split("/")
    return parts[0] if len(parts) > 1 else parts[0][:-len(".rs")]


def engine_files(cfg: dict) -> tuple[list[tuple[Path, str, str, tuple[str, str]]], list[str]]:
    """Every production engine file as (path, table, module, (class, domain)).

    `table` is `engine_modules` for a file under commands/ and `engine_support`
    for one beside it. A command module that is not listed is a block of its
    own, as `classify` says. A module beside commands/ that is not listed is
    returned in the second list instead: it has no default, because the
    modules there are shell, plumbing or one domain's, and guessing wrong
    either hides its edges or fails every module that imports it.
    """
    commands = entries(cfg["engine_modules"])
    support = entries(cfg["engine_support"])
    files = tracked(ENGINE_ROOT, suffixes=(".rs",))
    test_only = test_only_modules([f for f in files if rel(f).startswith(COMMANDS)])
    out: list[tuple[Path, str, str, tuple[str, str]]] = []
    unlisted: list[str] = []
    for f in files:
        r = rel(f)
        if f in test_only:
            continue
        if r.startswith(COMMANDS):
            name = engine_module(r, COMMANDS)
            if name == "mod":
                continue
            out.append((f, "engine_modules", name, classify(commands, name)))
            continue
        name = engine_module(r, ENGINE_ROOT)
        if name == "commands":
            continue
        if name not in support:
            unlisted.append(r)
            continue
        out.append((f, "engine_support", name, classify(support, name)))
    return out, unlisted


def ui_domain(path: str, table: dict | None = None) -> str | None:
    """Census key of a ui/src path.

    A directory is a domain; so is a bare file. A census key containing a
    slash names a path prefix inside a directory (`editor/math` covers
    `editor/math.ts` and `editor/mathDollar.ts`), and the longest such prefix
    wins, so one directory can hold several domains without moving files.
    A file no prefix claims belongs to its directory's key, so it takes the
    directory's class; only a key the census does not name at all is a block.

    posixpath-style string handling, not Path: these are repo-relative keys
    with forward slashes, and Path would resolve them against the filesystem
    root on Windows.
    """
    if not path.startswith("ui/src/"):
        return None
    inner = path[len("ui/src/"):]
    for suffix in (".tsx", ".ts"):
        if inner.endswith(suffix):
            inner = inner[: -len(suffix)]
    prefixes = [k for k in (table or {}) if "/" in k and inner.startswith(k)]
    if prefixes:
        return max(prefixes, key=len)
    return inner.split("/")[0]


def ui_files(cfg: dict) -> list[tuple[Path, str, tuple[str, str]]]:
    """Every production ui/src TS file as (path, census key, (class, domain))."""
    table = entries(cfg["ui_domains"])
    out: list[tuple[Path, str, tuple[str, str]]] = []
    for f in tracked("ui/src/", suffixes=(".ts", ".tsx")):
        r = rel(f)
        if ".test." in r:
            continue
        key = ui_domain(r, table)
        out.append((f, key, classify(table, key)))
    return out
