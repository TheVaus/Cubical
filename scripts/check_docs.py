#!/usr/bin/env python3
"""Docs consistency checker. Driven by the `ownership` block in docs/README.md.

Run from anywhere: python3 scripts/check_docs.py  (0 = clean, 1 = violations)

WHAT THIS CANNOT DO — read before trusting a green run.

It detects DUPLICATION, not CONTRADICTION. It finds the same fact stated twice;
it cannot find two statements that are each internally consistent and mutually
incompatible.

The failure that triggered the rework this script came out of: one doc mandated
rustdoc on public items while another banned all doc-comments. Both were
internally coherent. They shared no detectable pattern — no regex over either
would have found the other. A checker of this shape is structurally incapable of
catching that class, and adding rules will not change it.

The only real mitigation is surface-area reduction: fewer docs, fewer words,
fewer places a contradiction can hide. Treat a green run as "no fact is stated
twice", never as "the docs agree".
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], text=True).strip())

LINK = re.compile(r"\]\(([^)]+)\)")
FENCE = re.compile(r"```.*?```", re.DOTALL)

PRIMER = ROOT / "CLAUDE.md"
PRIMER_BUDGET_WORDS = 600
PRIMER_BUDGET_LINES = 80

# Counts and volatile identifiers are queries, not facts. A written count is
# stale within days and reads as authoritative forever.
BANNED = [
    (re.compile(r"\b\d+\s+(?:tests?|vitest|unit tests?|integration tests?)\b", re.I),
     "a test count — counts are a query, not a stored fact; run scripts/check.sh"),
    (re.compile(r"\b(?:tests?|vitest)\s+(?:count|total)\s*[:=]\s*\d+", re.I),
     "a test count — counts are a query, not a stored fact"),
    (re.compile(r"\balert\s+#\d+", re.I),
     "a Dependabot alert written as #N — alert IDs are not issue numbers and collide with them"),
    (re.compile(r"\bCVSS\b|\bseverity[:=]?\s*(?:critical|high|moderate|low)\b", re.I),
     "a CVE severity — severities are re-scored upstream; link the alert instead"),
]

FROZEN_BANNER = "Frozen — historical record"
GENERATED_BANNER = "do not edit"

GENERATED = [
    "docs/generated/repo-layout.md",
    "docs/generated/ipc-surface.md",
    "design-system/INVENTORY.md",
    "docs/principles/README.md",
]

fails: list[str] = []


def rel(p: Path) -> str:
    # as_posix(), not str() — see scripts/gates/_common.py:rel. This value is
    # matched against the forward-slash owner paths in the ownership block.
    return p.relative_to(ROOT).as_posix()


def tracked_md() -> list[Path]:
    out = subprocess.check_output(["git", "ls-files", "*.md"], cwd=ROOT, text=True)
    return [ROOT / line for line in out.splitlines() if line]


def is_archive(r: str) -> bool:
    return r.startswith("docs/archive/")


def is_generated_path(r: str) -> bool:
    return r in GENERATED


def is_doc_link(target: str) -> bool:
    if target.endswith((".md", ".html", "/")):
        return True
    base = target.rsplit("/", 1)[-1]
    return "/" in target and "." not in base


def load_ownership() -> list[tuple[str, str, str]]:
    """Parse the fenced `ownership` block in docs/README.md. It is the data;
    the rendered table above it is for humans."""
    text = (ROOT / "docs" / "README.md").read_text(encoding="utf-8")
    # The closing fence must be at line start. A non-anchored match stops at the
    # first backtick run *inside* a row, silently truncating that row's pattern
    # to something far broader than intended — which is exactly how a row whose
    # pattern was "^\x60\x60\x60ownership" once degraded to "^" and flagged
    # every file in the repo.
    m = re.search(r"^```ownership\n(.*?)^```", text, re.DOTALL | re.M)
    if not m:
        sys.exit("docs/README.md has no ```ownership block — the checker is "
                 "driven by it and cannot run without it.")
    rows = []
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        # maxsplit=2: the pattern column is a regex and may itself contain "|"
        # (alternation). fact-id and owner-path never do.
        parts = [c.strip() for c in line.split("|", 2)]
        if len(parts) != 3:
            sys.exit(f"ownership block: malformed row (want 3 columns): {line}")
        fact_id, owner, pattern = parts
        if pattern in ("^", ".", ".*", ""):
            sys.exit(f"ownership row '{fact_id}': detection-pattern {pattern!r} "
                     f"matches everything. Use '-' for no pattern.")
        rows.append((fact_id, owner, pattern))
    return rows


OWNERSHIP = load_ownership()

# ---- 1. broken internal doc links (living docs only; archive is frozen) ----
for f in tracked_md():
    r = rel(f)
    if is_archive(r):
        continue
    text = FENCE.sub("", f.read_text(encoding="utf-8", errors="replace"))
    for m in LINK.finditer(text):
        target = m.group(1).strip()
        if not target or target.startswith(("http://", "https://", "#", "mailto:")):
            continue
        target = target.split("#", 1)[0]
        if not target or not is_doc_link(target):
            continue
        if not (f.parent / target).exists():
            fails.append(f"broken link: {r} -> {target}")

# ---- 2. single-owner enforcement, driven by the ownership block ----
for fact_id, owner, pattern in OWNERSHIP:
    if pattern == "-":
        continue
    try:
        rx = re.compile(pattern, re.M)
    except re.error as e:
        fails.append(f"ownership row '{fact_id}': bad detection-pattern ({e})")
        continue
    for f in tracked_md():
        r = rel(f)
        if is_archive(r) or r == owner:
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        # The ownership block holds the detection patterns as literal text, so
        # it matches itself. Strip it before scanning its own host file.
        if r == "docs/README.md":
            text = re.sub(r"^```ownership\n.*?^```", "", text, flags=re.DOTALL | re.M)
        if rx.search(text):
            fails.append(f"'{fact_id}' restated in {r} — owner is {owner}. "
                         f"Link to it; do not copy it.")

# ---- 3. owners must exist ----
for fact_id, owner, _ in OWNERSHIP:
    if not (ROOT / owner).exists():
        fails.append(f"ownership row '{fact_id}': owner {owner} does not exist.")

# ---- 4. banned patterns (living docs only — archive is frozen and exempt) ----
# The conflict this resolves: the layer specs moved to archive UNCHANGED, and
# they contain historical test counts. Correcting them would destroy the record.
for f in tracked_md():
    r = rel(f)
    if is_archive(r) or is_generated_path(r):
        continue
    text = f.read_text(encoding="utf-8", errors="replace")
    for rx, why in BANNED:
        m = rx.search(text)
        if m:
            line_no = text[:m.start()].count("\n") + 1
            fails.append(f"{r}:{line_no}: {why} — found {m.group(0)!r}")

# ---- 5. banners ----
for f in tracked_md():
    r = rel(f)
    if not is_archive(r):
        continue
    first = f.read_text(encoding="utf-8", errors="replace").split("\n", 1)[0]
    if FROZEN_BANNER not in first:
        fails.append(f"{r}: archive file is missing the frozen banner on line 1.")

for g in GENERATED:
    p = ROOT / g
    if not p.exists():
        continue
    first = p.read_text(encoding="utf-8", errors="replace").split("\n", 1)[0]
    if GENERATED_BANNER not in first:
        fails.append(f"{g}: generated file is missing the do-not-edit banner on line 1.")

# ---- 6. primer budget: words, not just lines ----
primer = PRIMER.read_text(encoding="utf-8")
words = len(primer.split())
lines = len(primer.splitlines())
if words > PRIMER_BUDGET_WORDS:
    fails.append(f"CLAUDE.md is {words} words — the auto-loaded primer budget is "
                 f"{PRIMER_BUDGET_WORDS}. It is paid on every task, forever. "
                 f"Move detail into docs/ and link to it.")
if lines > PRIMER_BUDGET_LINES:
    fails.append(f"CLAUDE.md is {lines} lines — budget is {PRIMER_BUDGET_LINES}.")

if fails:
    print("Docs check FAILED — the rule is docs/principles/single-owner-facts.md")
    for x in fails:
        print(f"  - {x}")
    print("\nOwnership is data: the ```ownership block in docs/README.md. "
          "If a fact genuinely needs a new owner, add a row there.")
    sys.exit(1)

print(f"Docs check passed: links resolve, {len(OWNERSHIP)} facts single-sourced, "
      f"banners present, primer {words}/{PRIMER_BUDGET_WORDS} words.")
print("  note: this detects duplication, not contradiction — see the module "
      "docstring for what it structurally cannot catch.")
