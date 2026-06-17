# L3 Session F — Link + Tag Autocomplete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the CodeMirror editor, typing `[[` opens an autocomplete dropdown over the vault's markdown files, and typing `#` at a word boundary (outside code) opens autocomplete over existing tags; selecting an entry completes the `[[…]]` or `#…` token.

**Architecture:** Two new read-only `cubical-index` query helpers (`files_for_link_query`, `tag_paths_for_prefix`) back two new pure async command handlers (`link_autocomplete`, `tag_autocomplete`) exposed over IPC via the standard thin-shim pattern. On the frontend, a per-vault `AutocompleteProvider` (mirroring the existing `WikiLinkResolver` injection) feeds two CodeMirror 6 `CompletionSource`s installed via the `@codemirror/autocomplete` `autocompletion({ override })` extension. Trigger detection and insert-text construction are pure, unit-tested functions; "inside code" gating reads the Lezer syntax tree.

**Tech Stack:** Rust, `libsql` (local SQLite), `cubical-index` query helpers, Tauri command shims, TypeScript, Solid, CodeMirror 6 (`@codemirror/autocomplete`, `@codemirror/state`, `@codemirror/language`), vitest.

---

## Background — read before touching code

You have no prior context on this codebase. Read this section, then the referenced files, before starting.

### What we're building

Cubical is a local-first Markdown PKM app (Tauri + Rust + Solid). L3 ("Knowledge Graph") adds wiki-links, tags, backlinks, etc. Sessions A–E are done. This is **Session F — link + tag autocomplete** (`docs/layer-3-spec.md` §2.6 + §8 "Session F").

When the user types `[[` in the editor, a dropdown should list the vault's markdown files; picking one inserts a valid `[[path]]` wiki-link. When the user types `#` at a word boundary outside code, a dropdown should list existing tags (prefix-filtered); picking one inserts `#tag`.

### Authoritative scope = the §8 DoD (not the §2.6 prose)

`docs/layer-3-spec.md` §8 "Session F" **Definition of Done** is the contract:

> `[[` lists files and inserts a valid link; `#` lists tags; correct trigger gating.

The §2.6 prose additionally muses about "after `#` inside the brackets, that file's headings / block-ids." **That is explicitly OUT OF SCOPE for this plan** (see Scope Boundaries). The DoD does not require it.

### How the existing pieces fit (the patterns you will mirror)

- **Index query helpers** live in `crates/cubical-index/src/{links,tags}.rs` as `pub async fn …(conn: &IndexConn, …) -> Result<…, IndexError>`. They run SQL against the libSQL `files` / `tags` tables. See `tags::files_for_tag_prefix` (the closest model — note its `escape_like_literal` helper and `LIKE … ESCAPE '\'` usage).
- **Command handlers** live in `crates/cubical-app/src/commands/*.rs` as pure `pub async fn name(state: &AppState, req: XRequest) -> Result<XResponse, CubicalError>`. They pull the open vault from `state.vaults().read().await`, call an index helper, and map to wire types. See `commands::tags::query_tag_page` — copy its shape exactly.
- **Wire types** live in `crates/cubical-app/src/api/types.rs` (`#[derive(Deserialize)]` requests, `#[derive(Serialize)]` responses). See `QueryTagPageRequest` / `QueryTagPageResponse` / `TagPageFile`.
- **Tauri shims** are 3-line `#[tauri::command]` forwarders in `crates/cubical-app/src/lib.rs`, registered in the `tauri::generate_handler![…]` list. See the `query_tag_page` shim.
- **Frontend IPC** is centralized in `ui/src/api/ipc.ts` — typed wire structs + one `invoke(...)` wrapper per command. Components NEVER call `invoke` directly. See `queryTagPage`.
- **Per-vault provider injection:** `ui/src/editor/wikilinkResolver.ts` exports `createWikiLinkResolver(vaultId, ipc?)`. `App.tsx` holds it in a signal (`wikilinkResolver`), sets it on vault open (~line 714 `setWikilinkResolver(createWikiLinkResolver(resp.vault_id))`), and passes it to `<Editor wikilinkResolver={…}>`. `Editor.tsx` holds it in a `Compartment` and reconfigures on prop change. **You will add an exactly-parallel `AutocompleteProvider`.**
- **Editor extension install site:** `Editor.tsx` `onMount`, the `EditorState.create({ extensions: [...] })` array. Markdown is configured as `markdown({ extensions: [wikilinkExtension, tagExtension] })`. Live-preview decorations + resolver facet are each in their own `Compartment`.

### Tech notes

- `@codemirror/autocomplete` is already present in `ui/node_modules` (transitive via the `codemirror` meta-package) but is NOT a direct dependency in `ui/package.json`. Task 7 adds it explicitly — never rely on transitive resolution for a direct import.
- A CM6 `CompletionSource` is `(context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>`. Returning a Promise is fully supported — our sources call IPC. A `CompletionResult` is `{ from: number, options: Completion[], validFor?: RegExp }`. `validFor` lets CM filter in-place as the user keeps typing without re-invoking the source.
- `CompletionContext` (from `@codemirror/autocomplete`) is constructible in vitest with `new CompletionContext(state, pos, explicit)` — no DOM needed. `syntaxTree(state)` (from `@codemirror/language`) also works headless. This makes the sources unit-testable.

### Scope boundaries — do NOT do these

- **Do NOT implement in-bracket heading / block-id completion** (`[[target#…`). Block-ids need Session G's `blocks` table (not built yet); headings aren't indexed. The DoD doesn't require it. The link trigger detection MUST stop the query at `#` or `|` (so it never tries to complete an anchor/display), but completing anchors is a later session.
- **Do NOT change wiki-link or tag parsing / decoration** (`wikilink.ts`, `tag.ts`, the decoration plugin). Autocomplete is additive — a new extension + new IPC, nothing else.
- **Do NOT add a new migration or touch the `files` / `tags` schemas.** Both helpers are read-only `SELECT`s over existing tables.
- **Do NOT call `invoke()` outside `ui/src/api/ipc.ts`.**
- **Do NOT bypass the pure-handler pattern** — no `#[tauri::command]` logic beyond the 3-line shim; all logic in `commands/*.rs`.

---

## File Structure

**Create:**
- `crates/cubical-app/src/commands/autocomplete.rs` — the two pure handlers + their unit tests.
- `ui/src/editor/autocomplete.ts` — pure trigger detection, insert-text construction, code-context gating, and the two `CompletionSource` builders.
- `ui/src/editor/autocomplete.test.ts` — vitest for the pure functions + gating.
- `ui/src/editor/autocompleteProvider.ts` — `createAutocompleteProvider(vaultId, ipc?)`, the per-vault IPC adapter (mirrors `wikilinkResolver.ts`).

**Modify:**
- `crates/cubical-index/src/links.rs` — add `files_for_link_query` + tests.
- `crates/cubical-index/src/tags.rs` — add `tag_paths_for_prefix` + tests.
- `crates/cubical-index/src/lib.rs` — re-export the two new helpers.
- `crates/cubical-app/src/api/types.rs` — add request/response/candidate structs.
- `crates/cubical-app/src/commands/mod.rs` — `pub mod autocomplete;`.
- `crates/cubical-app/src/lib.rs` — two Tauri shims + register them in `generate_handler!`; import the new types.
- `ui/src/api/ipc.ts` — wire types + `linkAutocomplete` / `tagAutocomplete` functions.
- `ui/src/Editor.tsx` — new `autocompleteProvider` prop + `autocompletion` extension in a compartment.
- `ui/src/App.tsx` — construct/clear the provider alongside `wikilinkResolver`; pass it to `<Editor>`.
- `ui/package.json` — add `@codemirror/autocomplete` as a direct dependency.

---

### Task 1: `files_for_link_query` index helper

**Files:**
- Modify: `crates/cubical-index/src/links.rs`
- Modify: `crates/cubical-index/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/cubical-index/src/links.rs`. (That module already has an `open_test_index()` helper and a `seed_file` helper — confirm their exact names by reading the bottom of `links.rs`; if `seed_file` is named differently or absent, copy the `seed_file` from `tags.rs`'s test module, which inserts a `files` row with `type_id='markdown'`.)

```rust
#[tokio::test]
async fn files_for_link_query_substring_case_insensitive() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "Daily/2026-05-28.md").await;
    seed_file(&conn, "notes/Project Cubical.md").await;
    seed_file(&conn, "notes/cubical-ast.md").await;
    seed_file(&conn, "archive/old.md").await;

    // Case-insensitive substring over the whole path.
    let got = files_for_link_query(&conn, "cubical", 50).await.unwrap();
    assert_eq!(
        got,
        vec![
            "notes/Project Cubical.md".to_string(),
            "notes/cubical-ast.md".to_string(),
        ]
    );
}

#[tokio::test]
async fn files_for_link_query_empty_query_lists_all_markdown_ordered_and_limited() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "b.md").await;
    seed_file(&conn, "a.md").await;
    seed_file(&conn, "c.md").await;

    let all = files_for_link_query(&conn, "", 50).await.unwrap();
    assert_eq!(all, vec!["a.md".to_string(), "b.md".to_string(), "c.md".to_string()]);

    let limited = files_for_link_query(&conn, "", 2).await.unwrap();
    assert_eq!(limited, vec!["a.md".to_string(), "b.md".to_string()]);
}

#[tokio::test]
async fn files_for_link_query_excludes_non_markdown_and_escapes_like() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "real_note.md").await; // markdown
    // A binary file must never appear in link autocomplete.
    conn.connection()
        .execute(
            "INSERT INTO files \
             (path, type_id, size_bytes, mtime_unix, content_hash, last_seen, created_at, updated_at) \
             VALUES ('image.png', 'binary', 0, 0, '', 0, 0, 0)",
            (),
        )
        .await
        .unwrap();

    let got = files_for_link_query(&conn, "note", 50).await.unwrap();
    assert_eq!(got, vec!["real_note.md".to_string()]);

    // The `_` in the query must be escaped — it must NOT act as a LIKE
    // single-char wildcard. "real_note" matches; a near-miss must not.
    let exact = files_for_link_query(&conn, "real_note", 50).await.unwrap();
    assert_eq!(exact, vec!["real_note.md".to_string()]);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p cubical-index links::tests::files_for_link_query -- --nocapture`
Expected: FAIL to compile — `files_for_link_query` does not exist.

- [ ] **Step 3: Implement the helper**

Add to `crates/cubical-index/src/links.rs` (near the other `pub async fn` query helpers, above the `tests` module). It needs an `escape_like_literal` like the one in `tags.rs`; add a private copy here (small, self-contained — keeping it local avoids a cross-module visibility change):

```rust
/// Escape LIKE-special bytes (`\`, `%`, `_`) so a literal can be used
/// inside `LIKE … ESCAPE '\'` without its specials acting as wildcards.
/// Mirrors `crate::tags`'s identically-named private helper.
fn escape_like_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        if ch == '\\' || ch == '%' || ch == '_' {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// Markdown file paths matching `query` as a case-insensitive substring
/// of the vault-relative path, ordered by path, capped at `limit`. An
/// empty `query` returns the first `limit` markdown paths. Non-markdown
/// files are excluded — wiki-links target notes, not binaries.
///
/// Backs the `[[` link-autocomplete command (L3 Session F, spec §2.6).
pub async fn files_for_link_query(
    conn: &IndexConn,
    query: &str,
    limit: u32,
) -> Result<Vec<String>, IndexError> {
    let needle = query.to_lowercase();
    let like = format!("%{}%", escape_like_literal(&needle));
    let mut rows = conn
        .connection()
        .query(
            "SELECT path FROM files \
             WHERE type_id = 'markdown' \
               AND (?1 = '' OR LOWER(path) LIKE ?2 ESCAPE '\\') \
             ORDER BY path \
             LIMIT ?3",
            params![needle, like, i64::from(limit)],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}
```

- [ ] **Step 4: Re-export from the crate root**

In `crates/cubical-index/src/lib.rs`, add `files_for_link_query` to the `pub use links::{…}` list:

```rust
pub use links::{
    backlinks_for, files_for_link_query, links_from, links_to, replace_links_for_file,
    BacklinkRow, LinkRow,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-index links::tests::files_for_link_query -- --nocapture`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-index/src/links.rs crates/cubical-index/src/lib.rs
git commit -m "feat(index): files_for_link_query — markdown paths for link autocomplete"
```

---

### Task 2: `tag_paths_for_prefix` index helper

**Files:**
- Modify: `crates/cubical-index/src/tags.rs`
- Modify: `crates/cubical-index/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/cubical-index/src/tags.rs` (it has `open_test_index()`, `seed_file`, and a `row(tag, source)` helper):

```rust
#[tokio::test]
async fn tag_paths_for_prefix_distinct_prefix_match_case_insensitive() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "a.md").await;
    seed_file(&conn, "b.md").await;
    replace_tags_for_file(
        &conn,
        "a.md",
        &[
            row("Project", TagSource::Inline),
            row("project/cubical", TagSource::Frontmatter),
        ],
    )
    .await
    .unwrap();
    replace_tags_for_file(&conn, "b.md", &[row("done", TagSource::Inline)])
        .await
        .unwrap();

    // Prefix match, case-insensitive; distinct across files.
    let got = tag_paths_for_prefix(&conn, "proj", 50).await.unwrap();
    assert_eq!(
        got,
        vec!["Project".to_string(), "project/cubical".to_string()]
    );
    // Non-matching prefix yields nothing.
    assert!(tag_paths_for_prefix(&conn, "zzz", 50).await.unwrap().is_empty());
}

#[tokio::test]
async fn tag_paths_for_prefix_empty_query_lists_all_distinct_limited() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "a.md").await;
    seed_file(&conn, "b.md").await;
    // Same tag on two files must collapse to one DISTINCT row.
    replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline)])
        .await
        .unwrap();
    replace_tags_for_file(&conn, "b.md", &[row("todo", TagSource::Frontmatter)])
        .await
        .unwrap();
    replace_tags_for_file(&conn, "a.md", &[row("todo", TagSource::Inline), row("area", TagSource::Inline)])
        .await
        .unwrap();

    let all = tag_paths_for_prefix(&conn, "", 50).await.unwrap();
    assert_eq!(all, vec!["area".to_string(), "todo".to_string()]);

    let limited = tag_paths_for_prefix(&conn, "", 1).await.unwrap();
    assert_eq!(limited, vec!["area".to_string()]);
}

#[tokio::test]
async fn tag_paths_for_prefix_escapes_like_underscore() {
    let (_dir, conn) = open_test_index().await;
    seed_file(&conn, "a.md").await;
    replace_tags_for_file(&conn, "a.md", &[row("my_tag", TagSource::Inline), row("myXtag", TagSource::Inline)])
        .await
        .unwrap();
    // `_` in the query must be escaped, so it does not match `myXtag`.
    let got = tag_paths_for_prefix(&conn, "my_", 50).await.unwrap();
    assert_eq!(got, vec!["my_tag".to_string()]);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p cubical-index tags::tests::tag_paths_for_prefix -- --nocapture`
Expected: FAIL to compile — `tag_paths_for_prefix` does not exist.

- [ ] **Step 3: Implement the helper**

Add to `crates/cubical-index/src/tags.rs` (near `files_for_tag_prefix`, reusing the existing private `escape_like_literal` already defined in that file):

```rust
/// Distinct tag paths whose lowercased form starts with `query`
/// (case-insensitive prefix), ordered by `tag_path`, capped at `limit`.
/// An empty `query` returns the first `limit` distinct tag paths. Case
/// is preserved as written (display); matching is case-insensitive.
///
/// Backs the `#` tag-autocomplete command (L3 Session F, spec §2.6).
pub async fn tag_paths_for_prefix(
    conn: &IndexConn,
    query: &str,
    limit: u32,
) -> Result<Vec<String>, IndexError> {
    let needle = query.to_lowercase();
    let prefix_like = format!("{}%", escape_like_literal(&needle));
    let mut rows = conn
        .connection()
        .query(
            "SELECT DISTINCT tag_path FROM tags \
             WHERE ?1 = '' OR LOWER(tag_path) LIKE ?2 ESCAPE '\\' \
             ORDER BY tag_path \
             LIMIT ?3",
            params![needle, prefix_like, i64::from(limit)],
        )
        .await?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().await? {
        out.push(row.get::<String>(0)?);
    }
    Ok(out)
}
```

- [ ] **Step 4: Re-export from the crate root**

In `crates/cubical-index/src/lib.rs`, add `tag_paths_for_prefix` to the `pub use tags::{…}` list:

```rust
pub use tags::{
    files_for_tag_prefix, replace_tags_for_file, tag_paths_for_prefix, tags_for_file, TagRow,
    TagSource,
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p cubical-index tags::tests::tag_paths_for_prefix -- --nocapture`
Expected: PASS (all three tests).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-index/src/tags.rs crates/cubical-index/src/lib.rs
git commit -m "feat(index): tag_paths_for_prefix — distinct tags for tag autocomplete"
```

---

### Task 3: Wire types + `link_autocomplete` / `tag_autocomplete` handlers

**Files:**
- Modify: `crates/cubical-app/src/api/types.rs`
- Create: `crates/cubical-app/src/commands/autocomplete.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs`

- [ ] **Step 1: Add the wire types**

In `crates/cubical-app/src/api/types.rs`, add (after the `query_tag_page` section, before `close_vault`). Match the existing `#[derive(...)]` conventions in that file — requests derive `Deserialize`, responses + nested rows derive `Serialize`:

```rust
// -- link_autocomplete / tag_autocomplete (L3 Session F) -----------------

/// Request payload for `link_autocomplete`.
#[derive(Debug, Clone, Deserialize)]
pub struct LinkAutocompleteRequest {
    /// Vault whose file index to query.
    pub vault_id: String,
    /// Substring typed after `[[`. Empty means "list the first page".
    pub query: String,
}

/// Response payload for `link_autocomplete`.
#[derive(Debug, Clone, Serialize)]
pub struct LinkAutocompleteResponse {
    /// Candidate files, ordered by path, capped server-side.
    pub candidates: Vec<LinkCandidate>,
}

/// One link-autocomplete candidate.
#[derive(Debug, Clone, Serialize)]
pub struct LinkCandidate {
    /// Vault-relative path — inserted as the wiki-link target.
    pub path: String,
    /// Display title — basename minus `.md`. Shown as the dropdown label.
    pub title: String,
}

/// Request payload for `tag_autocomplete`.
#[derive(Debug, Clone, Deserialize)]
pub struct TagAutocompleteRequest {
    /// Vault whose tag index to query.
    pub vault_id: String,
    /// Prefix typed after `#`. Empty means "list the first page".
    pub query: String,
}

/// Response payload for `tag_autocomplete`.
#[derive(Debug, Clone, Serialize)]
pub struct TagAutocompleteResponse {
    /// Candidate tag paths (no leading `#`), ordered, capped server-side.
    pub candidates: Vec<String>,
}
```

- [ ] **Step 2: Write the failing handler tests**

Create `crates/cubical-app/src/commands/autocomplete.rs` with ONLY the tests first (so the step fails to compile), modeled on `commands/tags.rs`'s test module (which has `fresh_state_with_vault`, `seed_file`, and a `tag(path, source)` helper — copy those helpers verbatim into this file's test module):

```rust
//! Pure async handlers for `link_autocomplete` + `tag_autocomplete`.
//!
//! Both are thin: pull the open vault, call the read-only index helper
//! (`files_for_link_query` / `tag_paths_for_prefix`), map to wire types.
//! See `docs/layer-3-spec.md` §2.6 + §8 Session F.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{AppState, OpenVault, ScanStatusBackend};
    use cubical_core::Vault;
    use cubical_index::{replace_tags_for_file, TagRow, TagSource};
    use tempfile::{tempdir, TempDir};
    use tokio_util::sync::CancellationToken;

    async fn fresh_state_with_vault(vault_id: &str) -> (TempDir, Vault, AppState) {
        let dir = tempdir().unwrap();
        let vault = Vault::open(dir.path()).await.expect("open");
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
        (dir, vault, state)
    }

    async fn seed_file(vault: &Vault, rel: &str, type_id: &str) {
        vault
            .index()
            .connection()
            .execute(
                "INSERT INTO files (
                    path, type_id, size_bytes, mtime_unix, content_hash,
                    inode, last_seen, created_at, updated_at
                ) VALUES (?1, ?2, 0, 0, '', NULL, 0, 0, 0)",
                libsql::params![rel, type_id],
            )
            .await
            .expect("seed files row");
    }

    fn tag(path: &str, source: TagSource) -> TagRow {
        TagRow { tag_path: path.into(), source }
    }

    #[tokio::test]
    async fn link_autocomplete_returns_titled_candidates() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "notes/Project Cubical.md", "markdown").await;
        seed_file(&vault, "image.png", "binary").await;

        let resp = link_autocomplete(
            &state,
            LinkAutocompleteRequest { vault_id: "v1".into(), query: "cub".into() },
        )
        .await
        .expect("ok");
        assert_eq!(resp.candidates.len(), 1);
        assert_eq!(resp.candidates[0].path, "notes/Project Cubical.md");
        assert_eq!(resp.candidates[0].title, "Project Cubical");
    }

    #[tokio::test]
    async fn tag_autocomplete_returns_prefix_matches() {
        let (_dir, vault, state) = fresh_state_with_vault("v1").await;
        seed_file(&vault, "a.md", "markdown").await;
        replace_tags_for_file(
            vault.index(),
            "a.md",
            &[tag("project", TagSource::Inline), tag("done", TagSource::Inline)],
        )
        .await
        .unwrap();

        let resp = tag_autocomplete(
            &state,
            TagAutocompleteRequest { vault_id: "v1".into(), query: "pro".into() },
        )
        .await
        .expect("ok");
        assert_eq!(resp.candidates, vec!["project".to_string()]);
    }

    #[tokio::test]
    async fn unknown_vault_errors() {
        let (_dir, _vault, state) = fresh_state_with_vault("v1").await;
        let err = link_autocomplete(
            &state,
            LinkAutocompleteRequest { vault_id: "ghost".into(), query: "x".into() },
        )
        .await
        .expect_err("vault-not-open");
        assert!(matches!(err, crate::error::CubicalError::VaultNotOpen(v) if v == "ghost"));
    }
}
```

- [ ] **Step 3: Register the module so it compiles**

In `crates/cubical-app/src/commands/mod.rs`, add the module declaration (keep the list alphabetical with the others):

```rust
pub mod autocomplete;
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cargo test -p cubical-app commands::autocomplete -- --nocapture`
Expected: FAIL to compile — `link_autocomplete` / `tag_autocomplete` are not defined.

- [ ] **Step 5: Implement the handlers**

Add the handler bodies + imports at the TOP of `crates/cubical-app/src/commands/autocomplete.rs` (above the `#[cfg(test)] mod tests`):

```rust
use std::path::Path;

use cubical_index::{files_for_link_query, tag_paths_for_prefix};

use crate::api::types::{
    LinkAutocompleteRequest, LinkAutocompleteResponse, LinkCandidate, TagAutocompleteRequest,
    TagAutocompleteResponse,
};
use crate::error::CubicalError;
use crate::state::AppState;

/// Server-side cap on candidates returned per request. Keeps the
/// dropdown responsive and the IPC payload small; the user narrows by
/// typing more, which re-queries.
const AUTOCOMPLETE_LIMIT: u32 = 50;

/// Display title for a candidate: the basename minus `.md`, falling
/// back to the full path when no terminal segment exists. Mirrors
/// `commands::tags::derive_title`.
fn derive_title(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| path.to_string())
}

/// File candidates for the `[[` link-autocomplete dropdown.
pub async fn link_autocomplete(
    state: &AppState,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let paths = files_for_link_query(open.vault.index(), &req.query, AUTOCOMPLETE_LIMIT).await?;
    let candidates = paths
        .into_iter()
        .map(|path| {
            let title = derive_title(&path);
            LinkCandidate { path, title }
        })
        .collect();
    Ok(LinkAutocompleteResponse { candidates })
}

/// Tag candidates for the `#` tag-autocomplete dropdown.
pub async fn tag_autocomplete(
    state: &AppState,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, CubicalError> {
    let guard = state.vaults().read().await;
    let open = guard
        .get(&req.vault_id)
        .ok_or_else(|| CubicalError::VaultNotOpen(req.vault_id.clone()))?;

    let candidates = tag_paths_for_prefix(open.vault.index(), &req.query, AUTOCOMPLETE_LIMIT).await?;
    Ok(TagAutocompleteResponse { candidates })
}
```

> If the compiler reports `CubicalError::VaultNotOpen`'s shape differs, open `crates/cubical-app/src/error.rs` and match the real variant used by `commands::tags::query_tag_page` (copied above). If `?` on the index call fails to convert `IndexError` into `CubicalError`, check how `query_tag_page` propagates it — it relies on a `From<IndexError> for CubicalError` impl that already exists; the same `?` works here.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p cubical-app commands::autocomplete -- --nocapture`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-app/src/api/types.rs crates/cubical-app/src/commands/autocomplete.rs crates/cubical-app/src/commands/mod.rs
git commit -m "feat(app): link_autocomplete + tag_autocomplete handlers"
```

---

### Task 4: Tauri shims + handler registration

**Files:**
- Modify: `crates/cubical-app/src/lib.rs`

- [ ] **Step 1: Import the new request/response types**

In `crates/cubical-app/src/lib.rs`, the `use crate::api::types::{…}` import block lists the wire types used by the shims. Add the four new types to it:

```rust
    LinkAutocompleteRequest, LinkAutocompleteResponse, TagAutocompleteRequest,
    TagAutocompleteResponse,
```

(Insert them into the existing `use crate::api::types::{ … };` block — find it near the top of `lib.rs`; it already imports `QueryTagPageRequest`, `GetBacklinksRequest`, etc.)

- [ ] **Step 2: Add the two shims**

Add after the `query_tag_page` shim in `crates/cubical-app/src/lib.rs`:

```rust
/// Tauri shim — see [`commands::autocomplete::link_autocomplete`].
#[tauri::command]
async fn link_autocomplete(
    state: tauri::State<'_, AppState>,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, CubicalError> {
    commands::autocomplete::link_autocomplete(state.inner(), req).await
}

/// Tauri shim — see [`commands::autocomplete::tag_autocomplete`].
#[tauri::command]
async fn tag_autocomplete(
    state: tauri::State<'_, AppState>,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, CubicalError> {
    commands::autocomplete::tag_autocomplete(state.inner(), req).await
}
```

- [ ] **Step 3: Register them in the handler list**

In the `tauri::generate_handler![…]` array, add both names (after `query_tag_page,`):

```rust
            link_autocomplete,
            tag_autocomplete,
```

- [ ] **Step 4: Build the app crate to verify wiring compiles**

Run: `cargo build -p cubical-app`
Expected: clean build (the `generate_handler!` macro fails loudly if a name is missing or a type isn't `Serialize`/`Deserialize`).

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-app/src/lib.rs
git commit -m "feat(app): register link/tag autocomplete Tauri commands"
```

---

### Task 5: Frontend IPC bindings

**Files:**
- Modify: `ui/src/api/ipc.ts`

- [ ] **Step 1: Add the wire types**

In `ui/src/api/ipc.ts`, add after the `query_tag_page` section (keep the "mirror the Rust structs" convention):

```ts
// ---------------------------------------------------------------------------
// link_autocomplete / tag_autocomplete (L3 Session F)
// ---------------------------------------------------------------------------

export interface LinkAutocompleteRequest {
  vault_id: string;
  /** Substring typed after `[[`. Empty lists the first page. */
  query: string;
}

/** One link-autocomplete candidate. */
export interface LinkCandidate {
  /** Vault-relative path — inserted as the wiki-link target. */
  path: string;
  /** Basename minus `.md` — shown as the dropdown label. */
  title: string;
}

export interface LinkAutocompleteResponse {
  candidates: LinkCandidate[];
}

export interface TagAutocompleteRequest {
  vault_id: string;
  /** Prefix typed after `#`. Empty lists the first page. */
  query: string;
}

export interface TagAutocompleteResponse {
  /** Tag paths without the leading `#`. */
  candidates: string[];
}
```

- [ ] **Step 2: Add the command functions**

In the Commands section of `ui/src/api/ipc.ts` (after `queryTagPage`):

```ts
/**
 * Candidate files for the `[[` link-autocomplete dropdown — markdown
 * paths matching `query` as a case-insensitive substring. Empty list
 * when nothing matches.
 */
export function linkAutocomplete(
  req: LinkAutocompleteRequest,
): Promise<LinkAutocompleteResponse> {
  return invoke("link_autocomplete", { req });
}

/**
 * Candidate tags for the `#` tag-autocomplete dropdown — distinct tag
 * paths whose lowercased form starts with `query`. Empty list when
 * nothing matches.
 */
export function tagAutocomplete(
  req: TagAutocompleteRequest,
): Promise<TagAutocompleteResponse> {
  return invoke("tag_autocomplete", { req });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean (no usages yet, but the new code must type-check).

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/ipc.ts
git commit -m "feat(ui): IPC bindings for link/tag autocomplete"
```

---

### Task 6: Pure autocomplete logic — trigger detection, insert text, gating, sources

**Files:**
- Create: `ui/src/editor/autocomplete.ts`
- Create: `ui/src/editor/autocompleteProvider.ts`
- Test: `ui/src/editor/autocomplete.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/editor/autocomplete.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { CompletionContext } from "@codemirror/autocomplete";

import {
  detectLinkTrigger,
  detectTagTrigger,
  linkInsertion,
  linkCompletionSource,
  tagCompletionSource,
} from "./autocomplete";
import type { AutocompleteProvider } from "./autocompleteProvider";

describe("detectLinkTrigger", () => {
  it("matches an open [[ with an empty query", () => {
    expect(detectLinkTrigger("see [[", 6)).toEqual({ query: "", from: 6 });
  });
  it("captures the partial target", () => {
    expect(detectLinkTrigger("x [[fo", 6)).toEqual({ query: "fo", from: 4 });
  });
  it("returns null once the link is closed", () => {
    expect(detectLinkTrigger("[[a]] ", 6)).toBeNull();
  });
  it("stops at a pipe (display) — no link trigger past it", () => {
    expect(detectLinkTrigger("[[a|", 4)).toBeNull();
  });
  it("stops at a hash (anchor) — no link trigger past it", () => {
    expect(detectLinkTrigger("[[a#", 4)).toBeNull();
  });
  it("returns null without an opener", () => {
    expect(detectLinkTrigger("no brackets here", 16)).toBeNull();
  });
});

describe("detectTagTrigger", () => {
  it("matches a bare # at start of line", () => {
    expect(detectTagTrigger("#", 1)).toEqual({ query: "", from: 1 });
  });
  it("matches # after whitespace with a partial body", () => {
    expect(detectTagTrigger("a #pr", 5)).toEqual({ query: "pr", from: 3 });
  });
  it("captures nested tag bodies", () => {
    expect(detectTagTrigger("#pr/su", 6)).toEqual({ query: "pr/su", from: 1 });
  });
  it("returns null when # is not at a word boundary", () => {
    expect(detectTagTrigger("a#pr", 4)).toBeNull();
  });
});

describe("linkInsertion", () => {
  it("adds the closing ]] when none follows", () => {
    expect(linkInsertion("notes/a.md", false)).toEqual({
      insert: "notes/a.md]]",
      cursorAfter: 12,
    });
  });
  it("omits the closer when ]] already follows the cursor", () => {
    expect(linkInsertion("notes/a.md", true)).toEqual({
      insert: "notes/a.md",
      cursorAfter: 10,
    });
  });
});

// --- Source integration (headless: EditorState + CompletionContext) -------

const fakeProvider = (
  links: { path: string; title: string }[],
  tags: string[],
): AutocompleteProvider => ({
  links: async () => links,
  tags: async () => tags,
});

function ctxAt(doc: string, pos: number): CompletionContext {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return new CompletionContext(state, pos, false);
}

describe("linkCompletionSource", () => {
  it("returns candidates inside a paragraph", async () => {
    const src = linkCompletionSource(
      fakeProvider([{ path: "a.md", title: "a" }], []),
    );
    const res = await src(ctxAt("see [[a", 7));
    expect(res).not.toBeNull();
    expect(res!.from).toBe(6);
    expect(res!.options.map((o) => o.label)).toContain("a");
  });

  it("is suppressed inside a fenced code block", async () => {
    const src = linkCompletionSource(
      fakeProvider([{ path: "a.md", title: "a" }], []),
    );
    const doc = "```\n[[a\n```\n";
    const res = await src(ctxAt(doc, 6)); // inside the fence, after [[a
    expect(res).toBeNull();
  });
});

describe("tagCompletionSource", () => {
  it("returns tag candidates in a paragraph", async () => {
    const src = tagCompletionSource(fakeProvider([], ["project"]));
    const res = await src(ctxAt("#pr", 3));
    expect(res).not.toBeNull();
    expect(res!.options.map((o) => o.label)).toContain("project");
  });

  it("is suppressed inside inline code", async () => {
    const src = tagCompletionSource(fakeProvider([], ["project"]));
    // `#pr` is preceded by a space INSIDE the code span, so trigger
    // detection succeeds (word boundary) and gating is what rejects it.
    const doc = "a `x #pr` b";
    const res = await src(ctxAt(doc, 8)); // caret after `r`, inside InlineCode
    expect(res).toBeNull();
  });
});
```

> Note on the gating tests: they rely on the standard `@lezer/markdown` node names `FencedCode` and `InlineCode`. If a node name differs in this CM version, the gating helper (Step 3) and these tests must use the actual names — log the syntax tree (`syntaxTree(state).topNode.toString()`) once to confirm. The deny-set approach is what matters; the exact strings are verifiable.

- [ ] **Step 2: Create the provider type (needed for the tests to import)**

Create `ui/src/editor/autocompleteProvider.ts`:

```ts
/**
 * Per-vault autocomplete adapter (L3 Session F, spec §2.6).
 *
 * Mirrors `createWikiLinkResolver`: one provider is bound to the open
 * vault and injected into the editor. It is a thin async wrapper over
 * the `link_autocomplete` / `tag_autocomplete` IPC. No caching — CM6's
 * `validFor` handles in-place filtering between keystrokes, and the
 * dropdown is short-lived, so each fresh trigger re-queries.
 */

import {
  linkAutocomplete as defaultLinkAutocomplete,
  tagAutocomplete as defaultTagAutocomplete,
  type LinkAutocompleteRequest,
  type LinkAutocompleteResponse,
  type LinkCandidate,
  type TagAutocompleteRequest,
  type TagAutocompleteResponse,
} from "../api/ipc";

export interface AutocompleteProvider {
  /** Files matching `query` (substring). Empty array on failure. */
  links: (query: string) => Promise<LinkCandidate[]>;
  /** Tags matching `query` (prefix). Empty array on failure. */
  tags: (query: string) => Promise<string[]>;
}

/**
 * Build a provider bound to one vault. `linkIpc` / `tagIpc` are injected
 * so tests can stub them; production passes the `api/ipc.ts` functions.
 * Failures resolve to an empty list so a transient IPC error just shows
 * no candidates rather than throwing into CM's completion pipeline.
 */
export function createAutocompleteProvider(
  vaultId: string,
  linkIpc: (
    req: LinkAutocompleteRequest,
  ) => Promise<LinkAutocompleteResponse> = defaultLinkAutocomplete,
  tagIpc: (
    req: TagAutocompleteRequest,
  ) => Promise<TagAutocompleteResponse> = defaultTagAutocomplete,
): AutocompleteProvider {
  return {
    async links(query) {
      try {
        const resp = await linkIpc({ vault_id: vaultId, query });
        return resp.candidates;
      } catch {
        return [];
      }
    },
    async tags(query) {
      try {
        const resp = await tagIpc({ vault_id: vaultId, query });
        return resp.candidates;
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/editor/autocomplete.test.ts`
Expected: FAIL — `./autocomplete` module not found / exports missing.

- [ ] **Step 4: Implement `ui/src/editor/autocomplete.ts`**

```ts
/**
 * Link + tag autocomplete for the editor (L3 Session F, spec §2.6).
 *
 * Trigger detection and insert-text construction are pure (unit-tested
 * in autocomplete.test.ts). The two `CompletionSource`s combine pure
 * detection + Lezer "inside code" gating + an injected
 * {@link AutocompleteProvider} (the IPC adapter). Anchors/block-ids
 * inside `[[…#…]]` are intentionally NOT completed here — the link
 * trigger stops at `#`/`|`; in-bracket anchor completion is a later
 * session (needs the L3 Session G blocks table).
 */

import type { CompletionContext, CompletionResult, CompletionSource } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

import type { AutocompleteProvider } from "./autocompleteProvider";

export interface Trigger {
  /** The text typed after the trigger, used to query candidates. */
  query: string;
  /** Absolute doc offset where the query starts (the completion `from`). */
  from: number;
}

/**
 * Detect a `[[` link trigger ending at `pos`. `before` is the text from
 * the start of the current line up to `pos`. Returns the target query
 * (chars after the last unclosed `[[`, stopping before `]`, `|`, `#`,
 * or newline) and where it begins, or null when the cursor is not
 * inside an open, target-position `[[`.
 */
export function detectLinkTrigger(before: string, pos: number): Trigger | null {
  // Unclosed `[[` followed only by valid target chars (no closing `]`,
  // no `|` display, no `#` anchor, no newline).
  const m = /\[\[([^\]\n|#]*)$/.exec(before);
  if (!m) return null;
  const query = m[1];
  return { query, from: pos - query.length };
}

/**
 * Detect a `#` tag trigger ending at `pos`. The `#` must be at a word
 * boundary (start of `before`, or preceded by whitespace) and followed
 * only by valid tag-body chars (`[A-Za-z0-9_/-]`). Returns the body
 * typed so far and where it begins, or null.
 */
export function detectTagTrigger(before: string, pos: number): Trigger | null {
  const m = /(?:^|\s)#([A-Za-z0-9_/-]*)$/.exec(before);
  if (!m) return null;
  const query = m[1];
  return { query, from: pos - query.length };
}

/**
 * Build the text to insert when a link candidate is chosen. Appends the
 * closing `]]` unless it already follows the cursor. `cursorAfter` is
 * the offset (relative to the insert start) where the caret should land.
 */
export function linkInsertion(
  path: string,
  closerFollows: boolean,
): { insert: string; cursorAfter: number } {
  const insert = closerFollows ? path : `${path}]]`;
  return { insert, cursorAfter: path.length + (closerFollows ? 0 : 2) };
}

/** Lezer node names that suppress autocomplete (raw / code contexts). */
const CODE_NODES = new Set([
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "InlineCode",
  "Comment",
  "CommentBlock",
  "HTMLBlock",
  "HTMLTag",
]);

/**
 * True when `pos` sits inside a code/raw context (and, when
 * `denyWikiLink`, inside a `WikiLink` node — a `#` there is an anchor,
 * not a tag). Walks the resolved node's ancestor chain.
 */
export function isInhibited(
  state: EditorState,
  pos: number,
  denyWikiLink: boolean,
): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1);
  while (node) {
    if (CODE_NODES.has(node.name)) return true;
    if (denyWikiLink && node.name === "WikiLink") return true;
    node = node.parent;
  }
  return false;
}

/** Read the current line's text from its start up to `pos`. */
function lineBefore(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos);
  return line.text.slice(0, pos - line.from);
}

/** `[[` link-completion source backed by `provider.links`. */
export function linkCompletionSource(
  provider: AutocompleteProvider,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = lineBefore(context.state, context.pos);
    const trig = detectLinkTrigger(before, context.pos);
    if (!trig) return null;
    if (isInhibited(context.state, context.pos, false)) return null;

    const candidates = await provider.links(trig.query);
    if (candidates.length === 0) return null;

    const after = context.state.sliceDoc(context.pos, context.pos + 2);
    const closerFollows = after === "]]";

    return {
      from: trig.from,
      options: candidates.map((c) => ({
        label: c.title,
        detail: c.path,
        apply: (view, _completion, from, to) => {
          const { insert, cursorAfter } = linkInsertion(c.path, closerFollows);
          view.dispatch({
            changes: { from, to, insert },
            selection: { anchor: from + cursorAfter },
          });
        },
      })),
      validFor: /^[^\]\n|#]*$/,
    };
  };
}

/** `#` tag-completion source backed by `provider.tags`. */
export function tagCompletionSource(
  provider: AutocompleteProvider,
): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = lineBefore(context.state, context.pos);
    const trig = detectTagTrigger(before, context.pos);
    if (!trig) return null;
    if (isInhibited(context.state, context.pos, true)) return null;

    const candidates = await provider.tags(trig.query);
    if (candidates.length === 0) return null;

    return {
      from: trig.from,
      options: candidates.map((tag) => ({ label: tag, apply: tag })),
      validFor: /^[A-Za-z0-9_/-]*$/,
    };
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/editor/autocomplete.test.ts`
Expected: PASS. If a gating test fails, log `syntaxTree(state).topNode.toString()` for the failing doc, correct the node name(s) in `CODE_NODES`, and re-run.

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/autocomplete.ts ui/src/editor/autocompleteProvider.ts ui/src/editor/autocomplete.test.ts
git commit -m "feat(ui): pure link/tag autocomplete logic + completion sources"
```

---

### Task 7: Wire autocomplete into the editor + app

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/src/Editor.tsx`
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the direct dependency**

In `ui/package.json`, add to `dependencies` (it is already installed transitively, so no reinstall needed — but make it explicit; keep the list alphabetical):

```json
    "@codemirror/autocomplete": "^6.18.0",
```

Verify the version actually present, then pin to it:

Run: `cd ui && node -p "require('@codemirror/autocomplete/package.json').version"`
Use that version (with a `^`) in `package.json` if `^6.18.0` doesn't match.

- [ ] **Step 2: Add the prop + compartment + extension in `Editor.tsx`**

In `ui/src/Editor.tsx`:

1. Add imports near the other editor imports:

```ts
import { autocompletion } from "@codemirror/autocomplete";
import {
  linkCompletionSource,
  tagCompletionSource,
} from "./editor/autocomplete";
import type { AutocompleteProvider } from "./editor/autocompleteProvider";
```

2. Add a compartment next to the others (`decorationCompartment`, etc.):

```ts
/**
 * Holds the autocomplete extension. Reconfigured when the per-vault
 * {@link AutocompleteProvider} prop changes (a different vault opens),
 * so the `[[` / `#` completion sources always query the right vault.
 * `null` provider → no-op (`[]`), so the editor works with no vault.
 */
const autocompleteCompartment = new Compartment();
```

3. Add a helper above the component that turns a provider into the extension:

```ts
/** Build the autocomplete extension for a provider, or a no-op when null. */
const autocompleteExtensionFor = (
  provider: AutocompleteProvider | null | undefined,
) =>
  provider
    ? autocompletion({
        override: [
          linkCompletionSource(provider),
          tagCompletionSource(provider),
        ],
      })
    : [];
```

4. Add the prop to `EditorProps`:

```ts
  /**
   * Per-vault autocomplete provider (L3 Session F). `null` when no
   * vault is open — `[[` / `#` complete nothing.
   */
  autocompleteProvider?: AutocompleteProvider | null;
```

5. Install the compartment in the `EditorState.create({ extensions: [...] })` array (right after the `wikilinkResolverCompartment.of(...)` entry):

```ts
          autocompleteCompartment.of(
            autocompleteExtensionFor(props.autocompleteProvider),
          ),
```

6. Add a `createEffect` to reconfigure on prop change (next to the other `createEffect`s, e.g. after the `wikilinkResolver` one):

```ts
  // Swap the autocomplete provider when the parent's prop changes (a
  // different vault is open). Reconfigure the compartment so the
  // completion sources close over the new vault id.
  createEffect(
    on(
      () => props.autocompleteProvider,
      (provider) => {
        view?.dispatch({
          effects: autocompleteCompartment.reconfigure(
            autocompleteExtensionFor(provider),
          ),
        });
      },
      { defer: true },
    ),
  );
```

- [ ] **Step 3: Wire the provider in `App.tsx`**

In `ui/src/App.tsx`:

1. Add the import (next to the `createWikiLinkResolver` import block, ~line 32):

```ts
import {
  createAutocompleteProvider,
  type AutocompleteProvider,
} from "./editor/autocompleteProvider";
```

2. Add a signal next to `wikilinkResolver` (~line 161):

```ts
  const [autocompleteProvider, setAutocompleteProvider] =
    createSignal<AutocompleteProvider | null>(null);
```

3. Set it wherever `setWikilinkResolver(createWikiLinkResolver(resp.vault_id))` is called (~line 714), immediately after:

```ts
      setAutocompleteProvider(createAutocompleteProvider(resp.vault_id));
```

4. Clear it wherever `wikilinkResolver` is cleared on vault close/reset. Find those sites:

Run: `grep -n "setWikilinkResolver(null)" ui/src/App.tsx`

Add `setAutocompleteProvider(null);` immediately after each `setWikilinkResolver(null);`. (If `wikilinkResolver` is never explicitly nulled — i.e. the app replaces it on the next open and there is no close-to-empty path — skip this; do NOT invent a close path.)

5. Pass the prop to `<Editor>` (~line 1158, next to `wikilinkResolver={wikilinkResolver()}`):

```ts
                  autocompleteProvider={autocompleteProvider()}
```

- [ ] **Step 4: Typecheck + build**

Run:
```bash
cd ui && npx tsc --noEmit && npm run build
```
Expected: both clean.

- [ ] **Step 5: Run the full vitest suite**

Run: `cd ui && npx vitest run`
Expected: PASS (all suites, including the new `autocomplete.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add ui/package.json ui/src/Editor.tsx ui/src/App.tsx
git commit -m "feat(ui): wire link/tag autocomplete into the editor"
```

---

### Task 8: Full verification, docs, finish branch

- [ ] **Step 1: Whole workspace Rust test suite**

Run: `cargo test --workspace`
Expected: PASS, 0 failures. (Known flake: `commands::vault::tests::get_setting_returns_none_for_absent_key` is parallel-execution-sensitive — if it fails, re-run in isolation: `cargo test -p cubical-app commands::vault::tests::get_setting_returns_none_for_absent_key`.)

- [ ] **Step 2: Lint + format + frontend gates**

Run, expecting all clean:
```bash
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
( cd ui && npx tsc --noEmit && npx vitest run && npm run build )
```

- [ ] **Step 3: Real-app smoke**

```bash
cargo build -p cubical-app
# then: cargo tauri dev, open a vault with several notes + tags.
#  - Type `[[` → a dropdown of files appears; pick one → `[[path]]`
#    is inserted with the caret after `]]`.
#  - Type `#` at the start of a word → a dropdown of existing tags
#    appears; pick one → `#tag` is inserted.
#  - Inside a fenced code block, `[[` and `#` must NOT trigger.
```
If hands-on `cargo tauri dev` isn't possible in your environment, record that honestly — the unit + headless-source tests (trigger detection, insert text, code-context gating, handler behavior) already prove the logic; the smoke only confirms wall-clock feel and the CM dropdown wiring.

- [ ] **Step 4: Update docs + state**

- In `docs/layer-3-spec.md` §9, add a `### 9.x Session F — Link + tag autocomplete` closeout entry (mirror the §9.5 / §9.6 style): what landed (two index helpers, two handlers + IPC, the pure detection/gating logic, the provider injection), the key decisions (DoD-scoped to files + tags; in-bracket anchor completion deferred to a post-G session; no caching — `validFor` handles inter-keystroke filtering; server-side `AUTOCOMPLETE_LIMIT = 50`), tests added, and the smoke status.
- In `docs/layer-3-spec.md` §8 "Session F", you may mark the session done in whatever convention the file uses for completed sessions (check how A–E are marked).
- Rewrite the `CLAUDE.md` "Project state" block (do not append): Sessions A–F done; update test counts; set "Next: L3 Session G — Block references."

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **DoD is the contract.** Files + tags only. The `detectLinkTrigger` regex deliberately stops at `#`/`|` so it never tries to complete an anchor — that's the documented scope edge, not a bug. Do not "also add heading completion while here": headings aren't indexed and block-ids need Session G's `blocks` table.
- **Mirror, don't invent.** Every Rust piece copies an existing pattern: index helper → `files_for_tag_prefix`; handler → `query_tag_page`; shim → the `query_tag_page` shim; wire types → `QueryTagPage*`. Every frontend piece mirrors the wiki-link resolver: `createAutocompleteProvider` ↔ `createWikiLinkResolver`, the `autocompleteProvider` prop + compartment ↔ the `wikilinkResolver` prop + compartment.
- **Gating is the "correct trigger gating" half of the DoD.** The `isInhibited` deny-set is the guard; the two headless source tests (fenced code, inline code) pin it. If `@lezer/markdown` node names differ from the assumed set, fix `CODE_NODES` to the real names — the mechanism is right regardless of the strings.
- **LIKE escaping is load-bearing.** Both index helpers escape `_`/`%`/`\` — the tag grammar allows `_`, so an unescaped `_` would silently widen matches. Tests pin this.
- **No new migration, no schema change, no `invoke()` outside `ipc.ts`, watcher + parsers untouched.** All four scope boundaries are verifiable by `git diff --stat`.
