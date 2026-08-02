# Cubical — Documentation

This is the docs index. The session primer is [`CLAUDE.md`](../CLAUDE.md) — start there.

[`CLAUDE.md`](../CLAUDE.md) is auto-loaded every session. Every other file in this tree is loaded on demand based on the task — use the table below to decide what to read.

## What kind of question do you have?

| Question | Read |
|---|---|
| What's the session primer? Current state? | [`CLAUDE.md`](../CLAUDE.md) |
| What's locked architecturally? | [`architecture/README.md`](architecture/README.md) — split by domain |
| What rule constrains this task? | [`principles/README.md`](principles/README.md) — one table, every rule, then open only the file you need |
| What's the code-style rule for X? | [`conventions.md`](conventions.md) — extended detail behind the principles |
| Why is this code written this way? What invariant does it hold? | [`implementation/`](implementation/) — split by domain |
| Where are we in the build order? What ships next? | [`build-order.md`](build-order.md) |
| What does this layer cover? What landed? | [`layer-0-spec.md`](layer-0-spec.md) · [`layer-1-spec.md`](layer-1-spec.md) · [`layer-2-spec.md`](layer-2-spec.md) · [`layer-3-spec.md`](layer-3-spec.md) · [`layer-4-spec.md`](layer-4-spec.md) |
| I'm touching IPC / Tauri | [`migration-touchpoints.md`](migration-touchpoints.md) |
| User wants a `.gitignore` for their vault | [`vault-gitignore.md`](vault-gitignore.md) |
| What's been explicitly cut from scope? | [`architecture/constraints.md`](architecture/constraints.md) |
| What exists right now — crates, IPC surface, DS components? | [`generated/`](generated/) + [`../design-system/INVENTORY.md`](../design-system/INVENTORY.md) |
| How does opening a note / tab / link actually work? | [`architecture/navigation.md`](architecture/navigation.md) |
| How fast must it be? How do I measure it? | [`architecture/foundation.md`](architecture/foundation.md) §1 (commitment 2) |

## Layer status

Layer state (status, tags, close dates) is owned by the **Layer status & tags**
table in [`build-order.md`](build-order.md). Don't restate it here.

## Repository layout

**Generated — [`generated/repo-layout.md`](generated/repo-layout.md).** Built from
the crate manifests plus a directory walk by `scripts/gen_repo_layout.py`, so it
cannot drift and it includes the agent-tooling surface (`.claude/`, `.agents/`,
`.superpowers/`, `graphify-out/`, `design-system/docs/`) that the hand-written
table it replaced silently omitted. Regenerate rather than edit.

Two rules about the layout, which are not generated:

- **Only `cubical-app` may depend on Tauri** — every other crate stays buildable
  and testable without the app harness. Owned by
  [`principles/crate-separation.md`](principles/crate-separation.md); the coupled
  surfaces are inventoried in [`migration-touchpoints.md`](migration-touchpoints.md).
- **`ui/dist/` is a build artifact left in the tree** by the `build` gate. It is
  gitignored, but shell `grep -r` still walks it and returns minified bundle —
  search with ripgrep, which honours `.gitignore`.

Source files carry no explanatory comments — the rule and its functional-pragma
exceptions are owned by [`principles/no-comments.md`](principles/no-comments.md).
The rationale that used to live in those comments is owned by
[`implementation/`](implementation/), one file per domain.

## Generated artifacts

Never hand-written; each carries a `do not edit` banner and is reproducible.
A doc in any other tier may **not** restate what a generator produces — link
instead. That is what stops the IPC surface and the crate list slowly
re-accumulating a stale copy elsewhere.

| Artifact | Generator | Answers |
|---|---|---|
| [`generated/repo-layout.md`](generated/repo-layout.md) | `scripts/gen_repo_layout.py` | What crates and directories exist, and which are Tauri-free |
| [`generated/ipc-surface.md`](generated/ipc-surface.md) | `scripts/gen_ipc_surface.py` | Every `#[tauri::command]` and the `cubical-ipc` wire types |
| [`../design-system/INVENTORY.md`](../design-system/INVENTORY.md) | `scripts/gen_ds_inventory.py` | What DS components exist, their import paths and props — **read before hand-rolling a control** |
| [`principles/README.md`](principles/README.md) | `scripts/gen_principles_readme.py` | Every rule in one table, with the gate that enforces it |

## Other content

- [`reviews/`](reviews/) — past workflow reviews (some recommendations still actionable)
- `superpowers/` — process artifacts for **in-flight** work only: `plans/` + `specs/` for the active (and parked-future) sessions, the live `*-progress.md` handoff, `mockups/`.
- [`superpowers/archive/`](superpowers/archive/) — everything from closed layers, frozen by type: `plans/`, `specs/`, `prompts/` (session closeouts), `notes/` (kickoffs + smoke runbooks).

## Doc discipline

The rule that keeps these docs consistent: **every fact has exactly one owner; every other doc links to it rather than restating it.** When you add or change a fact, update the owner — never a copy.

This is enforced by `scripts/check_docs.py` (in the gate set — see `CLAUDE.md`): it fails on broken internal links, on the schemas / precedence rule / layer-tag enumeration appearing outside their owner, and on `CLAUDE.md` exceeding its primer line budget.

| Fact | Owner |
|---|---|
| What Cubical is + non-negotiables | [`../CLAUDE.md`](../CLAUDE.md) |
| Current focus / branch / tests | [`../CLAUDE.md`](../CLAUDE.md) — Project state |
| Repo layout + crate roles | [`generated/repo-layout.md`](generated/repo-layout.md) — generated |
| The Tauri command / IPC surface | [`generated/ipc-surface.md`](generated/ipc-surface.md) — generated |
| What DS components exist | [`../design-system/INVENTORY.md`](../design-system/INVENTORY.md) — generated |
| Doc map (what to read for X) | this file — the question table |
| Layer status / tags / dates | [`build-order.md`](build-order.md) — Layer status & tags |
| Build-order ladder + v1.0 cut | [`build-order.md`](build-order.md) |
| Locked design + DB schemas | [`architecture/`](architecture/) (doc-wins precedence owned by [`architecture/README.md`](architecture/README.md)) |
| Performance bar, method, medians, harness | [`architecture/foundation.md`](architecture/foundation.md) §1 (commitment 2) |
| Per-layer intent + what landed | `layer-N-spec.md` (L0–L4 only; **L5 has no spec file** — its record is the [L5 design spec](superpowers/specs/2026-06-25-layer-5-daily-driver-polish-design.md) → What landed) |
| The list of setting keys | `ui/src/api/ipc.ts` — the `Setting` union; storage routing owned by [`architecture/ui.md`](architecture/ui.md) §12.1 |
| Implementation invariants (why the code is shaped this way) | [`implementation/`](implementation/) |
| The rule itself (imperative + gate + exceptions) | [`principles/`](principles/) — one file per rule, stable id |
| Extended detail behind a rule | [`conventions.md`](conventions.md) |
| Tauri-coupled surfaces | [`migration-touchpoints.md`](migration-touchpoints.md) |
| Out-of-scope non-features | [`architecture/constraints.md`](architecture/constraints.md) |

Three structural rules:

- **CLAUDE.md is a router, not a record.** It auto-loads every session, so it carries only identity, non-negotiables, protocol, current state, and pointers — never a copy of anything owned elsewhere. Keep it small.
- **Closed layer specs are historical records.** A `layer-N-spec.md` is frozen at layer close (banner at its top): it preserves the *plan* and *what was built* as of then. Current canonical truth lives in [`architecture/`](architecture/). Don't read a closed spec as current state, and when something changes later, update the architecture owner — not the frozen spec. Plan-vs-reality divergence is captured as an inline deviation, so the original intent survives without masquerading as current truth.
- **Archival lifecycle.** When a layer closes: collapse its layer-spec §"Session slicing" to a one-line pointer; move its `plans/`/`specs/`/`prompts/` and loose `*-kickoff`/`*-runbook` notes into the matching [`superpowers/archive/`](superpowers/archive/) subdir; repoint any references in the layer spec. Only in-flight work lives outside `archive/`.
