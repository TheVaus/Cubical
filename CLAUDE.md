# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. Tauri + Rust + Solid/TS. Plain `.md` files are the absolute source of truth. No Electron, no Node, no cloud.

This is the session primer. Read it before starting any work. For deep detail, follow the Docs pointers below. If a decision here conflicts with what a session participant says, raise the conflict — don't silently override it.

---

## Docs

- **Index:** `docs/README.md` — map of every doc, organized by the question you're trying to answer
- **Architecture:** `docs/architecture/README.md` — locked design decisions, split by domain
- **Layer specs:** `docs/layer-N-spec.md` — one per active or closed layer; intent + what landed
- **Conventions:** `docs/conventions.md` — Rust + TS code style, commits, tests
- **Build order:** `docs/build-order.md` — full layer ladder + v1.0 cut explanation

---

## Non-negotiables

These are load-bearing decisions. Not up for debate in a working session. Surface conflicts as architecture changes, not code changes.

- Plain `.md` files are the absolute source of truth. Everything else (libSQL, indexes, caches) is derived state rebuildable from the markdown.
- The vault is 100% portable and self-contained. No external services required to open a vault.
- No Electron, no Node.js runtime, no centralized cloud database for core storage.
- Files must survive being edited or renamed by external tools (vim, Finder, Dropbox) while the app is closed.
- Plugin code is sandboxed. The plugin ABI is WASI/WASM. JavaScript is supported as a *source language* via Javy/QuickJS-WASM, never as an unsandboxed runtime.
- Desktop only for v1. Mobile is deferred but the architecture must not preclude it.
- No file-identity UUIDs injected into any `.md` file before Layer 7. The vault is the user's vault, byte-for-byte, until sync onboarding.

For non-features explicitly cut from scope, see [`docs/architecture/constraints.md`](docs/architecture/constraints.md).

---

## Session protocol

**Loading:** This file is auto-loaded every session. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file. If editing code, load `docs/conventions.md`. If touching IPC / Tauri, load `docs/migration-touchpoints.md`.

**During work:** Update the current layer spec's in-progress section as things land.

**At session end:** Rewrite the Project state block below (4-6 lines max). Never append — rewrite.

---

## Repository layout

```
cubical/
├── crates/
│   ├── cubical-core/       # vault, file watcher, file-type registry, frontmatter I/O
│   ├── cubical-ast/        # canonical Markdown AST (no Tauri deps)
│   ├── cubical-index/      # libSQL schema and queries
│   ├── cubical-search/     # Tantivy wrapper (L4)
│   ├── cubical-sync/       # CrdtBackend trait + Loro impl (Loro lands at L7)
│   └── cubical-app/        # Tauri app, depends on the above
├── ui/                     # Solid + TypeScript + Vite frontend
├── docs/                   # see docs/README.md for the full index
├── CLAUDE.md
├── Cargo.toml
└── README.md
```

Crates without Tauri deps (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`) must remain buildable and testable without the app harness.

---

## Project state

Current layer: 4 — Search (in progress).

**L4-A-fix closed 2026-06-06 (`l4a-fix` tag).** Three architectural
contracts landed between L4-A and L4-B, all three motivating bugs
operator-confirmed fixed in the running app. `livePreviewBundle`
(Contract 1) makes preview-only transformations a named bundle inside
`decorationCompartment`, structurally closing bug #4. Embed rendering
(Contract 2) is an atomic **inline** replace over `[node.from,
node.to)` — *corrected from the originally-specified block replace,
which was malformed for mid-line embeds and itself caused the bug #6
cursor jump*; closes bug #6 and retires the deferred `⎘` indicator.
Resolver work (Contract 4) adds symmetric `debug()` / `onEvent()` /
`abort()` across both resolvers, plus `EmbedResolver.version()` folded
into the embed widget's identity — this closes bug #5 (nested embeds
A/B/C froze on "Loading…" because the widget tracked only its
top-level cache entry and nested embeds had no independent re-render
path; D worked because it was depth-1). Dev-only `window.__cubical`
exposes the live resolvers.

Two methodology notes for future sessions: (1) the bug #5/#6
root-causes were found via `superpowers:systematic-debugging` with
empirical jsdom probes after an initial guess-shaped fix failed
operator smoke — *don't ship editor fixes on unit tests alone*; jsdom
has no layout engine, so cursor-geometry bugs only surface in
`cargo tauri dev`. (2) Test fixtures must mirror real document shapes
— the Task 2 fixture put `![[X]]` alone on its line and masked the
mid-line bug.

`docs/conventions.md` now requires executed smoke before any
layer/fix tag — Contract E (closes the four-sessions-of-unverified-UI
loophole that birthed this session).

**Deferred from L4-A-fix:** navigation path split (Contract C) —
bugs #2, #3 not reproducing against the live vault; revisit at L4-C
when Omni-Bar surfaces the funnel as load-bearing. Bug #1
(`^block-id` rendering): operator confirmed current smaller+grayer
treatment is intended. Standing backfill (no code change this
session): L4-A search recipes + L1/L2 watcher/properties recipes —
the next session touching those surfaces runs them per the Sessions
ritual.

L4-A-fix test counts at close: **386 vitest + 458 Rust** (+30 vitest /
0 Rust over L4-A close). All six gates green at every commit boundary:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run
build`, `npx vitest run`. L0 closed 2026-05-13 (`l0`); L1 closed
2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`); L3 closed 2026-06-01
(`l3`); L4-A closed 2026-06-03 (`l4a`); L4-A-fix closed 2026-06-06
(`l4a-fix`).

Next: **L4-B — persistent left-panel search results UI**, now
unblocked. First UI consumer of L4-A's search IPC.
