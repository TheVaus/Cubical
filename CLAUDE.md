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

**L4-A-fix code-complete; tag PENDING on operator-driven steps.** Three
architectural contracts landed between L4-A and L4-B: `livePreviewBundle`
(Contract 1) makes preview-only transformations a named bundle inside
`decorationCompartment`, structurally closing bug #4; embed
atomic-replace at `[node.from, node.to)` (Contract 2) makes the byte
range *be* the widget, closing bug #6 and retiring the deferred `⎘`
indicator; resolver observability (Contract 4a) adds symmetric
`debug()` / `onEvent()` / `abort()` across `EmbedResolver` and
`WikiLinkResolver`, with dev-only `window.__cubical` exposure for
diagnostic.

`docs/conventions.md` now requires executed smoke before any
layer/fix tag — Contract E (closes the four-sessions-of-unverified-UI
loophole that birthed this session).

**Pending operator-driven work before `l4a-fix` tags:**
1. Bug #5 diagnostic per spec §3.3 decision tree, run against
   `~/Developer/sandbox/cubical-l4a-smoke/` from the dev console.
2. Bug #5 fix (Contract 4b) grounded in the diagnostic evidence;
   spec §8 circuit-breaker fires if cause is outside `ui/`.
3. Execute the consolidated smoke runbook
   (`docs/superpowers/2026-06-04-l4a-fix-smoke-runbook.md`) against
   the L4-A smoke vault; commit the filled-in `-executed.md` version.
4. Apply the `l4a-fix` tag.

**Deferred from L4-A-fix:** navigation path split (Contract C) —
bugs #2, #3 not reproducing against the live vault; revisit at L4-C
when Omni-Bar surfaces the funnel as load-bearing. Bug #1
(`^block-id` rendering): operator confirmed current smaller+grayer
treatment is intended.

L4-A-fix test counts at code-complete checkpoint: **383 vitest + 458
Rust** (+27 vitest / 0 Rust over L4-A close). All six gates green at
every commit boundary: `cargo test --workspace`, `cargo clippy
--workspace --all-targets -- -D warnings`, `cargo fmt --all --check`,
`npx tsc --noEmit`, `npm run build`, `npx vitest run`. L0 closed
2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22
(`l2`); L3 closed 2026-06-01 (`l3`); L4-A closed 2026-06-03 (`l4a`);
L4-A-fix tag pending.

Next: complete bug #5 diagnostic + fix + smoke, then tag `l4a-fix`.
L4-B (persistent left-panel search results UI) remains gated until
the tag lands.
