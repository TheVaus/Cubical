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

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + G full + `[[#^` block-id autocomplete + H.1 + H.2 + I done; **J.1 partial — infrastructure landed, IPC handlers pending**; J.2 + K pending).

Session J brainstorm + design + split prompts are committed; J.1 backend infrastructure landed in five commits (`3da2316` → `e1b1a70`) on branch `l3-session-j-pending-rewrites`. Spec §9.15 (`docs/layer-3-spec.md`) names what's in and what's out.

**J.1 — what landed** (chains 1+2+3 of the planned 4):
- Migration `006_pending_rewrites.sql` + `cubical-index::pending` query module (12 functions; `RewriteKind` / `PendingRewriteRow` / `NewPendingRewrite` / `RenameOpRow` types; `HIGHEST_KNOWN_VERSION=6`; new `IndexError::UnknownEnum`).
- Pure `cubical-core::vault::pending::apply_pending` + `materialize_on_read`. All three kinds: `WikiLink` (preserves `|display` + `#anchor` + `!` embed via private `emit_wikilink`); `Tag` (frontmatter `tags:` minimal targeted edits across inline-flow / block-list / scalar shapes + inline body with Session D boundary rules via `extract_text_runs`); `BlockRef` (referrer `[[note#^id]]` + defining-line `^id` trailing-token rule).
- Materialize-on-read invariant wired into `read_file_text`, `get_embed`, `get_unlinked_mentions`, scan pass 1, watcher `Modified` branch. `get_canonical_ast` derives from `read_file_text`, inherits. Watcher's `content_hash` pass kept on raw bytes (load-bearing for change detection). `refresh_X` signatures: `(vault, abs: &Path, rel)` → `(vault, rel, source: &str)` so caller does read+materialize once. `extract_links_off_executor` → `extract_links_from_source`.
- `link_mention` flushes pending rows for the source file FIRST (via new `commands::rename::flush_target_for_link_mention` helper — apply_pending + atomic_write + delete_pending_for_target + best-effort content_hash bump), then re-reads disk, then splices.
- `commands/rename.rs` exists as a J.1 stub holding only the flush helper.

**J.1 — what did NOT land** (chain 4 hit a subagent session limit mid-execution; partial state reverted to keep tree green):
- `mint_rename_op_id` (`config['pending_rewrites.next_rename_op_id']` counter).
- `rename_file` / `rename_tag` / `rename_block_id` IPC handlers. **Critical implementation detail confirmed during the chain-4 attempt:** none of the existing FKs (`links.source_path`, `tags.file_path`, `blocks.file_path`, `block_refs.source_file_path`, `frontmatter.file_path`) have `ON UPDATE CASCADE` (SQLite default is `NO ACTION`), so `rename_file` must `UPDATE` each FK-bearing table's path column BEFORE the `UPDATE files SET path = ?to`. Explicit rekey approach > shipping migration 007 to alter FK constraints.
- `flush_pending_rewrites` + `flush_pending_rewrites_for_target` IPCs (the chain-3 stub helper IS the per-target executor; rename + add the shim).
- `get_pending_rewrites_count` / `_breakdown` / `list_recent_rename_ops` / `undo_rename` IPCs.
- Flush triggers: 5-min periodic timer (per-vault tokio task + `tokio_util::sync::CancellationToken`), mandatory close_vault flush, >50-per-file fuse, manual.
- Backend own-write hash gate (`OpenVault.flush_own_writes: Arc<Mutex<HashSet<(PathBuf, ContentHash)>>>` populated by flush, drained by watcher dispatcher before emitting `vault:file-changed`) + `OpenVault.flush_in_progress` mutex + `OpenVault.flush_timer_cancel` token. Chain 4 attempted these three fields but didn't migrate the 9 existing `OpenVault { … }` struct-literal call sites; the partial state was reverted.
- `lib.rs` `generate_handler!` registration of 9 new IPCs.
- `ui/src/api/ipc.ts` typed binding stubs + `onVaultPendingRewritesChanged` + `onVaultFlushComplete` + `pending_rewrites.flush_interval_secs` in `Setting`.
- New events: `vault:pending-rewrites-changed { vault_id, count }`, `vault:flush-complete { vault_id, files_rewritten, refs_updated }`.

Earlier L3 (unchanged): backend block-refs (Session G, spec §9.8) — `create_block_ref` is the only `^block-id` minter; deterministic id `b`+sha256(path:position)[..6]. Frontend gesture + decoration + status bar (§9.9 + §9.10), `[[#^` block-id autocomplete (§9.11). H.1 (`embeds::{extract_section,extract_block,strip_frontmatter,slugify}` + `commands::embeds::get_embed`). H.2 (CM6 embed-widget, per-vault `EmbedResolver`, pure `renderEmbedBody`). Session I (`commands::mentions`) — full description in spec §9.14.

Tests: 381 Rust (326 baseline + 55 new in J.1 infrastructure: 14 cubical-index + 35 cubical-core::vault::pending + 6 app-side materialize sites). 329 vitest unchanged (no UI changes). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).

Next: finish J.1 chain-4 work in a fresh window — drive [`docs/superpowers/prompts/l3-session-j1-pending-rewrites-backend.md`](docs/superpowers/prompts/l3-session-j1-pending-rewrites-backend.md) STEP 2 items 5–11 (rename handlers + flush IPCs + triggers + own-write gate + IPC registration + ipc.ts stubs). Locked design at `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` still holds; the spec §9.15 partial entry catalogues every remaining piece. Then J.2 (frontend), then K (closeout, `l3` tag, full smoke pass). Hands-on smoke for Session I still pending (recipe in §9.14). H.3 polish (rich markdown inside embed body, click nav, `⎘` retirement) remains explicitly deferred — not on §6 DoD critical path.
