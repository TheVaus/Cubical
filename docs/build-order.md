# Cubical — Build Order

**v1.0 cuts at end of L5.** Layers 6+ are post-v1.

0. **Bedrock.** Workspace, Tauri, libSQL, file watcher, vault scan, file-type registry, frontmatter I/O, token surface. **No UUID injection.**
1. **Document Model.** Canonical Markdown AST in Rust, Lezer in CodeMirror, `get_canonical_ast` IPC, frontmatter into libSQL.
2. **Editing.** CodeMirror + Live Preview decorations, raw-source toggle, properties UI, light + dark themes. *First demo-able milestone.*
3. **Knowledge Graph.** Wiki-links, embeds, lazy block refs, backlinks, unlinked mentions, link/tag autocomplete, nested tags + virtual tag pages, rename → Pending Rewrites Cache.
4. **Search.** Tantivy full-text, Dataview-style libSQL queries, persistent search panel, Cmd/Ctrl+K Omni-Bar.
5. **Daily-Driver Polish.** Theme picker, export sanitization, perf pass, keyboard shortcuts. **Public v1.0 cut.**
6. **Plugins.** WASI host, manifest format, Web Worker runtime, Javy/QuickJS-WASM toolchain, plugin themes, ABI deprecation framework. *(Ships before sync — the plugin ABI is a one-way door once third parties depend on it; earn a stable core first.)*
7. **Sync.** Loro CRDT; frontmatter `cubical_id` UUIDs minted at onboarding; WebRTC P2P; optional E2EE relay.
8. **Time Machine.** Sync-clean-state snapshots, version history UI, 3-way merge UI. *(Post-v1.0)*
9. **Graph View.** WebGPU-rendered knowledge graph. *(Post-v1.0)*
10. **Long tail.** Canvas, mobile, anything else. *(Post-v1.0)*

For non-features explicitly cut from scope (including retired earlier proposals), see [`architecture/constraints.md`](architecture/constraints.md).
