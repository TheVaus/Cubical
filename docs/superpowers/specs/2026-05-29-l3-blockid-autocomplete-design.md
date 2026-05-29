# L3 — In-bracket `[[#^` block-id autocomplete (design)

**Date:** 2026-05-29
**Layer:** 3 — Knowledge Graph
**Depends on:** Session F autocomplete machinery (spec §9.7) + Session G `blocks` index (spec §9.8). Both already on `main`.

## Goal

When the user types `[[target#^pre`, open a CodeMirror dropdown of block ids defined in `target.md` whose name starts with `pre`. Picking one inserts the id and (if needed) the `]]` closer.

This closes the §9.7-deferred "in-bracket anchor completion" half — *for blocks only*. Heading completion (`[[target#heading`) stays deferred (no headings index exists).

## Scope

**In:** one new backend handler + IPC, one new trigger detector + completion source on the frontend, wire-up in `Editor.tsx` and the autocomplete provider.

**Out (YAGNI / deferred):**
- Heading autocomplete (`[[target#…` without `^`) — no headings index.
- A "create new block id here" affordance inside the dropdown (the `Cmd/Ctrl+Shift+B` gesture is the create path).
- Cross-vault completion or fuzzy matching across files (per-file scope, prefix filter — same as tags).

## Background — relevant existing machinery

- **`blocks_for_file(conn, file_path) -> Vec<BlockRow>`** already exists in `cubical-index::blocks` (Session G), returning ids ordered by `position_hint`. No new index helper needed.
- **`resolve_link`** (`crates/cubical-app/src/commands/links.rs:24`) is the template for "snapshot `files.path`, build `PathResolver`, call `resolve_target(target_raw)`." Identical pattern works here.
- **Session F autocomplete** (`ui/src/editor/autocomplete.ts`) defines `detectLinkTrigger` / `detectTagTrigger` (pure trigger regex returning `{from}` for CM6), `linkInsertion` (computes `{insert, cursorAfter}` with the `closerFollows` `]]` check), `isInhibited` (Lezer-walk code-context gate), and `linkCompletionSource` / `tagCompletionSource` (`CompletionSource` factories with `validFor` for inter-keystroke filtering). `autocompleteProvider.ts` carries the injected IPC callbacks; `Editor.tsx`'s `autocompleteCompartment` lists the sources in `autocompletion({ override: [...] })`. The same shape is reused for blocks.
- **Link trigger stops at `#`** (regex `/\[\[([^\]\n|#]*)$/`) — by construction it never fires once `#` is typed. So the block trigger and link trigger don't overlap.
- **`AUTOCOMPLETE_LIMIT = 50`** is the existing server-side cap in `commands/autocomplete.rs`.

## Components / data flow

```
type "[[note#^pre"
   ↓
detectBlockTrigger(before, pos)  → { target: "note", from: pos - "pre".length } | null
   ↓ (CM6 invokes via override CompletionSource)
isInhibited?  yes → null
   ↓
provider.completeBlockIds("note")
   ↓ IPC
block_id_autocomplete({ vault_id, target_raw: "note" })
   ├── snapshot files.path → PathResolver::build
   ├── resolve_target("note") → target_path or None
   ├── if Some(path): blocks_for_file(conn, &path).map(.block_id), cap LIMIT
   └── if None: []
   ↓
{ candidates: ["intro", "summary", ...] }
   ↓
CM6 dropdown filtered by `pre` via validFor /^[A-Za-z0-9_-]*$/
   ↓ pick "intro"
blockInsertion("intro", closerFollows) → { insert, cursorAfter }
   inserts "intro" (+ "]]" if no closer follows), caret past "]]"
```

## Backend additions (`cubical-app`)

- New handler `commands::autocomplete::block_id_autocomplete(state, req)`:
  ```rust
  pub async fn block_id_autocomplete(
      state: &AppState,
      req: BlockIdAutocompleteRequest,
  ) -> Result<BlockIdAutocompleteResponse, CubicalError> {
      let guard = state.vaults().read().await;
      let open = guard.get(&req.vault_id).ok_or_else(/* VaultNotOpen */)?;
      let vault = open.vault.clone();
      drop(guard);

      let conn = vault.index().connection();
      let mut rows = conn.query("SELECT path FROM files ORDER BY path", ()).await?;
      let mut known: Vec<String> = Vec::new();
      while let Some(row) = rows.next().await? { known.push(row.get(0)?); }
      let resolver = cubical_core::vault::links::PathResolver::build(known);
      // NB: PathResolver isn't currently re-exported through cubical_core's
      // public API — see implementation note below.

      let target_path = match resolver.resolve(&req.target_raw) {
          Some(p) => p,
          None => return Ok(BlockIdAutocompleteResponse { candidates: vec![] }),
      };
      let blocks = cubical_index::blocks_for_file(vault.index(), &target_path).await?;
      let candidates: Vec<String> = blocks
          .into_iter()
          .map(|b| b.block_id)
          .take(AUTOCOMPLETE_LIMIT as usize)
          .collect();
      Ok(BlockIdAutocompleteResponse { candidates })
  }
  ```
- **Implementation note on `PathResolver`:** `resolve_link` uses `resolve_target(target_raw, &known)` (a thin wrapper), not `PathResolver` directly. Mirror that — call `cubical_core::vault::links::resolve_target` to avoid touching crate visibility. (`resolve_target` is the public function; `PathResolver` is the internal type.)
- Wire types in `api/types.rs`:
  ```rust
  #[derive(Debug, Clone, Deserialize)]
  pub struct BlockIdAutocompleteRequest {
      pub vault_id: String,
      /// Wiki-link target as written (no `[[`/`]]`/`#`/`|`). Resolved
      /// to a file path via the same rules as `resolve_link`.
      pub target_raw: String,
  }
  #[derive(Debug, Clone, Serialize)]
  pub struct BlockIdAutocompleteResponse {
      /// Block ids defined in the resolved target file, ordered by
      /// position; empty when the target doesn't resolve. Capped server-
      /// side at AUTOCOMPLETE_LIMIT.
      pub candidates: Vec<String>,
  }
  ```
- 3-line Tauri shim in `lib.rs`, registered in `generate_handler![]`.
- IPC binding in `ui/src/api/ipc.ts`: `blockIdAutocomplete(req)`.
- **2 handler unit tests:** resolved target returns its ids in order; unresolved target returns `[]`.

## Frontend additions (`ui/src/editor`)

### Pure helpers (`autocomplete.ts`)

- **`detectBlockTrigger(before, pos)`** — regex `/\[\[([^\]\n|#]+)#\^([A-Za-z0-9_-]*)$/`. Returns `{ target, from }` where `from = pos - prefix.length` (so CM6's `from` replaces only the partial id). Returns `null` if no match, or if `target` is empty/whitespace.
- **`blockInsertion(id, closerFollows)`** mirroring `linkInsertion`: returns `{ insert, cursorAfter }`. `insert` is just the `id` (no leading `^` — the user already typed it). When `closerFollows` is false, append `]]`; `cursorAfter` lands two chars after the id (past the appended `]]`) or right after the id when the closer already exists.
- **`blockCompletionSource(provider)`**: builds a `CompletionSource` whose handler calls `detectBlockTrigger`, runs the `isInhibited` (code-context) gate, fetches `provider.completeBlockIds(target)`, maps to `Completion` options with `apply` invoking `blockInsertion`. `validFor: /^[A-Za-z0-9_-]*$/` (inter-keystroke filter — no re-query while the user types valid id chars).

### Provider (`autocompleteProvider.ts`)

Add `completeBlockIds(target: string): Promise<string[]>` to the `AutocompleteProvider` interface and its `createAutocompleteProvider(vaultId, linkIpc?, tagIpc?, blockIdIpc?)` factory (defaulting to `blockIdAutocomplete`). Failures resolve to `[]`, like the existing two.

### Editor wiring (`Editor.tsx`)

Add `blockCompletionSource(p)` to the `autocompletion({ override: [...] })` array in the `autocompleteCompartment`.

### Tests (vitest, in `autocomplete.test.ts`)

- `detectBlockTrigger`: matches `[[note#^]`, `[[note#^pre]`, `[[a/b#^_x-1]`; rejects empty target (`[[#^x]`), no `#^` (`[[note#pre]`), outside `[[…]]` (`text^pre`), inside fenced code (already covered by `isInhibited`).
- `blockInsertion`: with/without existing `]]`; cursor position correctness.
- `blockCompletionSource` headless: paragraph success (returns candidates from injected provider), fenced-code inhibition (returns null), empty target (returns null).

## Error handling

- Backend: any `IndexError` propagates via `From<IndexError> for CubicalError` (existing). Unknown vault → `VaultNotOpen` (existing).
- Frontend: provider failures resolve to `[]` (dropdown shows nothing rather than erroring), matching the link/tag pattern.

## Testing summary

- **Rust:** +2 handler tests (resolved + unresolved). 271 → 273.
- **Vitest:** +~9 (detectBlockTrigger × 4, blockInsertion × 2, blockCompletionSource × 3). 282 → ~291.

## Smoke plan (hands-on)

In `cargo tauri dev`: in note A type `[[B#^` where B has `^intro` and `^summary` minted (use `Cmd/Ctrl+Shift+B` on B's lines if needed). Confirm the dropdown lists `intro`, `summary`; typing `i` filters; Enter inserts `intro]]`; no dropdown when target doesn't resolve.

## Out-of-scope / follow-ups

- Heading completion (`[[target#…` without `^`) — needs a headings index (not built; postponed indefinitely or until a later session decides to index headings).
- A "no block ids yet — copy one with Cmd/Ctrl+Shift+B" empty-state message in the dropdown (YAGNI; empty dropdown is acceptable).
- Session H — Embeds.
