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

**Last completed milestone (2026-05-06):** File-type registry landed in `cubical-core`. The `FileTypeHandler` trait (per `docs/layer-0-spec.md` §5 — `type_id` / `matches` / `content_hash` / `sanitize_for_export`; UUID methods deferred to L7), `FileTypeError` (`thiserror`), and `FileTypeRegistry` (ordered `Vec<Box<dyn FileTypeHandler>>`, first-match-wins) live in `crates/cubical-core/src/file_type/`. `MarkdownHandler` claims `.md` / `.markdown` (case-insensitive); `BinaryHandler` is the catch-all. Both compute streaming SHA-256 content hashes via a shared `sha256_file_hex` helper (64 KiB chunks). `sanitize_for_export` is a pass-through across the board — the L7 `cubical_id` strip is a TODO marker in the rustdoc. The default `FileTypeRegistry::default()` registers markdown then binary. 10 unit tests cover dispatch, deterministic hashing, divergent-bytes hashing, empty-file hashing, large-file streaming (256 KiB), trait-object safety, and pass-through sanitize. `cargo fmt`, `cargo clippy --all-targets --all-features -- -D warnings`, and `cargo test` are all clean. `cubical-core` still has zero `tauri` imports.

**Next session's task:** libSQL schema + migration runner in `cubical-index` per `docs/layer-0-spec.md` §7 — `schema_version` / `files` / `config` / `audit_log` tables, version-1 migration as a `.sql` file referenced via `include_str!`, a linear migration runner that opens a DB at a given path and runs all migrations with `version > current` in a single transaction, and a refusal path for `schema_version > MIGRATIONS.last().version`. Tests should cover a fresh DB applying v1, an idempotent re-open, and a "schema-too-new" rejection. No vault scanning, no watcher, no Tauri commands — those come after.

When the layer is done, tag the commit and update this section to reflect L1 next.
