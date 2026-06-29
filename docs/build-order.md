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

---

## Layer status & tags

**Canonical source of truth for layer state.** Other docs (`CLAUDE.md`,
`README.md`, the layer specs) link here rather than restating tags/dates —
update this table on layer close, nowhere else.

| Layer | Status | Tag(s) (date) | Spec |
|---|---|---|---|
| 0 — Bedrock | Closed | `l0` (05-13) | [`layer-0-spec.md`](layer-0-spec.md) |
| 1 — Document Model | Closed | `l1` (05-09) | [`layer-1-spec.md`](layer-1-spec.md) |
| 2 — Editing | Closed | `l2` (05-22) | [`layer-2-spec.md`](layer-2-spec.md) |
| 3 — Knowledge Graph | Closed | `l3` (06-01) | [`layer-3-spec.md`](layer-3-spec.md) |
| 4 — Search | Sub-layers merged; `l4` close-tag pending operator GUI smoke | `l4a` (06-03) · `l4a-fix`/`.1` (06-06) · `l4b`/`l4c`/`l4a-fix.2` (06-08) · `l4d` (06-15) | [`layer-4-spec.md`](layer-4-spec.md) |
| 5 — Daily-Driver Polish | Not started (v1.0 cut) | — | — |

## Known open perf debt

Non-blocking, doesn't gate any layer: [`anti-patterns-2026-06-01.md`](anti-patterns-2026-06-01.md) — four perf anti-patterns surfaced post-L3 (N+1 in scan, full-tree decoration walk, row-at-a-time INSERTs, sequential async). Re-validated 2026-06-17: all four still open. Pick up opportunistically. Tracked as GitHub issues #14–#17 (milestone `v1.0`); the doc remains the analysis of record.
