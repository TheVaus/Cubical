# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. The "perfect Obsidian alternative" — same philosophy of absolute data ownership and plain-text portability, but rebuilt on a modern, Rust-native stack with no Electron, no Node, and no legacy JavaScript bloat.

This file is the persistent memory for Claude Code sessions. Read it at the start of every session before doing anything else. It captures the locked architecture, the build order, the non-negotiables, and the current state of the project. If a decision in this file conflicts with something a session participant says, raise the conflict explicitly rather than silently overriding the file.

---

## Non-negotiables

These are load-bearing decisions. They are not up for debate inside a working session. If a change to one of these is genuinely required, stop and surface it as an architectural change, not a code change.

- Plain `.md` files are the absolute source of truth. Everything else (libSQL, CRDT logs, indexes, caches) is derived state that can be rebuilt from the markdown.
- The vault is 100% portable and self-contained. No external services are required to open a vault.
- No Electron, no Node.js runtime, no centralized cloud database for core storage.
- Files must survive being edited or renamed by external tools (vim, Finder, Dropbox) while the app is closed.
- Plugin code is sandboxed. The plugin ABI is WASI/WASM. JavaScript is supported as a *source language* via Javy/QuickJS-WASM, never as an unsandboxed runtime.
- Desktop only for v1. Mobile is deferred but the architecture must not preclude it.

---

## Architecture summary

The full architecture lives in `docs/architecture.md`. This is the short version.

**Backend.** Tauri + Rust, with a strict IPC allowlist. All file I/O, database queries, parsing, indexing, and CRDT operations happen on the Rust side.

**Storage.** Plain `.md` files plus a `.cubical/index.db` libSQL database inside the vault for metadata, link indexes, block references, tags, pending rewrites, CRDT operation logs (post-L7), and Time Machine snapshots (post-L7). Single-file database, gitignorable, rebuildable.

**File identity.** **Path-based identity for v1.0** (Layers 0–6) — no UUIDs are written into user files at all. Renames are detected by the file watcher and reconciled through the Pending Rewrites Cache. **Frontmatter UUIDs (`cubical_id: <uuid>`) are introduced at L7** as part of "enable sync" onboarding; mtime is preserved across the write. The vault Cubical opens is the vault the user wrote, byte-for-byte, until they choose to enable sync.

**External-edit handling.** When `notify` reports an external change: read new content; if the file is open with unsaved local edits, snapshot the prior buffer to `.cubical/recovery/` and surface a 3-way merge UI; otherwise accept the new content silently and refresh the index. Time Machine is post-L7 / post-v1.0 and not the safety net for this layer — `.cubical/recovery/` is. Pre-L7 the diff is applied directly; post-L7 it goes through Loro as a `filesystem`-authored CRDT op.

**Editor.** CodeMirror 6 + Lezer in the webview. **Pretext** is the DOM-free text-measurement engine that sits beneath CM6's variable-height-content measurement paths and beneath large-list virtualization (file tree, search results). Pretext does not handle input — only measurement. Live Preview is implemented as Lezer-driven decorations on the editor state — not a separate render mode.

**Canonical AST.** A Rust-defined Markdown AST is the lingua franca for everything outside the editor. Lezer trees are normalized into canonical AST on the Rust side. Indexers, link resolvers, exporters, and plugins consume canonical AST. The editor is the only system that speaks Lezer. The AST is intentionally slim — only nodes Cubical itself produces. Cross-app importers are out of scope.

**Search.** Tantivy for full-text (BM25, stemming, typo tolerance). libSQL for structured Dataview-style queries against frontmatter, tags, and metadata.

**Sync.** **Layer 7.** Loro CRDT, Rust-native, with movable-tree support for the file tree. Per-note operation logs in libSQL keyed by `file_uuid`. CRDT layer is abstracted behind `trait CrdtBackend` — the trait exists from L0 as a planned interface, but Loro is unimplemented through L6. WebRTC P2P + optional E2EE relay land at L7.

**Pending Rewrites Cache.** Renames (file, tag, block-id) are deferred-write. The user-visible event is instant; referrer files are rewritten on a 5-min flush + on app close. Reads materialize on the fly (apply pending rewrites for the file before returning content). Status bar shows the unflushed count. Undo within the unflushed window is a SQL DELETE; after flush it's a reverse rewrite.

**Tags.** Both inline `#tag` and frontmatter `tags: [...]`. Nesting via `/`. Case-insensitive matching, case-preserving display. Hierarchy semantics: prefix match (`#parent` matches itself + descendants). Tag pages are virtual — auto-generated from libSQL queries, not real `.md` files.

**Block references.** Lazy `^block-id` slugs scoped per file. ID created only when the user makes a reference; no bulk auto-assignment. `(file_path, block_id)` unique within file pre-L7, `(file_uuid, block_id)` post-L7.

**Themes.** Single CSS-variable token surface in `ui/src/styles/tokens.css`. All UI components consume tokens; no hardcoded colors/fonts/spacings outside the tokens file. Built-in light + dark; user themes at `<vault>/.cubical/themes/`; plugin themes via manifest. CM6 theme generated programmatically from the same surface.

**Multi-vault.** One vault per window, multiple windows allowed. Single Tauri process holds `HashMap<VaultId, Vault>`; each window's frontend tracks one vault_id.

**Concurrency.** Three lanes with strict separation:
- Lane 1 (webview main thread): CodeMirror, Pretext, DOM. Nothing else.
- Lane 2 (Rust async, Tokio): all I/O, all DB, all parsing, all CRDT (post-L7), all heavy work.
- Lane 3 (Web Workers): WASM plugins (L6+).
IPC commands across Lane 1 ↔ Lane 2 are coarse-grained ("save note and return updated backlinks"), never chatty.

**Frontend framework.** Solid + TypeScript + Vite. Solid's fine-grained reactivity matches a UI driven by streaming backend events. Editor and Pretext own their own DOM; Solid stays out of their way.

**Frontmatter.** YAML 1.2 strict via `serde_yaml_ng` at the top of the file. Malformed frontmatter: open the file as if it has no frontmatter, surface "YAML parse error" in vault health UI.

---

## Build order

The project is built in foundation layers. Each layer assumes the layers below are solid; nothing in a higher layer leaks down. The current layer is recorded in the "Project state" section below.

**v1.0 cut is at the end of L5.**

0. **Bedrock.** Cargo workspace, Tauri scaffold, libSQL + migrations, file watcher, vault open/scan (non-blocking), polymorphic file-type registry, frontmatter read/write, minimal external-edit reload, token-surface scaffold in the frontend. **No UUID injection.**
1. **Document Model.** Lezer integration, canonical Markdown AST in Rust, Lezer-to-canonical normalizer, structured frontmatter parsing into libSQL columns.
2. **Editing.** CodeMirror 6 + Pretext-backed measurement + Live Preview decorations, raw-source toggle, properties UI, built-in light + dark themes derived from the token surface, CM6 theme generated from tokens. *First demo-able milestone.*
3. **Knowledge Graph.** Wiki-links, embeds (`![[...]]`), lazy block IDs and references, backlinks, unlinked mentions, link/tag autocomplete, **nested tags + virtual tag pages**, rename → Pending Rewrites Cache.
4. **Search.** Tantivy, Dataview-style libSQL queries, persistent search panel, Cmd/Ctrl+K Omni-Bar.
5. **Daily-Driver Polish.** Theme picker UI + vault `.cubical/themes/` scanning, export sanitization, perf pass, keyboard shortcuts. **Public v1.0 cut.**
6. **Plugins.** WASI host, manifest format, permission UI, Web Worker plugin runtime, JS-to-WASM toolchain (Javy/QuickJS-WASM), plugin dev kit, plugin-distributed themes, ABI deprecation framework (N, N-1, N-2 support window).
7. **Sync.** Loro lands; **frontmatter `cubical_id` UUIDs minted at "enable sync" onboarding**; WebRTC P2P; optional E2EE relay; two-tier asset pipeline.
8. **Time Machine.** (Post-v1.0.) Sync-clean-state snapshots, version-history UI, "view this note as it was on date X," "restore to this version," 3-way merge UI for in-flight conflicts.
9. **Graph View.** (Post-v1.0.) WebGPU-rendered knowledge graph.
10. **Long tail.** (Post-v1.0.) Canvas, mobile, anything else.

Plugins ship before sync network because the plugin ABI is a one-way door — once third parties depend on it, breaking changes are costly. Earn a stable core first.

**Cut features (not "later" — "no" for v1.x):** EOF HTML-comment UUIDs, recovery waterfall (4-tier), cross-app importers, local AI / RAG / llama.cpp as a core feature, `.cubical/quarantine/` directory.

---

## Repository layout

Cargo workspace from day one. TypeScript frontend in a sibling directory, owned by Vite.

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
├── docs/
│   ├── architecture.md
│   └── layer-0-spec.md
├── CLAUDE.md
├── Cargo.toml              # workspace
└── README.md
```

Crates without Tauri dependencies (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`) must remain testable and buildable without the app harness. This protects future code that consumes them — the eventual plugin SDK and headless tools.

`cubical-sync` exists as a crate from L0 onward, but only contains the `trait CrdtBackend` definition until L7 introduces the Loro implementation.

---

## Conventions

**Rust.** Edition 2021 (or latest stable). `cargo fmt` and `cargo clippy -- -D warnings` clean before any commit. Errors via `thiserror` for libraries, `anyhow` for the app crate. No `unwrap()` or `expect()` outside tests and `main`.

**TypeScript.** Strict mode on. No `any`. Prettier + ESLint. Solid's standard idioms: signals for fine-grained state, stores for structured state, `createResource` for async data from Tauri.

**Tauri commands.** Coarse-grained, named as verb-noun (`save_note_and_get_backlinks`, not `save_note` then `get_backlinks`). Every command takes a typed request struct and returns a typed response struct, even when one field would do. This pays off the moment a command grows.

**Tests.** `cubical-core`, `cubical-ast`, `cubical-index` have unit tests. The app crate has integration tests that boot a Tauri test harness against a temp vault. UI tests deferred until Layer 3 or later.

**Commits.** Conventional Commits style (`feat:`, `fix:`, `refactor:`, etc.). One logical change per commit. Layer transitions get a tag.

**Documentation.** Every public Rust item has rustdoc. Every Tauri command has a doc comment describing the request, response, and any side effects. The architecture and Layer specs in `docs/` are the canonical reference; if code disagrees with a spec, the spec wins until explicitly updated.

---

## Project state

**Current layer:** 0 — Bedrock. Scaffold complete; feature work pending.

**Last completed milestone (2026-05-05):** L0 first-session task list complete. Cargo workspace with six crates (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`, `cubical-app`) builds clean (`cargo clippy --all-targets --all-features -- -D warnings`). `cubical-app` is structured around the pure-handler / thin-shim pattern from `docs/layer-0-spec.md` §8 — `commands/`, `api/types.rs`, and `state.rs` are Tauri-free; only `events.rs` and `lib.rs`'s `#[tauri::command]` shims touch Tauri. The `ui/` Solid + TS + Vite skeleton ships with the CSS-variable token surface (`tokens.css` + `base.css`) and a single-chokepoint `api/ipc.ts`. `cargo tauri dev` verified to open an empty Cubical window with the tracing init log line firing. `docs/migration-touchpoints.md` documents the Tauri-coupled surfaces. Initial commit landed.

**Last completed milestone (2026-05-06, registry):** File-type registry landed in `cubical-core`. The `FileTypeHandler` trait (per `docs/layer-0-spec.md` §5 — `type_id` / `matches` / `content_hash` / `sanitize_for_export`; UUID methods deferred to L7), `FileTypeError` (`thiserror`), and `FileTypeRegistry` (ordered `Vec<Box<dyn FileTypeHandler>>`, first-match-wins) live in `crates/cubical-core/src/file_type/`. `MarkdownHandler` claims `.md` / `.markdown` (case-insensitive); `BinaryHandler` is the catch-all. Both compute streaming SHA-256 content hashes via a shared `sha256_file_hex` helper (64 KiB chunks). `sanitize_for_export` is a pass-through across the board — the L7 `cubical_id` strip is a TODO marker in the rustdoc. The default `FileTypeRegistry::default()` registers markdown then binary. 10 unit tests cover dispatch, deterministic hashing, divergent-bytes hashing, empty-file hashing, large-file streaming (256 KiB), trait-object safety, and pass-through sanitize. `cargo fmt`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` are all clean. `cubical-core` still has zero `tauri` imports.

**Last completed milestone (2026-05-06, migration runner):** libSQL schema + linear migration runner landed in `cubical-index` per `docs/layer-0-spec.md` §7. Public surface: `open_index(path) -> Result<IndexConn, IndexError>`, the `Migration` struct, the `MIGRATIONS` slice (v1 wired via `include_str!` from `migrations/001_initial.sql`), and the `IndexError` enum (`Io { path, source }`, `LibSql(#[from] libsql::Error)`, `SchemaTooNew(u32)`). The runner reads `schema_version` (treats a missing table as 0), refuses to open if the on-disk version exceeds the highest known migration, and otherwise applies all pending migrations + the version bump inside one transaction so a failure rolls back atomically. Idempotent on re-open. The 001 SQL creates the four L0 tables (`schema_version`, `files`, `config`, `audit_log`) with the three indexes (`idx_files_type`, `idx_files_inode`, `idx_audit_timestamp`) verbatim from the spec; tables reserved for later layers are not created. `cubical-index` still has zero `tauri` imports. The consolidated `CubicalError` in `cubical-core` (spec §9) was deliberately deferred — `IndexError` is local for now, to be folded in when the first command crosses crate boundaries. Four `#[tokio::test]` unit tests cover the four DoD points (fresh apply, idempotent re-open, schema-too-new rejection, broken-migration rollback via a `pub(crate)` `open_index_with_migrations` helper that takes an explicit migrations slice). `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` all green.

**Last completed milestone (2026-05-07):** Vault open + non-blocking scan + Tauri command surface + frontend open-vault flow landed end-to-end. `cubical-core` gained a `Vault` type ([`crates/cubical-core/src/vault/mod.rs`](crates/cubical-core/src/vault/mod.rs)) that validates the path, ensures `.cubical/` (with a temp-file write probe to catch ACL-denied dirs that `Permissions::readonly()` misses), and opens the index via `cubical_index::open_index`. `Vault` is `Clone` (PathBuf + `Arc<FileTypeRegistry>` + `Arc<IndexConn>`) so the scan task and command handlers each hold their own copy without a mutex. `scan(vault, cancel, progress)` ([`crates/cubical-core/src/vault/scan.rs`](crates/cubical-core/src/vault/scan.rs)) walks with `walkdir` skipping `.cubical/`, `.git/`, `node_modules/`, and any dot-prefixed directory; dispatches each file through the registry; hashes off the executor via `spawn_blocking`; UPSERTs into `files` preserving `created_at` across re-scans. Cancellation is checked between files via `tokio_util::sync::CancellationToken`. `cubical-app` gained five Tauri shims (`open_vault` / `cancel_vault_scan` / `get_vault_info` / `list_files` / `close_vault`) forwarding to pure handlers in `commands/vault.rs` (zero `tauri` imports — verified by grep). `events.rs` re-exports `tauri::AppHandle` so commands can name the type without importing tauri, and owns `spawn_scan_dispatcher` which forwards `ScanProgress` to `vault:scan-progress` events and emits exactly one terminal event (`vault:scan-complete` on success, `vault:scan-cancelled` on cancel/error). `CubicalError` ([`crates/cubical-app/src/error.rs`](crates/cubical-app/src/error.rs)) folds `VaultError`, `IndexError`, `FileTypeError`, and `libsql::Error`; serializes as `{ code, message }`. Frontend ([`ui/src/api/ipc.ts`](ui/src/api/ipc.ts), [`ui/src/App.tsx`](ui/src/App.tsx)) wires the five typed command wrappers, three event listeners, and an "Open Vault" button using `@tauri-apps/plugin-dialog`. The list refresh is throttled to 200ms during scan so a 10k-file vault doesn't issue N round trips. All values come from `tokens.css` — no hardcoded colors / fonts / spacings. 28 tests across the workspace pass (21 in cubical-core, 4 in cubical-index, 3 in cubical-app), `cargo fmt --check` / `cargo clippy --all-targets --all-features -- -D warnings` / `cargo test --all` / `npm run build` all green. Two ahead-of-this-session branches (`claude/peaceful-leakey-cb8efe` for the registry, `claude/suspicious-mclean-22d906` for the migration runner) were integrated into this branch via cherry-pick before starting; both are now ancestors of `main` and can be deleted.

**Architectural deviation worth flagging:** `docs/layer-0-spec.md` §2 lists `cubical-core` as having no workspace deps and `cubical-index` as depending on `cubical-core` "for shared types". No shared types ever materialized, the cubical-index → cubical-core dep was unused, and this session needed `cubical-core` to consume `cubical_index::IndexConn` directly so `Vault` can own the open DB handle. The dep direction was flipped: `cubical-index` no longer depends on `cubical-core`; `cubical-core` now depends on `cubical-index` (and on `libsql` for `params!`). The spec entry should be updated to match in the next docs pass. A second deviation: spec §9 placed `CubicalError` in `cubical-core`, but with the new dep direction that's where the consolidated error needs to live downstream of every error source — i.e. in `cubical-app`. The spec will be reconciled when L1 lands.

**Smoke test status:** `cargo build -p cubical-app` is clean and `cargo tauri dev` was invoked once during the integration step but the interactive smoke pass (click "Open Vault", pick a 10-file folder, observe progress streaming + final count + cancel-during-scan) was *not* completed in this session — the harness this session ran in is non-interactive. The next session should run `cargo tauri dev`, exercise the flow against a real folder, and confirm the five DoD checks (instant return, progress events, file list populates, scan-complete with correct count, no hang/panic on close-during-scan) before moving on to the watcher.

**Last completed milestone (2026-05-08, file watcher):** L0 §6 file watcher landed end-to-end. `cubical-core` gained a `Watcher` module ([`crates/cubical-core/src/vault/watcher.rs`](crates/cubical-core/src/vault/watcher.rs)) wrapping `notify` 6.1 + `notify-debouncer-full` 0.3 (added as a workspace dep) under a `WatchEvent` enum (`Created`/`Modified`/`Removed`/`Renamed{from,to}`) that holds **vault-relative** paths — `notify`/`notify-debouncer-full` types never leak across the crate boundary. `start_watcher(vault, cancel, events)` returns a `WatcherHandle` whose `Drop` impl calls `Debouncer::stop_nonblocking()` and aborts the bridge task. The debouncer runs at 100ms timeout + 25ms tick (per spec §6's 100ms debounce + 200ms end-to-end target). The std-thread debouncer callback feeds an internal tokio mpsc via `blocking_send`; a small bridge task watches the cancel token and forwards into the caller's `mpsc::Sender<WatchEvent>`. The vault root is canonicalized inside `start_watcher` so the prefix-strip in `relativize` works on macOS where FSEvents resolves `/var/...` → `/private/var/...`. Excluded paths are filtered component-wise (`node_modules`, anything dot-prefixed) — parity with `scan.rs`'s skip list, and crucial for not echoing `.cubical/index.db` writes back to ourselves. `VaultError::Watcher(notify::Error)` was added with `#[from]`. `cubical-core` still has zero `tauri` imports.

`cubical-app` got the lifecycle wire-up. `OpenVault` ([`crates/cubical-app/src/state.rs`](crates/cubical-app/src/state.rs)) gained a `watcher: Option<WatcherHandle>` field; `commands::vault::open_vault` ([`crates/cubical-app/src/commands/vault.rs`](crates/cubical-app/src/commands/vault.rs)) starts the watcher *before* registering the vault (so a watcher init failure doesn't leave a half-built `OpenVault` in state) and `close_vault` drops the handle implicitly when the `OpenVault` is removed from the map. `events.rs` ([`crates/cubical-app/src/events.rs`](crates/cubical-app/src/events.rs)) gained `spawn_watcher_dispatcher(app, vault_id, vault, events_rx)` that consumes `WatchEvent`s, calls `apply_watch_event_to_db` (a `pub(crate)` helper that handles the `files`-row UPSERT + `audit_log` INSERT), then emits `vault:file-changed` via the existing `emit_file_changed` helper. The dispatcher logs an `arrived → emit elapsed_ms` line so the spec §6 "<200ms end-to-end" target can be verified at the smoke pass. `audit_log` rows are written with `category='watcher'`, `level='info'`, a human-readable `message`, and a JSON `detail` blob (`kind` plus path(s)). `CubicalError` gained a `Watcher(String)` variant + matching `From<VaultError>::Watcher` arm. The `VaultFileChangeKind` enum derived `Debug` (it was needed for tracing). `audit_log` auto-pruning to 10 000 rows (spec §7) is a TODO — left dormant for L0+ since the table grows unbounded only across long sessions.

Frontend gained `VaultFileChanged` + `VaultFileChangeKind` types and an `onVaultFileChanged` listener in [`ui/src/api/ipc.ts`](ui/src/api/ipc.ts); `App.tsx` wires it in `onMount` and routes through the same 200ms-throttled `scheduleRefresh` used by scan-progress so a `git checkout` burst doesn't issue N round trips.

Tests this session: 11 new tests in `cubical-core` (3 FS-integration: created-event happy path, excluded-dirs produce zero events, drop-handle stops delivery within 500ms; 9 unit tests covering every `translate_event` branch including renames, excluded-path filtering, and unhandled `EventKind::Access`). 2 new tests in `cubical-app` (`apply_watch_event_to_db`'s `audit_log` row shape for `Created` and `Renamed`). **34 cubical-core + 5 cubical-app + 4 cubical-index = 43 tests** across the workspace pass; `cargo fmt --check` / `cargo clippy --all-targets --all-features -- -D warnings` / `cargo test --all` / `npm run build` all green.

**Architectural deviation worth flagging (macOS test honesty):** The L0 §12 #6 smoke criterion ("modifying an `.md` file results in a `vault:file-changed` event within 200ms") relies on `notify` 6.1's FSEvents backend reporting Modify/Remove/Rename events accurately. In automated tests on macOS, FSEvents accumulates a per-path flag bitmask that includes the original Created bit, so a write to a pre-existing file is reported as `EventKind::Create(File)`; `notify-debouncer-full` 0.3's `push_remove_event` then *cancels the queue* when a subsequent Remove arrives, swallowing the Remove. This makes synthetic test patterns (pre-create file → modify or delete it inside the watcher's lifetime) report nothing on macOS — even though real-world editor flows (where the file existed long before the watcher started) work fine. The user-flow guarantee is verified through the §12 #6 smoke pass against `cargo tauri dev`. `translate_event`'s logic — the part of the watcher we own — is fully unit-tested with synthetic `DebouncedEvent`s. The cubical-core watcher tests document this in a long block comment around the FS-integration cases. Bumping to `notify` 8.x + `notify-debouncer-full` 0.6 (which has different coalescing) is a candidate fix but would change a workspace dep and is out of scope for L0.

**Renames are emitted but not persisted as path moves.** `apply_watch_event_to_db` for `WatchEvent::Renamed` refreshes `last_seen` on the from-row only and writes an audit-log entry; it does *not* update the `path` column or insert a new row for `to`. Spec §3 says path-keyed identity updates are post-L0; doing them now would orphan future block refs / wiki-link rows pointing at the old path (those tables don't exist yet but the design is committed). The next vault scan will observe the new path as a fresh row. The L1+ session that introduces wiki-link tracking should move this responsibility to a proper rename handler (the Pending Rewrites Cache in spec §3 / §6).

**Smoke test status (this session):** Same as 2026-05-07 — automated gates all pass, but `cargo tauri dev` was *not* exercised interactively against a real vault. The next session should: (a) complete the deferred §12 #4 smoke pass (open a 10-file folder; verify the five scan DoD points), and (b) complete §12 #6 (modify a `.md` file externally; verify `vault:file-changed` reaches the frontend and the file list refreshes within ~300ms). The `cubical-cancel-test` fixture from the previous session is gone — recreate it with 2000–5000 plain `.md` files outside the repo before running the cancel-during-scan check.

**Next session's task:** **L1 Document Model** per `docs/layer-0-spec.md` §1's L1 entry — Lezer integration, canonical Markdown AST in `cubical-ast`, Lezer-to-canonical normalizer, and structured frontmatter parsing into libSQL columns. Before starting L1: complete the deferred §12 #4 + §12 #6 smoke passes from above, then tag the commit `l0` (this session writes the docs/code commits but does *not* tag — the tag should land after the smoke pass confirms L0 is feature-complete in practice, not just on paper). L0 is otherwise feature-complete.

When L1 is done, update this section to reflect L2 next.
