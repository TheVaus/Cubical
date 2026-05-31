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

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + G full + `[[#^` block-id autocomplete + H.1 + H.2 + I + **J.1 done**; J.2 + K pending).

Session J brainstorm + design + split prompts are committed; J.1 closed across two merges on `main` — chains 1+2+3 (`3da2316` → `1e26269`) and chain 4 (rename + flush IPCs + triggers + own-write gate + IPC registration + ipc.ts stubs). Spec §9.15 (`docs/layer-3-spec.md`) is the complete catalogue.

**J.1 highlights** (full prose in spec §9.15):
- Migration `006_pending_rewrites.sql` (`HIGHEST_KNOWN_VERSION=6`) + `cubical-index::pending` module (12 query fns + `RewriteKind`/`PendingRewriteRow`/`NewPendingRewrite`/`RenameOpRow` + new `IndexError::UnknownEnum`).
- Pure `cubical-core::vault::pending::apply_pending` covering all three kinds (wikilink with `|display`+`#anchor`+`!`embed preserved, tag inline+frontmatter, block-ref referrer+defining-line). Materialize-on-read wired into `read_file_text`/`get_embed`/`get_unlinked_mentions`/scan pass 1/watcher `Modified` extractors; `link_mention` flushes-then-reads-then-splices.
- `OpenVault::new(...)` constructor + three Arc-wrapped flush fields (`flush_own_writes`, `flush_in_progress`, `flush_timer_cancel`). Backend own-write hash gate consumed by watcher dispatcher's Modified branch (pure `consume_own_write_hash` helper) before `emit_file_changed` so flush rewrites don't bounce back as external edits.
- Three rename IPCs (`rename_file` / `rename_tag` / `rename_block_id`) with explicit FK rekey under `PRAGMA defer_foreign_keys = 1` (no migration 007). Two flush IPCs + per-target `flush_pending_for_target` executor + own-write gate populate-before-write. Four read-only IPCs (`get_pending_rewrites_count`/`_breakdown`/`list_recent_rename_ops`/`undo_rename`). All four flush triggers wired: periodic timer (reads `pending_rewrites.flush_interval_secs` from config, default 300), close-time flush (cancels timer first), >50-per-file fuse, manual.
- 9 new IPCs registered in `lib.rs`; emit helpers + handler signatures runtime-generic so tests use `tauri::test::MockRuntime`. `ui/src/api/ipc.ts` ships typed stubs + `onVaultPendingRewritesChanged` / `onVaultFlushComplete` listeners + `pending_rewrites.flush_interval_secs` in `Setting`. New events: `vault:pending-rewrites-changed { vault_id, count }`, `vault:flush-complete { vault_id, files_rewritten, refs_updated }`.

Earlier L3 (unchanged): backend block-refs (Session G, spec §9.8) — `create_block_ref` is the only `^block-id` minter; deterministic id `b`+sha256(path:position)[..6]. Frontend gesture + decoration + status bar (§9.9 + §9.10), `[[#^` block-id autocomplete (§9.11). H.1 (`embeds::{extract_section,extract_block,strip_frontmatter,slugify}` + `commands::embeds::get_embed`). H.2 (CM6 embed-widget, per-vault `EmbedResolver`, pure `renderEmbedBody`). Session I (`commands::mentions`) — full description in spec §9.14.

Tests: 406 Rust (326 baseline + 55 J.1 infrastructure + 25 J.1 chain-4: 3 events own-write gate + 22 commands::rename rename/flush/trigger paths). 329 vitest unchanged (ipc.ts stubs are unused). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).

Next: J.2 (frontend) — `Toast.tsx` + status-bar count + per-target breakdown dropdown + per-op undo affordance + right-click "Rename…" gesture + `App.tsx` wiring of the two new listeners + settings UI for `pending_rewrites.flush_interval_secs`. Headless smoke recipe documented in spec §9.15; hands-on smoke is J.2 scope per Session I's precedent. Then K (L3 closeout, `l3` tag, full smoke pass). Hands-on smoke for Session I still pending (recipe in §9.14). H.3 polish (rich markdown inside embed body, click nav, `⎘` retirement) remains explicitly deferred — not on §6 DoD critical path.
