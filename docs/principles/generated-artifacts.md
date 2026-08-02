# generated-artifacts — Regenerate, never hand-edit

**Rule:** Never hand-edit a file carrying a do-not-edit banner; change the generator instead.

**Gate:** `scripts/gates/generated.py` — regenerates all four artifacts in memory and fails on any diff.

**Why:** A generated artifact is trusted precisely because it cannot drift. One hand-edit converts it into a hand-written file that still *looks* authoritative, and the next regeneration silently discards the edit — so the change is lost and the trust was misplaced at the same time. The four artifacts are the answer to "what exists right now", which is the question a stale doc answers most confidently and most wrongly.

**Exceptions:** None. If the generator produces the wrong thing, that is a bug in the generator, and fixing it there is what keeps every future regeneration correct.

**Artifacts and their generators:**

| Artifact | Generator |
|---|---|
| `docs/generated/repo-layout.md` | `scripts/gen_repo_layout.py` |
| `docs/generated/ipc-surface.md` | `scripts/gen_ipc_surface.py` |
| `design-system/INVENTORY.md` | `scripts/gen_ds_inventory.py` |
| `docs/principles/README.md` | `scripts/gen_principles_readme.py` |

Each accepts `--check`, which regenerates in memory and exits non-zero if the tracked file differs. All four are deterministic: they read tracked sources only, emit no timestamps and no absolute paths, so a fresh clone produces the same bytes as a fully built tree.

**Detail:** [`../README.md`](../README.md) → Generated artifacts.
