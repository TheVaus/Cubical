# Cubical — Documentation

This is the docs index. The session primer is [`CLAUDE.md`](../CLAUDE.md) — start there.

[`CLAUDE.md`](../CLAUDE.md) is auto-loaded every session. Every other file in this tree is loaded on demand based on the task — use the table below to decide what to read.

## What kind of question do you have?

| Question | Read |
|---|---|
| What's the session primer? Current state? | [`CLAUDE.md`](../CLAUDE.md) |
| What's locked architecturally? | [`architecture/README.md`](architecture/README.md) — split by domain |
| What's the code-style rule for X? | [`conventions.md`](conventions.md) |
| Why is this code written this way? What invariant does it hold? | [`implementation/`](implementation/) — split by domain |
| Where are we in the build order? What ships next? | [`build-order.md`](build-order.md) |
| What does this layer cover? What landed? | [`layer-0-spec.md`](layer-0-spec.md) · [`layer-1-spec.md`](layer-1-spec.md) · [`layer-2-spec.md`](layer-2-spec.md) · [`layer-3-spec.md`](layer-3-spec.md) · [`layer-4-spec.md`](layer-4-spec.md) |
| I'm touching IPC / Tauri | [`migration-touchpoints.md`](migration-touchpoints.md) |
| User wants a `.gitignore` for their vault | [`vault-gitignore.md`](vault-gitignore.md) |
| What's been explicitly cut from scope? | [`architecture/constraints.md`](architecture/constraints.md) |

## Layer status

Layer state (status, tags, close dates) is owned by the **Layer status & tags**
table in [`build-order.md`](build-order.md). Don't restate it here.

## Repository layout

```
cubical/
├── crates/
│   ├── cubical-core/       # vault, file watcher, file-type registry, frontmatter I/O
│   ├── cubical-ast/        # canonical Markdown AST (no Tauri deps)
│   ├── cubical-index/      # libSQL schema and queries
│   ├── cubical-query/      # dataview-style query parser + evaluator
│   ├── cubical-search/     # Tantivy wrapper (L4)
│   ├── cubical-sync/       # CrdtBackend trait + Loro impl (Loro lands at L7)
│   ├── cubical-engine/     # transport-free engine: commands, AppState, EventSink, vault_lock
│   ├── cubical-ipc/        # wire boundary: Command/Outcome/Response, one dispatch(), render(), unix socket transport
│   ├── cubical-cli/        # `cubical` terminal frontend (runs standalone, or attaches to the running app)
│   └── cubical-app/        # Tauri app, depends on the above; hosts the cubical-ipc socket server
├── ui/                     # Solid + TypeScript + Vite frontend
├── design-system/          # @ds — SolidJS component library + canonical design tokens; ui/ borrows from here (architecture/ui.md §11.6)
├── docs/                   # this index
├── scripts/                # check.sh (the gate set) + check_docs.py
├── .github/                # CI workflow (runs check.sh) + Dependabot config
├── CLAUDE.md               # session primer (auto-loaded)
├── Cargo.toml
├── rust-toolchain.toml     # pinned Rust version (local == CI)
└── README.md
```

Crates without Tauri deps (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-query`, `cubical-search`, `cubical-sync`, `cubical-engine`, `cubical-ipc`, `cubical-cli`) must remain buildable and testable without the app harness — `cubical-app` is the only Tauri-coupled crate. Tauri-coupled surfaces are inventoried in [`migration-touchpoints.md`](migration-touchpoints.md).

Source files carry no explanatory comments — the rule (and the few functional pragmas that must never be stripped) is owned by [`conventions.md`](conventions.md) → Comments. The rationale that used to live in those comments is owned by [`implementation/`](implementation/), one file per domain.

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
| Repo layout + crate roles | this file — Repository layout |
| Doc map (what to read for X) | this file — the question table |
| Layer status / tags / dates | [`build-order.md`](build-order.md) — Layer status & tags |
| Build-order ladder + v1.0 cut | [`build-order.md`](build-order.md) |
| Locked design + DB schemas | [`architecture/`](architecture/) (doc-wins precedence owned by [`architecture/README.md`](architecture/README.md)) |
| Per-layer intent + what landed | `layer-N-spec.md` |
| Implementation invariants (why the code is shaped this way) | [`implementation/`](implementation/) |
| Code style, commits, tests | [`conventions.md`](conventions.md) |
| Tauri-coupled surfaces | [`migration-touchpoints.md`](migration-touchpoints.md) |
| Out-of-scope non-features | [`architecture/constraints.md`](architecture/constraints.md) |

Three structural rules:

- **CLAUDE.md is a router, not a record.** It auto-loads every session, so it carries only identity, non-negotiables, protocol, current state, and pointers — never a copy of anything owned elsewhere. Keep it small.
- **Closed layer specs are historical records.** A `layer-N-spec.md` is frozen at layer close (banner at its top): it preserves the *plan* and *what was built* as of then. Current canonical truth lives in [`architecture/`](architecture/). Don't read a closed spec as current state, and when something changes later, update the architecture owner — not the frozen spec. Plan-vs-reality divergence is captured as an inline deviation, so the original intent survives without masquerading as current truth.
- **Archival lifecycle.** When a layer closes: collapse its layer-spec §"Session slicing" to a one-line pointer; move its `plans/`/`specs/`/`prompts/` and loose `*-kickoff`/`*-runbook` notes into the matching [`superpowers/archive/`](superpowers/archive/) subdir; repoint any references in the layer spec. Only in-flight work lives outside `archive/`.
