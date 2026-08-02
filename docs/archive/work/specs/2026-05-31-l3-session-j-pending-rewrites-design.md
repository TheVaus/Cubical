> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

## L3 Session J — Rename → Pending Rewrites Cache (design)

**Date:** 2026-05-31
**Layer:** 3 — Knowledge Graph
**Depends on:** Session A `links` index (§9.1), Session D `tags` index (§9.4), Session G `blocks` / `block_refs` (§9.8). No other new dependencies.

## Goal

Implement spec §2.10 + locked schema in `docs/architecture/document-model.md` §5.7. Renaming a file, a tag, or a block-id becomes **instant**; the disk impact — rewriting referrer files — is **coalesced** through a new `pending_rewrites` libSQL table. Every read of a file's effective content materializes pending rewrites against the on-disk source. Flush is triggered four ways (timer, app-close, >50-per-file fuse, manual). Status bar shows the unflushed count; flush emits a toast. Undo within the unflushed window is instant.

## Scope split — J.1 (this design's implementation pass) + J.2 (follow-up)

Session J ships in two halves, mirroring the H.1 / H.2 precedent (§9.12 / §9.13). This spec covers both halves; the J.1 implementation plan will be written first against the J.1 sections below.

**J.1 — Backend + headless flow.** Migration, query module, pure `apply_pending` + `materialize_on_read`, materialize-on-read wired into all consumers, three rename IPCs, flush + four triggers, count/undo IPCs, backend-side own-write hash gate. End state: every J behaviour is verifiable through direct IPC calls; full Rust test coverage. No frontend code changes beyond IPC binding stubs.

**J.2 — Frontend.** TS IPC bindings + listeners, status-bar count item + tooltip + click-out, per-rename-op undo affordance, minimal Toast component, file-rename UI gesture (right-click → "Rename…"), App.tsx wiring (signals, listeners, periodic-timer setting). Vitest coverage. Interactive smoke against the full smoke vault.

The seam is clean: J.1's IPCs are the only surface J.2 touches. J.1 lands behind a TS binding the frontend doesn't yet call; J.2 wires it in.

---

## Background — relevant existing machinery

- **Migrations.** `crates/cubical-index/migrations/001..005_*.sql` exist; runner in `crates/cubical-index/src/runner.rs` reads them from `MIGRATIONS` and gates the test constant `HIGHEST_KNOWN_VERSION` (currently `5`). Adding J.1 bumps it to `6` (one new migration file + one constant).
- **Query module shape.** `cubical-index::{links,tags,blocks}` each ship `replace_X_for_file(tx, …)` + lookup helpers, all taking a borrowed connection and **not** opening their own transaction so callers can batch. J.1's `pending` module follows the same shape.
- **Pure scanner pattern.** `cubical-core::vault::{links,tags,blocks,mentions}` are pure modules (extract + helpers, no I/O). The pending materializer is the same shape: `apply_pending(source, &[PendingRewrite]) -> String` is pure; `materialize_on_read(vault, path, on_disk) -> String` is the thin I/O wrapper that pulls rows and calls the pure helper.
- **`cubical_ast::wikilink`** was promoted to `pub` in Session I (`scan_wikilinks`). J.1 uses it to rewrite wiki-link targets while preserving `|display` and `#anchor`/`#^block` suffixes.
- **Read paths.** `cubical-app::commands::vault::read_file_text` (`vault.rs:284`) is the editor's read surface. `get_canonical_ast`, `get_embed`, `get_unlinked_mentions` (source-file read) are the other "effective content" consumers. The **scan** + **watcher** dispatcher (`cubical-core::vault::scan`, `vault::watcher::apply_watch_event_to_db`) also read source bytes for the link/tag/block extractors.
- **Atomic write.** `cubical_core::atomic_write` (used by `write_file_text`, `link_mention`). J.1 uses it for both the file move (rename) and the flush rewrites.
- **`write_file_text`'s hash gate.** Editor-side `last_written_hash` lives in the *frontend* (`ui/src/api/ipc.ts`'s autosave path) and is matched against on the backend write — i.e. the editor's own write doesn't surprise the editor. Flush has no editor. J.1 introduces a **backend-side** own-write suppression: a per-vault `HashSet<(PathBuf, ContentHash)>` that flush populates before writing and the watcher dispatcher drains before emitting `vault:file-changed`. This means a flush write does not bounce back to the frontend as an external edit. Existing editor `last_written_hash` flow is unchanged.
- **`rename_op_id` storage.** L0's `config` table is the existing single-row counter store (`config(key TEXT PRIMARY KEY, value TEXT)`). J.1 reserves key `pending_rewrites.next_rename_op_id`; integer parsed/stored as string for consistency with existing config rows.
- **Vault open/close.** `cubical-app::commands::vault::{open_vault, close_vault}` (or equivalent) manage per-vault state. The periodic-flush task spawns inside `open_vault`'s success path and is cancelled in `close_vault`. The mandatory close-time flush runs `flush_pending_rewrites` synchronously *before* the index handle is dropped.

---

## J.1 — Backend

### Migration `006_pending_rewrites.sql`

```sql
-- L3 Session J — Pending Rewrites Cache.
-- See docs/architecture/document-model.md §5.7 and docs/layer-3-spec.md §2.10.
--
-- One row per deferred per-file token rewrite. Grouped by rename_op_id
-- so undo deletes exactly the rows a single rename enqueued.
-- No FK on target_file → files(path): a row targeting a since-deleted
-- file silently drops on flush rather than blocking the migration runner.

CREATE TABLE pending_rewrites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    target_file     TEXT NOT NULL,
    rewrite_kind    TEXT NOT NULL,         -- 'wiki_link' | 'tag' | 'block_ref'
    old_token       TEXT NOT NULL,
    new_token       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    rename_op_id    INTEGER NOT NULL
);
CREATE INDEX idx_pending_target ON pending_rewrites(target_file);
CREATE INDEX idx_pending_op     ON pending_rewrites(rename_op_id);
```

`HIGHEST_KNOWN_VERSION` in `runner.rs` tests bumps to `6`. The existing `fresh_db_applies_all_known_migrations` test extends to assert the new table + two indexes; one new test (`v6_applies_on_top_of_existing_v5_database`) seeds a `v5` database and verifies the migration applies cleanly.

### Query module `cubical-index::pending`

Mirrors `cubical-index::blocks`. Public surface:

```rust
pub struct PendingRewriteRow {
    pub id: i64,
    pub target_file: String,
    pub rewrite_kind: RewriteKind,        // enum: WikiLink | Tag | BlockRef
    pub old_token: String,
    pub new_token: String,
    pub created_at: i64,
    pub rename_op_id: i64,
}

pub enum RewriteKind { WikiLink, Tag, BlockRef }

pub async fn enqueue_pending(
    conn: &Connection,
    rows: &[NewPendingRewrite],
) -> Result<(), IndexError>;

pub async fn pending_for_target(
    conn: &Connection,
    target_file: &str,
) -> Result<Vec<PendingRewriteRow>, IndexError>;   // ORDER BY created_at, id

pub async fn pending_targets(
    conn: &Connection,
) -> Result<Vec<String>, IndexError>;              // DISTINCT target_file

pub async fn pending_count_total(conn: &Connection) -> Result<i64, IndexError>;
pub async fn pending_count_for_target(conn: &Connection, t: &str) -> Result<i64, IndexError>;

pub async fn pending_count_breakdown(
    conn: &Connection,
) -> Result<Vec<(String, i64)>, IndexError>;       // target_file, count DESC

pub async fn delete_rename_op(
    conn: &Connection,
    rename_op_id: i64,
) -> Result<u64, IndexError>;

pub async fn delete_pending_for_target(
    conn: &Connection,
    target_file: &str,
) -> Result<u64, IndexError>;

pub async fn list_recent_rename_ops(
    conn: &Connection,
    limit: i64,
) -> Result<Vec<RenameOpRow>, IndexError>;  // (rename_op_id, row_count, kind, created_at_min)
```

Unit tests: round-trip (enqueue+list), order is `created_at` then `id`, delete-by-op removes only matching rows, delete-by-target removes only matching target, count-by-target is correct, count-breakdown is DESC by count.

### Pure materializer `cubical-core::vault::pending`

A new module sibling to `vault::mentions`. Three public items.

```rust
pub struct PendingRewrite {
    pub kind: RewriteKind,
    pub old_token: String,
    pub new_token: String,
}

pub fn apply_pending(source: &str, rewrites: &[PendingRewrite]) -> String;
pub async fn materialize_on_read(
    idx: &IndexConn,
    path: &str,
    on_disk: &str,
) -> Result<String, IndexError>;
```

`apply_pending` walks `rewrites` in slice order (caller passes them in `created_at` order). For each rewrite, dispatch by kind:

- **`WikiLink`** — `old_token` and `new_token` are bare target paths (vault-relative, no `[[` / `|display` / `#anchor`). Walk the source via `cubical_ast::wikilink::scan_wikilinks`; for each `WikiLinkToken` whose `target` matches `old_token` (case-sensitive — wiki-link resolution is case-aware in the lower layers' on-disk form even though the *resolver* normalizes), rewrite only the `target` field and re-emit the token with its original `embed` (`!`-prefix), `|display`, and `#anchor` parts preserved. Plain text between tokens passes through unchanged. Implementation: rebuild the string by walking `TokenizedRun`s and reformatting `WikiLink` tokens that hit.
- **`Tag`** — `old_token` and `new_token` are tag paths without the leading `#` (e.g. `"work/active"`). Two passes:
  1. **Inline body.** Walk the source line-by-line, skip frontmatter lines + fenced code blocks (` ``` ` / `~~~`), then for each remaining line find `#<tag>` occurrences with the same boundary rules used by L3 Session D's `extract_tags` (start = line-start or whitespace; end = `!is_alphanumeric() && != '_' && != '-' && != '/'`). For each hit: if the tag text equals `old_token` rewrite to `new_token`; otherwise if it starts with `old_token + "/"` rewrite the prefix and keep the suffix (nested rename). Hits inside inline code spans are excluded the same way Session D excludes them (`vault::tags::extract_tags` is the canonical reference).
  2. **Frontmatter `tags:` list.** Parse the frontmatter block via the existing YAML loader (`cubical-core::vault::frontmatter`); rewrite each string entry that equals `old_token` or starts with `old_token + "/"`. Re-emit the frontmatter block. Non-string entries (rare; would be a malformed `tags:` list) pass through untouched.
- **`BlockRef`** — `old_token` and `new_token` are bare block ids without `^` (e.g. `"intro"`). Two patterns:
  1. **Referrer pattern:** `[[X#^old_id]]` / `[[X#^old_id|display]]` / `![[…]]`. Walk via `scan_wikilinks`; rewrite the `Anchor::Block { value }` when `value == old_token`.
  2. **Defining line pattern:** `^old_id` at the end of a line in the *defining* file. Walk line-by-line; on a line whose trailing token (after stripping trailing whitespace) is `^old_id` and `old_id` matches an allowed-block-id charset (Unicode letters / digits / `_` / `-`), rewrite that token to `^new_id`. The enqueue side (`rename_block_id`) is responsible for enqueuing a `BlockRef` row against both the *referrer* files (for pattern 1) AND the *defining* file (for pattern 2); the materializer treats both patterns uniformly by always trying both substitutions per row, which is safe because the defining-line pattern can only match in the defining file's source.

`materialize_on_read` queries `pending_for_target(conn, path)`; if empty, returns the input unchanged (no allocation in the common case — `Cow<'_, str>` could shave allocs but isn't worth the wire complexity for L3). Otherwise builds a `Vec<PendingRewrite>` and calls `apply_pending`.

**Unit tests** (in `vault::pending`):
- Wiki-link: bare, `|display`, `#heading`, `#^id`, `![[…]]`, multiple occurrences in one line, no false positive on a similarly-prefixed target.
- Tag: exact match, nested `#parent/child` rewrites prefix, false positive on `#parent2` does NOT match (boundary check), exclusion inside ` ```fence``` `, frontmatter `tags:` list entries (string + nested), code-block exclusion regression.
- Block-ref: referrer `[[note#^id]]`, referrer with display, defining-line `^id` rewrite (only triggers when defining file is the target).
- Composed: two rewrites in order — first a tag rewrite, then a wiki-link rewrite — applied sequentially; verify ordering semantics.
- Empty rewrites → input returned unchanged.
- Multi-byte source (Unicode) — byte indexing is correct.

### Read-path integration (materialize-on-read invariant)

Every IPC that returns "effective file content" wraps its on-disk read with `materialize_on_read`. **Decision:** the invariant is "every consumer that the user could observe disagreeing with the editor materializes; raw bytes are only used for hashing." Concretely:

- `commands::vault::read_file_text` — MUST materialize. (Editor view.)
- `commands::vault::get_canonical_ast` (if it reads a file at the IPC boundary) — MUST materialize. (Indexer / AST consumers agree with the editor.)
- `commands::embeds::get_embed` — MUST materialize. (Embed bodies reflect renames.)
- `commands::mentions::get_unlinked_mentions` — source files: MUST materialize. (Materialized text is what the user sees; an unlinked-mention scan over stale text would offer to link wrong spans.)
- `commands::mentions::link_mention` — MUST materialize before computing the splice, then write the post-splice content as a new on-disk version *and* drop any pending rows for that file (the splice is atomic; pending rewrites for that file are now baked in). Detail: easier to flush the file's pending rows first, then re-read the now-up-to-date disk content, then splice. Either is correct; the spec leans flush-first because it avoids the "splice into materialized but write non-materialized" trap.
- **Scan** (`cubical-core::vault::scan` bulk + watcher path) — MUST materialize before passing to the link/tag/block extractors. Otherwise backlinks reflect the *old* tokens until flush. The shared-parse refactor for §5.5 is deferred to L5 regardless; this change adds one indexed query per file-scan iteration on top of the existing four reads.
- **Watcher `content_hash` recomputation** (`apply_watch_event_to_db`'s hash pass) — reads raw bytes, NOT materialized. The hash represents the *on-disk* state, which is what the watcher's purpose is to track.
- **Raw-source toggle** (`raw_source_visibility` editor compartment from L2) — does not change. The toggle reveals the editor's *current buffer*; `read_file_text` is upstream of that and already materialized.

Implementation: each of the above call sites adds a `let content = materialize_on_read(idx, path, &on_disk).await?` between the read and the next consumer. Tests for each handler add a "materializes pending rewrites" case: seed a `pending_rewrites` row, observe the IPC returns the post-rewrite content.

### Rename IPCs — `cubical-app::commands::rename` (new module)

Three handlers + a shared `mint_rename_op_id` helper that reads `config['pending_rewrites.next_rename_op_id']`, increments it, writes it back, all inside a single transaction. First call defaults the counter to 1.

Each handler runs inside a single transaction: query referrers, enqueue pending rows, (for `rename_file`) move the file on disk + update `files.path`, commit. Then emits `vault:pending-rewrites-changed { vault_id, count }` with the new total count.

```rust
// rename_file
pub struct RenameFileRequest  { vault_id, from_path, to_path }
pub struct RenameFileResponse { rename_op_id: i64 }

pub async fn rename_file(state: &AppState, req: RenameFileRequest)
    -> Result<RenameFileResponse, CubicalError>
{
    // 1. Resolve vault; reject if from_path == to_path, if to_path already exists,
    //    or if from_path isn't a known markdown file.
    // 2. Inside a single transaction:
    //    a. SELECT DISTINCT source_path, target_raw FROM links WHERE target_path = ?from_path.
    //       (Distinct on the pair — a single source file can carry multiple referrer forms,
    //        e.g. `[[Daily]]` + `[[notes/Daily]]`. See "Wiki-link old_token derivation" below.)
    //    b. Mint rename_op_id via mint_rename_op_id().
    //    c. For each (source_path, target_raw) build a (kind=WikiLink, old_token, new_token,
    //       target_file=source_path, rename_op_id, created_at=unix_now). Bulk insert.
    //    d. Atomically move the file on disk: fs::rename (same-FS fast path) with an
    //       atomic_write + remove fallback for cross-FS edge cases.
    //    e. UPDATE files SET path = ?to_path WHERE path = ?from_path. Existing FKs are
    //       ON DELETE CASCADE; add ON UPDATE CASCADE where missing so links/tags/blocks
    //       rows rekey under the new path automatically. (Verified during implementation;
    //       if any cascade is missing, the migration that needs the change ships as 007.)
    //    f. Re-extract the moved file's outbound links/tags/blocks under the new path.
    //    g. Commit.
    // 3. Emit vault:pending-rewrites-changed { count }.
    // 4. The watcher fires a Renamed event for the same move; its dispatcher is a no-op
    //    when files.path already reflects the move (idempotent UPDATE). If a race surfaces
    //    during implementation, the backend own-write hash gate is extended to suppress it.
}
```

**Wiki-link `old_token` / `new_token` derivation — locked decision.** Use `links.target_raw` (the as-written form, post-anchor/display strip) for each distinct `(source_path, target_raw)` row whose `target_path = from_path`. This means: if `A.md` has `[[Daily]]` and `B.md` has `[[notes/Daily]]`, both resolving to `notes/Daily.md`, the enqueue produces two distinct pending rows — one with `old_token = "Daily"`, one with `old_token = "notes/Daily"` — and the materializer's wiki-link walker matches them respectively. `new_token` is derived from `to_path` symmetrically: strip the `.md` suffix; if the source wrote a basename, the new token is the new basename; if the source wrote a path, the new token is the new path with the same directory layout. Concretely: when `target_raw == basename(from_path).strip_suffix(".md")`, `new_token = basename(to_path).strip_suffix(".md")`; otherwise `new_token = to_path.strip_suffix(".md")`. Tested with a basename + path-form fixture.

```rust
// rename_tag
pub struct RenameTagRequest  { vault_id, old_tag, new_tag }
// → fresh rename_op_id; enqueue one Tag row per DISTINCT file_path in tags where
//   tag_path = old_tag OR tag_path LIKE old_tag || '/%'.
//   old_token = old_tag, new_token = new_tag (without leading #; materializer applies
//   per-line + frontmatter).

// rename_block_id
pub struct RenameBlockIdRequest { vault_id, file_path, old_id, new_id }
// → fresh rename_op_id;
//   (a) enqueue one BlockRef row per DISTINCT source_file_path in block_refs
//       where (target_file_path, target_block_id) = (file_path, old_id).
//       old_token = old_id, new_token = new_id, target_file = source_file_path.
//   (b) enqueue ONE extra BlockRef row targeting file_path itself
//       (so the defining line gets the ^old → ^new rewrite on materialize/flush).
```

All three handlers, after commit, emit `vault:pending-rewrites-changed { vault_id, count: pending_count_total(...) }`.

**Tests:** for each handler — happy path, no-op when there are no referrers (still mints op_id, count still increments only by the defining-line row for block-id; for tag/file with zero referrers, no rows enqueued and op_id is not minted), rejection of `from == to`, vault-not-open, FK-cascade survival (links rows still resolve through the new path after `files.path` update).

### Flush + helpers

```rust
pub struct FlushPendingRewritesResponse {
    pub files_rewritten: i64,
    pub refs_updated: i64,
}

pub async fn flush_pending_rewrites(state, req) -> Result<FlushPendingRewritesResponse, _>;

pub async fn flush_pending_rewrites_for_target(
    state, vault_id, target_file: &str,
) -> Result<FlushPendingRewritesResponse, _>;    // used by the >50 fuse + link_mention precondition

pub struct GetPendingRewritesCountResponse { pub count: i64 }
pub async fn get_pending_rewrites_count(state, req) -> Result<..., _>;

pub struct PendingRewriteBreakdownRow { target_file: String, count: i64 }
pub struct GetPendingRewritesBreakdownResponse { rows: Vec<PendingRewriteBreakdownRow> }
pub async fn get_pending_rewrites_breakdown(state, req) -> Result<..., _>;

pub struct RecentRenameOp {
    rename_op_id: i64,
    kind: RewriteKind,    // representative kind from the group
    row_count: i64,
    created_at: i64,
}
pub struct ListRecentRenameOpsResponse { ops: Vec<RecentRenameOp> }
pub async fn list_recent_rename_ops(state, req) -> Result<..., _>;   // J.2 consumes; lands in J.1 for testability

pub struct UndoRenameRequest { vault_id, rename_op_id: i64 }
pub async fn undo_rename(state, req) -> Result<(), _>;
```

**Flush algorithm.** For each distinct `target_file` from `pending_targets`:

1. Read on-disk content fresh.
2. Pull pending rows for that file (ORDER BY `created_at, id`).
3. Apply each rewrite textually. For wiki-link / block-ref rewrites the substitution piggybacks on `apply_pending` walking `scan_wikilinks`. For tag rewrites, ditto.
4. **External-write re-apply per §5.7:** the textual substitution naturally has the "find old → replace" semantic baked in. If a rewrite's `old_token` no longer appears in the freshly-read disk content, the substitution is a no-op and the row is dropped silently on commit. No special branch needed; the test for this asserts that a row whose `old_token` was externally removed simply doesn't contribute to `refs_updated`.
5. Before writing, compute the new content's hash and **insert `(path, hash)` into the per-vault `OwnWriteHashGate`** (see below). Atomic-write the new content. Update `files.content_hash` eagerly (best-effort, matching `link_mention`'s pattern).
6. Count `refs_updated` as the sum of per-row "did substitution apply" booleans; `files_rewritten` as the count of files whose content actually changed.
7. Delete every pending row for that `target_file`.
8. Emit `vault:flush-complete { vault_id, files_rewritten, refs_updated }` once at the end.
9. Emit `vault:pending-rewrites-changed { vault_id, count: 0 }` at the end (or to the residual non-zero count if a concurrent rename slipped in).

If reading a target file fails (file deleted externally between enqueue and flush), drop that file's pending rows silently and continue.

The whole flush is wrapped in a single `Mutex<()>` per-vault `flush_in_progress` guard so concurrent timer + manual + close flushes don't interleave; second caller blocks behind the first.

**Backend own-write hash gate.** `Vault` (or a thin sidecar `FlushOwnWrites`) holds `Mutex<HashSet<(PathBuf, ContentHash)>>`. Flush inserts before write. Watcher dispatcher (`apply_watch_event_to_db`'s `Modified` path), before emitting `vault:file-changed`, checks the set: if `(path, fresh_disk_hash)` is present, *remove* it and skip the emit. This mirrors the editor-side mechanism but is owned by the backend so flush — which has no editor — doesn't get bounced through `vault:file-changed` → refresh → frontend `read_file_text` round-trips. Tests: flush a file → assert the watcher dispatcher receives a `Modified` event but does NOT propagate `vault:file-changed`; an unrelated external write to the same file produces the event normally.

### Flush triggers

1. **Periodic timer** — per-vault tokio task spawned at `open_vault` success; reads `pending_rewrites.flush_interval_secs` from `config` (default `300`); on each tick calls `flush_pending_rewrites`. Cancelled in `close_vault` via a `CancellationToken` held next to the vault state.
2. **App close** — `close_vault` calls `flush_pending_rewrites` synchronously before dropping the index handle. Failure to flush is logged but does not block close (better to lose pending rewrites than to block shutdown — they re-enqueue on next open if the index re-scan picks them up). Note: `close_vault` is an async IPC handler with a live runtime — the awaited flush call is straightforward. The plan verifies that no `Drop` path on the vault state holds a residual close-time obligation; if one exists it gets the `block_on(handle.spawn(flush))` adapter pattern.
3. **>50-per-file fuse** — `enqueue_pending` checks `pending_count_for_target(target)`; if the post-insert count would exceed 50, the enqueue commits + then calls `flush_pending_rewrites_for_target(target)` synchronously, then emits the count-changed event. Only the offending file flushes; the rest stays deferred. Spec §5.7: "exceeding 50" — interpreted as a hard ceiling.
4. **Manual** — `flush_pending_rewrites` IPC exposed; J.2's status-bar click-out triggers it.

### IPC registration

`crates/cubical-app/src/lib.rs` `generate_handler!` block gains seven entries:

- `rename_file`, `rename_tag`, `rename_block_id`
- `flush_pending_rewrites`
- `get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`
- `undo_rename`

Wire types in `crates/cubical-app/src/api/types.rs` (or `commands/rename.rs` and re-exported, matching recent precedent).

### J.1 frontend stub

`ui/src/api/ipc.ts` ships **typed bindings only**: `renameFile`, `renameTag`, `renameBlockId`, `flushPendingRewrites`, `getPendingRewritesCount`, `getPendingRewritesBreakdown`, `listRecentRenameOps`, `undoRename`, plus the two new listeners (`onVaultPendingRewritesChanged`, `onVaultFlushComplete`). `Setting` union adds `pending_rewrites.flush_interval_secs`. The bindings are exported but unused — `tsc` allows that.

### J.1 verification

- `cargo test --workspace` — 326 baseline + new (migration tests + `pending` query module + `apply_pending` per-kind + handler success/error/edge cases + flush incl. external-write re-apply + each trigger + undo + own-write gate). Expected delta: ~50 new tests.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`.
- `cd ui && npx tsc --noEmit && npm run build` — IPC binding stubs typecheck.
- Headless smoke recipe documented (J.1 has no UI to smoke; full hands-on lives in J.2).

---

## J.2 — Frontend

J.2's plan is written separately after J.1 merges. Scope locked here:

- **`ui/src/Toast.tsx`** — minimal single-slot toast (auto-dismiss 4s, dismissible). Tokenized via existing CSS variables. Used by J.2's flush-complete listener; also reusable by future error/save-success surfaces.
- **`ui/src/statusbar/pendingRewrites.ts`** — pure `formatPendingRewrites(count) -> string` (mirrors `formatBrokenBlockRefs`). Vitest coverage for `0 / 1 / >1`.
- **`ui/src/statusbar/PendingRewrites.tsx`** — clickable status-bar item; click opens a small dropdown with: total count, per-target breakdown (top N), "Save all pending changes" button, "Undo last rename" rows (last N rename ops via `listRecentRenameOps`).
- **File-rename UI gesture** — right-click on a file in the FileList → context menu → "Rename…" → inline rename input (Enter commits, Esc cancels). Other gestures (keyboard shortcut) deferred to K polish.
- **`ui/src/App.tsx` wiring** — `pendingRewritesCount` signal updated from `onVaultPendingRewritesChanged`; toast triggered from `onVaultFlushComplete`; drop count on `close_vault`; periodic-timer setting surfaced in the existing settings flow.
- **Vitest** — formatter, status-bar dropdown behaviour, toast lifecycle.
- **Smoke** — full §9.15 smoke recipe (see Verification at end of spec).

J.2 does NOT introduce: tabs, split-pane, a 3-way merge UI for conflicts, the post-flush undo (L8), or click-to-diff on the toast (L8 Time Machine — spec §5.7 references it but flags Time Machine).

---

## Decisions worth noting (all baked in)

- **J.1 / J.2 split** locked; mirrors H.1 / H.2. Each merges into `main` independently.
- **`rename_op_id` type:** monotonic `INTEGER` from `config['pending_rewrites.next_rename_op_id']`. Sortable, displayable, no UUID dep.
- **Wiki-link `old_token` derivation:** the as-written `links.target_raw` for each distinct `(source_path, target_raw)` referrer. New token derived symmetrically. Captures both basename-form and path-form referrers in one rename.
- **File-rename UI gesture:** right-click → "Rename…". Hotkey deferred.
- **Scan materializes** through the link/tag/block extractors. Backlinks agree with the editor pre-flush. One extra indexed query per file; benchmark in J.1 only if the 30k-file scan regresses past ~12 s (current ~10 s per §5.6).
- **Watcher own-write suppression for flush writes:** per-vault `HashSet<(PathBuf, ContentHash)>` populated by flush, drained by watcher dispatcher.
- **>50 fuse:** flush only the offending target_file synchronously; other files stay deferred.
- **Status-bar surfaces:** total count in the bar; breakdown + per-op undo in the click-out dropdown.
- **`read_file_text` materialize vs raw:** always materialize. The watcher's content-hash pass reads raw bytes separately.
- **`get_canonical_ast` materialize vs raw:** materialize.
- **`link_mention` flushes the source file's pending rows before splicing**, then re-reads disk. Avoids the "splice into materialized but write non-materialized" trap.
- **Toast UI:** new minimal component (`Toast.tsx`, ~50 LOC).
- **External-write conflict:** silent drop per §5.7 — the textual "find-old-then-replace" naturally yields this when `old_token` is absent.
- **Post-flush undo:** L8 (out of scope).
- **`vault:index-changed`:** still unbuilt; the new `vault:pending-rewrites-changed` + `vault:flush-complete` events are J's only additions to the event substrate.

---

## Out of scope (J)

- L3 closeout, `l3` tag, hands-on smoke of ALL L3 surfaces — Session K.
- Post-flush undo — L8 Time Machine.
- Diff-view modal on flush toast — L8.
- 3-way merge UI on external-write conflicts — L8.
- H.3 polish — rich markdown inside embed bodies, click navigation, `⎘` retirement.
- Cross-vault renames — `ui.md` §11.5 declares cross-vault project-wide out of scope.
- Plugin capability surface for materialized reads — plugins land in a later layer (spec §5.7 references it).
- Rename of headings or arbitrary text — only file / tag / block-id are first-class rename targets.
- Keyboard-shortcut rename gesture — deferred to K polish.

---

## Verification (J as a whole)

`cargo test --workspace`, `cargo clippy`, `cargo fmt`, `tsc`, `npm run build`, `vitest`.

**Interactive smoke vault** (J.2, against `cargo tauri dev`):

```
Daily.md
---
tags: [planning, work/active]
---
Today's daily.

Project.md
See [[Daily]] for context. Also tagged #planning and #work/active.

Notes.md
Another reference to [[Daily]] and the #work/active tag.

Pinned.md
body ^anchor

Refs.md
See [[Pinned#^anchor]] for the pinned bit.
```

Cases (J.2 records evidence per case):
- **File rename:** `Daily.md` → `Journal.md` via right-click; disk shows old `[[Daily]]` but editor view shows `[[Journal]]` (materialized); status bar shows "2 pending changes"; click "Save all pending" → toast "Applied 2 reference updates across 2 files."; `cat Project.md` shows `[[Journal]]`.
- **Tag rename:** `#planning` → `#scheduling`. Status bar +1; editor materializes; flush updates disk.
- **Nested tag rename:** `#work` → `#projects`. `#work/active` becomes `#projects/active` in both Project.md and Notes.md.
- **Block-id rename:** `^anchor` in Pinned.md → `^pinned`. Pinned.md's defining line updates; Refs.md's `[[Pinned#^anchor]]` becomes `[[Pinned#^pinned]]`; both materialize in the editor; both flushed on click.
- **Undo before flush:** rename, see "+1 pending", click Undo in the status-bar dropdown; count returns to 0; referrer shows the old token.
- **External-write conflict:** rename Daily → Journal; in Finder/vim remove the `[[Daily]]` line from Project.md; flush; the row drops silently (no error toast).
- **>50 fuse:** synthesize a file with 51 `[[Daily]]` occurrences; rename Daily; that one file flushes immediately; others stay pending.
- **5-min timer:** set `pending_rewrites.flush_interval_secs = 5`; enqueue a rename; wait 6s; observe flush fires automatically (toast appears, status bar → 0).
- **App-close mandatory flush:** enqueue a rename; close the vault; reopen; verify disk reflects the rewrite + audit log row.

If a case can't be verified hands-on (auto context can't drive Tauri), document the deferred smoke per Session I's protocol.
