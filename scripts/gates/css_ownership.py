#!/usr/bin/env python3
"""css-ownership gate — a stylesheet styles its own domain and nothing else.

The domain-boundary gate reads TS imports, and a stylesheet has none, so a
block's rules could sit in substrate for as long as nobody looked. They did:
ui/src/styles/layout.css styled the statusbar, the vault switcher, the toasts
and the editor, which meant removing any of those blocks left its CSS behind.

One check, over tracked ui/src/**/*.css. A stylesheet's domain is the domain of
the directory it sits in (scripts/domain-boundaries.json owns that census). Each
class a selector declares is resolved to a domain through the prefix table in
scripts/css-ownership.json, and must resolve to the stylesheet's own.

Declarations, not usages: a block's component may wear a substrate class the
same way it may render a design-system component. Only the stylesheet that
declares a selector is constrained.

Fails on: a selector owned by another domain, a selector no prefix claims, a
rule built only from shared design-system or vendor classes, or a prefix whose
domain is not in the census. Does not fail when a prefix goes unused — it tells
you to drop the entry.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

CONFIG = ROOT / "scripts" / "css-ownership.json"
CENSUS = ROOT / "scripts" / "domain-boundaries.json"

COMMENT = re.compile(r"/\*.*?\*/", re.S)
CLASS = re.compile(r"\.(-?[A-Za-z_][A-Za-z0-9_-]*)")


def blanked(text: str) -> str:
    """The stylesheet with comments replaced by spaces, offsets preserved.

    Offsets, because the failure message carries a line number and a comment
    holding a class name would otherwise both shift every line below it and
    read as a declaration.
    """
    return COMMENT.sub(lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)


def selectors(text: str) -> list[tuple[int, str]]:
    """(line, selector) for every comma-separated selector in the sheet.

    `[^{}]+` cannot cross a brace, so a match can neither start inside a
    declaration block nor run past the end of one, and at-rule prelude and
    keyframe step are dropped by their own head rather than by a CSS parser:
    neither can name a class.
    """
    out: list[tuple[int, str]] = []
    for m in re.finditer(r"([^{}]+)\{", blanked(text)):
        head = m.group(1)
        if head.strip().startswith("@"):
            continue
        line = text.count("\n", 0, m.start(1)) + 1
        for part in head.split(","):
            lead = part[: len(part) - len(part.lstrip())]
            if part.strip():
                out.append((line + lead.count("\n"), " ".join(part.split())))
            line += part.count("\n")
    return out


def prefix_of(name: str, prefixes) -> str | None:
    """The longest entry in `prefixes` that `name` is, or extends with - or __."""
    hits = [p for p in prefixes
            if name == p or name.startswith(p + "-") or name.startswith(p + "__")]
    return max(hits, key=len) if hits else None


def sheet_domain(path: str, census: dict) -> tuple[str, str, str]:
    """(census key, class, domain) of a ui/src stylesheet.

    The directory is the domain; a stylesheet sitting directly under ui/src is
    its own. Unlisted defaults to block, exactly as the TS census does, so a new
    feature's stylesheet is fenced in from its first commit.
    """
    inner = path[len("ui/src/"):]
    key = inner.split("/")[0] if "/" in inner else inner[: -len(".css")]
    entry = census.get(key)
    if entry is None:
        return (key, "block", key)
    return (key, entry["class"], entry["domain"])


def run() -> int:
    gate = Gate("css-ownership", "domain-scoped-dependencies.md")
    cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
    census = {k: v for k, v in
              json.loads(CENSUS.read_text(encoding="utf-8"))["ui_domains"].items()
              if k != "_"}
    owners = {k: v for k, v in cfg["owners"].items() if k != "_"}
    shared = [p for p in cfg["shared"] if p != "_"]

    classes = {e["domain"]: e["class"] for k, e in census.items() if "/" not in k}
    for prefix in sorted(owners):
        if owners[prefix] not in classes:
            gate.fail(f"scripts/css-ownership.json gives .{prefix} to the "
                      f"'{owners[prefix]}' domain, which scripts/"
                      f"domain-boundaries.json does not name — fix the domain "
                      f"or add it to the census.")

    used: set[str] = set()
    sheets = 0
    resolved = 0
    for f in tracked("ui/src/", suffixes=(".css",)):
        r = rel(f)
        sheets += 1
        _, sheet_class, domain = sheet_domain(r, census)
        for line, sel in selectors(f.read_text(encoding="utf-8", errors="replace")):
            names = CLASS.findall(sel)
            if not names:
                continue
            owned = 0
            unclaimed = 0
            for name in names:
                prefix = prefix_of(name, owners)
                if prefix is None:
                    if prefix_of(name, shared) is None:
                        unclaimed += 1
                        gate.fail(
                            f"{r}:{line}: `{sel}` declares .{name}, which no "
                            f"domain claims. Give the prefix a domain in "
                            f"scripts/css-ownership.json, or list it under "
                            f"`shared` if it is a design-system or vendor class "
                            f"this rule only qualifies.")
                    continue
                owned += 1
                resolved += 1
                used.add(prefix)
                if owners[prefix] == domain:
                    continue
                extra = ""
                if (sheet_class == "substrate"
                        and classes.get(owners[prefix]) == "block"):
                    extra = (f" Substrate may not carry a block's styling: "
                             f"switching {owners[prefix]} off has to take its "
                             f"CSS with it.")
                gate.fail(
                    f"{r}:{line}: `{sel}` declares .{name}, which belongs to "
                    f"the '{owners[prefix]}' domain, not '{domain}'.{extra} Move "
                    f"the rule to a stylesheet in that domain and import it "
                    f"there, the way graph.css, viewer.css and terminal.css "
                    f"already do.")
            if not owned and not unclaimed:
                gate.fail(
                    f"{r}:{line}: `{sel}` styles design-system or vendor classes "
                    f"outright, so no domain owns it. Qualify the rule with a "
                    f"class this domain owns, or change the component itself.")

    for prefix in sorted(set(owners) - used):
        gate.warn(f".{prefix} has an owner in scripts/css-ownership.json but is "
                  f"declared nowhere — remove the entry.")

    return gate.finish(
        f"{resolved} owned selectors across {sheets} stylesheets, each "
        f"declaring only its own domain's.")


main_guard(run)
