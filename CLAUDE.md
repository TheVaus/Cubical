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

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + Session G backend core + Session G frontend gesture/decoration + broken-ref status bar done; `[[#^` autocomplete + Sessions H–K pending). Backend core (branch `l3-session-g-block-references`, spec §9.8): a `^block-id` is written to source by **exactly one** path — the `create_block_ref` command; nothing bulk-auto-assigns. Migration 005 adds `blocks(file_path, block_id, position_hint, last_modified)` + `block_refs(source_file_path, target_file_path, target_block_id)`, both CASCADE on `files(path)`; `HIGHEST_KNOWN_VERSION=5`. `cubical-core::vault::blocks`: `extract_block_ids` (fence-aware, `^`+`[A-Za-z_][A-Za-z0-9_-]*` at line end) + `refresh_blocks` (per-file — scan **Pass 1** + watcher) + `refresh_block_refs_for_file` (derives `block_refs` from resolved `anchor_kind='block'` `links` rows — scan **Pass 2** + watcher). `cubical-index::blocks`: `replace_blocks_for_file`/`replace_block_refs_for_file`, `blocks_for_file`, `block_exists`, `broken_block_refs` (query-time anti-join — broken-ness never stored). `cubical-app::commands::blocks`: `create_block_ref` (deterministic `b`+sha256(path:position)[..6] id; idempotent) + `get_broken_block_refs`. `resolve_link` unchanged. Scanner grammar (`is_valid_block_id`) ↔ minter grammar (`is_valid_id`) ↔ frontend `TRAILING_BLOCK_ID` regex **must stay in lockstep**. Frontend gesture/decoration (branch `l3-session-g-frontend`, spec §9.9): `Cmd/Ctrl+Shift+B` → `byteOffsetOf` (CM UTF-16 → UTF-8 bytes) → `Editor.onCopyBlockRef` → `App.handleCopyBlockRef` (`flushAutosave` → `createBlockRef` IPC → clipboard `[[path-minus-.md#^id]]`); the disk write rides the clean-buffer silent-reload path to surface `^id`. `^id` decoration: `findBlockIds` (direct doc scan à la `findFrontmatter`, fence-aware via Lezer ancestor walk) → `mark-blockid`/`cm-md-blockid` (muted, 0.85em, revealed raw on the cursor line), merged in `buildFor`. Pure helpers in `ui/src/editor/blockRef.ts`. Broken-ref status bar (branch `l3-session-g-statusbar`, spec §9.10): the existing `App.tsx` `<footer>` gains a `<Show>`-gated warning item via pure `formatBrokenBlockRefs` (`ui/src/statusbar/brokenRefs.ts`) → `{label,title}|null`; a `brokenBlockRefs` signal is refreshed by `getBrokenBlockRefs` on scan-complete + debounced `vault:file-changed`, cleared on vault reset. Passive (no click); broken *wiki-link* surfacing still deferred (no backend query).
Tests: 271 Rust (Session G backend +15; frontend sessions added none) + 282 vitest (+14 total since L2: 6 `blockRef` + 5 `findBlockIds` + 3 `formatBrokenBlockRefs`). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: **in-bracket `[[#^` autocomplete** (deferred from Session F; needs a new backend "block-ids in a file" query, so not frontend-only), then **Session H — Embeds**. Smoke still pending hands-on (automated-context constraint): (a) gesture — `Cmd/Ctrl+Shift+B` copies `[[note#^id]]`, `^id` lands in the `.md`, renders muted off-cursor / raw on-cursor; (b) status bar — `[[note#^missing]]` shows `⚠ 1 broken block ref`, clears when the id is added; (c) Session F `[[`/`#` dropdowns. All fully unit/integration-tested.
