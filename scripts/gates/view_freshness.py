#!/usr/bin/env python3
"""view-freshness gate — a cached view cannot outlive the state it mirrors.

Two structural checks. Both exist because the bugs they prevent are invisible
to tests: the code stays correct, the wiring quietly stops covering a case.

  1. Renames go through one door. Every path that renames a note has to end up
     refreshing the open buffers, and the cheapest way to guarantee that is for
     there to be a single caller of the rename IPCs. When a second call site
     appeared (a command palette entry, a drag-and-drop move), it would skip
     the refresh and every open note would show its links to the renamed file
     as broken.

  2. Every resolver cache is registered for refresh. A resolver that caches
     vault state and is not a member of ResolverGroup is never refreshed, so it
     serves pre-edit values for the rest of the session. That is exactly how
     [[note.prop]] went stale. Membership is what the refresh functions iterate,
     so the gate checks that the set of cache-bearing resolvers equals the set
     the group knows about. A resolver declares its cache either by spelling
     markStale() out in its own interface or by aliasing the shared resolver;
     the shared factory itself is the implementation every resolver borrows,
     not a cache anyone holds, so it is not a member of anything.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import ROOT, Gate, main_guard, rel, tracked  # noqa: E402

APP = ROOT / "ui" / "src" / "App.tsx"
IPC = ROOT / "ui" / "src" / "api" / "ipc.ts"
GROUP = ROOT / "ui" / "src" / "editor" / "resolverRefresh.ts"
SHARED = ROOT / "ui" / "src" / "editor" / "keyedResolver.ts"
SHARED_TYPE = "KeyedResolver"

RENAME_IPCS = ("renameFile", "renameFolder")
CHOKEPOINT = "handleRenameCommit"

# An interface is cache-bearing if it can be told its cache went stale.
STALE_METHOD = re.compile(r"^\s*markStale\(\): void;", re.M)
INTERFACE = re.compile(r"^export interface (\w+) \{(.*?)^\}", re.M | re.S)
# A resolver can also borrow the shared cache wholesale instead of restating it.
ALIAS = re.compile(rf"^export type (\w+) = {SHARED_TYPE}<", re.M)
GROUP_MEMBER = re.compile(r"^\s*\w+: (\w+) \| null;", re.M)


def chokepoint_span(src: str) -> tuple[int, int] | None:
    start = src.find(f"const {CHOKEPOINT} = ")
    if start < 0:
        return None
    end = src.find("\n  };", start)
    return (start, end) if end > 0 else (start, len(src))


def run() -> int:
    gate = Gate("view-freshness", "view-freshness.md")

    # ---- 1. One door for renames ----
    src = APP.read_text(encoding="utf-8")
    span = chokepoint_span(src)
    if span is None:
        gate.fail(
            f"{rel(APP)}: no `{CHOKEPOINT}` — the rename chokepoint is gone, so "
            f"nothing guarantees a rename refreshes the open buffers."
        )
    for path in tracked("ui/src/", suffixes=(".ts", ".tsx")):
        if path in (IPC, APP) or path.name.endswith((".test.ts", ".test.tsx")):
            continue
        text = path.read_text(encoding="utf-8")
        for ipc in RENAME_IPCS:
            if re.search(rf"\b{ipc}\(", text):
                gate.fail(
                    f"{rel(path)} calls {ipc}() directly. Route it through "
                    f"{CHOKEPOINT} in {rel(APP)}, which refreshes the open buffers "
                    f"after the rename lands."
                )
    if span is not None:
        for ipc in RENAME_IPCS:
            for m in re.finditer(rf"\bawait {ipc}\(", src):
                if not (span[0] <= m.start() <= span[1]):
                    gate.fail(
                        f"{rel(APP)}: {ipc}() is called outside {CHOKEPOINT}. Every "
                        f"rename goes through that one function so the buffer refresh "
                        f"cannot be skipped."
                    )

    # ---- 2. Every cache-bearing resolver is in the refresh group ----
    cache_bearing: dict[str, str] = {}
    for path in tracked("ui/src/editor/", suffixes=(".ts",)):
        if path.name.endswith(".test.ts") or path == SHARED:
            continue
        text = path.read_text(encoding="utf-8")
        for name, body in INTERFACE.findall(text):
            if STALE_METHOD.search(body):
                cache_bearing[name] = rel(path)
        for name in ALIAS.findall(text):
            cache_bearing[name] = rel(path)

    group_src = GROUP.read_text(encoding="utf-8")
    group_body = INTERFACE.search(group_src)
    registered = set(GROUP_MEMBER.findall(group_body.group(2))) if group_body else set()

    for name, where in sorted(cache_bearing.items()):
        if name not in registered:
            gate.fail(
                f"{where}: {name} caches vault state but is not a member of "
                f"ResolverGroup in {rel(GROUP)}, so nothing ever refreshes it. "
                f"Add it to the group and to both refresh functions."
            )

    return gate.finish(
        f"renames go through {CHOKEPOINT}; "
        f"{len(cache_bearing)} cache-bearing resolvers all registered for refresh."
    )


main_guard(run)
