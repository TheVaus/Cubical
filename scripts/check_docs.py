#!/usr/bin/env python3
"""Docs consistency checker. Enforces docs/README.md -> "Doc discipline".

Run from anywhere: python3 scripts/check_docs.py (0 = clean, 1 = violations).
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], text=True).strip())

LINK = re.compile(r"\]\(([^)]+)\)")
# Links inside fences are example syntax, not navigable doc links — strip first.
FENCE = re.compile(r"```.*?```", re.DOTALL)
TAG_ENUM = re.compile(r"l4a.*l4b.*l4c")          # an enumeration line, not a lone tag
PRIMER_BUDGET = 65

fails: list[str] = []


def rel(p: Path) -> str:
    return str(p.relative_to(ROOT))


def tracked_md() -> list[Path]:
    out = subprocess.check_output(["git", "ls-files", "*.md"], cwd=ROOT, text=True)
    return [ROOT / line for line in out.splitlines() if line]


def is_generated(p: Path) -> bool:
    # Both spellings: a dir-only .gitignore pattern ("graphify-out/") matches
    # only when the trailing slash marks the path as a directory, which git
    # cannot infer for a path that does not exist in the checkout.
    return any(
        subprocess.call(
            ["git", "check-ignore", "-q", cand],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        ) == 0
        for cand in (str(p), str(p) + "/")
    )


def is_doc_link(target: str) -> bool:
    """True only for navigation links into the doc graph (md / html / directory)."""
    if target.endswith((".md", ".html", "/")):
        return True
    base = target.rsplit("/", 1)[-1]
    # extensionless segment = directory ref; a bare word with no slash is example text
    return "/" in target and "." not in base


# ---- 1. broken internal doc links (living docs only; archive is frozen) ----
for f in tracked_md():
    if "superpowers/archive/" in rel(f):
        continue
    text = FENCE.sub("", f.read_text(encoding="utf-8", errors="replace"))
    for m in LINK.finditer(text):
        target = m.group(1).strip()
        if not target or target.startswith(("http://", "https://", "#", "mailto:")):
            continue
        target = target.split("#", 1)[0]
        if not target or not is_doc_link(target):
            continue
        resolved = f.parent / target
        if not resolved.exists() and not is_generated(resolved):
            fails.append(f"broken link: {rel(f)} -> {target}")


# ---- 2. single-source ownership guards (living docs only) ----
OWNERS = {
    "schema": "docs/architecture/document-model.md",
    "precedence": "docs/architecture/README.md",
    "tags": "docs/build-order.md",
}
for f in tracked_md():
    r = rel(f)
    if "superpowers/archive/" in r:
        continue
    text = f.read_text(encoding="utf-8", errors="replace")

    if r != OWNERS["schema"]:
        for tbl in ("links", "tags", "pending_rewrites"):
            if re.search(rf"CREATE TABLE {tbl}\b", text):
                fails.append(f"schema duplicated: 'CREATE TABLE {tbl}' in {r} "
                             f"(owner: {OWNERS['schema']})")

    if r != OWNERS["precedence"] and "the doc wins" in text:
        fails.append(f"precedence rule duplicated: 'the doc wins' in {r} "
                     f"(owner: {OWNERS['precedence']})")

    if r != OWNERS["tags"] and any(TAG_ENUM.search(ln) for ln in text.splitlines()):
        fails.append(f"layer-tag enumeration in {r} (owner: {OWNERS['tags']})")


# ---- 3. primer budget ----
n = len((ROOT / "CLAUDE.md").read_text(encoding="utf-8").splitlines())
if n > PRIMER_BUDGET:
    fails.append(f"CLAUDE.md is {n} lines — auto-loaded primer budget is "
                 f"{PRIMER_BUDGET}; move detail into docs/ and link to it.")


if fails:
    print("Docs check FAILED:")
    for x in fails:
        print(f"  - {x}")
    sys.exit(1)
print("Docs check passed: links resolve, facts single-sourced, primer within budget.")
