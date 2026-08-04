#!/usr/bin/env python3
"""Decides whether graphify-out/graph.json still describes the working tree.

Run from anywhere: python3 scripts/graph_freshness.py

Exit 0 means the graph may be trusted, 1 means it may not. A one-line verdict
goes to stdout either way; the detail behind a refusal goes to stderr.

Why this is not an mtime comparison: `graphify update` rewrites nothing when a
commit changes no extractable file, so a graph built minutes ago is older than
HEAD the moment a dependency bump or a workflow edit lands. Comparing
timestamps calls that stale and sends the session to ripgrep for the rest of
the day. Comparing *content* — which files moved, and whether the graph indexes
that kind of file at all — answers the question actually being asked.

The two failure modes carry different risk, so they get different verdicts:

  drift  — the graph indexes files git no longer has. This is what a
           restructure does and it is the dangerous one: the graph reports
           deleted code as live, confidently and without warning. It REFUSES.
  churn  — extractable files changed since the graph was built, or exist and
           were never indexed. The graph is merely behind, not lying. It WARNS
           and allows, because refusing here would mean refusing during any
           editing session, which is how a graph ends up never used at all.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(subprocess.check_output(
    ["git", "rev-parse", "--show-toplevel"], text=True).strip())
OUT = ROOT / "graphify-out"
GRAPH = OUT / "graph.json"
MANIFEST = OUT / "manifest.json"

# Above this share of indexed files being absent from git, the graph is
# describing a tree that no longer exists rather than one that merely moved on.
DRIFT_REFUSE_RATIO = 0.05

# Never counted as a blind spot: graphify skips these by design, so their
# absence from the manifest says nothing about how current the graph is.
NEVER_INDEXED = ("package-lock.json", "Cargo.lock", "skills-lock.json")


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, text=True,
        capture_output=True).stdout.strip()


def indexed_suffixes(manifest: dict) -> set[str]:
    """The extensions graphify actually extracted, read from the manifest.

    Derived rather than hardcoded so that installing a new tree-sitter grammar
    widens this set with no edit here.
    """
    return {Path(p).suffix for p in manifest if Path(p).suffix}


def changed_files(since: str) -> list[str]:
    committed = git("diff", "--name-only", since, "HEAD").splitlines()
    uncommitted = git("diff", "--name-only", "HEAD").splitlines()
    untracked = git("ls-files", "--others", "--exclude-standard").splitlines()
    return sorted({f for f in committed + uncommitted + untracked if f})


def main() -> int:
    if not GRAPH.exists() or not MANIFEST.exists():
        print("graph: absent — build it with `graphify update .` (free, no LLM).")
        return 1

    graph = json.loads(GRAPH.read_text(encoding="utf-8"))
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    indexed = set(manifest)
    suffixes = indexed_suffixes(manifest)

    tracked = set(git("ls-files").splitlines())
    phantom = sorted(f for f in indexed if not (ROOT / f).exists())
    unindexed = sorted(
        f for f in tracked - indexed
        if Path(f).suffix in suffixes and not f.endswith(NEVER_INDEXED))

    built_at = graph.get("built_at_commit") or ""
    known = bool(built_at) and git("cat-file", "-t", built_at) == "commit"
    churn = [f for f in changed_files(built_at)
             if Path(f).suffix in suffixes and not f.endswith(NEVER_INDEXED)] if known else []

    drift_ratio = len(phantom) / len(indexed) if indexed else 1.0

    def detail() -> None:
        for label, files in (("gone", phantom), ("unseen", unindexed), ("changed", churn)):
            for f in files[:4]:
                print(f"    {label}: {f}", file=sys.stderr)
            if len(files) > 4:
                print(f"    {label}: … and {len(files) - 4} more", file=sys.stderr)
        print("  Refresh: graphify update .   (free, no LLM calls)", file=sys.stderr)

    if not known:
        print(f"graph: REFUSING — no usable built_at_commit ({built_at or 'absent'}).",
              flush=True)
        print("  Rebuild with `graphify update .` (free, no LLM).", file=sys.stderr)
        return 1

    if drift_ratio > DRIFT_REFUSE_RATIO:
        print(f"graph: REFUSING — {len(phantom)} of {len(indexed)} indexed files "
              f"({drift_ratio:.0%}) no longer exist. It will report deleted code "
              f"as live.", flush=True)
        detail()
        return 1

    if phantom or unindexed or churn:
        print(f"graph: usable but behind — {len(phantom)} gone, {len(unindexed)} "
              f"never indexed, {len(churn)} changed since {built_at[:8]}. "
              f"Verify hits in those files.", flush=True)
        detail()
        return 0

    behind = git("rev-list", "--count", f"{built_at}..HEAD")
    note = (f"{behind} commit(s) behind HEAD, none touching indexed files"
            if behind not in ("", "0") else f"at HEAD ({built_at[:8]})")
    print(f"graph: fresh — {len(indexed)} files indexed, {note}.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
