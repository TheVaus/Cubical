> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session G — Block References (backend core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add block references to the backend — lazily mint a `^block-id` into a target file's markdown when a reference is created, index block ids + block refs, resolve `[[note#^id]]` through that index, and expose broken block refs for surfacing — with no bulk auto-assignment.

**Architecture:** A new `005_blocks` migration adds the locked `blocks` + `block_refs` tables. A pure source scanner extracts `^id` tokens (fence-aware) from markdown; `blocks` rows are refreshed **inline in scan Pass 1** and on every watcher edit (per-file, no resolution needed, exactly like tags). `block_refs` are **derived in scan Pass 2** (and on the watcher path) from the already-resolved block-anchored rows in the `links` table via one shared `refresh_block_refs_for_file` helper. A `create_block_ref` command mints a deterministic, file-unique `^id` into the target source and persists the `blocks` row. A `get_broken_block_refs` query surfaces refs whose target block no longer exists. `resolve_link` is unchanged — block resolution is represented by the `block_refs`/`blocks` tables.

**Tech Stack:** Rust, `libsql` (local SQLite), `sha2` (already a dep; used for deterministic id generation), `tokio` (`spawn_blocking` for file I/O), existing `cubical-index` / `cubical-core` / `cubical-app` patterns. **No frontend in this plan** (backend core only — the editor gesture, `^id` decoration, and status-bar surfacing are a deferred follow-up; one TS IPC binding is added so the new commands are callable).

---

## Background — read before touching code

You have no prior context. Read this, then the referenced files, before starting.

### What a block reference is (spec §2.7 + `docs/architecture/document-model.md` §5.3)

A **block id** is a slug `^my-id` appended to a paragraph or list item in the markdown source. It is **lazily assigned**: an id is minted *only* when a reference to that block is created — never bulk auto-assigned. The literal `^id` lives in the source as text. A **block reference** is a wiki-link with a block anchor, `[[note#^my-id]]`. Allowed id chars: letters/digits/`_`/`-`, must start with a letter or underscore. Scope is per file: `(file_path, block_id)` is unique within a file.

The locked schema (this session introduces it):
```sql
blocks(file_path, block_id, position_hint, last_modified)
block_refs(source_file_path, target_file_path, target_block_id)
```
`[[note#^id]]` resolves through these. Broken block refs (target paragraph or id deleted) surface alongside broken wiki-links in the vault-health status-bar item.

### What already exists (the patterns you mirror)

- **Wiki-link anchors are already parsed.** `cubical_ast::Anchor::Block { value }` is produced from `[[note#^id]]` (see `crates/cubical-ast/src/wikilink.rs::parse_body`). The `links` table already stores `anchor_kind='block'` + `anchor_value` per occurrence (see `crates/cubical-index/migrations/003_links.sql` and `crates/cubical-core/src/vault/links.rs::refresh_links`). **So block *references* are already captured in `links`.** This session adds the `blocks` (definitions) + `block_refs` (a derived, queryable projection of the resolved block-anchored links) tables.
- **Migrations** live in `crates/cubical-index/migrations/NNN_*.sql`, registered in `crates/cubical-index/src/migrations.rs::MIGRATIONS`, with `runner.rs::HIGHEST_KNOWN_VERSION` and a `fresh_db_applies_all_known_migrations` test. The latest is `004_tags.sql` (version 4). Read `003_links.sql` + `004_tags.sql` for SQL style (FK `ON DELETE CASCADE` on `files(path)`, indexes).
- **Index query modules** live in `crates/cubical-index/src/{links,tags}.rs` as `pub async fn …(conn: &IndexConn, …) -> Result<…, IndexError>`, re-exported from `crates/cubical-index/src/lib.rs`. `tags.rs::replace_tags_for_file` (delete-then-insert, participates in the caller's transaction) is the model for `replace_blocks_for_file`.
- **Per-file refresh helpers** live in `crates/cubical-core/src/vault/{links,tags,frontmatter}.rs` as `pub async fn refresh_X(vault: &Vault, abs_path: &Path, rel_path_str: &str) -> Result<…, libsql::Error>`, re-exported from `crates/cubical-core/src/lib.rs` line ~20 (`pub use vault::{ atomic_write, refresh_frontmatter, refresh_links, refresh_tags, scan, start_watcher, … }`). `links.rs::refresh_links` (parse off-executor → extract → resolve → `replace_links_for_file`) is the model; `links.rs::parse_off_executor` reads the file off the runtime.
- **The scan** is `crates/cubical-core/src/vault/scan.rs::scan`. Pass 1 (the walk) upserts `files` and calls `refresh_frontmatter` + buffers link extractions + `refresh_tags` **inline** per markdown file (lines ~225–238). Pass 2 (after the walk) builds a `PathResolver`, resolves the buffered links, and writes `links` rows per source via `replace_links_for_file` in batched transactions (loop at line ~284, each source written at line ~309, final commit at line ~319).
- **The watcher single-file path** is `crates/cubical-app/src/events.rs::apply_watch_event_to_db` (lines ~320–393): on a create/modify it calls `refresh_frontmatter`, `refresh_links`, `refresh_tags` for the one changed file.
- **Command handlers** are pure `pub async fn name(state: &AppState, req) -> Result<Resp, CubicalError>` in `crates/cubical-app/src/commands/*.rs`, with wire types in `api/types.rs`, 3-line Tauri shims in `lib.rs` registered in `generate_handler!`. `commands::links::resolve_link` and `commands::tags::query_tag_page` are models. The vault is fetched via `state.vaults().read().await.get(&req.vault_id).ok_or_else(|| CubicalError::VaultNotOpen(...))?`; the index connection is `open.vault.index()` (an `&IndexConn`) and `.index().connection()` for raw `libsql` queries.
- **Frontend IPC** is centralized in `ui/src/api/ipc.ts` (typed wire structs + one `invoke("name", { req })` wrapper per command). `query_tag_page` is the model.

### Scope boundaries — do NOT do these

- **No frontend feature work.** No editor "create block ref" gesture, no `^id` decoration, no status-bar component. The chosen scope is backend core. The only TS change is adding IPC bindings in `ipc.ts` so the new commands are callable (Task 8). The full surfacing UI is a follow-up.
- **Do NOT change `resolve_link`'s response shape.** It already echoes the parsed `Block` anchor. Block resolution is represented by the `block_refs`/`blocks` tables + the `get_broken_block_refs` query — no ripple into the frontend resolver.
- **Do NOT bulk auto-assign ids.** Ids are minted *only* by `create_block_ref`. The scanner only *reads* ids that already exist in source.
- **Do NOT change wiki-link / tag / frontmatter extraction.** Block-id extraction is a separate, additive source scan.
- **Do NOT touch the `links` table schema** — block refs are derived from it, not stored in it differently.
- **No new external crate deps.** Use `sha2` (already used by the scan's content-hash path) for deterministic id generation.

### Block-id grammar (used by both the scanner and the minter — keep them identical)

A block id is `^` followed by `[A-Za-z_][A-Za-z0-9_-]*`. In source it appears at the **end of a line** (after trimming trailing whitespace), either preceded by whitespace (`some text ^id`) or as the whole trimmed line (`^id`). The scanner ignores `^id` inside fenced code blocks (``` ``` ``` / `~~~`). This matches what `create_block_ref` writes (it appends ` ^id` to a line's end) and what `Anchor::Block` resolution expects (an arbitrary trimmed value — our generated ids are a strict subset).

---

## File Structure

**Create:**
- `crates/cubical-index/migrations/005_blocks.sql` — `blocks` + `block_refs` tables + indexes.
- `crates/cubical-index/src/blocks.rs` — `BlockRow` / `BlockRefRow` + `replace_blocks_for_file`, `blocks_for_file`, `block_exists`, `replace_block_refs_for_file`, `broken_block_refs` + tests.
- `crates/cubical-core/src/vault/blocks.rs` — pure `extract_block_ids` scanner + `refresh_blocks` + `refresh_block_refs_for_file` + tests.
- `crates/cubical-app/src/commands/blocks.rs` — `create_block_ref` + `get_broken_block_refs` handlers + tests.

**Modify:**
- `crates/cubical-index/src/migrations.rs` — register migration 005 + a `migration_005_creates_blocks_tables` test.
- `crates/cubical-index/src/runner.rs` — bump `HIGHEST_KNOWN_VERSION` to 5.
- `crates/cubical-index/src/lib.rs` — `mod blocks;` + re-exports.
- `crates/cubical-core/src/vault/mod.rs` — `pub mod blocks;` (mirror how `links`/`tags` are declared — confirm the real module-declaration site).
- `crates/cubical-core/src/lib.rs` — re-export `refresh_blocks`, `refresh_block_refs_for_file`.
- `crates/cubical-core/src/vault/scan.rs` — Pass 1 inline `refresh_blocks`; Pass 2 `refresh_block_refs_for_file` per source.
- `crates/cubical-app/src/events.rs` — watcher: `refresh_blocks` + `refresh_block_refs_for_file` for the changed file.
- `crates/cubical-app/src/api/types.rs` — `CreateBlockRef*`, `GetBrokenBlockRefs*`, `BrokenBlockRef` wire types.
- `crates/cubical-app/src/commands/mod.rs` — `pub mod blocks;`.
- `crates/cubical-app/src/lib.rs` — two shims + registration + type imports.
- `ui/src/api/ipc.ts` — bindings for the two new commands.

---

### Task 1: Migration 005 — `blocks` + `block_refs` tables

**Files:**
- Create: `crates/cubical-index/migrations/005_blocks.sql`
- Modify: `crates/cubical-index/src/migrations.rs`
- Modify: `crates/cubical-index/src/runner.rs`

- [ ] **Step 1: Write the migration SQL**

Create `crates/cubical-index/migrations/005_blocks.sql`:

```sql
-- Layer 3 block references. See docs/architecture/document-model.md §5.3
-- and docs/layer-3-spec.md §2.7.
--
-- `blocks`: one row per `^block-id` token found in a file's source.
-- `position_hint` is the byte offset of the start of the line carrying
-- the id (for ordering / locating); `last_modified` is a unix seconds
-- stamp written at refresh time. `(file_path, block_id)` is unique per
-- the per-file scope rule.
--
-- `block_refs`: one row per RESOLVED block-anchored wiki-link
-- (`[[target#^id]]`). Derived from the `links` table during scan Pass 2
-- and on watcher edits. A ref is "broken" when no `blocks` row matches
-- (target_file_path, target_block_id) — computed at query time, not
-- stored.
--
-- ON DELETE CASCADE on the source/owning file path means a future
-- `DELETE FROM files` (pending-rewrites territory, Session J) cleans up.

CREATE TABLE blocks (
    file_path     TEXT NOT NULL,
    block_id      TEXT NOT NULL,
    position_hint INTEGER NOT NULL,
    last_modified INTEGER NOT NULL,
    PRIMARY KEY (file_path, block_id),
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE block_refs (
    source_file_path TEXT NOT NULL,
    target_file_path TEXT NOT NULL,
    target_block_id  TEXT NOT NULL,
    FOREIGN KEY (source_file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX idx_blocks_lookup ON blocks(file_path, block_id);
CREATE INDEX idx_block_refs_source ON block_refs(source_file_path);
CREATE INDEX idx_block_refs_target ON block_refs(target_file_path, target_block_id);
```

- [ ] **Step 2: Write the failing migration test**

Add to the `#[cfg(test)] mod tests` in `crates/cubical-index/src/migrations.rs` (mirror `migration_004_creates_tags_table`):

```rust
#[test]
fn migration_005_creates_blocks_tables() {
    let m = MIGRATIONS
        .iter()
        .find(|m| m.version == 5)
        .expect("005 migration must be registered");
    let sql = m.up;
    assert!(sql.contains("CREATE TABLE blocks"), "must create blocks table");
    assert!(sql.contains("CREATE TABLE block_refs"), "must create block_refs table");
    assert!(sql.contains("position_hint"));
    assert!(sql.contains("target_block_id"));
    assert!(sql.contains("idx_block_refs_target"));
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p cubical-index migrations::tests::migration_005 -- --nocapture`
Expected: FAIL — the `005` migration isn't registered yet (`expect` panics).

- [ ] **Step 4: Register the migration + bump the version**

In `crates/cubical-index/src/migrations.rs`, append to the `MIGRATIONS` array (after the version-4 entry):

```rust
    Migration {
        version: 5,
        up: include_str!("../migrations/005_blocks.sql"),
    },
```

In `crates/cubical-index/src/runner.rs`, change `const HIGHEST_KNOWN_VERSION: i64 = 4;` to `= 5;`.

- [ ] **Step 5: Run the migration + runner tests to verify they pass**

Run: `cargo test -p cubical-index migrations:: runner::tests::fresh_db_applies_all_known_migrations -- --nocapture`
Expected: PASS — `migration_005_creates_blocks_tables`, `migrations_are_in_strict_ascending_order`, and the fresh-db test (now asserting `schema_version == 5`) all green.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-index/migrations/005_blocks.sql crates/cubical-index/src/migrations.rs crates/cubical-index/src/runner.rs
git commit -m "feat(index): migration 005 — blocks + block_refs tables"
```

---

### Task 2: Block-id source scanner (pure)

**Files:**
- Create: `crates/cubical-core/src/vault/blocks.rs`
- Modify: `crates/cubical-core/src/vault/mod.rs` (declare the module)

- [ ] **Step 1: Declare the module**

In `crates/cubical-core/src/vault/mod.rs`, add `pub mod blocks;` next to the existing `pub mod links;` / `pub mod tags;` declarations (read the file to match the exact style/ordering).

- [ ] **Step 2: Write the failing scanner tests**

Create `crates/cubical-core/src/vault/blocks.rs` with the scanner's tests first (plus the public type, so it compiles to a failing assertion rather than a missing-symbol error):

```rust
//! Block-id source scanning + per-file index refresh (L3 Session G,
//! spec §2.7). A block id is `^id` (`^` + `[A-Za-z_][A-Za-z0-9_-]*`) at
//! the end of a source line, ignored inside fenced code. Ids are read
//! here but only ever *minted* by `create_block_ref` — never bulk
//! auto-assigned (spec §2.7 / document-model §5.3).

use std::path::Path;

use cubical_index::{replace_block_refs_for_file, replace_blocks_for_file, BlockRefRow, BlockRow};

use crate::vault::Vault;

/// One `^block-id` occurrence found in a file's source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockIdOccurrence {
    /// The id without the leading `^`.
    pub block_id: String,
    /// Byte offset of the start of the line carrying the id.
    pub position: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_trailing_block_id() {
        let src = "A paragraph line. ^intro\n\nnext para\n";
        let got = extract_block_ids(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].block_id, "intro");
        assert_eq!(got[0].position, 0);
    }

    #[test]
    fn extracts_id_on_its_own_line_with_position() {
        // Line 0 is "para" (5 bytes incl. \n), line 1 is "^solo".
        let src = "para\n^solo\n";
        let got = extract_block_ids(src);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].block_id, "solo");
        assert_eq!(got[0].position, 5);
    }

    #[test]
    fn ignores_block_ids_inside_fenced_code() {
        let src = "```\nlet x = 1; ^notanid\n```\n\nreal ^yes\n";
        let got = extract_block_ids(src);
        let ids: Vec<&str> = got.iter().map(|o| o.block_id.as_str()).collect();
        assert_eq!(ids, vec!["yes"]);
    }

    #[test]
    fn rejects_mid_line_and_invalid_starts() {
        // `^id` not at end of line → not a block id.
        assert!(extract_block_ids("text ^mid more\n").is_empty());
        // Caret followed by a digit-start → invalid (must start letter/_).
        assert!(extract_block_ids("text ^1bad\n").is_empty());
        // Bare caret → nothing.
        assert!(extract_block_ids("text ^\n").is_empty());
    }

    #[test]
    fn empty_source_returns_empty() {
        assert!(extract_block_ids("").is_empty());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p cubical-core vault::blocks::tests -- --nocapture`
Expected: FAIL to compile — `extract_block_ids` does not exist (and the `cubical_index` block imports don't exist yet either; if compilation blocks on those imports, temporarily stub them — but Task 3 adds them, so prefer to implement Task 2's `extract_block_ids` body now and leave the `refresh_*` functions, which need Task 3's types, for Task 4. To keep Task 2 self-contained, **drop the `use cubical_index::...` line and the `Vault` import in this task** and add them in Task 4 when `refresh_blocks` lands.)

> Practical note: implement ONLY `extract_block_ids` + `BlockIdOccurrence` + the tests in this task. Remove the `cubical_index` / `Vault` imports for now (they belong to Task 4). This keeps the crate compiling.

- [ ] **Step 4: Implement the scanner**

Replace the imports at the top of `blocks.rs` with just what the scanner needs, and add `extract_block_ids` above the `tests` module:

```rust
//! (keep the module doc-comment from Step 2)

/// One `^block-id` occurrence found in a file's source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockIdOccurrence {
    /// The id without the leading `^`.
    pub block_id: String,
    /// Byte offset of the start of the line carrying the id.
    pub position: u64,
}

/// Scan markdown `source` for `^block-id` tokens at line ends, skipping
/// fenced code blocks. Returns occurrences in source order. Pure.
pub fn extract_block_ids(source: &str) -> Vec<BlockIdOccurrence> {
    let mut out = Vec::new();
    let mut offset: u64 = 0;
    let mut in_fence = false;
    let mut fence_marker = "";
    for line in source.split_inclusive('\n') {
        let trimmed_end = line.trim_end_matches(['\n', '\r']);
        let trimmed = trimmed_end.trim();
        // Track fenced code so ids inside it don't count.
        if !in_fence && (trimmed.starts_with("```") || trimmed.starts_with("~~~")) {
            in_fence = true;
            fence_marker = if trimmed.starts_with("```") { "```" } else { "~~~" };
        } else if in_fence && trimmed.starts_with(fence_marker) {
            in_fence = false;
        } else if !in_fence {
            if let Some(id) = block_id_at_line_end(trimmed_end) {
                out.push(BlockIdOccurrence {
                    block_id: id,
                    position: offset,
                });
            }
        }
        offset += line.len() as u64;
    }
    out
}

/// If `line` (trailing newline already stripped) ends with a block id
/// token (`^id` either preceded by whitespace or as the whole trimmed
/// line), return the id without the `^`. Otherwise `None`.
fn block_id_at_line_end(line: &str) -> Option<String> {
    let line = line.trim_end();
    let caret = line.rfind('^')?;
    let id = &line[caret + 1..];
    // The `^` must start the (trimmed) line or follow whitespace.
    let before_ok = caret == 0
        || line[..caret]
            .chars()
            .next_back()
            .is_some_and(char::is_whitespace);
    if !before_ok {
        return None;
    }
    if !is_valid_block_id(id) {
        return None;
    }
    Some(id.to_string())
}

/// `[A-Za-z_][A-Za-z0-9_-]*` — must start letter/underscore.
fn is_valid_block_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}
```

> Note on `block_id_at_line_end`: the `line[..caret].chars().next_back()` check ensures `text ^mid more` does NOT match (the `^` is followed by `mid more`, and `rfind('^')` finds that single `^`, but `is_valid_block_id("mid more")` fails on the space). And `issue#42`-style content is irrelevant (no `^`). Confirm the `rejects_mid_line_and_invalid_starts` test passes — `"text ^mid more"` → id candidate is `"mid more"` → invalid (space) → `None`. Good.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-core vault::blocks::tests -- --nocapture`
Expected: PASS (all five scanner tests). Also `cargo clippy -p cubical-core --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-core/src/vault/blocks.rs crates/cubical-core/src/vault/mod.rs
git commit -m "feat(core): block-id source scanner (fence-aware, end-of-line)"
```

---

### Task 3: `cubical-index` block + block_ref queries

**Files:**
- Create: `crates/cubical-index/src/blocks.rs`
- Modify: `crates/cubical-index/src/lib.rs`

- [ ] **Step 1: Declare the module + re-exports**

In `crates/cubical-index/src/lib.rs`, add `mod blocks;` next to `mod links;` / `mod tags;`, and add a re-export block:

```rust
pub use blocks::{
    block_exists, blocks_for_file, broken_block_refs, replace_block_refs_for_file,
    replace_blocks_for_file, BlockRefRow, BlockRow, BrokenBlockRef,
};
```

- [ ] **Step 2: Write the failing tests**

Create `crates/cubical-index/src/blocks.rs` with imports + tests first (model the test scaffolding on `tags.rs`'s `open_test_index` + `seed_file`):

```rust
//! Queries against the L3 `blocks` + `block_refs` tables (migration 005,
//! schema in `migrations/005_blocks.sql`). `blocks` holds `^block-id`
//! definitions per file; `block_refs` holds resolved `[[#^id]]` refs.
//! "Broken" refs are computed at query time via an anti-join to
//! `blocks`. See `docs/layer-3-spec.md` §2.7.

use libsql::params;

use crate::error::IndexError;
use crate::runner::IndexConn;

/// One `blocks` row: a block-id definition in a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRow {
    /// Block id without the leading `^`.
    pub block_id: String,
    /// Byte offset of the line carrying the id.
    pub position_hint: u64,
}

/// One `block_refs` row: a resolved `[[target#^id]]` reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockRefRow {
    /// Resolved target file path.
    pub target_file_path: String,
    /// Target block id (no `^`).
    pub target_block_id: String,
}

/// A broken block ref surfaced for vault health: a ref whose target
/// block id does not exist in `blocks`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokenBlockRef {
    /// File containing the `[[…#^id]]`.
    pub source_file_path: String,
    /// Target file the ref points at.
    pub target_file_path: String,
    /// Missing block id.
    pub target_block_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::open_index;
    use tempfile::TempDir;

    async fn open_test_index() -> (TempDir, IndexConn) {
        let dir = TempDir::new().expect("tmpdir");
        let conn = open_index(&dir.path().join("index.db")).await.expect("open");
        (dir, conn)
    }

    async fn seed_file(conn: &IndexConn, path: &str) {
        conn.connection()
            .execute(
                "INSERT INTO files \
                 (path, type_id, size_bytes, mtime_unix, content_hash, last_seen, created_at, updated_at) \
                 VALUES (?1, 'markdown', 0, 0, '', 0, 0, 0)",
                params![path],
            )
            .await
            .expect("seed files row");
    }

    #[tokio::test]
    async fn replace_then_lookup_blocks() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_blocks_for_file(
            &conn,
            "a.md",
            &[BlockRow { block_id: "intro".into(), position_hint: 0 }],
        )
        .await
        .unwrap();
        assert!(block_exists(&conn, "a.md", "intro").await.unwrap());
        assert!(!block_exists(&conn, "a.md", "missing").await.unwrap());
        let got = blocks_for_file(&conn, "a.md").await.unwrap();
        assert_eq!(got, vec![BlockRow { block_id: "intro".into(), position_hint: 0 }]);
    }

    #[tokio::test]
    async fn replace_blocks_is_delete_then_insert() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_blocks_for_file(&conn, "a.md", &[BlockRow { block_id: "old".into(), position_hint: 0 }])
            .await
            .unwrap();
        replace_blocks_for_file(&conn, "a.md", &[BlockRow { block_id: "new".into(), position_hint: 3 }])
            .await
            .unwrap();
        let got = blocks_for_file(&conn, "a.md").await.unwrap();
        assert_eq!(got, vec![BlockRow { block_id: "new".into(), position_hint: 3 }]);
    }

    #[tokio::test]
    async fn broken_block_refs_anti_joins_blocks() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "src.md").await;
        seed_file(&conn, "tgt.md").await;
        // tgt.md defines only "present".
        replace_blocks_for_file(&conn, "tgt.md", &[BlockRow { block_id: "present".into(), position_hint: 0 }])
            .await
            .unwrap();
        // src.md references both "present" (ok) and "gone" (broken).
        replace_block_refs_for_file(
            &conn,
            "src.md",
            &[
                BlockRefRow { target_file_path: "tgt.md".into(), target_block_id: "present".into() },
                BlockRefRow { target_file_path: "tgt.md".into(), target_block_id: "gone".into() },
            ],
        )
        .await
        .unwrap();
        let broken = broken_block_refs(&conn).await.unwrap();
        assert_eq!(
            broken,
            vec![BrokenBlockRef {
                source_file_path: "src.md".into(),
                target_file_path: "tgt.md".into(),
                target_block_id: "gone".into(),
            }]
        );
    }

    #[tokio::test]
    async fn deleting_file_cascades_blocks_and_refs() {
        let (_d, conn) = open_test_index().await;
        seed_file(&conn, "a.md").await;
        replace_blocks_for_file(&conn, "a.md", &[BlockRow { block_id: "x".into(), position_hint: 0 }])
            .await
            .unwrap();
        replace_block_refs_for_file(&conn, "a.md", &[BlockRefRow { target_file_path: "a.md".into(), target_block_id: "x".into() }])
            .await
            .unwrap();
        conn.connection().execute("DELETE FROM files WHERE path = 'a.md'", ()).await.unwrap();
        assert!(blocks_for_file(&conn, "a.md").await.unwrap().is_empty());
        assert!(broken_block_refs(&conn).await.unwrap().is_empty());
    }
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cargo test -p cubical-index blocks::tests -- --nocapture`
Expected: FAIL to compile — the query functions don't exist.

- [ ] **Step 4: Implement the queries**

Add above the `tests` module in `crates/cubical-index/src/blocks.rs`. `replace_*` use delete-then-insert and execute on the caller's connection (participating in any open transaction), exactly like `tags::replace_tags_for_file`:

```rust
/// Replace all `blocks` rows for `file_path`. Delete-then-insert; runs
/// on the caller's connection (no own transaction). `last_modified` is
/// stamped now (unix seconds).
pub async fn replace_blocks_for_file(
    conn: &IndexConn,
    file_path: &str,
    rows: &[BlockRow],
) -> Result<(), IndexError> {
    let now = now_unix_secs();
    let c = conn.connection();
    c.execute("DELETE FROM blocks WHERE file_path = ?1", params![file_path])
        .await?;
    for r in rows {
        c.execute(
            "INSERT OR IGNORE INTO blocks (file_path, block_id, position_hint, last_modified) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                file_path,
                r.block_id.clone(),
                i64::try_from(r.position_hint).unwrap_or(i64::MAX),
                now
            ],
        )
        .await?;
    }
    Ok(())
}

/// All block-id definitions in `file_path`, ordered by `position_hint`.
pub async fn blocks_for_file(
    conn: &IndexConn,
    file_path: &str,
) -> Result<Vec<BlockRow>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT block_id, position_hint FROM blocks \
             WHERE file_path = ?1 ORDER BY position_hint",
            params![file_path],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        let block_id: String = row.get(0)?;
        let position_hint: i64 = row.get(1)?;
        out.push(BlockRow {
            block_id,
            position_hint: u64::try_from(position_hint).unwrap_or(0),
        });
    }
    Ok(out)
}

/// Whether `(file_path, block_id)` exists in `blocks`.
pub async fn block_exists(
    conn: &IndexConn,
    file_path: &str,
    block_id: &str,
) -> Result<bool, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT 1 FROM blocks WHERE file_path = ?1 AND block_id = ?2 LIMIT 1",
            params![file_path, block_id],
        )
        .await?;
    Ok(rows.next().await?.is_some())
}

/// Replace all `block_refs` rows for `source_file_path`. Delete-then-
/// insert on the caller's connection.
pub async fn replace_block_refs_for_file(
    conn: &IndexConn,
    source_file_path: &str,
    rows: &[BlockRefRow],
) -> Result<(), IndexError> {
    let c = conn.connection();
    c.execute(
        "DELETE FROM block_refs WHERE source_file_path = ?1",
        params![source_file_path],
    )
    .await?;
    for r in rows {
        c.execute(
            "INSERT INTO block_refs (source_file_path, target_file_path, target_block_id) \
             VALUES (?1, ?2, ?3)",
            params![source_file_path, r.target_file_path.clone(), r.target_block_id.clone()],
        )
        .await?;
    }
    Ok(())
}

/// Every block ref whose target block id is not defined in `blocks`.
/// Ordered for stable output.
pub async fn broken_block_refs(conn: &IndexConn) -> Result<Vec<BrokenBlockRef>, IndexError> {
    let mut rows = conn
        .connection()
        .query(
            "SELECT r.source_file_path, r.target_file_path, r.target_block_id \
             FROM block_refs r \
             LEFT JOIN blocks b \
               ON b.file_path = r.target_file_path AND b.block_id = r.target_block_id \
             WHERE b.block_id IS NULL \
             ORDER BY r.source_file_path, r.target_file_path, r.target_block_id",
            (),
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(BrokenBlockRef {
            source_file_path: row.get(0)?,
            target_file_path: row.get(1)?,
            target_block_id: row.get(2)?,
        });
    }
    Ok(out)
}

/// Unix seconds now (saturating). Local helper to avoid a chrono dep.
fn now_unix_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-index blocks::tests -- --nocapture`
Expected: PASS (all four). Then `cargo test -p cubical-index` (no regressions) + `cargo clippy -p cubical-index --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-index/src/blocks.rs crates/cubical-index/src/lib.rs
git commit -m "feat(index): blocks + block_refs queries (incl. broken-ref anti-join)"
```

---

### Task 4: `refresh_blocks` + `refresh_block_refs_for_file` (core)

**Files:**
- Modify: `crates/cubical-core/src/vault/blocks.rs`
- Modify: `crates/cubical-core/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/cubical-core/src/vault/blocks.rs` (these need a `Vault` + a markdown file on disk + a `files` row, since the FKs require it — model the setup on `links.rs`'s refresh tests; read them to copy the `Vault::open` + scan-or-seed pattern):

```rust
#[tokio::test]
async fn refresh_blocks_populates_rows_from_source() {
    use cubical_index::blocks_for_file;
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("a.md");
    std::fs::write(&p, "first para ^one\n\nsecond ^two\n").unwrap();
    let vault = Vault::open(dir.path()).await.expect("open");
    // The files row must exist for the FK; a scan creates it.
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    crate::vault::scan(vault.clone(), tokio_util::sync::CancellationToken::new(), tx)
        .await
        .expect("scan");

    refresh_blocks(&vault, &p, "a.md").await.expect("refresh");
    let got = blocks_for_file(vault.index(), "a.md").await.unwrap();
    let ids: Vec<&str> = got.iter().map(|b| b.block_id.as_str()).collect();
    assert_eq!(ids, vec!["one", "two"]);
}

#[tokio::test]
async fn refresh_block_refs_derives_from_resolved_block_links() {
    use cubical_index::{broken_block_refs, replace_blocks_for_file, BlockRow};
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("src.md"), "see [[tgt#^present]] and [[tgt#^gone]]\n").unwrap();
    std::fs::write(dir.path().join("tgt.md"), "body ^present\n").unwrap();
    let vault = Vault::open(dir.path()).await.expect("open");
    let (tx, _rx) = tokio::sync::mpsc::channel(8);
    crate::vault::scan(vault.clone(), tokio_util::sync::CancellationToken::new(), tx)
        .await
        .expect("scan");

    // After a full scan, "gone" has no blocks row → exactly one broken ref.
    let broken = broken_block_refs(vault.index()).await.unwrap();
    assert_eq!(broken.len(), 1);
    assert_eq!(broken[0].source_file_path, "src.md");
    assert_eq!(broken[0].target_block_id, "gone");
    let _ = (replace_blocks_for_file, BlockRow); // silence unused if trimmed
}
```

> The second test exercises the scan-integrated path end-to-end (Task 5 wires `refresh_blocks` + `refresh_block_refs_for_file` into `scan`). It is written here because it asserts the `refresh_block_refs_for_file` behaviour; it will only pass once Task 5 is done. Mark this test `#[ignore]` if you want Task 4 to commit green on its own, then un-ignore it in Task 5. (Preferred: implement Task 4's functions now, leave this test un-ignored, and let it pass after Task 5. If executing strictly task-by-task with green commits, `#[ignore]` it here and remove the attribute in Task 5 Step 4.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p cubical-core vault::blocks::tests::refresh_blocks_populates_rows_from_source -- --nocapture`
Expected: FAIL to compile — `refresh_blocks` does not exist.

- [ ] **Step 3: Implement the refresh helpers**

At the top of `crates/cubical-core/src/vault/blocks.rs`, restore the imports and add the functions (above `extract_block_ids`):

```rust
use std::path::Path;

use cubical_index::{
    replace_block_refs_for_file, replace_blocks_for_file, BlockRefRow, BlockRow,
};

use crate::vault::links::read_source_off_executor; // added in this step — see note
use crate::vault::Vault;
```

> Import note: `refresh_blocks` needs the file's raw source text. `links.rs` has a private `parse_off_executor` that returns a parsed `Document`, not raw text. Add a sibling `pub(crate) async fn read_source_off_executor(abs_path: &Path) -> Option<String>` to `links.rs` (a ~6-line `spawn_blocking` `std::fs::read` → `String::from_utf8_lossy`, mirroring `parse_off_executor`'s read half) — that is the function imported on the line above. (Do not reuse the `Document` parser — block ids are not in the AST.) Concretely, add to `links.rs`:
>
> ```rust
> /// Read `abs_path`'s raw bytes off the runtime as lossy UTF-8.
> /// `None` when the file can't be read. Used by block-id scanning,
> /// which needs source text rather than a parsed `Document`.
> pub(crate) async fn read_source_off_executor(abs_path: &std::path::Path) -> Option<String> {
>     let path_buf = abs_path.to_path_buf();
>     tokio::task::spawn_blocking(move || {
>         std::fs::read(&path_buf)
>             .ok()
>             .map(|b| String::from_utf8_lossy(&b).into_owned())
>     })
>     .await
>     .ok()
>     .flatten()
> }
> ```

```rust
/// Re-scan `abs_path`'s source for `^block-id` tokens and replace this
/// file's `blocks` rows. Mirrors `refresh_links`'s resilience: an
/// unreadable file clears the rows. The matching `files` row must exist
/// (FK).
pub async fn refresh_blocks(
    vault: &Vault,
    abs_path: &Path,
    rel_path_str: &str,
) -> Result<(), libsql::Error> {
    let source = read_source_off_executor(abs_path).await.unwrap_or_default();
    let rows: Vec<BlockRow> = extract_block_ids(&source)
        .into_iter()
        .map(|o| BlockRow {
            block_id: o.block_id,
            position_hint: o.position,
        })
        .collect();
    replace_blocks_for_file(vault.index(), rel_path_str, &rows)
        .await
        .map_err(map_index_err)
}

/// Derive this file's `block_refs` from its resolved block-anchored
/// rows in the `links` table (`anchor_kind='block'` with a non-null
/// `target_path`) and replace them. Used by both the scan (Pass 2,
/// after links are written) and the watcher.
pub async fn refresh_block_refs_for_file(
    vault: &Vault,
    source_path: &str,
) -> Result<(), libsql::Error> {
    let conn = vault.index().connection();
    let mut rows = conn
        .query(
            "SELECT target_path, anchor_value FROM links \
             WHERE source_path = ?1 AND anchor_kind = 'block' AND target_path IS NOT NULL \
               AND anchor_value IS NOT NULL",
            libsql::params![source_path],
        )
        .await?;
    let mut refs = Vec::new();
    while let Some(row) = rows.next().await? {
        let target_file_path: String = row.get(0)?;
        let target_block_id: String = row.get(1)?;
        refs.push(BlockRefRow {
            target_file_path,
            target_block_id,
        });
    }
    replace_block_refs_for_file(vault.index(), source_path, &refs)
        .await
        .map_err(map_index_err)
}
```

`map_index_err` already exists in `links.rs` (it maps `cubical_index::IndexError` → `libsql::Error`). Either make it `pub(crate)` in `links.rs` and `use crate::vault::links::map_index_err;`, or copy the tiny function into `blocks.rs`. Prefer widening it to `pub(crate)` (DRY).

- [ ] **Step 4: Re-export from `cubical_core`**

In `crates/cubical-core/src/lib.rs`, add `refresh_blocks, refresh_block_refs_for_file` to the `pub use vault::{ … }` re-export list (line ~20–21, alongside `refresh_links`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-core vault::blocks -- --nocapture`
Expected: `refresh_blocks_populates_rows_from_source` PASSES now. (`refresh_block_refs_derives_from_resolved_block_links` passes after Task 5 — if you `#[ignore]`d it, it stays ignored until then.) `cargo clippy -p cubical-core --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-core/src/vault/blocks.rs crates/cubical-core/src/vault/links.rs crates/cubical-core/src/lib.rs
git commit -m "feat(core): refresh_blocks + refresh_block_refs_for_file"
```

---

### Task 5: Wire blocks into the scan

**Files:**
- Modify: `crates/cubical-core/src/vault/scan.rs`

- [ ] **Step 1: Import the new helpers**

In `crates/cubical-core/src/vault/scan.rs`, extend the `use crate::vault::{ … }` block to include the blocks helpers:

```rust
    blocks::{refresh_block_refs_for_file, refresh_blocks},
```

(Add it alphabetically next to the existing `links::{…}` / `tags::refresh_tags` entries.)

- [ ] **Step 2: Pass 1 — refresh blocks inline per markdown file**

In the `if type_id == "markdown" {` block (around line 225–238), after the `refresh_tags(...)` call, add:

```rust
            // L3 §2.7: block-id definitions are per-file (no resolution),
            // so they refresh inline here alongside frontmatter + tags.
            if let Err(e) = refresh_blocks(&vault, &abs_path, &path_str).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "blocks refresh failed");
            }
```

- [ ] **Step 3: Pass 2 — derive block_refs after each source's links are written**

In the Pass 2 loop (around line 284–319), immediately AFTER the `replace_links_for_file(vault.index(), &source_path, &rows)` call + its error handling (line ~309), add:

```rust
        // L3 §2.7: now that this source's resolved links are persisted,
        // project its block-anchored ones into the block_refs table.
        if let Err(e) = refresh_block_refs_for_file(&vault, &source_path).await {
            tracing::warn!(path = %source_path, error = %e, "block_refs refresh failed");
        }
```

> Both run inside `link_tx` on the same connection, so `refresh_block_refs_for_file`'s `SELECT … FROM links` sees the just-written (uncommitted) rows. The final `link_tx.commit()` at line ~319 persists both.

- [ ] **Step 4: Un-ignore the cross-cutting test (if you ignored it in Task 4)**

If you added `#[ignore]` to `refresh_block_refs_derives_from_resolved_block_links` in Task 4, remove it now.

- [ ] **Step 5: Run the scan + blocks tests**

Run: `cargo test -p cubical-core vault::scan vault::blocks -- --nocapture`
Expected: PASS — including `refresh_block_refs_derives_from_resolved_block_links` (one broken ref for `gone`), and every pre-existing scan test (links/tags/frontmatter/cancellation) still green.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-core/src/vault/scan.rs crates/cubical-core/src/vault/blocks.rs
git commit -m "feat(core): populate blocks (Pass 1) + block_refs (Pass 2) in scan"
```

---

### Task 6: Wire blocks into the watcher

**Files:**
- Modify: `crates/cubical-app/src/events.rs`

- [ ] **Step 1: Import the helpers**

In `crates/cubical-app/src/events.rs`, extend the `cubical_core` import (line ~18, currently `refresh_frontmatter, refresh_links, refresh_tags, scan, ScanProgress, Vault, VaultError`) to add `refresh_block_refs_for_file, refresh_blocks`.

- [ ] **Step 2: Refresh blocks + block_refs on the single-file path**

In `apply_watch_event_to_db` (around lines 378–393), after the `refresh_tags(...)` call, add — in this order (blocks must be refreshed before block_refs are recomputed, though for the *edited* file the ref derivation only depends on its own `links` rows, which `refresh_links` just wrote two lines above):

```rust
                if let Err(e) = refresh_blocks(vault, &abs, &path_str).await {
                    tracing::warn!(path = %abs.display(), error = %e, "blocks refresh failed");
                }
                if let Err(e) = refresh_block_refs_for_file(vault, &path_str).await {
                    tracing::warn!(path = %abs.display(), error = %e, "block_refs refresh failed");
                }
```

> Caveat (acceptable for backend core): editing file B to *add* a block id does not, by itself, recompute the broken-ness of refs in file A that point at B — `broken_block_refs` is computed fresh at query time, so the next `get_broken_block_refs` call reflects B's new block immediately. No stale state. Good.

- [ ] **Step 3: Build + run the app crate tests**

Run: `cargo build -p cubical-app && cargo test -p cubical-app events -- --nocapture`
Expected: clean build; existing watcher tests still pass. (No new test here — the helpers are unit-tested in core; this is wiring. If `events.rs` has a watcher integration test that asserts on links/tags after an edit, confirm it still passes.)

- [ ] **Step 4: Commit**

```bash
git add crates/cubical-app/src/events.rs
git commit -m "feat(app): watcher refreshes blocks + block_refs on edits"
```

---

### Task 7: `create_block_ref` command (mint + persist)

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs`
- Create: `crates/cubical-app/src/commands/blocks.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs`

- [ ] **Step 1: Add wire types**

In `crates/cubical-app/src/api/types.rs`, after the autocomplete section:

```rust
// -- create_block_ref / get_broken_block_refs (L3 Session G) -------------

/// Request payload for `create_block_ref`.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateBlockRefRequest {
    /// Vault owning the target file.
    pub vault_id: String,
    /// Vault-relative path of the file whose block is being referenced.
    pub target_path: String,
    /// Byte offset into the target file identifying the block (the
    /// id is appended to the end of the line containing this offset).
    pub position: u64,
}

/// Response payload for `create_block_ref`.
#[derive(Debug, Clone, Serialize)]
pub struct CreateBlockRefResponse {
    /// The block id (no leading `^`) — newly minted or pre-existing.
    pub block_id: String,
}

/// Request payload for `get_broken_block_refs`.
#[derive(Debug, Clone, Deserialize)]
pub struct GetBrokenBlockRefsRequest {
    /// Vault to inspect.
    pub vault_id: String,
}

/// Response payload for `get_broken_block_refs`.
#[derive(Debug, Clone, Serialize)]
pub struct GetBrokenBlockRefsResponse {
    /// Broken refs, ordered. Empty when none.
    pub refs: Vec<BrokenBlockRefDto>,
}

/// One broken block ref for the frontend (vault-health surfacing).
#[derive(Debug, Clone, Serialize)]
pub struct BrokenBlockRefDto {
    /// File containing the `[[…#^id]]`.
    pub source_file_path: String,
    /// Target file.
    pub target_file_path: String,
    /// Missing block id.
    pub target_block_id: String,
}
```

- [ ] **Step 2: Register the module + write failing tests**

In `crates/cubical-app/src/commands/mod.rs`, add `pub mod blocks;` (alphabetical, before `links`).

Create `crates/cubical-app/src/commands/blocks.rs` with module doc + tests first (copy the `fresh_state_with_vault` helper from `commands/autocomplete.rs` or `commands/tags.rs`):

```rust
//! Pure handlers for L3 block references (Session G):
//! `create_block_ref` (lazily mint + persist a `^block-id` in a file's
//! source) and `get_broken_block_refs` (vault-health surfacing).
//! See `docs/layer-3-spec.md` §2.7 + §3.3.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn state_with_vault_at(dir: &std::path::Path, vault_id: &str) -> (Vault, AppState) {
        let vault = Vault::open(dir).await.expect("open");
        let state = AppState::new();
        state.vaults().write().await.insert(
            vault_id.to_string(),
            OpenVault {
                vault: vault.clone(),
                cancel: CancellationToken::new(),
                scan_status: ScanStatusBackend::Complete,
                watcher: None,
            },
        );
        (vault, state)
    }

    #[tokio::test]
    async fn create_block_ref_mints_and_persists_id() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "first para\n\nsecond para\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;

        // position 0 → the first line ("first para").
        let resp = create_block_ref(
            &state,
            CreateBlockRefRequest { vault_id: "v1".into(), target_path: "a.md".into(), position: 0 },
        )
        .await
        .expect("ok");
        let id = resp.block_id;
        assert!(!id.is_empty());

        // The id was written to source at the end of the first line.
        let src = std::fs::read_to_string(dir.path().join("a.md")).unwrap();
        assert!(src.lines().next().unwrap().ends_with(&format!("^{id}")), "src was: {src:?}");

        // And a blocks row was persisted.
        let exists = cubical_index::block_exists(vault.index(), "a.md", &id).await.unwrap();
        assert!(exists);
    }

    #[tokio::test]
    async fn create_block_ref_is_idempotent_when_line_already_has_id() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "first para ^existing\n").unwrap();
        let (_vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let resp = create_block_ref(
            &state,
            CreateBlockRefRequest { vault_id: "v1".into(), target_path: "a.md".into(), position: 0 },
        )
        .await
        .expect("ok");
        assert_eq!(resp.block_id, "existing");
        // Source unchanged (no second id appended).
        let src = std::fs::read_to_string(dir.path().join("a.md")).unwrap();
        assert_eq!(src, "first para ^existing\n");
    }

    #[tokio::test]
    async fn get_broken_block_refs_reports_missing_targets() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("src.md"), "ref [[tgt#^gone]]\n").unwrap();
        std::fs::write(dir.path().join("tgt.md"), "body\n").unwrap();
        let (vault, state) = state_with_vault_at(dir.path(), "v1").await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        cubical_core::vault::scan(vault.clone(), CancellationToken::new(), tx).await.unwrap();

        let resp = get_broken_block_refs(
            &state,
            GetBrokenBlockRefsRequest { vault_id: "v1".into() },
        )
        .await
        .expect("ok");
        assert_eq!(resp.refs.len(), 1);
        assert_eq!(resp.refs[0].target_block_id, "gone");
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p cubical-app commands::blocks -- --nocapture`
Expected: FAIL to compile — handlers undefined.

- [ ] **Step 4: Implement the handlers**

Add at the top of `crates/cubical-app/src/commands/blocks.rs`:

```rust
use cubical_core::vault::blocks::refresh_blocks;
use cubical_index::{broken_block_refs, BlockRow};
use sha2::{Digest, Sha256};

use crate::api::types::{
    BrokenBlockRefDto, CreateBlockRefRequest, CreateBlockRefResponse, GetBrokenBlockRefsRequest,
    GetBrokenBlockRefsResponse,
};
use crate::error::CubicalError;
use crate::state::AppState;

/// Lazily mint (or reuse) a block id on the line at `position` in
/// `target_path`, writing `^id` into the source and persisting the
/// `blocks` row. Idempotent: if the line already ends with a block id,
/// returns it unchanged.
pub async fn create_block_ref(
    state: &AppState,
    req: CreateBlockRefRequest,
) -> Result<CreateBlockRefResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let vault = open.vault.clone();
    drop(guard);

    let abs = vault.root().join(&req.target_path);
    let source = tokio::fs::read_to_string(&abs)
        .await
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    let (new_source, block_id) = mint_block_id(&source, req.position, &req.target_path);
    if new_source != source {
        tokio::fs::write(&abs, &new_source)
            .await
            .map_err(|e| CubicalError::Io(e.to_string()))?;
    }
    // Persist the blocks row immediately so resolution doesn't wait on
    // the watcher. (The watcher echo will re-refresh; replace is idempotent.)
    refresh_blocks(&vault, &abs, &req.target_path)
        .await
        .map_err(|e| CubicalError::Io(e.to_string()))?;

    Ok(CreateBlockRefResponse { block_id })
}

/// Compute the new source + the id for the line containing `position`.
/// If that line already ends with a valid `^id`, reuse it (no change).
/// Otherwise append ` ^<generated>` to the line's end. The id is
/// deterministic per (path, position): `b` + first 6 hex of
/// sha256("path:position"), guaranteeing a letter start + uniqueness in
/// practice; on the rare in-file collision a numeric suffix is added.
fn mint_block_id(source: &str, position: u64, path: &str) -> (String, String) {
    let pos = (position as usize).min(source.len());
    // Find the [line_start, line_end) byte range containing `pos`.
    let line_start = source[..pos].rfind('\n').map_or(0, |i| i + 1);
    let line_end = source[pos..]
        .find('\n')
        .map_or(source.len(), |i| pos + i);
    let line = &source[line_start..line_end];
    let line_trimmed = line.trim_end();

    // Reuse an existing trailing id.
    if let Some(existing) = trailing_block_id(line_trimmed) {
        return (source.to_string(), existing);
    }

    let existing_ids = existing_block_ids(source);
    let id = unique_id(path, position, &existing_ids);

    // Insert ` ^id` at the end of the trimmed line content.
    let insert_at = line_start + line_trimmed.len();
    let mut new_source = String::with_capacity(source.len() + id.len() + 2);
    new_source.push_str(&source[..insert_at]);
    new_source.push_str(&format!(" ^{id}"));
    new_source.push_str(&source[insert_at..]);
    (new_source, id)
}

/// Trailing `^id` on an already-trimmed line, if valid.
fn trailing_block_id(line: &str) -> Option<String> {
    let caret = line.rfind('^')?;
    let id = &line[caret + 1..];
    let before_ok = caret == 0
        || line[..caret].chars().next_back().is_some_and(char::is_whitespace);
    if before_ok && is_valid_id(id) {
        Some(id.to_string())
    } else {
        None
    }
}

/// All trailing block ids currently in `source` (for collision checks).
fn existing_block_ids(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|l| trailing_block_id(l.trim_end()))
        .collect()
}

fn is_valid_id(id: &str) -> bool {
    let mut c = id.chars();
    matches!(c.next(), Some(ch) if ch.is_ascii_alphabetic() || ch == '_')
        && c.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn unique_id(path: &str, position: u64, existing: &[String]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    hasher.update(b":");
    hasher.update(position.to_le_bytes());
    let hex = format!("{:x}", hasher.finalize());
    let base = format!("b{}", &hex[..6]);
    if !existing.contains(&base) {
        return base;
    }
    // Rare collision: append an incrementing suffix.
    for n in 2.. {
        let candidate = format!("{base}-{n}");
        if !existing.contains(&candidate) {
            return candidate;
        }
    }
    unreachable!("the loop always returns")
}

/// Every block ref whose target block id is missing, for vault health.
pub async fn get_broken_block_refs(
    state: &AppState,
    req: GetBrokenBlockRefsRequest,
) -> Result<GetBrokenBlockRefsResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;
    let broken = broken_block_refs(open.vault.index()).await?;
    let refs = broken
        .into_iter()
        .map(|b| BrokenBlockRefDto {
            source_file_path: b.source_file_path,
            target_file_path: b.target_file_path,
            target_block_id: b.target_block_id,
        })
        .collect();
    Ok(GetBrokenBlockRefsResponse { refs })
}
```

> **Verify these against the real source before relying on them:**
> - `CubicalError` variant for I/O — the template uses `CubicalError::Io(String)`. Open `crates/cubical-app/src/error.rs` and use the actual I/O variant (it may be named differently or wrap `std::io::Error`). If there is none, the existing `write_file_text` handler in `commands/vault.rs` shows how file-write errors are mapped — mirror that.
> - `vault.root()` — confirm the accessor that returns the vault's root `&Path` (used to build the absolute path). Check `cubical_core::Vault`'s public methods; `scan.rs` uses `vault.root()`.
> - `BlockRow` import is only needed if you reference it; trim unused imports to satisfy clippy.
> - `?` on `broken_block_refs(...)` relies on `From<IndexError> for CubicalError` (the same impl `query_tag_page` uses).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-app commands::blocks -- --nocapture`
Expected: PASS (all three). Then `cargo clippy -p cubical-app --all-targets -- -D warnings` + `cargo fmt --all`.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/src/api/types.rs crates/cubical-app/src/commands/blocks.rs crates/cubical-app/src/commands/mod.rs
git commit -m "feat(app): create_block_ref + get_broken_block_refs handlers"
```

---

### Task 8: Tauri shims + registration + IPC bindings

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Import types + add shims**

In `crates/cubical-app/src/lib.rs`, add to the `use crate::api::types::{ … }` block:

```rust
    CreateBlockRefRequest, CreateBlockRefResponse, GetBrokenBlockRefsRequest,
    GetBrokenBlockRefsResponse,
```

Add the shims after the autocomplete shims:

```rust
/// Tauri shim — see [`commands::blocks::create_block_ref`].
#[tauri::command]
async fn create_block_ref(
    state: tauri::State<'_, AppState>,
    req: CreateBlockRefRequest,
) -> Result<CreateBlockRefResponse, CubicalError> {
    commands::blocks::create_block_ref(state.inner(), req).await
}

/// Tauri shim — see [`commands::blocks::get_broken_block_refs`].
#[tauri::command]
async fn get_broken_block_refs(
    state: tauri::State<'_, AppState>,
    req: GetBrokenBlockRefsRequest,
) -> Result<GetBrokenBlockRefsResponse, CubicalError> {
    commands::blocks::get_broken_block_refs(state.inner(), req).await
}
```

Register both in `generate_handler![…]` (after `tag_autocomplete,`):

```rust
            create_block_ref,
            get_broken_block_refs,
```

- [ ] **Step 2: Build to verify wiring**

Run: `cargo build -p cubical-app`
Expected: clean (the macro fails loudly on a missing name or a non-Serde type).

- [ ] **Step 3: Add the frontend IPC bindings**

In `ui/src/api/ipc.ts`, add after the autocomplete section (mirror `queryTagPage`):

```ts
// ---------------------------------------------------------------------------
// create_block_ref / get_broken_block_refs (L3 Session G)
// ---------------------------------------------------------------------------

export interface CreateBlockRefRequest {
  vault_id: string;
  /** Vault-relative path of the file whose block is referenced. */
  target_path: string;
  /** Byte offset identifying the block (id appended to that line). */
  position: number;
}

export interface CreateBlockRefResponse {
  /** Block id (no leading `^`), minted or pre-existing. */
  block_id: string;
}

export interface GetBrokenBlockRefsRequest {
  vault_id: string;
}

export interface BrokenBlockRef {
  source_file_path: string;
  target_file_path: string;
  target_block_id: string;
}

export interface GetBrokenBlockRefsResponse {
  refs: BrokenBlockRef[];
}

/**
 * Lazily mint (or reuse) a `^block-id` on the line at `position` in
 * `target_path`, persisting it. Returns the block id.
 */
export function createBlockRef(
  req: CreateBlockRefRequest,
): Promise<CreateBlockRefResponse> {
  return invoke("create_block_ref", { req });
}

/** Every block ref whose target block id no longer exists. */
export function getBrokenBlockRefs(
  req: GetBrokenBlockRefsRequest,
): Promise<GetBrokenBlockRefsResponse> {
  return invoke("get_broken_block_refs", { req });
}
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean (bindings unused for now — that's fine; the surfacing UI is the deferred follow-up).

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-app/src/lib.rs ui/src/api/ipc.ts
git commit -m "feat: register block-ref Tauri commands + IPC bindings"
```

---

### Task 9: Full verification + docs + finish branch

- [ ] **Step 1: Whole workspace Rust suite**

Run: `cargo test --workspace`
Expected: PASS, 0 failures. (Known flake: `commands::vault::tests::get_setting_returns_none_for_absent_key` — re-run in isolation if it trips.)

- [ ] **Step 2: Lint + format + frontend gates**

```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
( cd ui && npx tsc --noEmit && npx vitest run && npm run build )
```
Expected: all clean. (vitest count unchanged — no UI logic added; the chunk-size build warning is pre-existing.)

- [ ] **Step 3: Real-app smoke (best-effort)**

```bash
cargo build -p cubical-app
# then: cargo tauri dev, open ~/Developer/sandbox/vault.
#  - In the dev console / via a temporary call, invoke create_block_ref
#    on a note + position; confirm `^id` appears in the .md on disk and
#    the file list reflects no corruption.
#  - Confirm a [[note#^missing]] surfaces via get_broken_block_refs.
```
There is no editor gesture this session (deferred), so a full hands-on smoke is limited; record honestly. The migration + scanner + index + scan-integration + handler unit tests already prove correctness end-to-end (`refresh_block_refs_derives_from_resolved_block_links` and `create_block_ref_*` exercise the real scan + real file writes).

- [ ] **Step 4: Update docs + state**

- Add `### 9.8 Session G — Block references (backend core)` to `docs/layer-3-spec.md` §9 (mirror §9.7 style): migration 005, the fence-aware scanner, the inline-Pass-1 blocks / derived-Pass-2 block_refs design, `create_block_ref`'s lazy deterministic minting, `get_broken_block_refs`, and the explicit deferral of the editor gesture / `^id` decoration / status-bar UI. Note `resolve_link` was intentionally left unchanged.
- Rewrite the `CLAUDE.md` "Project state" block (do not append): Sessions A–F + G-backend done; update test counts; set "Next: L3 Session G frontend follow-up (editor create-ref gesture, `^id` decoration, broken-ref status bar) + the deferred in-bracket `[[#^` autocomplete, then Session H — Embeds."

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **Lazy assignment is the headline invariant.** The scanner only READS `^id`s; the ONLY writer is `create_block_ref`. There is no code path that bulk-assigns. The `create_block_ref_is_idempotent_*` test guards against double-minting.
- **`block_refs` is derived, never hand-authored.** It is always a projection of the resolved block-anchored `links` rows, recomputed by `refresh_block_refs_for_file` in both the scan (Pass 2) and the watcher. "Broken" is a query-time anti-join, so adding a block to the target file fixes the broken state on the next query with no extra bookkeeping.
- **Scanner ↔ minter grammar must stay identical** (`[A-Za-z_][A-Za-z0-9_-]*`, end-of-line, fence-aware). `is_valid_block_id` (scanner) and `is_valid_id` (minter) are the same rule in two crates — if you change one, change both. (They can't share code without a new shared crate; keep them in lockstep, each with its own tests.)
- **`resolve_link` untouched** — block resolution lives in the `blocks`/`block_refs` tables + `get_broken_block_refs`, so there's no frontend resolver ripple. This is the deliberate backend-core boundary.
- **Out of scope, on purpose:** editor "create block ref" gesture, `^id` decoration, the broken-ref status-bar item, in-bracket `[[#^` autocomplete (still deferred from Session F), and block *embeds* `![[#^id]]` (Session H). The IPC bindings added in Task 8 are unused until that follow-up — intentional.
- **Position semantics** for `create_block_ref` are "the line containing the byte offset." That's deterministic and testable; the eventual editor gesture passes the cursor's offset. Document this in §9.8 so the frontend follow-up knows the contract.
