#!/usr/bin/env python3
"""domain-names gate — always-on code may not spell a block's name.

The other half of docs/principles/domain-scoped-dependencies.md. domain_boundary.py
reads imports, so it sees the edges; this gate reads names, which is the half an
import graph structurally cannot see. Substrate that writes `"terminal"` in a
closed union, a switch arm or a key string does not import the terminal block,
yet the block is neither removable (deleting it leaves a dead arm behind) nor
addable (a new one edits substrate). Every recent boundary PR found these by
hand.

Three checks over the census in scripts/domain-boundaries.json, with the
grandfather and ignore lists in scripts/domain-names.json:

  1. Toggle ids. Every id in the engine's plugin registry must equal a block
     domain in the census, so "which name is a block's name" has one answer
     and the gate below cannot be evaded by renaming a toggle.
  2. String literals in always-on files: equal to a block's name, or keyed on
     one (`graph.open`, `terminal.agent_instructions_offered`,
     `plugins.property_refs_enabled`).
  3. Rust enum variants in always-on files whose name is a block's.

Always-on means census class substrate or plumbing. The shell is exempt by
definition, and so is test code: `production_lines()` from _census.py blanks
`#[cfg(test)]` items and `.test.` files are not scanned.

A block's names are read per side. `tags` is a block in ui/src and substrate in
the engine, so a Rust literal `"tags"` is a table name and a TS literal `"tags"`
is the tag pane — the census already knows which, and asking it is cheaper than
an ignore entry per file.

Fails on a new name only. Pre-existing ones are grandfathered with the issue
that tracks removing them, so the gate lands green and the paydown list is the
config diff.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402
from _census import (  # noqa: E402
    ALWAYS_ON, engine_files, entries, load_census, production_text,
    test_only_modules, ui_files)

CONFIG = ROOT / "scripts" / "domain-names.json"
PLUGINS = ROOT / "crates" / "cubical-engine" / "src" / "plugins.rs"

TOGGLE_ID = re.compile(r"Self::\w+\s*=>\s*\"([a-z][a-z0-9-]*)\"")
TOGGLE_ID_FN = re.compile(r"fn id\(self\)[^{]*\{(.*?)\n    \}", re.S)
RUST_STRING = re.compile(r'"([^"\\\n]*(?:\\.[^"\\\n]*)*)"')
TS_STRING = re.compile(r'"([^"\\\n]*)"|\'([^\'\\\n]*)\'|`([^`\\\n$]*)`')
RUST_COMMENT = re.compile(r"^\s*//.*$", re.M)
TS_COMMENT = re.compile(r"^\s*//.*$|/\*.*?\*/", re.M | re.S)
ENUM = re.compile(r"\benum\s+(\w+)\s*\{")
VARIANT = re.compile(r"^\s*(?:#\[[^\]]*\]\s*)?([A-Z]\w*)\s*[,({=]", re.M)
KEYED = re.compile(r"^([a-z][a-z0-9_-]*)[.:]")
SETTING_KEY = re.compile(r"^plugins\.([a-z0-9_]+)_enabled$")


def fold(name: str) -> str:
    """A name with case, separators and a trailing plural dropped.

    property-refs, propertyRefs and PropertyRef fold to one key: a block's name
    reaches code in whatever shape the language wants, and a gate that reads
    only the census spelling is a gate that a rename of style evades.
    """
    folded = re.sub(r"[-_]", "", name).lower()
    return folded[:-1] if folded.endswith("s") else folded


def block_names(tables: list[dict], toggles: set[str]) -> dict[str, str]:
    """{folded name: the name as the census writes it} for these census tables."""
    out: dict[str, str] = {}
    for table in tables:
        for entry in entries(table).values():
            if entry["class"] == "block":
                out.setdefault(fold(entry["domain"]), entry["domain"])
    for toggle in toggles:
        out.setdefault(fold(toggle), toggle)
    return out


def toggle_ids() -> set[str]:
    """The ids in the engine's plugin registry — the user-facing name of a block."""
    body = TOGGLE_ID_FN.search(PLUGINS.read_text(encoding="utf-8"))
    return set(TOGGLE_ID.findall(body.group(1))) if body else set()


def literals(text: str, rust: bool) -> list[tuple[int, str]]:
    """(line, value) for every single-line string literal outside a comment."""
    stripped = (RUST_COMMENT if rust else TS_COMMENT).sub(
        lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
    out: list[tuple[int, str]] = []
    for m in (RUST_STRING if rust else TS_STRING).finditer(stripped):
        value = next((g for g in m.groups() if g is not None), "")
        if value:
            out.append((stripped.count("\n", 0, m.start()) + 1, value))
    return out


def variants(text: str) -> list[tuple[int, str]]:
    """(line, variant) for every variant of every enum declared in `text`.

    An enum is the closed-union shape the rule is about: a substrate enum with
    one variant per block is a list of blocks substrate has to be edited to
    extend. Braces are balanced from the header, so a struct variant's own
    fields do not read as variants of the enum below it.
    """
    out: list[tuple[int, str]] = []
    for head in ENUM.finditer(text):
        depth = 0
        end = len(text)
        for i in range(head.end() - 1, len(text)):
            if text[i] == "{":
                depth += 1
            elif text[i] == "}":
                depth -= 1
                if depth == 0:
                    end = i
                    break
        body = text[head.end():end]
        for m in VARIANT.finditer(body):
            before = body[:m.start()]
            inner = before.count("{") + before.count("(") - before.count("}") - before.count(")")
            if inner == 0:
                out.append((text.count("\n", 0, head.end() + m.start(1)) + 1, m.group(1)))
    return out


def named(value: str, names: dict[str, str]) -> str | None:
    """The block `value` names, or None.

    Three shapes, because a name reaches substrate as more than a bare word:
    the name itself, a key whose first segment is the name (`graph.open`,
    `terminal.agent_instructions_offered`, `search:status`), and the settings
    key the plugin registry derives from it.
    """
    if fold(value) in names:
        return names[fold(value)]
    key = SETTING_KEY.match(value)
    if key and fold(key.group(1)) in names:
        return names[fold(key.group(1))]
    head = KEYED.match(value)
    if head and fold(head.group(1)) in names:
        return names[fold(head.group(1))]
    return None


class Used:
    """Which config entries this run needed, so a stale one can be reported."""

    def __init__(self) -> None:
        self.allowed: set[str] = set()
        self.ignore: set[int] = set()


def ignored(cfg: dict, used: set[int], path: str, value: str) -> bool:
    """True if this spelling is listed as a non-reference in this file.

    Literals are matched exactly, never folded: `tag` is the AST node kind for
    `#tag` syntax and `tags` is the block, and an entry for one must not cover
    the other.
    """
    for i, entry in enumerate(cfg["ignore"]):
        if value in entry["literals"] and path.startswith(tuple(entry["files"])):
            used.add(i)
            return True
    return False


def report(gate: Gate, cfg: dict, used: set[str], path: str, line: int,
           block: str, what: str, cls: str) -> None:
    for key in (f"{path} -> {block}", f"{path} -> *"):
        if key in cfg["allowed"]:
            used.add(key)
            return
    where = "substrate" if cls == "substrate" else "engine plumbing"
    gate.fail(
        f"{path}:{line}: {what} names the {block} block, and {where} is always "
        f"on — the block is then neither removable (this stays behind) nor "
        f"addable (the next one edits this file). Give substrate a registry the "
        f"shell fills, as ui/src/shell/registerBlocks.ts already does, or "
        f"record it in scripts/domain-names.json with the issue that tracks "
        f"removing it.")


def scan(gate: Gate, cfg: dict, used: Used, path: str, text: str, cls: str,
         names: dict[str, str], rust: bool) -> None:
    body = production_text(text) if rust else text
    for line, value in literals(body, rust):
        block = named(value, names)
        if block and not ignored(cfg, used.ignore, path, value):
            report(gate, cfg, used.allowed, path, line, block,
                   f'the literal "{value}"', cls)
    if not rust:
        return
    for line, variant in variants(body):
        block = names.get(fold(variant))
        if block and not ignored(cfg, used.ignore, path, variant):
            report(gate, cfg, used.allowed, path, line, block,
                   f"the enum variant `{variant}`", cls)


def check_config(gate: Gate, cfg: dict, used: Used) -> None:
    """The paydown record stays a record: every entry has an issue and a hit."""
    for key, entry in sorted(cfg["allowed"].items()):
        if not entry.get("issue"):
            gate.fail(f"scripts/domain-names.json: `{key}` has no issue number. "
                      f"An entry without one is not an exception, it is an "
                      f"unrecorded violation.")
        elif key not in used.allowed:
            gate.warn(f"scripts/domain-names.json: `{key}` matches nothing any "
                      f"more — the name is gone, so remove the entry and close "
                      f"issue #{entry['issue']} if it is done.")
    for i, entry in enumerate(cfg["ignore"]):
        if i not in used.ignore:
            gate.warn(f"scripts/domain-names.json: the ignore entry for "
                      f"{entry['literals']} matches nothing any more — remove it.")


def check_toggles(gate: Gate, toggles: set[str], names: dict[str, str]) -> None:
    """A toggle id is a block's name, so the census has to know it as one."""
    for toggle in sorted(toggles):
        if fold(toggle) not in names:
            gate.fail(
                f"crates/cubical-engine/src/plugins.rs: the toggle id "
                f"'{toggle}' is not a block domain in "
                f"scripts/domain-boundaries.json. A toggle id and its census "
                f"domain are the same name, so that this gate and the census "
                f"talk about the same block.")


def run() -> int:
    gate = Gate("domain-names", "domain-scoped-dependencies.md")
    cfg = load_census()
    names_cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    used = Used()
    toggles = toggle_ids()
    rust_names = block_names(
        [cfg["crates"], cfg["engine_modules"], cfg["engine_support"]], toggles)
    ui_names = block_names([cfg["ui_domains"]], toggles)
    check_toggles(gate, toggles, rust_names | ui_names)

    scanned = 0
    for f, _, _, (cls, _) in engine_files(cfg)[0]:
        if cls not in ALWAYS_ON:
            continue
        scanned += 1
        scan(gate, names_cfg, used, rel(f),
             f.read_text(encoding="utf-8", errors="replace"), cls, rust_names, True)
    substrate_crates = {name for name, entry in entries(cfg["crates"]).items()
                        if entry["class"] == "substrate"}
    crate_files = [f for f in tracked("crates/", suffixes=(".rs",))
                   if rel(f).split("/")[1] in substrate_crates]
    test_only = test_only_modules(crate_files)
    for f in crate_files:
        r = rel(f)
        if f in test_only:
            continue
        scanned += 1
        scan(gate, names_cfg, used, r,
             f.read_text(encoding="utf-8", errors="replace"), "substrate",
             rust_names, True)
    for f, _, (cls, _) in ui_files(cfg):
        if cls not in ALWAYS_ON:
            continue
        scanned += 1
        scan(gate, names_cfg, used, rel(f),
             f.read_text(encoding="utf-8", errors="replace"), cls, ui_names, False)
    check_config(gate, names_cfg, used)

    return gate.finish(
        f"{scanned} always-on files name no block "
        f"({len(names_cfg['allowed'])} grandfathered).")


main_guard(run)
