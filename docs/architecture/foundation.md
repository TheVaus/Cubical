> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: Foundation

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
