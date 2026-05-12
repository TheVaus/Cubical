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
