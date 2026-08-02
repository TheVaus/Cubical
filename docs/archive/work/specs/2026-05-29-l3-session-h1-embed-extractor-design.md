> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session H.1 — Embed content extractor + IPC (design)

**Date:** 2026-05-29
**Layer:** 3 — Knowledge Graph
**Depends on:** Session G `blocks` index (spec §9.8) — `blocks_for_file` gives the byte offset of each `^id` line. No other new dependencies.

## Goal

Backend half of Session H (spec §2.8): a `get_embed` IPC that, given a wiki-link target (`note`, `note#heading`, `note#^id`), returns the content to be rendered inline by the future embed widget. Pure markdown-aware extractors do the work; the handler is a thin orchestrator. Frontend: zero changes — the IPC binding lands unused (mirroring the §9.8 Session G backend cadence; the widget arrives in H.2).

## Scope

**In:**
- Pure `extract_section(source, heading)` and `extract_block(source, byte_offset)` extractors + a small `strip_frontmatter(source)` helper, in `cubical-core::vault::embeds`.
- `get_embed` handler in `cubical-app::commands::embeds`: resolves target → reads file → routes to the right extractor based on the anchor kind.
- Wire types + Tauri shim + `ipc.ts` binding (`getEmbed`).
- Unit + handler tests; no frontend changes.

**Out (deferred to H.2 / H.3):**
- The embed widget, depth cap, cycle detection, unresolved placeholder rendering (all H.2).
- Rich markdown-live-preview rendering inside the widget (H.3 polish — optional, not in §2.8 DoD).
- Backend-side recursion / max depth (frontend's concern; H.1 returns one note's slice at a time).

## Background — relevant existing machinery

- **`resolve_target` + the snapshot pattern.** `resolve_link` (`crates/cubical-app/src/commands/links.rs:24`) is the template: `SELECT path FROM files ORDER BY path` → `cubical_core::vault::links::resolve_target(target_raw, &known) -> Option<String>`. The `[[#^` autocomplete handler (§9.11) follows the same pattern.
- **`split_target_anchor(target_raw) -> (String, Option<ResolvedAnchor>)`** is private to `commands/links.rs` (lines 63–91). Widen to `pub(crate)` and reuse — same pattern Session G used for `map_index_err`.
- **`ResolvedAnchor`** (`api/types.rs:300`) is `enum { Heading { value }, Block { value } }`. The `value` strings are stored without `#`/`^` (matching how `Anchor::Block { value }` is parsed).
- **`blocks_for_file(conn, file_path) -> Vec<BlockRow>`** (Session G) gives `(block_id, position_hint)` per id; `position_hint` is the byte offset of the line carrying `^id` (set by Session G's `extract_block_ids`).
- **Path resolution accepts** exact vault path with/without `.md`, then unique basename. Same call surface for embeds.
- **No frontmatter-strip helper exists yet.** A small one is added in this session.

## Components / data flow

```
getEmbed({ vault_id, target_raw: "Daily" })
   ↓ commands::embeds::get_embed
   ├── snapshot files.path
   ├── split_target_anchor → ("Daily", None)
   ├── resolve_target → Some("notes/Daily.md")
   ├── read file off-executor (lossy UTF-8)
   ├── kind: anchor.is_none() → "note"
   │   ├── strip_frontmatter(source)
   │   └── content = body
   ├── kind: Heading { value } → "section"
   │   └── extract_section(source, value)
   │       └── Some(slice) | None  → "missing-anchor" if None
   └── kind: Block { value } → "block"
       ├── blocks_for_file → find (id == value) → position_hint
       └── extract_block(source, position_hint)
           └── slice
   ↓
{ kind, target_path?, content? }   // see "Response shape" below
```

Unresolved target → `{ kind: "unresolved" }` (no target_path/content). Resolved target but anchor not found → `{ kind: "missing-anchor", target_path }`.

## Pure extractors (`cubical-core::vault::embeds`)

A new module sibling to `vault::blocks`. Three public functions.

### `extract_section(source, heading) -> Option<String>`

Returns the slice from the next line *after* the matched heading to the line *before* the next heading whose level is `≤` the matched heading's. `None` if no heading matches.

**Heading matching:** both the heading text from source and the anchor `value` are slugified the same way (lowercased, non-alphanumeric run collapsed to `-`, leading/trailing `-` trimmed) and compared for equality. So a source heading `"My Section!"` matches anchor values `"my-section"`, `"My Section"`, or `"My Section!"` — they all slugify to `"my-section"`. One-pass over the lines:
- A heading line is `^#{1,6}\s+(.+)$` (ATX only — setext headings out of scope for v1, can land later if needed).
- For each heading, normalize its text and compare to the normalized anchor.
- On match, record the level and the line index *after* the heading; keep walking until another heading with level `≤` matched level or EOF; return the slice.

Trailing whitespace at the end of the slice is preserved as written (no trimming) so the embed renders the user's authored content verbatim.

### `extract_block(source, byte_offset) -> String`

The `byte_offset` points at the start of a line carrying a trailing `^id` (per Session G's `position_hint` contract). Walk back from that line through preceding non-blank lines until a blank line or the start of file; walk forward similarly until a blank line or EOF. Return that contiguous block.

This handles paragraphs and most list items uniformly (CommonMark paragraphs end at blank lines; a single-line list item also ends at a blank line). For multi-line list items with continuation, the simple "until blank line" rule still captures the contiguous block.

If `byte_offset >= source.len()`, return an empty string (defensive — shouldn't happen since `position_hint` came from a fresh scan of this source).

### `strip_frontmatter(source) -> &str`

If `source` starts with `---\n` (or `---\r\n`) and a closing `---` on its own line follows, return the slice after the closer (and its trailing newline). Otherwise return the whole source. Pure, returns a borrowed slice — no allocation.

### Tests

In `cubical-core/src/vault/embeds.rs` `#[cfg(test)] mod tests`:
- `extract_section_matches_heading_by_slug` — `# My Section\nbody\n` + anchor `"my-section"` → `"body\n"`.
- `extract_section_respects_level_ceiling` — `## A\nfoo\n# B\nbar\n` with anchor `"a"` → `"foo\n"` (stops at `# B`).
- `extract_section_returns_none_when_missing` — anchor `"ghost"` → `None`.
- `extract_section_handles_subheadings` — `# A\nfoo\n## A.1\nbar\n# B\n` with anchor `"a"` → `"foo\n## A.1\nbar\n"` (sub-heading kept; same-level `# B` stops).
- `extract_block_paragraph` — `"para one\nstill para ^id\n\nnext\n"`, offset of line `"still para ^id"` → `"para one\nstill para ^id\n"`.
- `extract_block_list_item` — `"- a\n- b ^id\n- c\n\n"`, offset of `"- b ^id"` → `"- a\n- b ^id\n- c\n"` (block ends at the blank line).
- `strip_frontmatter_present` — `"---\ntitle: x\n---\nbody\n"` → `"body\n"`.
- `strip_frontmatter_absent` — `"plain\n"` → `"plain\n"`.

## Handler (`cubical-app::commands::embeds`)

New module + handler. Pseudocode (full code lands in the plan):

```rust
pub async fn get_embed(
    state: &AppState,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, CubicalError> {
    // 1. Vault lookup (mirror commands/autocomplete::block_id_autocomplete).
    // 2. Snapshot files.path.
    // 3. Use crate::commands::links::split_target_anchor (widen to pub(crate)).
    // 4. resolve_target(target, &known) → Option<String>.
    //    None → return GetEmbedResponse { kind: Unresolved, target_path: None, content: None }.
    // 5. Read the target file off-executor (use cubical_core::vault::links::read_source_off_executor;
    //    already pub(crate) — exposed for Session G).
    //    Unreadable file → kind: Unresolved (consistent with refresh_blocks's resilience).
    // 6. Match anchor:
    //      None                    → kind=Note,   content=strip_frontmatter(&src).to_string().
    //      Some(Heading { value }) → extract_section(&src, &value)
    //                                  → Some(s) ? kind=Section, content=s
    //                                            : kind=MissingAnchor, content=None.
    //      Some(Block { value })   → blocks_for_file(idx, &path).await?
    //                                  .into_iter().find(|b| b.block_id == value)
    //                                  → Some(b) ? extract_block(&src, b.position_hint)
    //                                              → kind=Block, content=s
    //                                            : kind=MissingAnchor, content=None.
    // 7. Always set target_path = Some(path) when resolved.
}
```

### Tests

In `commands/embeds.rs` `#[cfg(test)]`:
- `get_embed_full_note_strips_frontmatter` — file `"---\nk: v\n---\nbody\n"`, target = basename → kind=Note, content=`"body\n"`, target_path set.
- `get_embed_section_returns_heading_slice` — file with `# Intro\ntext\n# Other\n`, target = `name#Intro` → kind=Section, content=`"text\n"`.
- `get_embed_block_returns_paragraph_via_blocks_for_file` — seed a `blocks` row + write file with the matching `^id` line → kind=Block, content=the surrounding block.
- `get_embed_unresolved_target_returns_unresolved` — empty vault → kind=Unresolved.

## Wire types

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct GetEmbedRequest {
    pub vault_id: String,
    /// Wiki-link target as written (no `[[`/`]]`/`|`). May include
    /// a `#heading` or `#^block-id` anchor.
    pub target_raw: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EmbedKind {
    Note,
    Section,
    Block,
    /// Target doesn't resolve to any file in the vault.
    Unresolved,
    /// Target resolves but the named heading / block id wasn't found.
    MissingAnchor,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetEmbedResponse {
    pub kind: EmbedKind,
    /// Resolved vault-relative path; `None` only when kind=Unresolved.
    pub target_path: Option<String>,
    /// Extracted content; `None` when kind is Unresolved or MissingAnchor.
    pub content: Option<String>,
}
```

Frontend IPC binding (`ipc.ts`): mirrored TypeScript types + `getEmbed(req): Promise<GetEmbedResponse>`. Unused until H.2 — `tsc` allows unused exports.

## Error handling

- Vault not open → `VaultNotOpen(id)` (existing).
- Snapshot / blocks query errors → propagate via `From<IndexError> for CubicalError` (existing).
- File read failure → fold into `EmbedKind::Unresolved` (the embed surface treats "can't read" the same as "doesn't exist"; the watcher will heal on next change).

## Out of scope (recap)

- Frontend widget, depth cap, cycle detection, callout styling — all H.2.
- Rich markdown rendering inside the embed — H.3 (optional polish).
- Setext headings (`===`/`---` under a title line) — paragraph-prose embeds rarely use them; can land in a later polish pass without breaking the H.1 IPC shape.
- Embedded image/audio rendering — separate from text embeds, out of L3 entirely (call out only if it ever matters).
