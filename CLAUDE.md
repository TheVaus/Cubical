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

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix done + Session G backend core done; Session G frontend follow-up + Sessions H–K pending). Session G landed block-reference *backend core* on branch `l3-session-g-block-references` (see layer-3-spec §9.8). Headline invariant: a `^block-id` is written to source by **exactly one** path — the `create_block_ref` command; nothing bulk-auto-assigns. Migration 005 adds `blocks(file_path, block_id, position_hint, last_modified)` (per-file `^id` definitions) + `block_refs(source_file_path, target_file_path, target_block_id)` (resolved `[[target#^id]]`), both CASCADE on `files(path)`; `HIGHEST_KNOWN_VERSION=5`. `cubical-core::vault::blocks`: pure `extract_block_ids` (fence-aware, `^`+`[A-Za-z_][A-Za-z0-9_-]*` at line end) + `refresh_blocks` (per-file, no resolution — inline in scan **Pass 1** + watcher) + `refresh_block_refs_for_file` (derives `block_refs` from resolved `anchor_kind='block'` rows in `links` — scan **Pass 2** in the same `link_tx` + watcher). `cubical-index::blocks`: `replace_blocks_for_file`/`replace_block_refs_for_file` (delete-then-insert), `blocks_for_file`, `block_exists`, `broken_block_refs` (query-time `LEFT JOIN`/anti-join — broken-ness never stored). `cubical-app::commands::blocks`: `create_block_ref` (mint deterministic `b`+sha256(path:position)[..6] id at the line containing a byte `position`, append ` ^id`, write file, persist row; idempotent if line already has an id) + `get_broken_block_refs`; two Tauri shims + `ipc.ts` `createBlockRef`/`getBrokenBlockRefs` (unused until UI). `resolve_link` deliberately unchanged. Scanner grammar (`is_valid_block_id`) and minter grammar (`is_valid_id`) are duplicated across crates and **must stay in lockstep**. Scope = backend core only — editor create-ref gesture, `^id` decoration, broken-ref status bar are the deferred frontend follow-up.
Tests: 271 Rust (+15: 1 migration-005 + 4 index-query + 5 scanner + 2 core-refresh + 3 handlers) + 268 vitest (unchanged — no UI logic). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: **L3 Session G frontend follow-up** (editor create-ref gesture, `^id` decoration, broken-ref status bar) + the deferred in-bracket `[[#^` autocomplete (now that `blocks` exists), then **Session H — Embeds**. Smoke notes still pending hands-on (automated-context constraint): (a) Session G — invoke `create_block_ref` on a real note, confirm `^id` lands in the `.md` + `[[note#^missing]]` surfaces via `get_broken_block_refs`; (b) Session F autocomplete `[[`/`#` dropdowns. Both fully unit/integration-tested.
