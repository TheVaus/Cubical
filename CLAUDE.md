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

**L4-A-fix closed 2026-06-06 (`l4a-fix` tag).** Editor-surface
structural-debt session between L4-A and L4-B; all motivating bugs
operator-confirmed fixed in the running app. `livePreviewBundle`
(Contract 1) makes preview-only transformations a named bundle inside
`decorationCompartment`, structurally closing bug #4. Embed rendering
(Contract 2, final form): when `![[…]]` is **alone on its line** (the
by-convention shape), the whole line is replaced with an atomic
**block** decoration `Decoration.replace({ widget, block: true })`
over `[line.from, line.to)` — the cursor-safe primitive (same as
frontmatter hiding); mid-line embeds stay raw. Cursor traversal across
the rendered card (Contract 2b, added under smoke): `atomicRanges`
handles horizontal motion, and `ui/src/editor/embedNav.ts` adds a
custom `ArrowUp`/`ArrowDown` keymap that corrects CM6's *geometric*
vertical motion — a tall card is one document line spanning many
screen rows, so default Up/Down overshoots it; `correctedVerticalHead`
detects an overshoot of >1 document line and steps exactly one
document line. Resolver work (Contract 4) adds `debug()` / `onEvent()`
/ `abort()` plus `EmbedResolver.version()` folded into the embed
widget identity — closes bug #5 (nested embeds A/B/C froze on
"Loading…"; the widget tracked only its top-level cache entry and
nested embeds have no independent re-render path; D worked because it
was depth-1). Dev-only `window.__cubical` exposes the live resolvers.

Three methodology notes for future sessions: (1) **don't ship editor
fixes on unit tests alone** — jsdom has no layout engine, so the
cursor-geometry bugs only surfaced in `cargo tauri dev`; the embed
render/cursor work took *five* operator re-smoke rounds, and the
final vertical-motion fix was derived from a dev-only diagnostic
listener logging real before/after cursor positions. (2) **Test
fixtures must mirror real document shapes** — an early fixture put
`![[X]]` alone on its line and masked the mid-line bug. (3) **Match
the framework, don't fight it** — block-sized content needs block
decorations; the cursor tension was only resolved by reading how CM6
(and Obsidian) actually handle it (`atomicRanges` + a custom arrow
keymap), not by swapping decoration types.

`docs/conventions.md` now requires executed smoke before any
layer/fix tag — Contract E (closes the four-sessions-of-unverified-UI
loophole that birthed this session).

**Known issue (deferred, documented):** typing in a file with a
rendered embed occasionally jumps the viewport to the top (cursor
stays put) — autosave's own-write watcher event unconditionally
invalidates the embed cache, remounting every embed (height thrash).
Root cause + fix options in `docs/layer-4-spec.md` §9.2; recommended
as a focused follow-up before L4-B.

**Deferred from L4-A-fix:** navigation path split (Contract C) —
bugs #2, #3 not reproducing against the live vault; revisit at L4-C
when Omni-Bar surfaces the funnel as load-bearing. Bug #1
(`^block-id` rendering): operator confirmed current smaller+grayer
treatment is intended. Standing backfill (no code change this
session): L4-A search recipes + L1/L2 watcher/properties recipes —
the next session touching those surfaces runs them per the Sessions
ritual.

L4-A-fix test counts at close: **394 vitest + 458 Rust** (+38 vitest /
0 Rust over L4-A close). All six gates green at every commit boundary:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run
build`, `npx vitest run`. L0 closed 2026-05-13 (`l0`); L1 closed
2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`); L3 closed 2026-06-01
(`l3`); L4-A closed 2026-06-03 (`l4a`); L4-A-fix closed 2026-06-06
(`l4a-fix`).

Next: **L4-B — persistent left-panel search results UI**, now
unblocked. First UI consumer of L4-A's search IPC.
