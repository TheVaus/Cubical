# Cubical — Architecture

This document is the canonical record of Cubical's architectural decisions. It is the long form; `CLAUDE.md` carries the short form. When this document and code disagree, this document wins until explicitly updated.

Decisions here are *locked*. They are the result of deliberate review and trade-off analysis. They can be changed, but only by an explicit architecture change, not by a session-level call.

---

## 1. Philosophy

Cubical is a Personal Knowledge Management application built on three commitments:

1. **The user's vault is sovereign.** It is plain markdown, fully portable, and survives the app being uninstalled, the company shutting down, or the user editing files in any external tool. The vault works without Cubical; Cubical only works because the vault works.
2. **Performance is a feature, not a polish item.** Every architectural choice is measured against latency at the keystroke, scroll, and search. "Fast enough" is not the bar. "Imperceptible" is.
3. **The app does not lock the user in.** No proprietary file formats for content. No required cloud account. No data inside Cubical that the user cannot export, inspect, or take elsewhere.

These commitments produce hard rules that downstream decisions must respect:

- Plain `.md` files are the source of truth. Indexes, caches, CRDT logs, and snapshots are derived state — they can be deleted at any time and the vault remains intact.
- The app must gracefully handle external modifications to the vault (renames in Finder, edits in vim, file additions by Dropbox sync) made while Cubical is closed.
- No legacy runtimes (Electron, Node) are part of the shipped product.
- Plugin code is hardware-sandboxed by default; capability grants are explicit and granular.

---

## 2. Stack

**Backend:** Tauri 2.x with a Rust core. Strict IPC allowlist; no broad filesystem or shell access from the webview. All heavy work — file I/O, parsing, indexing, CRDT operations, embeddings — runs on the Rust side.

**Frontend:** Solid + TypeScript + Vite. Solid is chosen for its fine-grained reactivity, near-zero runtime overhead, and clean interop with libraries that own their own DOM (CodeMirror, Pretext, future WebGPU canvases).

**Editor surface:** CodeMirror 6 + Lezer. CodeMirror handles input, selection, IME, accessibility, and decoration; Lezer provides incremental markdown parsing for Live Preview. The Lezer markdown grammar is the editor's parser.

**Text measurement and virtualization:** Pretext (Cheng Lou). Used as the measurement layer beneath the editor's virtualized scroller and beneath any large-list UI (file explorer, search results). Pretext is *not* the editor — it does not handle input. Its role is height calculation and line layout for non-DOM-bound layout decisions.

**Canonical AST:** A Markdown AST defined in the `cubical-ast` Rust crate. Lezer trees produced in the editor are normalized into canonical AST on the Rust side. Every system outside the editor — indexer, link resolver, backlink computer, exporter, plugin host — consumes canonical AST. This guarantees one document interpretation across the whole system, eliminating the class of bug where different parsers see different documents.

**Metadata and index storage:** libSQL (a SQLite fork). Single file at `<vault>/.cubical/index.db`. Holds file metadata, link index, block-reference index, CRDT operation logs, Time Machine snapshots, and (later) vector embeddings. The libSQL choice over plain SQLite is for the embedded server / network mode option later, and for native vector support; for the core flow, libSQL is used as a standard embedded database.

**Full-text search:** Tantivy. Rust-native, BM25-ranked, with stemming and typo tolerance. Indexes the canonical AST, not the raw markdown — which means search understands document structure (heading-only search, code-block exclusion, etc.).

**CRDT engine:** Loro. Rust-native, supports movable trees natively (relevant for the file tree and outliner moves), has a rich-text model closer to Peritext than Yjs's. The CRDT layer is abstracted behind a Rust trait so swapping is theoretically possible — though a swap is not planned.

**Graph rendering (Layer 9, post-v1.0):** WebGPU. Bypasses WebGL limits to keep 60fps on 100k-node graphs. Justified by real-world vault scale at this size; WebGL would degrade on pan/zoom. For v1 desktop targets (WebView2, WKWebView, WebKitGTK) WebGPU is sufficiently supported.

**Local AI:** Out of core scope. AI capability is delegated to the plugin ecosystem rather than baked into the app. libSQL's vector storage option remains available to plugins as a capability if a plugin author wants to ship embeddings + RAG.

---

## 3. The vault

A vault is a directory on disk. The user picks it; Cubical does not own the location.

```
<vault>/
├── any/folder/structure/the/user/wants/
│   ├── note-a.md
│   ├── note-b.md
│   └── ...
├── .assets/                 # deduplicated binary assets
│   ├── ab/cd/abcd1234...png
│   └── ...
└── .cubical/
    ├── index.db             # libSQL: metadata, links, CRDT logs (post-L7), snapshots (post-L7)
    ├── config.toml          # vault-local config (overrides global)
    ├── themes/              # user-installed CSS themes (L5+)
    └── recovery/            # pre-merge buffer snapshots (L7+)
```

The `.cubical/` directory is the only state Cubical owns inside the vault. Everything in it is rebuildable from the markdown — deleting `.cubical/` and reopening the vault produces a fully functional vault again, just without history.

`.assets/` holds binary assets (images, PDFs) deduplicated by content hash. Deduplication is **per-vault only** — cross-vault deduplication or global asset folders are explicitly rejected because they break vault portability.

---

## 4. File identity

File identity is the absolute anchor for cross-references (wiki-links, block refs, backlinks). Cubical's identity model evolves across the build:

- **Layers 0–6 (v1.0): path-based identity.** No UUIDs are written into user files. The vault Cubical opens is the vault the user wrote, byte-for-byte. Renames are detected via the file watcher and reconciled through the Pending Rewrites Cache (§5.6). Renames that happen while the app is closed fall back to inode + content-hash heuristics.
- **Layer 7 (sync): frontmatter UUIDs introduced.** When the user opts into sync, Cubical mints a `cubical_id: <uuid>` key in each file's YAML frontmatter as part of onboarding. The OS "last modified" timestamp is captured before each write and restored after. Files without frontmatter get one created. This is the single batch-write moment in a vault's lifetime; it is framed to the user as "enabling sync" rather than "Cubical mangling your files on first open."

Path is mutable across both phases; the UUID (post-L7) is stable forever.

### 4.1 Why frontmatter, not EOF comment

Earlier drafts proposed an EOF HTML comment of the form `<!-- ... Cubical ID: ... -->`. That approach is retired. Frontmatter is the conventional metadata zone, users already accept that tools edit YAML, and it sits where structured queries (Dataview-style) can read it without special handling. EOF comments would have been more visually intrusive at the bottom of the document — the reading territory — and easier to delete by accident.

### 4.2 Export sanitization

Before any export — PDF, HTML, copy-to-clipboard-as-markdown — the `cubical_id` frontmatter key is stripped from the in-memory buffer. The exported artifact carries no Cubical-specific metadata. Pre-L7 there is nothing to strip. This is a hard requirement: leaking UUIDs in shared documents is a privacy risk.

### 4.3 External edits

When `notify` reports a `.md` file modified externally (vim, Dropbox, another Cubical instance pre-sync), Cubical:

1. Reads the new file content.
2. If the file is currently open with unsaved local edits, the prior buffer state is written to `.cubical/recovery/<timestamp>-<filename>` as a safety snapshot (this is the user's escape hatch). The user is prompted with a 3-way merge UI (their unsaved buffer vs. the external content vs. the prior known state).
3. If the file is not open or has no unsaved changes, the new content is accepted silently and the file's index entry is updated.
4. The file's `last_known_content_hash` and `mtime` are refreshed.

Pre-L7, no CRDT is involved — the external edit replaces the in-memory state. Post-L7, the diff is treated as a single CRDT operation authored by `filesystem` with the current timestamp and merged through Loro. Recovery snapshots are kept for a configurable retention window (default: 30 days).

---

## 5. Document model

### 5.1 Frontmatter

YAML, at the top of the file. Non-negotiable per markdown convention — placement anywhere else is not parsed as YAML by external tools.

```markdown
---
title: My Note
tags: [research, pkm]
created: 2026-04-27
---

Note content...
```

Frontmatter is parsed into structured columns in libSQL for fast Dataview-style queries. The .md file is the source of truth; libSQL is the index.

### 5.2 Wiki-links

`[[target]]`, `[[target|display]]`, `[[target#heading]]`, `[[target#^block-id]]`. Resolution is via libSQL's link index, keyed by `file_path` pre-L7 and by `file_uuid` post-L7 (schema migration handles the transition at the L7 onboarding moment). Renames do not rewrite referencing files immediately — they enqueue entries in the Pending Rewrites Cache (§5.6) that are flushed periodically and on close.

### 5.3 Block references

A block ID is a slug (`^my-block`) appended to a paragraph or list item. **Lazy assignment:** an ID is only created when the user creates a reference to that paragraph (typing `[[note#^...]]` in autocomplete, or invoking a "create block ref" action). No bulk auto-assignment. The literal `^id` lives in the markdown source as text; it survives content edits as long as the user doesn't delete it.

Allowed characters: Unicode letters, digits, `_`, `-`. Must start with a letter or underscore.

Scope: per file. `(file_path, block_id)` is unique within a file pre-L7; `(file_uuid, block_id)` post-L7.

The libSQL schema (introduced at L3):

- `blocks(file_path, block_id, position_hint, last_modified)`
- `block_refs(source_file_path, target_file_path, target_block_id)`

Block reference rewrites on rename go through the Pending Rewrites Cache. Broken block references (target paragraph deleted, ID removed) surface in the vault health UI alongside broken wiki-links.

### 5.4 Embeds

`![[target]]` embeds the full content of another note inline. `![[target#heading]]` embeds a section. `![[target#^block-id]]` embeds a single block. Embeds are rendered live in Live Preview and resolve through the same link index as wiki-links — they are wiki-links with an `embed: true` flag in the AST.

Embeds are recursive but bounded: a configurable maximum depth (default 4) prevents pathological infinite-embed cycles. Beyond the depth, the embed is rendered as a styled link instead of inlined content.

### 5.5 Canonical AST

Defined in the `cubical-ast` crate. A normalized markdown AST, framework-independent, no Tauri or webview dependencies.

```rust
pub enum Node {
    Document(Vec<Node>),
    Heading { level: u8, children: Vec<Node>, block_id: Option<String> },
    Paragraph { children: Vec<Node>, block_id: Option<String> },
    List { ordered: bool, items: Vec<ListItem> },
    CodeBlock { lang: Option<String>, content: String },
    BlockQuote(Vec<Node>),
    WikiLink { target: String, display: Option<String>, anchor: Option<Anchor>, embed: bool },
    Tag { path: String, source: TagSource },  // TagSource: Inline | Frontmatter
    InlineCode(String),
    Emphasis(Vec<Node>),
    Strong(Vec<Node>),
    Text(String),
    // ... etc.
}
```

The exact shape is finalized during Layer 1. The point is: this AST is the lingua franca. Lezer trees from the editor are normalized into it. Indexers consume it. The exporter consumes it. Plugins (Layer 6) receive it across the WASI boundary.

The AST is intentionally slim — it represents only the markdown subset Cubical itself produces and renders. Cross-app importers (Obsidian, Logseq, Notion) are out of v1 scope, so the AST does not carry math, mermaid, callout, footnote, or other extension nodes.

### 5.6 Tags

Two declaration sources, one logical concept.

- **Inline:** `#tag` anywhere in body text. Must follow whitespace or line-start. Excluded inside fenced code blocks, inline code spans, link targets, and wiki-link targets.
- **Frontmatter:** `tags: [tag1, tag2/sub, tag3]` (YAML list).

Both feed the same tag index.

**Nesting** uses `/`: `#parent/child/grandchild`.

**Casing** is case-insensitive for matching, case-preserving for display. The canonical display form is whichever case was typed first in the vault; a tag-edit UI lets the user override.

**Allowed characters:** Unicode letters, digits, `_`, `-`, `/`. Must contain at least one letter or underscore (rules out `#1234`).

**Hierarchy semantics:** prefix-match. Querying `#parent` matches `#parent`, `#parent/child`, and all deeper descendants. Querying `#parent/child` matches `#parent/child` and its descendants but not bare `#parent`. A file tagged `#a/b/c` is recorded with that exact leaf path; ancestor segments are not indexed separately.

**Tag pages** are auto-generated and virtual — backed by a libSQL query, not real `.md` files. Route `tag:projects/cubical` opens a list of files using that tag or any descendant.

**Schema (L3):**

```sql
CREATE TABLE tags (
    file_path TEXT NOT NULL,
    tag_path  TEXT NOT NULL,
    source    TEXT NOT NULL,         -- 'inline' | 'frontmatter'
    PRIMARY KEY (file_path, tag_path, source)
);
CREATE INDEX idx_tags_path ON tags(tag_path);
```

(`file_path` becomes `file_uuid` post-L7 via schema migration.)

### 5.7 Pending Rewrites Cache

Renames (file rename, tag rename, block-id rename) are *deferred-write*. The user-visible event — the rename — is instant. The disk impact — rewriting referrer files — is coalesced.

**Why deferred:** a rename of a heavily-linked file or tag would otherwise trigger dozens to hundreds of file writes synchronously, causing UI lag, file-watcher cascades, and cloud-sync churn. Coalescing eliminates all four.

**Schema (L3):**

```sql
CREATE TABLE pending_rewrites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    target_file     TEXT NOT NULL,         -- file to be rewritten
    rewrite_kind    TEXT NOT NULL,         -- 'wiki_link' | 'tag' | 'block_ref'
    old_token       TEXT NOT NULL,         -- e.g. '[[old-name]]', '#projects', '^intro'
    new_token       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    rename_op_id    INTEGER NOT NULL       -- groups all rewrites from one rename
);
CREATE INDEX idx_pending_target ON pending_rewrites(target_file);
CREATE INDEX idx_pending_op     ON pending_rewrites(rename_op_id);
```

**Reads materialize.** Every read of a file's effective content (display, indexing, export) reads on-disk content, applies pending rewrites for that file in `created_at` order, returns the materialized result. One indexed query per read; cheap.

**Flush triggers:**
- Periodic timer (default 5 min, configurable).
- On app close (mandatory).
- On `pending_rewrites` count for a single target file exceeding 50 (pathological-case fuse).
- On user-invoked "Save all pending changes."

**External-write conflict.** If `notify` reports `target_file` was modified externally while pending rewrites exist, on flush the rewrite is re-applied textually: find the old token in the new content; if present, replace; if not (user removed it manually), the rewrite silently drops.

**Plugin file reads must go through Cubical's capability**, not raw WASI fs, so plugins see materialized content. WASI fs is denied by default in the permission model anyway.

**Status bar always shows the unflushed count** ("12 pending changes"). Toast notification on flush completion: "Applied 12 reference updates across 7 files." Click → diff view.

**Undo:** instant within the unflushed window (`DELETE FROM pending_rewrites WHERE rename_op_id = ?`). After flush, undo is a full reverse rewrite — same flush mechanism, opposite direction.

---

## 6. Concurrency model

Three lanes with strict separation. Crossing a lane boundary is an explicit, designed event, never an accident.

**Lane 1 — Webview main thread.** CodeMirror 6 instance, Pretext layout calls, Solid component tree, DOM rendering, user input handling. Owns the in-memory editor state for currently-focused notes only. Speaks to Lane 2 via Tauri commands.

**Lane 2 — Rust async (Tokio).** Tantivy indexing, libSQL queries, file I/O via `notify`, CRDT merge operations (post-L7), AST normalization, Pending Rewrites flush, export pipeline. All disk and database work lives here.

**Lane 3 — Web Workers.** Reserved for WASM plugins (Layer 6). Plugins communicate with the main thread via `postMessage` and with Rust via the Tauri command bridge.

A possible future **Lane 4 — Wasmtime headless plugin host** is added in v2 if a real use case appears for plugins that need direct DB access without DOM. The WASI ABI is shared with Lane 3, so plugins target one ABI regardless of host.

### 6.1 IPC design

Tauri commands are the Lane 1 ↔ Lane 2 boundary. Every command is a serialization point. Two rules:

1. **Commands are coarse-grained.** `save_note_and_get_backlinks` over `save_note` + `get_backlinks`. Round-trips are expensive; design them out.
2. **Every command has typed request and response structs.** Even if a single field would suffice today. Growth is inevitable; struct fields are cheap.

Streaming results (e.g., search-as-you-type) use Tauri's event system, not return values.

---

## 7. Sync

Sync ships at **Layer 7**. Pre-L7, Cubical is single-device; the `cubical-sync` crate exists as a planned interface (`trait CrdtBackend`) but has no implementation. Pre-L7 file reconciliation across external edits uses the simpler hash + mtime model described in §4.3.

### 7.1 Loro

Loro is the CRDT engine that lands at L7. The vault's file tree is a Loro movable tree; each note's content is a Loro text. The `(file_uuid, block_id)` pairs (introduced at L7 onboarding alongside frontmatter UUIDs) are stable identifiers across the CRDT.

The CRDT layer is abstracted behind `trait CrdtBackend` with Loro as the only implementation. The trait exists so the *boundary* is clean, not because a swap is planned. Code outside `cubical-sync` calls the trait, not Loro directly.

### 7.2 Operation logs

Per-note operation logs in libSQL, keyed by `file_uuid`. Each row is an operation with author, timestamp, and serialized payload. Operation log tables (`crdt_operations`, `crdt_snapshots`) are reserved in the schema but not created until L7.

Log growth is bounded by periodic snapshot + compaction:

1. When a note's log exceeds N operations or M bytes (tunable), a snapshot of the materialized state is taken.
2. Operations older than the snapshot are pruned, except for those needed to reconcile with peers that haven't yet seen the snapshot.

### 7.3 Network

Layer 7. WebRTC P2P for direct device-to-device sync; optional E2EE relay for store-and-forward when peers are not simultaneously online. The relay is a thin server that holds encrypted blobs only — it cannot read user content.

### 7.4 Two-tier asset pipeline

Text and CRDT operations sync over WebSockets at high priority. Binary assets sync on background queues with their own bandwidth controls. Implemented in L7.

---

## 8. Plugins

### 8.1 ABI

WASM with WASI sandboxing. The host (Cubical) and plugin share a typed ABI for: reading the canonical AST of a file, querying libSQL via a constrained query interface, registering UI surfaces, subscribing to vault events.

The ABI is versioned with integers (`abi_version: 1`, `abi_version: 2`, …). Each plugin's manifest declares `target_abi_version`. **Cubical at runtime ABI version `N` accepts plugins targeting `N`, `N-1`, or `N-2`.** Older plugins fail to load with a clear migration message: *"This plugin targets ABI v3; Cubical supports v4–v6. Please ask the plugin author for an update."* When ABI `N+1` ships, plugins targeting `N-2` are dropped — authors get a full version cycle to migrate before their plugin breaks.

The host implementation uses version-aware code paths sharing common types — *not* generic translation shims. E.g., if v1 had `read_file(path)` and v2 has `read_file(path, opts)`, the v1 path supplies default opts when calling the unified impl. This is honest about what cross-version compat actually costs and gives plugin authors a predictable migration cadence.

### 8.2 Source languages

The native target language is Rust. AssemblyScript, Zig, Go (TinyGo), and C are also supported by virtue of WASI being the target.

JavaScript and TypeScript are first-class source languages, supported via Javy (or QuickJS-WASM, depending on tooling maturity at Layer 6 time). A JS plugin compiles to a QuickJS interpreter running inside WASM. The plugin pays an interpreter overhead (roughly 2–5x slower than native WASM) but retains full sandboxing and the same WASI ABI. The overhead is invisible for the typical plugin shape (event handlers + capability calls; no heavy CPU work); plugins that genuinely need native-WASM speed can target Rust. This is the unlock that gives Cubical an ecosystem at launch — JS-literate developers can contribute without learning Rust.

### 8.3 Permissions

Granular, explicit, per-plugin. The user grants:

- Read access to specific folders or the whole vault
- Write access to specific folders or the whole vault
- Network access (denied by default)
- Specific Cubical capabilities (run search, query metadata, etc.)

A plugin cannot escalate. The permission UI shows what each plugin currently has and lets the user revoke.

### 8.4 Concurrency

Plugins run in Lane 3 (Web Workers) for v1. They can spin up their own background work without blocking the main thread.

### 8.5 Memory pipeline

Where the host and plugin share memory regions for large data (canonical AST traversal, query results), zero-copy is the design intent. Practically, this requires careful ABI design — the WASM linear memory model permits it, but the ergonomics depend on tooling. Layer 6 will determine the exact mechanism.

### 8.6 File access

Plugins reading vault files **must go through the Cubical capability** (`vault.read_file(path)`), not raw WASI fs. This guarantees plugins see materialized content (with Pending Rewrites applied) rather than stale on-disk text. WASI fs is denied by default in the permission model; granting it is an explicit, granular choice the user makes per plugin.

### 8.7 Themes

Plugins may distribute one or more themes via the manifest's `themes` field. Plugin themes plug into the same CSS token surface as built-in and user themes (§11.4), so they are first-class — not a separate code path.

---

## 9. Binary assets

Assets dropped into a note are:

1. SHA-256 hashed.
2. Stored at `.assets/<first-2-chars>/<next-2-chars>/<full-hash>.<ext>`.
3. Referenced from the note via a path-relative link.

If the same asset is dropped again (same hash), no copy is made — the existing file is linked.

A background Rust task generates WebP thumbnails for images. The UI lazy-loads thumbnails and swaps to full-resolution as a viewport-entry approaches. This keeps memory low even for image-heavy notes.

Cross-vault deduplication is **explicitly rejected.** It breaks portability — you cannot zip up a vault and send it to someone if half the assets live in a global folder elsewhere.

---

## 10. Time Machine

A snapshot of the vault's tracked-file state, stored in libSQL. **Layer 8, post-v1.0.**

**Trigger: sync-clean state.** A snapshot is taken when there are zero pending CRDT operations and zero unsaved buffers — i.e., the vault is fully reconciled, in flight on neither side. This is intentionally *not* a periodic timer. Pre-L7 there is no CRDT layer to be clean *relative to*, so Time Machine is dormant. Post-L7 it fires at meaningful boundaries — moments when the user has, in effect, "committed" to a vault state.

Snapshots are content-addressed by hash, so unchanged files don't bloat the database. A snapshot row is `(timestamp, file_uuid, content_hash, content_blob_id)`; the actual content lives in a deduplicated blob table.

The user-facing surface (version-history UI, "restore to this version," 3-way merge UI for in-flight conflicts) is L8 work.

**Pre-L7 safety substrate.** Before L7 ships, the safety net for external edits is the simpler `.cubical/recovery/` directory described in §4.3 — a temp-file written before each external-edit reconciliation, retained for a configurable window (default 30 days). This is not a full Time Machine; it has no UI and no version-pick semantics. It exists so users always have a one-click path back to the prior buffer state if a merge result is undesirable.

---

## 11. UI

### 11.1 Layout

- **Left panel:** universal '+' create button, file explorer (heights measured by Pretext, virtualized via standard list-virtualization), persistent search panel (Tantivy).
- **Central workspace:** tab bar with split-pane support, unified Live Preview editor.
- **Right sidebar:** backlinks pane and unlinked mentions pane.
- **Bottom status bar:** indexer progress, vault health (broken refs, malformed YAML), Pending Rewrites count, sync state (post-L7).

### 11.2 Global triggers

- `Cmd/Ctrl+K`: Omni-Bar for transient quick-nav and command execution.
- `[[`: in-editor link auto-complete.
- `#`: in-editor tag auto-complete (when typed at word boundary outside code blocks).
- Drag-and-drop: dropping an asset into the editor creates an inline link and triggers the deduplication pipeline.

### 11.3 Live Preview

There is no separate "Read mode" and "Edit mode." Live Preview is the only mode for normal use. A Raw Source toggle exists for power users who want to see the literal markdown.

Live Preview is implemented as Lezer-driven decorations on the CodeMirror state. The line the cursor is on shows raw markdown; other lines show rendered form. Cursor movement triggers decoration re-application, which is fast because Lezer parsing is incremental.

### 11.4 Theming

A single CSS-variable token surface lives in `ui/src/styles/tokens.css`. **All UI components consume tokens; no hardcoded colors, fonts, or spacings exist outside the tokens file.** This is enforced by lint rule.

**Token categories:** colors (`--c-bg-primary`, `--c-fg-primary`, `--c-accent`, `--c-success`, `--c-warning`, `--c-error`, …), typography (`--font-body`, `--font-mono`, `--text-base`, `--leading-base`, …), spacing scale (`--space-1` through `--space-8`), border radii, shadows.

**Built-in themes** ship with the app: Light, Dark, optionally High-Contrast.

**User themes** live at `<vault>/.cubical/themes/<theme-name>.css`. Cubical scans this folder on startup and populates the theme picker.

**Plugin themes** are registered via the plugin manifest's `themes` field. They plug into the same token surface — they are CSS files that override token values.

**CodeMirror integration.** The CM6 theme is generated programmatically from the same token surface. Authors write themes against tokens; the editor stays in sync with the rest of the UI without a second theme to maintain.

**Live theme switch.** Setting `<html data-theme="...">` triggers a CSS-variable cascade. No reload, no flicker.

### 11.5 Multi-vault

**One vault per window, multiple windows allowed.** A single Tauri process holds `HashMap<VaultId, Vault>` in Rust state. Each window's frontend tracks one `vault_id` and uses it in all IPC commands. Users with multiple vaults open multiple windows.

Cross-vault search, cross-vault tabs, and cross-vault command-palette are explicitly out of scope — most users don't ask for them, and the implementation cost is significant. The IPC contract leaves the door open if user demand emerges later.

---

## 12. Settings

User-facing settings, organized by category:

**Files & Core.** Vault path. `.cubical/recovery/` retention window (default 30 days). Pending Rewrites flush cadence (default 5 min). Auto-save debounce (default 300ms). Asset destination is locked to `.assets/` (not configurable).

**Editor & Export.** Live Preview vs Raw Source default. Export sanitization rules (display only — sanitization is mandatory).

**Appearance.** Theme picker (built-in + user themes from `<vault>/.cubical/themes/` + plugin-distributed themes). Font family, font size overrides.

**Search.** Tantivy indexing controls.

**Sync & Network.** (L7+) Local P2P toggle, E2EE key generation and management, relay configuration.

**Plugins & Security.** (L6+) Per-plugin WASI permission toggles.

**Time Machine.** (L8+) Snapshot retention window, manual snapshot trigger.

---

## 13. What is explicitly out of scope

These are deliberate non-decisions. They are not "later" — they are "no."

- Centralized cloud database for core storage. The vault is local.
- Cross-vault asset deduplication or global asset folders.
- Proprietary file formats for content. Markdown only.
- Required user accounts.
- JavaScript plugin runtimes that bypass the WASM sandbox.
- Cross-app importers (Obsidian, Logseq, Notion, …). Community plugins can solve this; the core does not.
- Local AI / RAG / embeddings as a core feature. AI is a plugin-ecosystem concern; libSQL's vector capability is exposed to plugins that want it.
- Telemetry that ships content, file names, or vault structure off-device. (Crash reporting and aggregate usage stats may be opt-in, separately.)

---

## 14. Open architectural questions

These are deliberately deferred to the layer where they become live decisions, not because they are unimportant.

- Exact canonical AST schema → finalized in Layer 1.
- Exact CRDT operation log compaction parameters → tuned during Layer 7.
- Exact Tauri command surface → grown organically per layer; reviewed for coarseness at each layer transition.
- Plugin ABI specifics → finalized in Layer 6, by which time we have real consumers (the core Cubical features themselves) to design against.
- WebGPU graph rendering data structures → Layer 9.
- **Encryption at rest** for `.cubical/index.db` and `.cubical/recovery/`. Reserved as a future concern; the architecture should not preclude it.
- **i18n strategy.** A UI string layer will be reserved in the frontend; real translations are post-v1.0.
- **License / business model.** MIT placeholder during alpha; revisited before public beta cut at L5.
- **Backup / corruption recovery story** for `.cubical/index.db`. Mostly documentation rather than architecture, but the trade-offs (rebuild from .md vs. provide a built-in backup tool) deserve a section before L5.
- **Sync details** — WebRTC NAT traversal, STUN/TURN, relay hosting model, key management. Own conversation when L7 becomes live.

When one of these becomes live, it gets its own section here, written before any code.
