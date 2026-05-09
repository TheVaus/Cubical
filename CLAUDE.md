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

**Current layer:** 2 — Editing. L1 sessions A + B both landed; the `l1` tag is pending the deferred `cargo tauri dev` smoke pass.

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

**Last completed milestone (2026-05-09, L1 session A — canonical AST + frontmatter index):** AST data types and the `parse(source) -> Document` entry point landed in `cubical-ast` ([`crates/cubical-ast/src/lib.rs`](crates/cubical-ast/src/lib.rs), [`types.rs`](crates/cubical-ast/src/types.rs), [`frontmatter.rs`](crates/cubical-ast/src/frontmatter.rs), [`normalize.rs`](crates/cubical-ast/src/normalize.rs)). The AST is intentionally slim per `docs/architecture.md` §5.5: `Document { frontmatter: Option<Frontmatter>, blocks: Vec<Block>, source_len }`; blocks are `Heading | Paragraph | List | CodeBlock | Quote | ThematicBreak | Html`; inlines are `Text | Emph | Strong | Code | Link | Image | LineBreak`; every block carries a `Span { start, end }` in absolute byte offsets into the original source. Wiki-links / embeds / block IDs / tags pass through as plain `Inline::Text` — they're L3 work. Soft breaks fold into surrounding text; hard breaks become explicit `LineBreak`. `serde` derive on every type so the AST can cross the `get_canonical_ast` IPC boundary in session B.

Frontmatter detection is strict per `docs/layer-0-spec.md` §3: opening `---` must be at byte 0, no leading whitespace; closing `---` on its own line. CRLF tolerated. YAML 1.2 strict via `serde_yaml_ng`; values flatten to `serde_json::Value` so the libSQL column shape is one thing. Malformed YAML logs `tracing::warn!` and degrades to `frontmatter = None` — the body is parsed normally either way. Non-mapping top-level YAML (a bare scalar / list) is also treated as `None`.

Pulldown-cmark normalizer (`pulldown-cmark` 0.13, MIT/Apache, `Options::empty()`) walks the offset-iter event stream into the canonical shape via an explicit `Container` stack. Tight-list items don't get a `Tag::Paragraph` from pulldown-cmark, so `push_inline` injects an implicit `Paragraph` the first time inline content arrives inside an `Item`; `close_implicit_paragraph_in_item` closes it before any sub-block opens or the `Item` ends. `Tag::HtmlBlock` collects `Event::Html` chunks into a single `Block::Html`; tags the L1 AST doesn't model (tables, footnotes, definition lists, math) ride a transparent `Swallow` container. 25 tests in `cubical-ast` cover frontmatter split (CRLF, leading whitespace rejection, missing closer, code-fence-`---`-as-non-closer), YAML parsing (scalars / lists / nested maps / non-mapping / malformed / empty), and the AST normalizer (every Block variant, every Inline variant, idempotence, span coverage).

Workspace dep: `pulldown-cmark = { version = "0.13", default-features = false }` pinned in the workspace `Cargo.toml`. Pulled into `cubical-ast` only. `cubical-ast` has zero `tauri` imports.

libSQL migration v2 ([`crates/cubical-index/migrations/002_frontmatter.sql`](crates/cubical-index/migrations/002_frontmatter.sql)) adds the `frontmatter` table — `(file_path, key, value, PRIMARY KEY (file_path, key), FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE)` plus `idx_frontmatter_key`. `value` is JSON-encoded so scalars / lists / nested objects all share one column shape. Wired via `MIGRATIONS` in [`crates/cubical-index/src/migrations.rs`](crates/cubical-index/src/migrations.rs); the runner already supports a chain. Crucially, the runner now executes `PRAGMA foreign_keys = ON` on every connection — libSQL/SQLite ships with FKs OFF by default, the pragma is per-connection, and Cubical relies on it for the v2 cascade and any future cascades. The four pre-existing migration tests were updated to use a `HIGHEST_KNOWN_VERSION` constant rather than hard-coded 1, plus two new tests cover v1→v2 upgrade-with-data and `PRAGMA foreign_keys = 1` post-open. 6 cubical-index tests, all green.

Indexing wire-up: a new `vault::frontmatter::refresh_frontmatter(vault, abs, rel_str)` helper ([`crates/cubical-core/src/vault/frontmatter.rs`](crates/cubical-core/src/vault/frontmatter.rs)) reads + parses + DELETE-then-INSERT-keyed-on-`file_path`. Idempotent across re-scans, naturally handles deleted keys. Parse runs in `tokio::task::spawn_blocking` (CPU-bound, mirrors the hash dispatch in `scan.rs`). Called from two write paths: `vault::scan` after the `files` UPSERT for `type_id == "markdown"` files only, and `events::apply_watch_event_to_db` for `Created` / `Modified` markdown files. Non-markdown files skip — frontmatter is a markdown-only concept. `Removed` and `Renamed` watcher events deliberately do NOT touch the `frontmatter` table beyond what cascade would do (and L0 doesn't `DELETE FROM files` for those events, see spec §6 + §3 — coordinated change with L3's Pending Rewrites Cache). `cubical-core` gained `cubical-ast` + `serde_json` deps; still zero `tauri` imports.

IPC: new `get_frontmatter` command per `docs/layer-0-spec.md` §8's pure-handler / thin-shim pattern. Pure handler in [`commands/vault.rs`](crates/cubical-app/src/commands/vault.rs) reads from the `frontmatter` table, never re-parses on-disk markdown. Returns `Err(CubicalError::FileNotFound)` when the path isn't tracked in `files`; empty `entries` for files without frontmatter is a valid response. Frontend wrapper in [`ui/src/api/ipc.ts`](ui/src/api/ipc.ts) mirrors the wire types; UI-less, ready for session B to call. `App.tsx` untouched. Stored JSON values that fail to round-trip (writer regression) surface as a string with a `tracing::warn!` rather than dropping data. `CubicalError` gained the `FileNotFound(String)` variant.

Tests this session: 25 new in `cubical-ast`, 5 new in `cubical-core` (3 in scan covering frontmatter rows, malformed-yaml-no-error, key removal across rescans, plus a non-markdown skip; 4 in `vault::frontmatter::tests` covering the helper directly), 2 new in `cubical-index` (v1→v2 upgrade, PRAGMA), 5 new in `cubical-app` (4 `get_frontmatter` cases — happy path, empty entries, unknown path, unknown vault — plus 1 watcher dispatcher Modified-refreshes-frontmatter). **Workspace totals: cubical-ast 25 + cubical-core 42 + cubical-index 6 + cubical-app 10 = 83 tests, all green.** `cargo fmt --check` / `cargo clippy --all-targets --all-features -- -D warnings` / `cargo test --all` / `npm run build` all clean. No `cargo tauri dev` smoke pass needed — frontmatter has no UI yet; everything is verifiable through `cargo test`.

**Next session's task:** **L1 session B** — Lezer in CodeMirror (frontend), Lezer-to-canonical normalizer (frontend or shared via WASM TBD by session B), and the `get_canonical_ast` IPC command (Rust shim returning a parsed `Document` for a given path). Per `docs/layer-0-spec.md` §1's L1 entry. The Rust-side `parse(source)` is ready; session B's job is to wire the editor's Lezer tree into the same canonical shape and expose the IPC. Do not tag `l1` until B lands.

**Last completed milestone (2026-05-09, L1 session B — Lezer in CodeMirror + canonical AST IPC):** The L1 contract closes end-to-end. Rust `cubical_ast::parse` + the editor's Lezer-backed normalizer in TS now produce the same `Document` JSON shape from the same source string, verified by a cross-language parity harness with shared fixtures.

**AST shape fix (load-bearing prerequisite).** Session A's `Inline::Text(String)` and `Inline::Code(String)` were tuple newtype variants on an internally-tagged enum (`#[serde(tag = "kind", rename_all = "snake_case")]`). `serde_json` panics at serialization time for that combination — a latent bug that would have detonated the moment `get_canonical_ast` tried to ship a paragraph through IPC. Both variants are now struct-shaped (`Text { value: String }`, `Code { value: String }`), bringing the wire shape in line with the other Inline variants (`Emph { children }`, `Strong { children }`, `Link { dest, title, children }`, ...). The new `document_round_trips_through_serde_json` test in [`cubical-ast/src/lib.rs`](crates/cubical-ast/src/lib.rs) is the regression guard. All session-A normalizer + tests updated to the new pattern; nothing else in the AST changed. The wire-shape change is documented inline on the `Inline` enum rustdoc.

**Rust IPC commands.** `read_file_text` and `get_canonical_ast` landed in [`commands/vault.rs`](crates/cubical-app/src/commands/vault.rs) following the §8 pure-handler / thin-shim pattern. `read_file_text` is the coarse-grained "give me a markdown file's contents as text" command — it does the existence check (`files.path` lookup), the type check (`type_id == "markdown"` only — binary rejected with `InvalidRequest`), and the on-disk read inside `tokio::task::spawn_blocking`. `get_canonical_ast` reuses `read_file_text` for the disk fetch and pushes `cubical_ast::parse` through `spawn_blocking` (CPU-bound — mirrors the hashing dispatch in `scan.rs`). Pre-L7 the AST is recomputed on every call; the only AST-derived storage at L1 is the frontmatter index. New error variant: `CubicalError::InvalidRequest(String)` for argument-validation failures. Wire shapes mirror Session A's pattern (typed request/response structs in `api/types.rs`); the `get_canonical_ast` response carries a `cubical_ast::Document` directly so the AST has exactly one source-of-truth definition.

**Tauri shims** in [`crates/cubical-app/src/lib.rs`](crates/cubical-app/src/lib.rs) added (`read_file_text`, `get_canonical_ast`); `invoke_handler` updated. `cubical-app` already pulled `cubical-ast` transitively via `cubical-core`; the dep was already declared explicitly so no Cargo.toml change. Pure modules (`commands/`, `api/`, `state.rs`) remain Tauri-free — verified by `grep -rE "use tauri\\b" crates/cubical-app/src/{commands,api,state.rs}` returning empty.

**Frontend stack.** `ui/package.json` gained `codemirror` 6, `@codemirror/lang-markdown` 6, `@codemirror/state` 6, `@codemirror/view` 6, `@lezer/common` 1, `yaml` 2, plus `vitest` 2 + `@types/node` (devDeps). `npm install` runs against a worktree-local cache (`/tmp/npm-cache-worktree`) when the global `~/.npm` is permission-locked.

**TypeScript canonical AST + normalizer.** [`ui/src/ast/types.ts`](ui/src/ast/types.ts) is the wire-shape mirror of `cubical_ast::Document` — discriminated unions on `kind` with `snake_case` tag values, exactly matching `#[serde(tag = "kind", rename_all = "snake_case")]`. [`ui/src/ast/frontmatter.ts`](ui/src/ast/frontmatter.ts) is the strict frontmatter splitter (CRLF-tolerant, leading-whitespace-rejecting, `---`-on-its-own-line closer); YAML parsing is delegated to the `yaml` package. [`ui/src/ast/normalize.ts`](ui/src/ast/normalize.ts) walks the Lezer tree (`@lezer/markdown`'s `parser.parse`) and produces the same `CanonicalDocument` shape as `cubical_ast::parse`. The non-trivial pieces of parity:

- **Span trailing-newline rules**: pulldown-cmark's spans for Heading/Paragraph/Quote/ThematicBreak/Html include exactly one trailing `\n`; Lezer's spans stop at the last non-newline byte. The TS normalizer extends each block's `to` by one `\n` (`extendOneNewline`) to match. CodeBlock spans intentionally don't extend — both parsers stop at the closing fence.
- **List item span includes blank lines**: pulldown-cmark extends a list item's span through every blank line that separates it from the next item (or source end). The TS normalizer mirrors this with `extendThroughBlankLines`. The List's own span end then becomes the last extended item's end.
- **Inline content from Lezer "gaps"**: Lezer doesn't emit explicit text nodes — text content sits between marker children. `readInlines` walks a node's children and fills the gaps from the source string, coalescing adjacent text runs and folding any embedded `\n` to a single space (matching pulldown-cmark's soft-break-as-space semantics).
- **Emphasis/Strong inner-range derivation**: for `*emph*` and `**strong**`, Lezer surrounds the inner text with `EmphasisMark` children (no inner text node). The inner range is `[firstMark.to, lastMark.from)`.
- **Heading marker trimming**: ATX `# ` / Setext `===` / `---` markers are trimmed via per-mark inspection so the heading's inline content excludes them.

L1's AST doesn't model wiki-links, embeds, block IDs, tags, tables, footnotes, definition lists, or math — those are L3+. They pass through as plain text or are silently skipped.

**Cross-language parity harness.** [`crates/cubical-ast/tests/fixtures/parity.json`](crates/cubical-ast/tests/fixtures/parity.json) is a single committed file with `[{name, input, expected}]` entries; both [`crates/cubical-ast/tests/parity_fixtures.rs`](crates/cubical-ast/tests/parity_fixtures.rs) and [`ui/src/ast/parity.test.ts`](ui/src/ast/parity.test.ts) verify that their respective parser produces `expected` for each `input`. The Rust test is also the regenerator: `CUBICAL_UPDATE_PARITY_FIXTURES=1 cargo test -p cubical-ast --test parity_fixtures` rewrites `expected` from the current `parse` output. Workflow when the AST shape intentionally changes: regenerate via Rust, then re-run the TS suite — if it fails, fix the TS normalizer (never the fixtures by hand). 8 fixtures cover heading + paragraph, fenced code, loose list, blockquote, link + image, frontmatter (with nested mapping), thematic break, and inline code + hard break.

**CodeMirror 6 editor surface.** [`ui/src/Editor.tsx`](ui/src/Editor.tsx) is a minimal Solid wrapper: it owns its own `<div>` and the `EditorView`, never lets Solid touch the CM6 DOM (Lane-1 contract from `docs/architecture.md` §11), and exposes a one-way `onAstChange` callback that fires the canonical AST 150ms after the last keystroke. L1 ships raw markdown only — no Live Preview decorations, no Pretext-backed measurement, just CM6 + history + default keymap + `markdown()` from `@codemirror/lang-markdown`. The editor's CM6 theme is a placeholder pulling tokens from `tokens.css`; L2 wires the real theme. `value` prop changes (file selection) are dispatched as a CM6 transaction so the buffer the user is editing isn't fought.

**App-level wiring.** [`ui/src/App.tsx`](ui/src/App.tsx) gained a two-pane layout: file list on the left (clickable rows for markdown files), Editor on the right. Selection state is local Solid signals; not persisted. [`ui/src/api/ipc.ts`](ui/src/api/ipc.ts) gained `readFileText` + `getCanonicalAst` + their request/response types (with `CanonicalDocument` imported from `./ast/types` so the AST type lives in one place). The existing `vault:file-changed` listener is unchanged — external edits still refresh the file list via the 200ms-throttled refresh.

**Tests this session.** Workspace totals: cubical-ast 26 (was 25 +1 round-trip serde test) + 1 parity_fixtures integration test + cubical-core 42 + cubical-index 6 + cubical-app 17 (was 10 +7 read_file_text/get_canonical_ast happy + error paths) = **92 Rust tests across the workspace, all green**. UI side: **23 vitest tests** (8 parity-harness fixtures + 15 normalizer/frontmatter unit tests). All gates clean: `cargo fmt --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all`, `npm run build`, `npm test`.

**Smoke test status (this session):** Same as 2026-05-08 — automated gates all pass, but `cargo tauri dev` was *not* exercised interactively (the harness this session ran in is non-interactive). The `l1` tag is **not yet applied** for this reason. The next session should: open a vault containing one or more `.md` files, click a file in the list, confirm (a) the editor shows the raw markdown, (b) typing fires `onAstChange` with a sensible AST (visible via the "AST: …" footer), (c) external edits to the open file still surface via `vault:file-changed`. Then `git tag l1` and push.

**Architectural note (no spec deviation, but worth recording):** Session A planned to deliver `get_canonical_ast` itself; this session reframed the boundary so `read_file_text` lives below `get_canonical_ast` (the AST command reuses the file read). The two commands together form the read-side surface for L2's editor wiring, with a clean type-check/Markdown-only gate at the I/O seam. No spec change — `docs/layer-0-spec.md` §8 doesn't enumerate L1 commands by name.

**Architectural note (parity contract).** The wire JSON for `Inline` no longer includes any tuple variants. If a future change reintroduces one (e.g. `Variant(SomeMapType)` where the inner serializes as a struct/map), the round-trip test still passes — but it would be safer to keep all variants struct-shaped to avoid the runtime panic surface that bit session A.
