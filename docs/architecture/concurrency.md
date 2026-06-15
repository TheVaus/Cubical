> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: Concurrency

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

### 6.2 Search (Layer 4) — locked decisions

Three load-bearing calls introduced by L4-A, promoted here at L4 close. The originating record (with the resolving sessions) is `docs/layer-4-spec.md` §5.

1. **Every per-vault search command keys on `vault_id`.** The four search commands (`search`, `search_index_status`, `search_rebuild_index`, `search_get_health`) and `dataview_query` (L4-D) each take a request struct carrying `vault_id`, per the L0 multi-vault contract. No per-vault IPC is implicitly scoped to a "current" vault — this is an explicit application of §6.1 rule 2.

2. **The search state cell holds exactly three values — `Building`, `Ready`, `Error` — and never a stuck `Building`.** While indexing, `search` returns whatever the current reader sees with `still_indexing: true`, never an error. A scan cancelled mid-flight must not leave the cell in `Building`: the search refresher short-circuits when its `CancellationToken` fires, preserving the L0/L1 100ms cancellation budget. UI relies on the cell always resolving out of `Building`.

3. **Prose fields are `STORED` in the search index; the index is rebuildable derived state.** `body`, `headings`, `code`, and `frontmatter` (alongside `path`, `title`, `tags`, `mtime_secs`, `size_bytes`) are stored, so Tantivy's snippet generator yields tokenizer-correct `<mark>` highlights for *every* matched field, not just `title` (L4-B resolved the original L4-A store-vs-reread choice in favour of storing — ~2-3× index disk, accepted). The index lives only under `<vault>/.cubical/search/`, never injects identity into `.md` source, and carries a `schema_version` stamp; a version mismatch or missing stamp wipes and rebuilds the index on open.
