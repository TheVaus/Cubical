# L4 Session A — Tantivy full-text search backend

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Tantivy-backed full-text search to Cubical as a backend-only session: new content in `cubical-search`, indexing piped through the existing scan + watcher fan-out, query exposed via four Tauri IPC commands. No UI ships; the index is exercised through dev-console IPC during smoke.

**Architecture:** `cubical-search` becomes the Tantivy wrapper (depends only on `cubical-ast` + `tantivy`). One Tantivy doc per `.md` file, with structural fields (`title`, `headings`, `body`, `code`, `tags`, `frontmatter`) plus `mtime_secs` / `size_bytes` / `path`. Two tokenizers: `en_stem` for prose, `code` (`SimpleTokenizer` + lowercase, no stemmer) for symbol-heavy code. Indexing rides the existing `vault/scan.rs` Pass 1 loop as a fifth refresher (`refresh_search_index`) after blocks; the watcher's `apply_watch_event_to_db` dispatcher gets the same fan-out plus a delete path. Schema-version stamp at `<vault>/.cubical/search/schema.json`; mismatch wipes and rebuilds. Single `IndexWriter`, `IndexReader` with `ReloadPolicy::Manual` reloaded after each commit.

**Tech Stack:** Rust (`cubical-search`, `cubical-core`, `cubical-app`); TypeScript / Solid (`ui/src/ipc`); Tantivy 0.22.x; Tauri 2 IPC; existing libSQL `config` table for hidden commit-interval settings.

---

## Spec references

- [`docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`](../specs/2026-06-02-l4-a-tantivy-design.md) — the full L4-A design (commits `87dc646` + `8f0a947`).
- [`docs/architecture/foundation.md`](../../architecture/foundation.md) §36 (Tantivy lock-in).
- [`docs/architecture/ui.md`](../../architecture/ui.md) §9, §61 (search panel + cross-vault carve-out).
- [`docs/layer-3-spec.md`](../../layer-3-spec.md) §5.5, §5.6, §5.7 (materialize-on-read; per-file 4-parse precedent).
- [`docs/build-order.md`](../../build-order.md) line 9 (L4 scope).

---

## File structure

**Create:**

```
crates/cubical-search/src/error.rs              # SearchError
crates/cubical-search/src/schema.rs             # Tantivy schema + field handles + tokenizer registration
crates/cubical-search/src/doc.rs                # IndexDoc projector (frontmatter + body walker)
crates/cubical-search/src/index.rs              # SearchIndex: open/upsert/delete/reader/commit
crates/cubical-search/src/status.rs             # IndexState, IndexStatus, IndexHealth
crates/cubical-search/src/query.rs              # SearchQuery, SearchHit, FieldScope, run_search

crates/cubical-core/src/vault/search_refresh.rs # async refresh_search_index wrapper

crates/cubical-app/src/commands/search.rs       # four IPC handlers

ui/src/ipc/search.ts                            # TS wrappers + types
ui/src/ipc/search.test.ts                       # vitest smoke

docs/layer-4-spec.md                            # NEW — layer-4 spec scaffold, §9.1 filled at close
~/Developer/sandbox/cubical-l4a-smoke/          # NEW smoke vault (built in Task 14)
```

**Modify:**

```
crates/cubical-search/Cargo.toml                # add tantivy = "0.22", serde for IndexHealth
crates/cubical-search/src/lib.rs                # replace skeleton, re-export modules

crates/cubical-core/Cargo.toml                  # add cubical-search dependency
crates/cubical-core/src/vault/mod.rs            # add `search: Arc<SearchIndex>` field, open it, accessor
crates/cubical-core/src/vault/scan.rs           # call refresh_search_index after refresh_blocks; commit search every 5000 docs
crates/cubical-core/src/vault/watcher.rs        # fan out to search refresh + delete in apply_watch_event_to_db

crates/cubical-app/Cargo.toml                   # add cubical-search dependency
crates/cubical-app/src/api/types.rs             # IPC request/response DTOs
crates/cubical-app/src/lib.rs                   # register four Tauri shims
crates/cubical-app/src/commands/mod.rs          # `pub mod search;`

CLAUDE.md                                       # rewrite "Project state" at session close
```

---

## Tantivy schema (the contract every later task reads)

The fields (locked in Task 3; reused by every subsequent task):

| Field name       | Type                          | Indexed | Stored | Tokenizer    |
|------------------|-------------------------------|---------|--------|--------------|
| `path`           | `STRING`                      | yes     | yes    | raw          |
| `title`          | `TEXT`                        | yes     | yes    | `en_stem`    |
| `headings`       | `TEXT`                        | yes     | no     | `en_stem`    |
| `body`           | `TEXT`                        | yes     | no     | `en_stem`    |
| `code`           | `TEXT`                        | yes     | no     | `code`       |
| `tags`           | `STRING` (multi-valued)       | yes     | yes    | raw          |
| `frontmatter`    | `TEXT`                        | yes     | no     | `en_stem`    |
| `mtime_secs`     | `i64` (`INDEXED \| STORED \| FAST`) | yes (fast) | yes | — |
| `size_bytes`     | `u64` (`INDEXED \| STORED \| FAST`) | yes (fast) | yes | — |

Tokenizers registered on the index's `TokenizerManager`:

- `en_stem`: `SimpleTokenizer` + `LowerCaser` + `Stemmer::new(Language::English)`. No stop-word filter.
- `code`: `SimpleTokenizer` + `LowerCaser`. No stemmer.

Schema-version stamp: `<vault>/.cubical/search/schema.json` containing `{"version": 1}`. Mismatch / missing / unparseable → wipe `search/` directory and rebuild.

---

## Tasks

### Task 1: Workspace deps + `cubical-search` lib scaffold

Bring Tantivy into the workspace and prepare `cubical-search`'s module tree. No feature code yet — this task just makes everything compile.

**Files:**
- Modify: `crates/cubical-search/Cargo.toml`
- Modify: `crates/cubical-search/src/lib.rs`
- Modify: `crates/cubical-core/Cargo.toml`
- Modify: `crates/cubical-app/Cargo.toml`

- [ ] **Step 1: Add deps to `crates/cubical-search/Cargo.toml`.**

```toml
[package]
name = "cubical-search"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
authors.workspace = true
description = "Tantivy wrapper. Full-text search over the canonical AST (L4-A)."

[dependencies]
cubical-ast = { path = "../cubical-ast" }
tantivy = "0.22"
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
```

- [ ] **Step 2: Replace `crates/cubical-search/src/lib.rs`.**

```rust
//! `cubical-search` — Tantivy wrapper.
//!
//! Full-text search over the canonical AST. One Tantivy document per
//! `.md` file with structural fields (`title`, `headings`, `body`,
//! `code`, `tags`, `frontmatter`). See
//! `docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod doc;
pub mod error;
pub mod index;
pub mod query;
pub mod schema;
pub mod status;

pub use doc::IndexDoc;
pub use error::SearchError;
pub use index::SearchIndex;
pub use query::{FieldScope, MatchedField, SearchHit, SearchQuery, SearchResponse, SortMode};
pub use status::{IndexHealth, IndexState, IndexStatus};
```

- [ ] **Step 3: Create empty module stubs so the lib compiles.**

For each of `doc.rs`, `error.rs`, `index.rs`, `query.rs`, `schema.rs`, `status.rs` under `crates/cubical-search/src/`, write:

```rust
//! Stub — populated in a later task.
```

This will fail to compile because of the `pub use` statements. That's expected; fix it temporarily by replacing each `pub use` line in `lib.rs` with a `#[allow(dead_code)] use` reference OR by populating Task 2/3/etc. before re-running `cargo build`. Simplest: comment the `pub use` lines out for now and uncomment as each module is fleshed out. **Add a TODO comment in `lib.rs`** noting which tasks restore each re-export.

- [ ] **Step 4: Add `cubical-search` as a dependency of `cubical-core` and `cubical-app`.**

In `crates/cubical-core/Cargo.toml` `[dependencies]`:

```toml
cubical-search = { path = "../cubical-search" }
```

In `crates/cubical-app/Cargo.toml` `[dependencies]`:

```toml
cubical-search = { path = "../cubical-search" }
```

- [ ] **Step 5: Verify workspace compiles.**

Run: `cargo build --workspace`
Expected: clean build, no errors. Warnings about unused imports in `cubical-search/src/lib.rs` are acceptable for this commit.

- [ ] **Step 6: Commit.**

```bash
git add crates/cubical-search/Cargo.toml crates/cubical-search/src/ crates/cubical-core/Cargo.toml crates/cubical-app/Cargo.toml
git commit -m "feat(l4-a): cubical-search crate scaffold + tantivy workspace dep"
```

---

### Task 2: `SearchError` type

**Files:**
- Modify: `crates/cubical-search/src/error.rs`
- Modify: `crates/cubical-search/src/lib.rs` (re-enable `pub use error::SearchError;`)

- [ ] **Step 1: Write a failing test in `crates/cubical-search/src/error.rs`.**

```rust
//! Error type for `cubical-search`.

use thiserror::Error;

/// Errors produced by the Tantivy wrapper.
#[derive(Debug, Error)]
pub enum SearchError {
    /// I/O failure (open, persist, schema.json read/write).
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Tantivy library error (open, commit, search, parse).
    #[error("tantivy: {0}")]
    Tantivy(#[from] tantivy::TantivyError),

    /// `QueryParser` rejected the user-supplied query string.
    #[error("query parse: {0}")]
    QueryParse(String),

    /// `SearchQuery.limit` exceeded the hard cap of 500.
    #[error("limit {got} exceeds maximum of {max}")]
    LimitTooLarge {
        /// What the caller asked for.
        got: usize,
        /// The hard cap (500).
        max: usize,
    },

    /// JSON failure reading/writing `schema.json`.
    #[error("schema.json: {0}")]
    SchemaJson(#[from] serde_json::Error),

    /// Internal poisoning of the writer mutex (should be unreachable in
    /// practice — surfaced as an `IpcError::Internal` upstream).
    #[error("search writer poisoned")]
    WriterPoisoned,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limit_too_large_display() {
        let e = SearchError::LimitTooLarge { got: 1000, max: 500 };
        assert_eq!(e.to_string(), "limit 1000 exceeds maximum of 500");
    }
}
```

- [ ] **Step 2: Re-enable the re-export.**

In `crates/cubical-search/src/lib.rs`, uncomment `pub use error::SearchError;`.

- [ ] **Step 3: Run the test.**

Run: `cargo test -p cubical-search error::tests`
Expected: PASS (1 test).

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-search/src/error.rs crates/cubical-search/src/lib.rs
git commit -m "feat(l4-a): SearchError type"
```

---

### Task 3: Tantivy schema + tokenizers

Define the field handles once; every later task imports them.

**Files:**
- Modify: `crates/cubical-search/src/schema.rs`
- Modify: `crates/cubical-search/src/lib.rs`

- [ ] **Step 1: Write the failing test.**

In `crates/cubical-search/src/schema.rs`:

```rust
//! Tantivy schema definition for the search index.

use tantivy::schema::{
    Field, IndexRecordOption, Schema, SchemaBuilder, TextFieldIndexing, TextOptions, FAST,
    INDEXED, STORED, STRING,
};
use tantivy::tokenizer::{LowerCaser, SimpleTokenizer, Stemmer, TextAnalyzer, TokenizerManager, Language};

/// Tokenizer name for the English-stemmed prose tokenizer.
pub const TOKENIZER_EN_STEM: &str = "en_stem";

/// Tokenizer name for the code tokenizer (lowercase, no stem).
pub const TOKENIZER_CODE: &str = "code";

/// Handles for every field in the schema.
#[derive(Debug, Clone, Copy)]
pub struct Fields {
    /// Vault-relative path. `STRING` (not tokenized); upsert/delete key.
    pub path: Field,
    /// Title text. `TEXT` + `en_stem`. Stored.
    pub title: Field,
    /// Concatenated heading text. `TEXT` + `en_stem`. Not stored.
    pub headings: Field,
    /// Prose body. `TEXT` + `en_stem`. Not stored.
    pub body: Field,
    /// Code text. `TEXT` + `code`. Not stored.
    pub code: Field,
    /// Multi-valued lowercase tag strings. `STRING`. Stored.
    pub tags: Field,
    /// Flattened frontmatter scalars. `TEXT` + `en_stem`. Not stored.
    pub frontmatter: Field,
    /// Unix seconds. `i64` `INDEXED|STORED|FAST`.
    pub mtime_secs: Field,
    /// File size in bytes. `u64` `INDEXED|STORED|FAST`.
    pub size_bytes: Field,
}

/// Build the schema (called once per `SearchIndex::open`).
pub fn build_schema() -> (Schema, Fields) {
    let mut sb = SchemaBuilder::new();

    let en_stem_indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER_EN_STEM)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);
    let code_indexing = TextFieldIndexing::default()
        .set_tokenizer(TOKENIZER_CODE)
        .set_index_option(IndexRecordOption::WithFreqsAndPositions);

    let en_stem_stored = TextOptions::default().set_indexing_options(en_stem_indexing.clone()).set_stored();
    let en_stem_not_stored = TextOptions::default().set_indexing_options(en_stem_indexing.clone());
    let code_not_stored = TextOptions::default().set_indexing_options(code_indexing);

    let path = sb.add_text_field("path", STRING | STORED);
    let title = sb.add_text_field("title", en_stem_stored);
    let headings = sb.add_text_field("headings", en_stem_not_stored.clone());
    let body = sb.add_text_field("body", en_stem_not_stored.clone());
    let code = sb.add_text_field("code", code_not_stored);
    let tags = sb.add_text_field("tags", STRING | STORED);
    let frontmatter = sb.add_text_field("frontmatter", en_stem_not_stored);
    let mtime_secs = sb.add_i64_field("mtime_secs", INDEXED | STORED | FAST);
    let size_bytes = sb.add_u64_field("size_bytes", INDEXED | STORED | FAST);

    (
        sb.build(),
        Fields {
            path,
            title,
            headings,
            body,
            code,
            tags,
            frontmatter,
            mtime_secs,
            size_bytes,
        },
    )
}

/// Register `en_stem` and `code` tokenizers on the supplied manager.
pub fn register_tokenizers(mgr: &TokenizerManager) {
    let en_stem = TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .filter(Stemmer::new(Language::English))
        .build();
    let code = TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(LowerCaser)
        .build();
    mgr.register(TOKENIZER_EN_STEM, en_stem);
    mgr.register(TOKENIZER_CODE, code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_all_expected_fields() {
        let (schema, f) = build_schema();
        assert_eq!(schema.get_field_name(f.path), "path");
        assert_eq!(schema.get_field_name(f.title), "title");
        assert_eq!(schema.get_field_name(f.headings), "headings");
        assert_eq!(schema.get_field_name(f.body), "body");
        assert_eq!(schema.get_field_name(f.code), "code");
        assert_eq!(schema.get_field_name(f.tags), "tags");
        assert_eq!(schema.get_field_name(f.frontmatter), "frontmatter");
        assert_eq!(schema.get_field_name(f.mtime_secs), "mtime_secs");
        assert_eq!(schema.get_field_name(f.size_bytes), "size_bytes");
    }

    #[test]
    fn tokenizers_register_under_expected_names() {
        let mgr = TokenizerManager::default();
        register_tokenizers(&mgr);
        assert!(mgr.get(TOKENIZER_EN_STEM).is_some(), "en_stem not registered");
        assert!(mgr.get(TOKENIZER_CODE).is_some(), "code tokenizer not registered");
    }
}
```

- [ ] **Step 2: Run the tests.**

Run: `cargo test -p cubical-search schema::tests`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit.**

```bash
git add crates/cubical-search/src/schema.rs crates/cubical-search/src/lib.rs
git commit -m "feat(l4-a): Tantivy schema + en_stem/code tokenizers"
```

---

### Task 4: `IndexDoc` simple-field projector

The "simple" fields are everything except the AST body walker: `path`, `title`, `tags`, `frontmatter`, `mtime_secs`, `size_bytes`. Body walker is Task 5.

**Files:**
- Modify: `crates/cubical-search/src/doc.rs`
- Modify: `crates/cubical-search/src/lib.rs`

- [ ] **Step 1: Write the failing test first.**

```rust
//! Project an on-disk markdown file into Tantivy fields.

use cubical_ast::{frontmatter::parse_frontmatter, parse, Document};

/// Projection of one `.md` file into the search schema.
#[derive(Debug, Clone, PartialEq)]
pub struct IndexDoc {
    /// Vault-relative path.
    pub path: String,
    /// Frontmatter `title` if a string scalar; else filename stem.
    pub title: String,
    /// Concatenated heading text.
    pub headings: String,
    /// Prose body (Task 5 fills this).
    pub body: String,
    /// Fenced + inline code text (Task 5 fills this).
    pub code: String,
    /// Lowercased tag strings.
    pub tags: Vec<String>,
    /// Flattened frontmatter scalars (`key value` pairs), excluding `title` and `tags`.
    pub frontmatter: String,
    /// File mtime in unix seconds.
    pub mtime_secs: i64,
    /// File size in bytes.
    pub size_bytes: u64,
}

/// Build the simple fields from raw source + filesystem metadata. The
/// AST is parsed locally so the caller hands only `(path, source, mtime, size)`.
///
/// `tags` are collected from frontmatter `tags:` plus inline `#tag`
/// occurrences (via `cubical_ast::tag::scan_tags`). They are lowercased
/// at projection time so the `tag:` field-prefix query parses to the
/// same form as the indexed value.
pub fn project(path: &str, source: &str, mtime_secs: i64, size_bytes: u64) -> IndexDoc {
    let doc = parse(source);
    let title = derive_title(path, &doc, source);
    let tags = collect_tags(&doc, source);
    let frontmatter = flatten_frontmatter(source);
    let headings = collect_headings(&doc);
    // body + code are filled by Task 5's walker; placeholders here.
    IndexDoc {
        path: path.to_string(),
        title,
        headings,
        body: String::new(),
        code: String::new(),
        tags,
        frontmatter,
        mtime_secs,
        size_bytes,
    }
}

fn derive_title(path: &str, doc: &Document, source: &str) -> String {
    if let Some(fm) = parse_frontmatter(source) {
        if let Some(t) = fm.get_string("title") {
            return t.to_string();
        }
    }
    // Fallback: filename stem (everything after the last `/`, with `.md` stripped).
    let stem = path.rsplit('/').next().unwrap_or(path);
    stem.strip_suffix(".md").unwrap_or(stem).to_string()
}

fn collect_tags(_doc: &Document, source: &str) -> Vec<String> {
    use cubical_ast::tag::scan_tags;
    let mut out: Vec<String> = Vec::new();
    if let Some(fm) = parse_frontmatter(source) {
        for t in fm.get_string_list("tags") {
            out.push(t.to_lowercase());
        }
    }
    for hit in scan_tags(source) {
        out.push(hit.name.to_lowercase());
    }
    out.sort();
    out.dedup();
    out
}

fn flatten_frontmatter(source: &str) -> String {
    let Some(fm) = parse_frontmatter(source) else { return String::new() };
    let mut buf = String::new();
    for (key, value) in fm.flattened_scalars() {
        if key == "title" || key == "tags" || key.starts_with("tags.") {
            continue;
        }
        if !buf.is_empty() {
            buf.push(' ');
        }
        buf.push_str(&key);
        buf.push(' ');
        buf.push_str(&value);
    }
    buf
}

fn collect_headings(_doc: &Document) -> String {
    // Filled in Task 5 (heading collection is part of the walker).
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_uses_frontmatter_when_present() {
        let src = "---\ntitle: My Note\n---\n\n# Heading\n";
        let d = project("notes/x.md", src, 0, 0);
        assert_eq!(d.title, "My Note");
    }

    #[test]
    fn title_falls_back_to_filename_stem() {
        let src = "Just prose, no frontmatter.\n";
        let d = project("Daily/2026-06-02.md", src, 0, 0);
        assert_eq!(d.title, "2026-06-02");
    }

    #[test]
    fn tags_collected_lowercased_deduped_sorted() {
        let src = "---\ntags: [Project/Cubical, Notes]\n---\n\n#project/cubical and #Notes again\n";
        let d = project("x.md", src, 0, 0);
        assert_eq!(d.tags, vec!["notes".to_string(), "project/cubical".to_string()]);
    }

    #[test]
    fn frontmatter_excludes_title_and_tags() {
        let src = "---\ntitle: T\ntags: [a]\nauthor: jane\n---\n";
        let d = project("x.md", src, 0, 0);
        assert!(d.frontmatter.contains("author"));
        assert!(d.frontmatter.contains("jane"));
        assert!(!d.frontmatter.contains(" T"));
        assert!(!d.frontmatter.contains(" a"));
    }

    #[test]
    fn mtime_and_size_pass_through() {
        let d = project("x.md", "", 1717286400, 42);
        assert_eq!(d.mtime_secs, 1717286400);
        assert_eq!(d.size_bytes, 42);
    }
}
```

- [ ] **Step 2: Check the frontmatter API surface this test depends on.**

The test calls `parse_frontmatter`, `fm.get_string`, `fm.get_string_list`, `fm.flattened_scalars`. Check that those exist in `crates/cubical-ast/src/frontmatter.rs`:

Run: `grep -n "pub fn get_string\|pub fn get_string_list\|pub fn flattened_scalars\|pub fn parse_frontmatter" crates/cubical-ast/src/frontmatter.rs`

If any of `get_string`, `get_string_list`, or `flattened_scalars` are missing, **add them** before continuing. Each addition is small (3–15 lines) — they're thin wrappers over the existing YAML value type. The test above is the contract.

If `flattened_scalars` doesn't exist, implement it as: depth-first walk over the parsed YAML, joining nested keys with `.`, stringifying each leaf scalar (bool/number/date/string), expanding sequences into repeated `(key, value)` pairs. Return type `Vec<(String, String)>` or an iterator.

- [ ] **Step 3: Re-enable the re-export.**

In `crates/cubical-search/src/lib.rs`, uncomment `pub use doc::IndexDoc;`.

- [ ] **Step 4: Run the tests.**

Run: `cargo test -p cubical-search doc::tests`
Expected: 5 PASS.

- [ ] **Step 5: Commit.**

```bash
git add crates/cubical-search/src/doc.rs crates/cubical-search/src/lib.rs crates/cubical-ast/src/frontmatter.rs
git commit -m "feat(l4-a): IndexDoc simple-field projector (title, tags, frontmatter, mtime, size)"
```

---

### Task 5: Body walker (headings, body, code)

This walks the canonical `Document` and produces three strings. The rules from the spec:

- `body` includes paragraph / list-item / blockquote / table-cell text, standard markdown image alt text, and wiki-link **display text** (alias if set, else target's last path component for block-refs).
- `body` excludes fenced + inline code (→ `code`), wiki-image embeds (`![[image.png]]`), raw `[[…]]` syntax, raw `#tag` tokens, raw `^block-id` markers, frontmatter, HTML comments, transcluded content.
- `headings` = all ATX + setext heading text joined with `\n`.
- `code` = fenced + inline code text joined with `\n`.

**Files:**
- Modify: `crates/cubical-search/src/doc.rs`

- [ ] **Step 1: Write the failing test (extend the existing `tests` module).**

Add these tests to `crates/cubical-search/src/doc.rs`'s `tests` module:

```rust
#[test]
fn headings_collected_across_levels() {
    let src = "# H1 alpha\n\n## H2 beta\n\nbody\n\n### H3 gamma\n";
    let d = project("x.md", src, 0, 0);
    assert_eq!(d.headings, "H1 alpha\nH2 beta\nH3 gamma");
}

#[test]
fn body_excludes_code_blocks_and_inline_code() {
    let src = "Prose one.\n\n```rust\nfn main() { println!(\"hi\"); }\n```\n\nProse two with `inline_code` here.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("Prose one"));
    assert!(d.body.contains("Prose two with"));
    assert!(d.body.contains("here"));
    assert!(!d.body.contains("println"));
    assert!(!d.body.contains("inline_code"));
    assert!(d.code.contains("println"));
    assert!(d.code.contains("inline_code"));
}

#[test]
fn body_uses_wikilink_display_text_alias() {
    let src = "See [[Some/Note|the doc]] for context.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("the doc"));
    assert!(!d.body.contains("[["));
    assert!(!d.body.contains("Some/Note"));
}

#[test]
fn body_uses_target_last_component_when_no_alias() {
    let src = "Refer to [[notes/Sub/Topic]] later.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("Topic"));
    assert!(!d.body.contains("notes/Sub"));
}

#[test]
fn body_block_ref_uses_target_not_resolved_content() {
    // ^abc is the block id; the body field must not try to resolve it.
    let src = "Cite [[Other#^abc]] here.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("Other"));
    assert!(!d.body.contains("^abc"));
    assert!(!d.body.contains("abc"));
}

#[test]
fn body_excludes_wiki_image_embeds() {
    let src = "Below: ![[diagram.png]] and prose after.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("Below"));
    assert!(d.body.contains("prose after"));
    assert!(!d.body.contains("diagram.png"));
    assert!(!d.body.contains("![["));
}

#[test]
fn body_includes_standard_image_alt_text() {
    let src = "Look: ![my diagram](./img.png) — and more.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("my diagram"));
}

#[test]
fn body_excludes_raw_tags_and_block_ids() {
    let src = "Some text #project/foo and a marker ^abc123\nplus more.\n";
    let d = project("x.md", src, 0, 0);
    assert!(d.body.contains("Some text"));
    assert!(d.body.contains("plus more"));
    assert!(!d.body.contains("#project"));
    assert!(!d.body.contains("project/foo"));
    assert!(!d.body.contains("^abc123"));
}
```

- [ ] **Step 2: Replace `collect_headings` and add `walk_body_code`.**

Replace the body of `crates/cubical-search/src/doc.rs`'s `collect_headings` stub and add a `walk_body_code(doc, source) -> (String, String)` plus rewrite `project` to use it. The walker iterates `cubical_ast::Block` + `Inline` and dispatches per variant:

- `Block::Heading { text, .. }` → append `text` (+ `\n` separator) to `headings`. **Do not** descend into headings for body text.
- `Block::Paragraph { inlines }`, `Block::Blockquote`, list items, table cells → walk inlines into `body`.
- `Block::CodeBlock { code, .. }` → append `code` (+ `\n`) to `code`.
- `Inline::Text(s)` → append `s` + ' ' to `body`.
- `Inline::Code(s)` → append `s` + ' ' to `code`.
- `Inline::WikiLink { target, display, embed, .. }`:
  - if `embed` (the `![[…]]` form) **and** the target ends in an image extension (`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.svg`) → **skip entirely**.
  - else compute `text = display.unwrap_or_else(|| target.rsplit('/').next().unwrap_or(target))` and append + ' ' to `body`.
- `Inline::Link { url: _, text }` (standard markdown link) → walk `text` into `body`.
- `Inline::Image { alt, .. }` (standard markdown image) → append `alt` + ' ' to `body`.
- `Inline::Tag(_)` → skip (tags belong to the `tags` field).

Use the actual variant names from `cubical_ast::types`. Check them with `grep -n "pub enum Inline\|pub enum Block" crates/cubical-ast/src/types.rs` first; adapt the dispatch if any variant differs (e.g. some codebases use `BlockId(String)` for `^id` markers — skip those too).

Update `project` to call `walk_body_code` and `collect_headings` from the same single AST walk where practical (one pass is enough). Headings already trimmed: each heading text on its own line, joined with `\n`, no trailing newline. Body and code trimmed of trailing whitespace on commit.

- [ ] **Step 3: Run the tests.**

Run: `cargo test -p cubical-search doc::tests`
Expected: 13 PASS (5 from Task 4 + 8 new).

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-search/src/doc.rs
git commit -m "feat(l4-a): body+headings+code walker honoring spec exclusions"
```

---

### Task 6: `SearchIndex` — open / persist / upsert / delete / commit

The heart of the wrapper. Schema-version stamp + tokenizer registration on open. `IndexWriter` held internally, `IndexReader` with `ReloadPolicy::Manual` reloaded after every commit.

**Files:**
- Modify: `crates/cubical-search/src/index.rs`
- Modify: `crates/cubical-search/src/lib.rs`

- [ ] **Step 1: Write the failing tests first.**

```rust
//! Tantivy index wrapper.

use crate::doc::IndexDoc;
use crate::error::SearchError;
use crate::schema::{build_schema, register_tokenizers, Fields};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};
use tantivy::collector::TopDocs;
use tantivy::query::TermQuery;
use tantivy::schema::{IndexRecordOption, Schema, Value};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

/// Current on-disk schema version. Bump on any schema change; mismatch
/// wipes `<vault>/.cubical/search/` and forces a rebuild.
pub const SCHEMA_VERSION: u32 = 1;

const SCHEMA_JSON: &str = "schema.json";

#[derive(Debug, Serialize, Deserialize)]
struct SchemaStamp {
    version: u32,
}

/// Tantivy wrapper. One per vault. Single writer, shared reader.
pub struct SearchIndex {
    dir: PathBuf,
    fields: Fields,
    schema: Schema,
    index: Index,
    writer: Mutex<IndexWriter>,
    reader: RwLock<IndexReader>,
}

impl SearchIndex {
    /// Open or create the search index at `dir`. Wipes + rebuilds the
    /// directory if `schema.json` is missing, unparseable, or carries a
    /// non-current version.
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, SearchError> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;

        // Check the stamp; wipe if mismatched.
        let stamp_path = dir.join(SCHEMA_JSON);
        let needs_wipe = match std::fs::read_to_string(&stamp_path) {
            Ok(s) => match serde_json::from_str::<SchemaStamp>(&s) {
                Ok(stamp) => stamp.version != SCHEMA_VERSION,
                Err(_) => true,
            },
            Err(_) => true,
        };
        if needs_wipe && dir.exists() {
            // Wipe contents but keep the directory itself (atomic enough; no concurrent writer at open time).
            for entry in std::fs::read_dir(&dir)? {
                let path = entry?.path();
                if path.is_dir() {
                    std::fs::remove_dir_all(&path)?;
                } else {
                    std::fs::remove_file(&path)?;
                }
            }
        }

        let (schema, fields) = build_schema();
        let index = Index::open_or_create(tantivy::directory::MmapDirectory::open(&dir)?, schema.clone())?;
        register_tokenizers(index.tokenizers());

        // 50 MB writer heap (Tantivy default).
        let writer = index.writer(50_000_000)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;

        // Re-stamp.
        std::fs::write(&stamp_path, serde_json::to_string(&SchemaStamp { version: SCHEMA_VERSION })?)?;

        Ok(Self {
            dir,
            fields,
            schema,
            index,
            writer: Mutex::new(writer),
            reader: RwLock::new(reader),
        })
    }

    /// The vault-relative directory backing this index.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Read-only schema handle.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Field handles for query construction.
    pub fn fields(&self) -> Fields {
        self.fields
    }

    /// Upsert one document — delete-by-path then add. Caller commits.
    pub fn upsert(&self, d: &IndexDoc) -> Result<(), SearchError> {
        let writer = self.writer.lock().map_err(|_| SearchError::WriterPoisoned)?;
        let term = Term::from_field_text(self.fields.path, &d.path);
        writer.delete_term(term);
        let f = self.fields;
        let mut doc = doc!(
            f.path => d.path.clone(),
            f.title => d.title.clone(),
            f.headings => d.headings.clone(),
            f.body => d.body.clone(),
            f.code => d.code.clone(),
            f.frontmatter => d.frontmatter.clone(),
            f.mtime_secs => d.mtime_secs,
            f.size_bytes => d.size_bytes,
        );
        for t in &d.tags {
            doc.add_text(f.tags, t);
        }
        writer.add_document(doc)?;
        Ok(())
    }

    /// Delete by path. Caller commits.
    pub fn delete_path(&self, path: &str) -> Result<(), SearchError> {
        let writer = self.writer.lock().map_err(|_| SearchError::WriterPoisoned)?;
        let term = Term::from_field_text(self.fields.path, path);
        writer.delete_term(term);
        Ok(())
    }

    /// Commit buffered writes + reload the reader so subsequent queries
    /// see them.
    pub fn commit(&self) -> Result<(), SearchError> {
        {
            let mut writer = self.writer.lock().map_err(|_| SearchError::WriterPoisoned)?;
            writer.commit()?;
        }
        let reader = self.reader.read().map_err(|_| SearchError::WriterPoisoned)?;
        reader.reload()?;
        Ok(())
    }

    /// Total document count (after the most recent reload).
    pub fn doc_count(&self) -> Result<u64, SearchError> {
        let reader = self.reader.read().map_err(|_| SearchError::WriterPoisoned)?;
        Ok(reader.searcher().num_docs())
    }

    /// Cheap-clone access to a fresh `IndexReader` for query module.
    pub(crate) fn reader_clone(&self) -> Result<IndexReader, SearchError> {
        let reader = self.reader.read().map_err(|_| SearchError::WriterPoisoned)?;
        Ok(reader.clone())
    }

    /// Index handle (for `QueryParser` construction in `query.rs`).
    pub(crate) fn index(&self) -> &Index {
        &self.index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn doc_fixture(path: &str, body: &str, tags: &[&str]) -> IndexDoc {
        IndexDoc {
            path: path.to_string(),
            title: format!("Title of {path}"),
            headings: String::new(),
            body: body.to_string(),
            code: String::new(),
            tags: tags.iter().map(|s| (*s).to_string()).collect(),
            frontmatter: String::new(),
            mtime_secs: 0,
            size_bytes: 0,
        }
    }

    #[test]
    fn open_creates_dir_and_stamp() {
        let tmp = TempDir::new().unwrap();
        let _idx = SearchIndex::open(tmp.path()).unwrap();
        assert!(tmp.path().join("schema.json").exists());
    }

    #[test]
    fn upsert_then_doc_count_is_one() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "hello world", &["foo"])).unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 1);
    }

    #[test]
    fn upsert_same_path_replaces() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "v1", &[])).unwrap();
        idx.upsert(&doc_fixture("a.md", "v2", &[])).unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 1);
    }

    #[test]
    fn delete_path_removes_doc() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "hello", &[])).unwrap();
        idx.commit().unwrap();
        idx.delete_path("a.md").unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0);
    }

    #[test]
    fn schema_version_mismatch_wipes() {
        let tmp = TempDir::new().unwrap();
        {
            let idx = SearchIndex::open(tmp.path()).unwrap();
            idx.upsert(&doc_fixture("a.md", "hello", &[])).unwrap();
            idx.commit().unwrap();
        }
        // Stomp the stamp with a bad version.
        std::fs::write(tmp.path().join("schema.json"), r#"{"version": 999}"#).unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0, "old data should have been wiped");
    }

    #[test]
    fn missing_stamp_wipes_and_re_creates() {
        let tmp = TempDir::new().unwrap();
        {
            let idx = SearchIndex::open(tmp.path()).unwrap();
            idx.upsert(&doc_fixture("a.md", "hello", &[])).unwrap();
            idx.commit().unwrap();
        }
        std::fs::remove_file(tmp.path().join("schema.json")).unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0);
    }
}
```

- [ ] **Step 2: Re-enable the re-export.**

In `crates/cubical-search/src/lib.rs`, uncomment `pub use index::SearchIndex;`.

- [ ] **Step 3: Run the tests.**

Run: `cargo test -p cubical-search index::tests`
Expected: 6 PASS.

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-search/src/index.rs crates/cubical-search/src/lib.rs
git commit -m "feat(l4-a): SearchIndex open/upsert/delete/commit + schema-version wipe"
```

---

### Task 7: Status + health types

Simple data types; their state-transitions live with the IPC layer in Task 12. This task just nails the shapes.

**Files:**
- Modify: `crates/cubical-search/src/status.rs`
- Modify: `crates/cubical-search/src/lib.rs`

- [ ] **Step 1: Write `status.rs` with tests.**

```rust
//! Status + health DTOs surfaced through IPC.

use serde::{Deserialize, Serialize};

/// High-level state of the search index for the current vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexState {
    /// Initial scan is populating the index. `search` returns whatever
    /// the reader currently sees with `still_indexing: true`.
    Building,
    /// Index is up to date with the last scan/watcher event.
    Ready,
    /// Open or commit failed; further writes are suppressed until next
    /// `search_rebuild_index` or app restart.
    Error,
}

/// Polled by the future UI for "still indexing…" + diagnostics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStatus {
    /// Current state.
    pub state: IndexState,
    /// Files indexed so far this session.
    pub indexed_files: u64,
    /// Total file count the scan enumerated (0 until enumeration completes).
    pub total_files: u64,
    /// Unix seconds of the most recent commit, if any.
    pub last_commit_secs: Option<i64>,
}

/// Debug-only health snapshot, for dev console + future settings UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexHealth {
    /// On-disk schema version stamp.
    pub schema_version: u32,
    /// Tantivy segment count.
    pub segments: u64,
    /// Total document count.
    pub doc_count: u64,
    /// Approximate on-disk bytes.
    pub disk_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_state_serializes_snake_case() {
        let s = serde_json::to_string(&IndexState::Building).unwrap();
        assert_eq!(s, "\"building\"");
        let s = serde_json::to_string(&IndexState::Ready).unwrap();
        assert_eq!(s, "\"ready\"");
        let s = serde_json::to_string(&IndexState::Error).unwrap();
        assert_eq!(s, "\"error\"");
    }
}
```

- [ ] **Step 2: Re-enable the re-export.**

In `crates/cubical-search/src/lib.rs`, uncomment `pub use status::{IndexHealth, IndexState, IndexStatus};`.

- [ ] **Step 3: Run the tests.**

Run: `cargo test -p cubical-search status::tests`
Expected: 1 PASS.

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-search/src/status.rs crates/cubical-search/src/lib.rs
git commit -m "feat(l4-a): IndexState/IndexStatus/IndexHealth DTOs"
```

---

### Task 8: Query API

`QueryParser` over the schema with field boosts; `FieldScope` swaps the parser's default fields; `fuzzy: true` rewrites single-term queries; snippets per matched field.

**Files:**
- Modify: `crates/cubical-search/src/query.rs`
- Modify: `crates/cubical-search/src/lib.rs`

- [ ] **Step 1: Write the failing tests first.**

```rust
//! Query API and runner.

use crate::error::SearchError;
use crate::index::SearchIndex;
use crate::schema::{Fields, TOKENIZER_EN_STEM};
use serde::{Deserialize, Serialize};
use tantivy::collector::TopDocs;
use tantivy::query::{FuzzyTermQuery, Query, QueryParser};
use tantivy::schema::Value;
use tantivy::{Snippet, SnippetGenerator, Term};

/// Hard cap on `limit`.
pub const LIMIT_MAX: usize = 500;
/// Default `limit` when caller passes 0.
pub const LIMIT_DEFAULT: usize = 50;
/// Minimum term length for fuzzy matching.
pub const FUZZY_MIN_LEN: usize = 4;

/// Free-text query input.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SearchQuery {
    /// The user-typed query string.
    pub text: String,
    /// Page size. 0 → `LIMIT_DEFAULT`. >`LIMIT_MAX` → error.
    #[serde(default)]
    pub limit: usize,
    /// Pagination offset.
    #[serde(default)]
    pub offset: usize,
    /// Which fields to search.
    #[serde(default)]
    pub fields: FieldScope,
    /// Whether to apply edit-distance-1 fuzziness on single-term queries (≥4 chars).
    #[serde(default)]
    pub fuzzy: bool,
    /// Sort order.
    #[serde(default)]
    pub sort: SortMode,
}

/// What to search.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldScope {
    /// `title^3 + headings^2 + body + tags^2 + frontmatter`.
    #[default]
    Default,
    /// Restrict to `headings`.
    HeadingsOnly,
    /// Restrict to `body`.
    BodyOnly,
    /// Restrict to `code`.
    CodeOnly,
    /// Exact-match filter on `tags` (multi-valued AND).
    Tags { tags: Vec<String> },
}

/// Sort order for results.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SortMode {
    /// Descending BM25.
    #[default]
    Relevance,
    /// Descending `mtime_secs`.
    RecencyDesc,
}

/// One result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Vault-relative path.
    pub path: String,
    /// Display title.
    pub title: String,
    /// BM25 score (or mtime_secs cast to f32 when sort=Recency).
    pub score: f32,
    /// Unix-seconds modification time.
    pub mtime_secs: i64,
    /// Per-field highlighted snippets.
    pub matched_fields: Vec<MatchedField>,
    /// Stored tag values for the hit.
    pub tags: Vec<String>,
}

/// One snippet from one matched field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchedField {
    /// Field name (`"title"`, `"headings"`, `"body"`, `"code"`, `"tags"`, `"frontmatter"`).
    pub field: String,
    /// 150-char snippet with `<mark>…</mark>` boundaries.
    pub snippet: String,
}

/// Wraps a hit list with metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResponse {
    /// Ranked hits, capped at `limit`.
    pub hits: Vec<SearchHit>,
    /// Tantivy's hit-count estimate before truncation.
    pub total_estimated: u64,
    /// Elapsed milliseconds for this query.
    pub took_ms: u64,
    /// True if the index state was `Building` at query time.
    pub still_indexing: bool,
}

/// Run a query. `still_indexing` is set by the caller in `commands::search`.
pub fn run_search(idx: &SearchIndex, q: &SearchQuery) -> Result<SearchResponse, SearchError> {
    let started = std::time::Instant::now();
    let limit = match q.limit {
        0 => LIMIT_DEFAULT,
        n if n > LIMIT_MAX => return Err(SearchError::LimitTooLarge { got: n, max: LIMIT_MAX }),
        n => n,
    };
    if q.text.trim().is_empty() {
        return Ok(SearchResponse {
            hits: Vec::new(),
            total_estimated: 0,
            took_ms: started.elapsed().as_millis() as u64,
            still_indexing: false,
        });
    }

    let f = idx.fields();
    let reader = idx.reader_clone()?;
    let searcher = reader.searcher();

    // Build the parsed query for the chosen scope.
    let parsed: Box<dyn Query> = match &q.fields {
        FieldScope::Default => {
            let mut p = QueryParser::for_index(idx.index(), vec![f.title, f.headings, f.body, f.tags, f.frontmatter]);
            p.set_field_boost(f.title, 3.0);
            p.set_field_boost(f.headings, 2.0);
            p.set_field_boost(f.tags, 2.0);
            Box::new(p.parse_query(&prepare_query_text(&q.text)).map_err(|e| SearchError::QueryParse(e.to_string()))?)
        }
        FieldScope::HeadingsOnly => {
            let p = QueryParser::for_index(idx.index(), vec![f.headings]);
            Box::new(p.parse_query(&prepare_query_text(&q.text)).map_err(|e| SearchError::QueryParse(e.to_string()))?)
        }
        FieldScope::BodyOnly => {
            let p = QueryParser::for_index(idx.index(), vec![f.body]);
            Box::new(p.parse_query(&prepare_query_text(&q.text)).map_err(|e| SearchError::QueryParse(e.to_string()))?)
        }
        FieldScope::CodeOnly => {
            let p = QueryParser::for_index(idx.index(), vec![f.code]);
            Box::new(p.parse_query(&prepare_query_text(&q.text)).map_err(|e| SearchError::QueryParse(e.to_string()))?)
        }
        FieldScope::Tags { tags } => {
            // Exact-match AND across all requested tags.
            use tantivy::query::{BooleanQuery, Occur, TermQuery};
            use tantivy::schema::IndexRecordOption;
            let clauses: Vec<(Occur, Box<dyn Query>)> = tags
                .iter()
                .map(|t| {
                    let term = Term::from_field_text(f.tags, &t.to_lowercase());
                    let q: Box<dyn Query> = Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                    (Occur::Must, q)
                })
                .collect();
            Box::new(BooleanQuery::new(clauses))
        }
    };

    // Fuzzy rewrite for single-term queries on Default scope.
    let final_query: Box<dyn Query> = if q.fuzzy {
        match (&q.fields, single_term(&q.text)) {
            (FieldScope::Default, Some(term)) if term.chars().count() >= FUZZY_MIN_LEN => {
                Box::new(FuzzyTermQuery::new(Term::from_field_text(f.title, &term.to_lowercase()), 1, true))
            }
            _ => parsed,
        }
    } else {
        parsed
    };

    let top = match q.sort {
        SortMode::Relevance => TopDocs::with_limit(limit + q.offset),
        SortMode::RecencyDesc => TopDocs::with_limit(limit + q.offset).order_by_fast_field::<i64>("mtime_secs"),
    };

    let docs = searcher.search(&*final_query, &top)?;
    let total_estimated = docs.len() as u64;

    let mut hits = Vec::new();
    for (score, addr) in docs.into_iter().skip(q.offset).take(limit) {
        let doc = searcher.doc(addr)?;
        let path = doc.get_first(f.path).and_then(|v| v.as_text()).unwrap_or("").to_string();
        let title = doc.get_first(f.title).and_then(|v| v.as_text()).unwrap_or(&path).to_string();
        let mtime_secs = doc.get_first(f.mtime_secs).and_then(|v| v.as_i64()).unwrap_or(0);
        let tags: Vec<String> = doc.get_all(f.tags).filter_map(|v| v.as_text().map(|s| s.to_string())).collect();

        // Snippets — for each text field that produced a match.
        let matched_fields = collect_snippets(&searcher, &*final_query, &doc, f)?;
        hits.push(SearchHit { path, title, score, mtime_secs, matched_fields, tags });
    }

    Ok(SearchResponse {
        hits,
        total_estimated,
        took_ms: started.elapsed().as_millis() as u64,
        still_indexing: false,
    })
}

/// Strip raw `#` from query text (`#project` → `project`) and lowercase
/// the right-hand-side of any `tag:Value`. `#` is a `QueryParser`
/// metacharacter; lowercasing matches the at-index normalization.
fn prepare_query_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '#' && chars.peek().map(|n| n.is_alphanumeric()).unwrap_or(false) {
            continue; // drop the '#'; keep the term
        }
        out.push(c);
    }
    // Lowercase `tag:VALUE` (find `tag:` and lowercase to the next whitespace).
    lowercase_after("tag:", &mut out);
    out
}

fn lowercase_after(prefix: &str, s: &mut String) {
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx + prefix.len()]);
        let after = &rest[idx + prefix.len()..];
        let end = after.find(|c: char| c.is_whitespace()).unwrap_or(after.len());
        out.push_str(&after[..end].to_lowercase());
        rest = &after[end..];
    }
    out.push_str(rest);
    *s = out;
}

fn single_term(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.contains(' ') || trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn collect_snippets(
    searcher: &tantivy::Searcher,
    q: &dyn Query,
    doc: &tantivy::Document,
    f: Fields,
) -> Result<Vec<MatchedField>, SearchError> {
    let mut out = Vec::new();
    for (name, field) in [
        ("title", f.title),
        ("headings", f.headings),
        ("body", f.body),
        ("code", f.code),
        ("frontmatter", f.frontmatter),
    ] {
        let mut gen = match SnippetGenerator::create(searcher, q, field) {
            Ok(g) => g,
            Err(_) => continue,
        };
        gen.set_max_num_chars(150);
        let snippet = gen.snippet_from_doc(doc);
        let html = snippet.to_html();
        if !html.is_empty() {
            out.push(MatchedField { field: name.to_string(), snippet: html });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::SearchIndex;
    use crate::doc::IndexDoc;
    use tempfile::TempDir;

    fn fixture_index() -> (TempDir, SearchIndex) {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        for (p, title, body, code, tags, head) in [
            ("a.md", "Alpha Notes", "the quick brown fox", "fn alpha() {}", vec!["foo"], "Heading One"),
            ("b.md", "Beta Notes", "another lazy dog", "fn beta() {}", vec!["bar"], "Heading Two"),
            ("c.md", "Cubical", "cubical search proof", "let _ = cubical::query();", vec!["project/cubical"], "Search"),
        ] {
            idx.upsert(&IndexDoc {
                path: p.into(), title: title.into(), headings: head.into(),
                body: body.into(), code: code.into(),
                tags: tags.into_iter().map(String::from).collect(),
                frontmatter: String::new(), mtime_secs: 1717000000, size_bytes: 1024,
            }).unwrap();
        }
        idx.commit().unwrap();
        (tmp, idx)
    }

    #[test]
    fn empty_query_returns_empty() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "   ".into(), limit: 0, offset: 0,
            fields: FieldScope::Default, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        assert!(r.hits.is_empty());
        assert_eq!(r.total_estimated, 0);
    }

    #[test]
    fn limit_over_max_errors() {
        let (_t, idx) = fixture_index();
        let err = run_search(&idx, &SearchQuery {
            text: "fox".into(), limit: 501, offset: 0,
            fields: FieldScope::Default, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap_err();
        assert!(matches!(err, SearchError::LimitTooLarge { got: 501, max: 500 }));
    }

    #[test]
    fn default_scope_matches_body() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "fox".into(), limit: 0, offset: 0,
            fields: FieldScope::Default, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "a.md");
    }

    #[test]
    fn code_only_scope_matches_code_not_body() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "alpha".into(), limit: 0, offset: 0,
            fields: FieldScope::CodeOnly, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "a.md");
    }

    #[test]
    fn headings_only_scope() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "search".into(), limit: 0, offset: 0,
            fields: FieldScope::HeadingsOnly, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "c.md");
    }

    #[test]
    fn tag_scope_exact_match_lowercased() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "anything".into(), limit: 0, offset: 0,
            fields: FieldScope::Tags { tags: vec!["Project/Cubical".into()] },
            fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "c.md");
    }

    #[test]
    fn hash_prefix_stripped_from_free_text() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "#fox".into(), limit: 0, offset: 0,
            fields: FieldScope::Default, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        assert_eq!(r.hits.len(), 1);
    }

    #[test]
    fn fuzzy_on_short_term_no_match_expansion() {
        let (_t, idx) = fixture_index();
        // 3-char term: should NOT match "fox" with edit-distance fuzzy.
        let r = run_search(&idx, &SearchQuery {
            text: "fxo".into(), limit: 0, offset: 0,
            fields: FieldScope::Default, fuzzy: true, sort: SortMode::Relevance,
        }).unwrap();
        // Since fuzzy is below threshold, falls through to parsed query;
        // "fxo" does not match "fox" exactly, so 0 hits.
        assert!(r.hits.is_empty());
    }

    #[test]
    fn snippet_contains_mark_tags() {
        let (_t, idx) = fixture_index();
        let r = run_search(&idx, &SearchQuery {
            text: "fox".into(), limit: 0, offset: 0,
            fields: FieldScope::Default, fuzzy: false, sort: SortMode::Relevance,
        }).unwrap();
        let snippet = &r.hits[0].matched_fields[0].snippet;
        assert!(snippet.contains("<b>") || snippet.contains("<mark>"));
    }
}
```

- [ ] **Step 2: Re-enable the re-export.**

In `crates/cubical-search/src/lib.rs`, uncomment `pub use query::{FieldScope, MatchedField, SearchHit, SearchQuery, SearchResponse, SortMode};`.

- [ ] **Step 3: Run the tests.**

Run: `cargo test -p cubical-search query::tests`
Expected: 9 PASS.

> **If Tantivy's `Snippet::to_html` uses `<b>` not `<mark>`,** the assertion accepts either. Spec calls for `<mark>`; if Tantivy 0.22 hard-codes `<b>`, post-process the HTML in `collect_snippets` by replacing `<b>`/`</b>` with `<mark>`/`</mark>`.

- [ ] **Step 4: Commit.**

```bash
git add crates/cubical-search/src/query.rs crates/cubical-search/src/lib.rs
git commit -m "feat(l4-a): SearchQuery + QueryParser + FieldScope + snippets"
```

---

### Task 9: Wire `SearchIndex` into `Vault`

`Vault::open` already opens libSQL; extend it to open the Tantivy index after. Add a `search()` accessor.

**Files:**
- Modify: `crates/cubical-core/src/vault/mod.rs`

- [ ] **Step 1: Add the field.**

Edit `crates/cubical-core/src/vault/mod.rs` `pub struct Vault`:

```rust
#[derive(Clone)]
pub struct Vault {
    root: Arc<PathBuf>,
    registry: Arc<FileTypeRegistry>,
    index: Arc<IndexConn>,
    search: Arc<cubical_search::SearchIndex>,
}
```

- [ ] **Step 2: Open in `Vault::open` (after `open_index`).**

After `let index = open_index(&db_path).await?;` add:

```rust
        let search_dir = cubical_dir.join("search");
        let search = cubical_search::SearchIndex::open(&search_dir)
            .map_err(|e| VaultError::Search(e.to_string()))?;
```

Then include it in the `Self { … }` construction:

```rust
        Ok(Self {
            root: Arc::new(root),
            registry: Arc::new(FileTypeRegistry::default()),
            index: Arc::new(index),
            search: Arc::new(search),
        })
```

- [ ] **Step 3: Add a `Search` variant to `VaultError`.**

Locate the `VaultError` enum (likely in the same file or a sibling); add:

```rust
    /// Search index open / commit failure.
    #[error("search index: {0}")]
    Search(String),
```

- [ ] **Step 4: Add the accessor.**

```rust
    /// The open Tantivy search index.
    #[must_use]
    pub fn search(&self) -> &cubical_search::SearchIndex {
        &self.search
    }
```

- [ ] **Step 5: Write the test (in the same file's `#[cfg(test)] mod tests`).**

```rust
    #[tokio::test]
    async fn vault_open_creates_search_dir_and_stamp() {
        let tmp = tempfile::TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        let search_dir = tmp.path().join(".cubical").join("search");
        assert!(search_dir.exists());
        assert!(search_dir.join("schema.json").exists());
        // Accessor returns a usable handle.
        assert_eq!(vault.search().doc_count().unwrap(), 0);
    }
```

- [ ] **Step 6: Run.**

Run: `cargo test -p cubical-core vault_open_creates_search_dir_and_stamp`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add crates/cubical-core/src/vault/mod.rs
git commit -m "feat(l4-a): open Tantivy index inside Vault::open; expose vault.search()"
```

---

### Task 10: `refresh_search_index` + scan integration + 5000-doc commit

The fifth refresher. Adds to scan Pass 1 after `refresh_blocks`. Adds a per-N-doc commit inside the scan loop so memory stays bounded on large vaults.

**Files:**
- Create: `crates/cubical-core/src/vault/search_refresh.rs`
- Modify: `crates/cubical-core/src/vault/mod.rs` (`pub mod search_refresh;`)
- Modify: `crates/cubical-core/src/vault/scan.rs`

- [ ] **Step 1: Create `crates/cubical-core/src/vault/search_refresh.rs`.**

```rust
//! Wire `cubical-search` into the scan + watcher refresher fan-out.
//!
//! Signature matches the L3 peers (`refresh_links`, `refresh_tags`,
//! `refresh_blocks`): `(vault, rel, source: &str)`. The function parses
//! the source locally via `cubical_ast::parse`, projects an `IndexDoc`,
//! upserts it. Caller commits — either every 5000 docs during scan
//! (see `scan.rs::SEARCH_COMMIT_EVERY`) or on the watcher's debounced
//! cadence (Task 11).

use crate::vault::Vault;
use cubical_search::{IndexDoc, SearchError};

/// Upsert one file into the Tantivy index. Does not commit.
pub async fn refresh_search_index(
    vault: &Vault,
    rel: &str,
    source: &str,
    mtime_secs: i64,
    size_bytes: u64,
) -> Result<(), SearchError> {
    let doc = cubical_search::doc::project(rel, source, mtime_secs, size_bytes);
    vault.search().upsert(&doc)
}

/// Delete one path from the Tantivy index. Does not commit.
pub async fn delete_search_index(vault: &Vault, rel: &str) -> Result<(), SearchError> {
    vault.search().delete_path(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn refresh_then_query_finds_the_doc() {
        let tmp = TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        let src = "# Hello\n\nworld of search.\n";
        refresh_search_index(&vault, "a.md", src, 0, src.len() as u64).await.unwrap();
        vault.search().commit().unwrap();
        assert_eq!(vault.search().doc_count().unwrap(), 1);
    }

    #[tokio::test]
    async fn delete_removes_the_doc() {
        let tmp = TempDir::new().unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        refresh_search_index(&vault, "a.md", "x", 0, 1).await.unwrap();
        vault.search().commit().unwrap();
        delete_search_index(&vault, "a.md").await.unwrap();
        vault.search().commit().unwrap();
        assert_eq!(vault.search().doc_count().unwrap(), 0);
    }
}
```

- [ ] **Step 2: Register the module.**

In `crates/cubical-core/src/vault/mod.rs`, add `pub mod search_refresh;` next to the other refreshers.

- [ ] **Step 3: Wire into scan Pass 1.**

In `crates/cubical-core/src/vault/scan.rs`:

1. Add a constant near the top:

```rust
/// Commit the Tantivy index every N docs during initial scan so the
/// writer's in-memory buffer stays bounded on large vaults.
const SEARCH_COMMIT_EVERY: usize = 5_000;
```

2. Import the refresher: at the top of `scan.rs`, add `use super::search_refresh::refresh_search_index;`.

3. After the existing `refresh_blocks` call inside the `if type_id == "markdown"` block (around line 266), insert:

```rust
            // L4-A: search index refresh. Same resilience policy as the
            // others — log on error, do not abort the scan.
            let mtime_secs = mtime_for(&abs_path).unwrap_or(0);
            let size_bytes = source.len() as u64;
            if let Err(e) = refresh_search_index(&vault, &path_str, &source, mtime_secs, size_bytes).await {
                tracing::warn!(path = %abs_path.display(), error = %e, "search index refresh failed");
            }
```

4. Add the `mtime_for` helper at the bottom of `scan.rs`:

```rust
fn mtime_for(path: &std::path::Path) -> Option<i64> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md.modified().ok()?;
    Some(mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64)
}
```

5. Add periodic search commits. In the scan loop, near the existing `batch_count += 1; if batch_count >= SCAN_BATCH_SIZE { … }` block, add a parallel counter for search:

```rust
        search_batch_count += 1;
        if search_batch_count >= SEARCH_COMMIT_EVERY {
            if let Err(e) = vault.search().commit() {
                tracing::warn!(error = %e, "search index periodic commit failed");
            }
            search_batch_count = 0;
        }
```

Declare `let mut search_batch_count = 0usize;` before the loop.

6. After the loop, add the final commit:

```rust
    // L4-A: final search commit so the scan's last batch is queryable.
    if let Err(e) = vault.search().commit() {
        tracing::warn!(error = %e, "search index final commit failed");
    }
```

- [ ] **Step 4: Write a scan-integration test.**

In `crates/cubical-core/src/vault/scan.rs` `#[cfg(test)] mod tests` (or wherever scan integration tests already live):

```rust
    #[tokio::test]
    async fn scan_populates_search_index() {
        let tmp = tempfile::TempDir::new().unwrap();
        // Create two markdown files in the vault.
        std::fs::write(tmp.path().join("a.md"), "# A\n\nalpha body\n").unwrap();
        std::fs::write(tmp.path().join("b.md"), "# B\n\nbeta body\n").unwrap();

        let vault = Vault::open(tmp.path()).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        scan(&vault, tx).await.unwrap();
        while rx.recv().await.is_some() {} // drain progress

        assert_eq!(vault.search().doc_count().unwrap(), 2);
    }
```

(Adapt the `scan` call signature to whatever it actually is in the codebase — check existing scan tests for the pattern.)

- [ ] **Step 5: Run.**

Run: `cargo test -p cubical-core --test scan` (or the appropriate suite path).
Expected: PASS plus all pre-existing scan tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add crates/cubical-core/src/vault/search_refresh.rs crates/cubical-core/src/vault/mod.rs crates/cubical-core/src/vault/scan.rs
git commit -m "feat(l4-a): scan integration + refresh_search_index + 5000-doc commit boundary"
```

---

### Task 11: Watcher fan-out (create/modify/delete/rename)

`apply_watch_event_to_db` already dispatches to L3 refreshers. Extend it: add search refresh on create/modify, search delete on delete, delete-old + add-new on rename. Commit at the end of each dispatcher invocation (the watcher's debounce is upstream — each invocation here is already debounced).

**Files:**
- Modify: `crates/cubical-core/src/vault/watcher.rs`

- [ ] **Step 1: Locate the dispatcher.**

Run: `grep -n "apply_watch_event_to_db\|refresh_frontmatter\|refresh_tags\|refresh_blocks" crates/cubical-core/src/vault/watcher.rs | head -20`

Find the branches: created, modified, deleted, renamed.

- [ ] **Step 2: Add the search calls.**

For **created** and **modified** markdown events, after the existing block refresh, add:

```rust
            let mtime_secs = std::fs::metadata(&abs_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            if let Err(e) = crate::vault::search_refresh::refresh_search_index(
                vault, &path_str, &source, mtime_secs, source.len() as u64,
            ).await {
                tracing::warn!(error = %e, "watcher: search refresh failed");
            }
```

For **deleted** events, after the existing libSQL cleanups:

```rust
            if let Err(e) = crate::vault::search_refresh::delete_search_index(vault, &path_str).await {
                tracing::warn!(error = %e, "watcher: search delete failed");
            }
```

For **renamed** events, the existing L3-J handler already pairs `(old, new)`. After the libSQL rekey:

```rust
            // L4-A: rename = delete old + add new in one commit.
            if let Err(e) = crate::vault::search_refresh::delete_search_index(vault, &old_path).await {
                tracing::warn!(error = %e, "watcher: search delete (rename old) failed");
            }
            // The new path will be refreshed by the modified branch on
            // the next event (the rename emits a paired create/modify
            // per L3-J). If the codebase needs an immediate refresh
            // here, read the new source and call refresh_search_index.
```

Read the existing rename handler carefully — if it does its own read of the new source, add an immediate `refresh_search_index` call instead of relying on a separate modified event.

- [ ] **Step 3: Commit search at the end of each dispatcher call.**

After the dispatcher's existing `tx.commit()` for libSQL, add:

```rust
        if let Err(e) = vault.search().commit() {
            tracing::warn!(error = %e, "watcher: search commit failed");
        }
```

- [ ] **Step 4: Write integration tests.**

In `crates/cubical-core/src/vault/watcher.rs` `#[cfg(test)] mod tests`:

```rust
    #[tokio::test]
    async fn watcher_modify_event_refreshes_search() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join("a.md"), "initial").unwrap();
        let vault = Vault::open(tmp.path()).await.unwrap();
        // Initial scan
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        crate::vault::scan::scan(&vault, tx).await.unwrap();
        while rx.recv().await.is_some() {}

        // Simulate a modify event
        std::fs::write(tmp.path().join("a.md"), "updated content with marker").unwrap();
        // Call dispatcher directly with a Modified event for "a.md"
        // (use the actual event-construction helper in the codebase).
        // ... apply_watch_event_to_db(&vault, modified_event).await.unwrap();

        // After dispatch, the new content should be queryable.
        let r = cubical_search::query::run_search(vault.search(), &cubical_search::SearchQuery {
            text: "marker".into(), limit: 0, offset: 0,
            fields: cubical_search::FieldScope::Default, fuzzy: false,
            sort: cubical_search::SortMode::Relevance,
        }).unwrap();
        assert_eq!(r.hits.len(), 1);
        assert_eq!(r.hits[0].path, "a.md");
    }

    #[tokio::test]
    async fn watcher_delete_event_removes_from_search() {
        // Similar to above: scan, then delete a.md via the dispatcher,
        // assert doc_count == 0.
    }
```

(Use whatever helper the existing tests use to invoke the dispatcher — search the file for an existing watcher test as a template.)

- [ ] **Step 5: Run.**

Run: `cargo test -p cubical-core watcher`
Expected: PASS for new tests + all existing watcher tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add crates/cubical-core/src/vault/watcher.rs
git commit -m "feat(l4-a): watcher fan-out — search refresh on create/modify, delete on delete/rename"
```

---

### Task 12: IPC commands + Tauri registration

Four Tauri shims: `search`, `search_index_status`, `search_rebuild_index`, `search_get_health`.

**Files:**
- Create: `crates/cubical-app/src/commands/search.rs`
- Modify: `crates/cubical-app/src/commands/mod.rs`
- Modify: `crates/cubical-app/src/lib.rs`
- Modify: `crates/cubical-app/src/api/types.rs`

- [ ] **Step 1: Add the IPC DTOs.**

In `crates/cubical-app/src/api/types.rs`, add:

```rust
use cubical_search::{IndexHealth, IndexStatus, SearchQuery, SearchResponse};

/// Re-export so the frontend can derive TS types from a single source.
pub use cubical_search::{
    FieldScope as SearchFieldScope, MatchedField as SearchMatchedField,
    SearchHit, SortMode as SearchSortMode,
};

/// Wrapper for the `search` IPC command.
pub type SearchRequest = SearchQuery;

/// Wrapper for the `search` IPC response.
pub type SearchResponseDto = SearchResponse;

/// Wrapper for `search_index_status`.
pub type SearchIndexStatusDto = IndexStatus;

/// Wrapper for `search_get_health`.
pub type SearchHealthDto = IndexHealth;
```

- [ ] **Step 2: Write the handlers.**

`crates/cubical-app/src/commands/search.rs`:

```rust
//! IPC handlers for L4-A search.

use crate::error::IpcError;
use crate::state::AppState;
use cubical_search::{
    query::run_search, IndexHealth, IndexState, IndexStatus, SearchQuery, SearchResponse,
};

/// Run a free-text query against the current vault's index.
#[tauri::command]
pub async fn search(
    state: tauri::State<'_, AppState>,
    request: SearchQuery,
) -> Result<SearchResponse, IpcError> {
    let vault = state.vault().ok_or(IpcError::NoVaultOpen)?;
    let state_snapshot = state.search_state();
    let mut response = run_search(vault.search(), &request).map_err(IpcError::from)?;
    response.still_indexing = matches!(state_snapshot, IndexState::Building);
    Ok(response)
}

/// Lightweight polling status.
#[tauri::command]
pub async fn search_index_status(
    state: tauri::State<'_, AppState>,
) -> Result<IndexStatus, IpcError> {
    Ok(state.search_status())
}

/// Wipe the on-disk index and trigger a full reindex via the existing
/// scan path. Returns immediately; caller polls `search_index_status`.
#[tauri::command]
pub async fn search_rebuild_index(
    state: tauri::State<'_, AppState>,
) -> Result<(), IpcError> {
    let vault = state.vault().ok_or(IpcError::NoVaultOpen)?;
    state.set_search_state(IndexState::Building);
    let search_dir = vault.root().join(".cubical").join("search");
    // The Tantivy directory must be wiped before reopening.
    std::fs::remove_dir_all(&search_dir).ok();
    // Trigger a re-scan asynchronously.
    let vault = vault.clone();
    let state_handle = state.clone();
    tauri::async_runtime::spawn(async move {
        let (tx, _rx) = tokio::sync::mpsc::channel(16);
        if let Err(e) = crate::commands::vault::rescan_vault(&vault, tx).await {
            tracing::warn!(error = %e, "search_rebuild_index: rescan failed");
        }
        state_handle.set_search_state(IndexState::Ready);
    });
    Ok(())
}

/// Debug snapshot for dev console + future settings UI.
#[tauri::command]
pub async fn search_get_health(
    state: tauri::State<'_, AppState>,
) -> Result<IndexHealth, IpcError> {
    let vault = state.vault().ok_or(IpcError::NoVaultOpen)?;
    let idx = vault.search();
    Ok(IndexHealth {
        schema_version: cubical_search::index::SCHEMA_VERSION,
        segments: idx.reader_clone().map(|r| r.searcher().segment_readers().len() as u64).unwrap_or(0),
        doc_count: idx.doc_count().unwrap_or(0),
        disk_bytes: dir_size(idx.dir()).unwrap_or(0),
    })
}

fn dir_size(p: &std::path::Path) -> std::io::Result<u64> {
    let mut total = 0;
    for entry in std::fs::read_dir(p)? {
        let entry = entry?;
        let md = entry.metadata()?;
        total += if md.is_file() { md.len() } else { dir_size(&entry.path())? };
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // Tests construct a real AppState + Vault + index a few fixture
    // files; round-trip each command.
    // ... (follow the pattern used by commands::links::tests)
}
```

- [ ] **Step 3: Add `AppState` plumbing.**

In `crates/cubical-app/src/state.rs`, add a search-state cell:

```rust
use cubical_search::IndexState;
use std::sync::Mutex;
use std::time::SystemTime;

pub struct SearchStateCell {
    state: Mutex<IndexState>,
    indexed_files: Mutex<u64>,
    total_files: Mutex<u64>,
    last_commit_secs: Mutex<Option<i64>>,
}

impl Default for SearchStateCell {
    fn default() -> Self {
        Self {
            state: Mutex::new(IndexState::Building),
            indexed_files: Mutex::new(0),
            total_files: Mutex::new(0),
            last_commit_secs: Mutex::new(None),
        }
    }
}

impl AppState {
    pub fn search_state(&self) -> IndexState { *self.search_cell.state.lock().unwrap() }
    pub fn set_search_state(&self, s: IndexState) { *self.search_cell.state.lock().unwrap() = s; }
    pub fn search_status(&self) -> cubical_search::IndexStatus {
        cubical_search::IndexStatus {
            state: self.search_state(),
            indexed_files: *self.search_cell.indexed_files.lock().unwrap(),
            total_files: *self.search_cell.total_files.lock().unwrap(),
            last_commit_secs: *self.search_cell.last_commit_secs.lock().unwrap(),
        }
    }
    // Setters used by the scan loop to update progress (wired in a
    // follow-on if needed; L4-A can ship with totals = 0).
}
```

Add `search_cell: SearchStateCell` to `AppState`, initialised `Default::default()`. On `Vault::open` success, transition `Building` → `Ready` after the initial scan completes. Look for the existing open-vault command handler and add `state.set_search_state(IndexState::Ready)` after `scan` returns.

- [ ] **Step 4: Register the commands.**

In `crates/cubical-app/src/commands/mod.rs`:

```rust
pub mod search;
```

In `crates/cubical-app/src/lib.rs`'s `tauri::generate_handler!` macro list, add:

```rust
            commands::search::search,
            commands::search::search_index_status,
            commands::search::search_rebuild_index,
            commands::search::search_get_health,
```

- [ ] **Step 5: Add `IpcError::NoVaultOpen` + `From<SearchError>`.**

In `crates/cubical-app/src/error.rs`:

```rust
    /// No vault currently open — search/etc. cannot run.
    #[error("no vault is open")]
    NoVaultOpen,
    /// Search subsystem error.
    #[error("search: {0}")]
    Search(String),
```

And:

```rust
impl From<cubical_search::SearchError> for IpcError {
    fn from(e: cubical_search::SearchError) -> Self {
        IpcError::Search(e.to_string())
    }
}
```

(Adapt to whatever the existing `IpcError` shape looks like.)

- [ ] **Step 6: Write IPC tests.**

In `crates/cubical-app/src/commands/search.rs` `#[cfg(test)] mod tests`:

```rust
    #[tokio::test]
    async fn search_round_trips_empty_query() {
        // Construct AppState + vault as commands::links::tests does.
        // Issue an empty-text query; assert hits == [].
    }

    #[tokio::test]
    async fn still_indexing_flag_set_when_state_is_building() {
        // Force AppState's search_state to Building; assert response
        // carries still_indexing = true.
    }

    #[tokio::test]
    async fn rebuild_wipes_then_repopulates() {
        // Open vault, index two files, call rebuild, wait for rescan,
        // assert doc_count == 2.
    }

    #[tokio::test]
    async fn health_reports_schema_version_1() {
        // Open vault; call search_get_health; assert schema_version == 1.
    }
```

(Reuse the existing `commands::*::tests` setup helpers — `grep -n "fn fixture_state\|fn test_vault" crates/cubical-app/src/commands/*.rs | head` to find them.)

- [ ] **Step 7: Run.**

Run: `cargo test -p cubical-app commands::search`
Expected: 4 PASS.

- [ ] **Step 8: Commit.**

```bash
git add crates/cubical-app/src/commands/search.rs crates/cubical-app/src/commands/mod.rs crates/cubical-app/src/lib.rs crates/cubical-app/src/api/types.rs crates/cubical-app/src/state.rs crates/cubical-app/src/error.rs
git commit -m "feat(l4-a): four search IPC commands + AppState plumbing"
```

---

### Task 13: TS IPC wrappers + vitest smoke

**Files:**
- Create: `ui/src/ipc/search.ts`
- Create: `ui/src/ipc/search.test.ts`

- [ ] **Step 1: Write the failing test.**

`ui/src/ipc/search.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { search, searchIndexStatus, searchRebuildIndex, searchGetHealth } from "./search";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe("search ipc", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("forwards search() to the `search` command with the request payload", async () => {
    mockInvoke.mockResolvedValueOnce({
      hits: [], total_estimated: 0, took_ms: 1, still_indexing: false,
    });
    await search({ text: "hello", limit: 50, offset: 0, fields: { kind: "default" }, fuzzy: false, sort: "relevance" });
    expect(mockInvoke).toHaveBeenCalledWith("search", { request: expect.objectContaining({ text: "hello" }) });
  });

  it("searchIndexStatus invokes the status command and returns the typed shape", async () => {
    mockInvoke.mockResolvedValueOnce({ state: "ready", indexed_files: 2, total_files: 2, last_commit_secs: 1717 });
    const s = await searchIndexStatus();
    expect(s.state).toBe("ready");
  });

  it("searchRebuildIndex invokes the rebuild command", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await searchRebuildIndex();
    expect(mockInvoke).toHaveBeenCalledWith("search_rebuild_index");
  });

  it("searchGetHealth returns schema_version", async () => {
    mockInvoke.mockResolvedValueOnce({ schema_version: 1, segments: 1, doc_count: 2, disk_bytes: 100 });
    const h = await searchGetHealth();
    expect(h.schema_version).toBe(1);
  });
});
```

- [ ] **Step 2: Write `ui/src/ipc/search.ts`.**

```typescript
/**
 * IPC wrappers for L4-A search.
 *
 * Backend contract: `docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md` §IPC.
 */

import { invoke } from "@tauri-apps/api/core";

export type FieldScope =
  | { kind: "default" }
  | { kind: "headings_only" }
  | { kind: "body_only" }
  | { kind: "code_only" }
  | { kind: "tags"; tags: string[] };

export type SortMode = "relevance" | "recency_desc";

export interface SearchQuery {
  text: string;
  limit: number;
  offset: number;
  fields: FieldScope;
  fuzzy: boolean;
  sort: SortMode;
}

export interface MatchedField {
  field: string;
  snippet: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  mtime_secs: number;
  matched_fields: MatchedField[];
  tags: string[];
}

export interface SearchResponse {
  hits: SearchHit[];
  total_estimated: number;
  took_ms: number;
  still_indexing: boolean;
}

export type IndexState = "building" | "ready" | "error";

export interface IndexStatus {
  state: IndexState;
  indexed_files: number;
  total_files: number;
  last_commit_secs: number | null;
}

export interface IndexHealth {
  schema_version: number;
  segments: number;
  doc_count: number;
  disk_bytes: number;
}

export function search(request: SearchQuery): Promise<SearchResponse> {
  return invoke<SearchResponse>("search", { request });
}

export function searchIndexStatus(): Promise<IndexStatus> {
  return invoke<IndexStatus>("search_index_status");
}

export function searchRebuildIndex(): Promise<void> {
  return invoke<void>("search_rebuild_index");
}

export function searchGetHealth(): Promise<IndexHealth> {
  return invoke<IndexHealth>("search_get_health");
}
```

- [ ] **Step 3: Run vitest.**

Run: `npx vitest run ui/src/ipc/search.test.ts`
Expected: 4 PASS.

- [ ] **Step 4: Confirm typecheck and build pass.**

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit.**

```bash
git add ui/src/ipc/search.ts ui/src/ipc/search.test.ts
git commit -m "feat(l4-a): TS IPC wrappers for the four search commands"
```

---

### Task 14: L4 spec scaffold + §9.1 + CLAUDE.md state + final gates + smoke

**Files:**
- Create: `docs/layer-4-spec.md`
- Modify: `CLAUDE.md`
- Smoke vault: `~/Developer/sandbox/cubical-l4a-smoke/`

- [ ] **Step 1: Create `docs/layer-4-spec.md`.**

Use the L3 spec's top matter as a template. Sections:

- `# Layer 4 — Search` (top heading + intro paragraph)
- `## 1. Goal` — Tantivy + Dataview + persistent panel + Cmd-K (one-paragraph version of build-order §4)
- `## 2. Sessions` — A/B/C/D placeholders (only A's bullet filled now)
- `## 6. Definition of Done` — empty checklist, populated as sessions land
- `## 9. Session closeouts`
  - `### 9.1 Session A — Tantivy backend`
    - bullets: schema (locked); 5-refresher scan loop; watcher fan-out; 4 IPCs; smoke vault path; perf record (filled in step 5)
    - link to design spec
    - test counts at close (filled in step 5)

- [ ] **Step 2: Run the carry-over smoke against the L3 vault.**

Run: `cargo tauri dev` against `~/Developer/sandbox/cubical-l3-smoke/`.

Manual checks (record observations in `§9.1`):
- Wiki-link navigation still works
- Backlinks panel still populates
- Tag pages still render
- Embeds still render
- Pending-rewrites status bar still shows count + flushes
- (New) Open dev console; `await window.__TAURI__.invoke('search_index_status')` returns `{state:"ready", ...}`

If any L3 surface regresses, **stop and triage** — do not advance to L4-A new smoke. Most likely cause: scan-loop ordering or watcher fan-out interference.

- [ ] **Step 3: Build the L4-A new smoke vault.**

Build `~/Developer/sandbox/cubical-l4a-smoke/` by copying the L3 smoke vault and adding:

- `code/rust_examples.md` — three fenced Rust code blocks with distinctive symbols (`fn parse_canonical_ast`, `struct PendingRewrites`, etc.)
- `code/python_examples.md` — fenced Python (`def search_query`, `class SearchIndex`)
- `data/frontmatter_rich.md` — frontmatter with nested keys (`author.name: jane`, `author.email: jane@example.com`), list values (`tags: [project/cubical, archived]`), numeric/date scalars
- `Aliased Note.md` — frontmatter `aliases: ["Aliased", "AliasedNote"]` with body referencing several Cubical-specific terms so the wiki-link display-text test has material

- [ ] **Step 4: Issue the smoke queries via dev console.**

Open the L4-A vault in `cargo tauri dev`; in the dev console run:

```js
const q = (fields, text, extra={}) =>
  window.__TAURI__.invoke('search', { request: { text, limit: 0, offset: 0, fields, fuzzy: false, sort: "relevance", ...extra } });

// 1) Default scope, single term that lives in body
await q({kind:"default"}, "cubical");

// 2) HeadingsOnly
await q({kind:"headings_only"}, "search");

// 3) CodeOnly — should find code-heavy file
await q({kind:"code_only"}, "PendingRewrites");

// 4) Tags filter
await q({kind:"tags", tags:["project/cubical"]}, "*");

// 5) Fuzzy on
await q({kind:"default"}, "cubicall", { fuzzy: true });

// 6) Health snapshot
await window.__TAURI__.invoke('search_get_health');

// 7) Rebuild — verify rebuild path + watcher convergence
await window.__TAURI__.invoke('search_rebuild_index');
await new Promise(r => setTimeout(r, 5000));
await window.__TAURI__.invoke('search_index_status');
```

Record observed JSON for each query in `§9.1` of the L4 spec.

- [ ] **Step 5: Record the perf benchmark.**

Run a 200-query benchmark against `~/Developer/sandbox/cubical-cancel-test/` (the §5.6 30k-file vault). Use a small driver in `crates/cubical-search/benches/` or `examples/` that opens the vault's `.cubical/search/`, issues the 200-query mix from the spec, records `took_ms` per query, prints p50/p99 + initial-scan throughput. Record numbers in `§9.1`.

If p99 is > 80 ms, do **not** gate the merge — record as observed and tag as "L5 perf-pass candidate."

- [ ] **Step 6: Run all closeout gates.**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
npx tsc --noEmit
npm run build
npx vitest run
```

All must be green. If clippy complains about new lints, fix at the call site — do not blanket-allow.

- [ ] **Step 7: Update `CLAUDE.md` "Project state".**

Rewrite the four-to-six-line block. Template:

```
Current layer: 4 — Search (in progress).

**L4-A closed YYYY-MM-DD** (`l4a` tag). Tantivy backend live: per-file index with structural fields, five-refresher scan loop, watcher fan-out (create/modify/delete/rename), four IPCs (`search`, `search_index_status`, `search_rebuild_index`, `search_get_health`). Schema-version stamp at `<vault>/.cubical/search/schema.json` (v1). Smoke vault `~/Developer/sandbox/cubical-l4a-smoke/`. Final L4-A test counts: <Rust> Rust + <vitest> vitest. All gates green at close.

Deferred: persistent panel UI (L4-B), Cmd/Ctrl+K Omni-Bar (L4-C), Dataview libSQL queries (L4-D), regex / NEAR / date-range query syntax, multi-term fuzzy (L4-D).

Next: **Session L4-B — persistent left-panel search results UI** (per `docs/build-order.md`).
```

(Fill in the test counts after Step 6 ran.)

- [ ] **Step 8: Tag and commit.**

```bash
git add docs/layer-4-spec.md CLAUDE.md
git commit -m "docs(l4-a): layer-4-spec scaffold, §9.1 closeout, CLAUDE.md project state"
git tag l4a
```

---

## Self-review

Running the four checks the writing-plans skill prescribes:

**1. Spec coverage.** Each spec section maps to a task:

- §Crate boundary → Task 1
- §Schema → Task 3
- §Body extraction rules → Task 5
- §Indexing pipeline / scan hook / 5000-doc commit / materialize-on-read invariant → Task 10
- §Watcher path / delete / rename → Task 11
- §Schema version stamp + wipe → Task 6
- §Query API (SearchQuery / FieldScope / fuzzy / snippets / sort / empty query / limit cap / lowercase tag) → Task 8
- §IPC surface (4 commands + still_indexing flag + async rebuild) → Task 12
- §TS wrappers → Task 13
- §L3 carry-over smoke + L4-A new smoke + dev-console recipes + perf record → Task 14
- §Migration touchpoints (none) — trivially satisfied (no migrations added)
- §Non-goals — encoded as omissions; explicitly listed in Task 14 step 7's project-state block
- §Resolved-in-spec decisions — encoded in Task 5 (private walker, no `cubical_ast::prose`) and Task 3 (`code` tokenizer = `SimpleTokenizer` + `LowerCaser`)

**2. Placeholder scan.** Two intentional "adapt to existing code" notes remain — Task 5 step 2 ("check variant names with `grep`"), Task 11 step 2 (renamed-event helper), Task 12 step 6 (test-fixture helpers). These are not placeholders for *new* code; they point the engineer at existing code patterns to mirror. Acceptable — the alternative would be guessing function names that may not match.

**3. Type consistency.** Spot-checked: `SearchQuery.fields: FieldScope` matches in `query.rs`, `state.rs`, `search.ts`. `IndexState` enum values (`Building` / `Ready` / `Error`) serialize as `building` / `ready` / `error` (Task 7 step 1's `serde(rename_all = "snake_case")`); TS union matches (Task 13's `IndexState = "building" | "ready" | "error"`). `SCHEMA_VERSION = 1` matches `schema_version: 1` in TS test.

**4. No vague error handling.** Each error path has an explicit `tracing::warn!` + skip policy (matching the L3 refresher contract). The single user-facing error (`LimitTooLarge`) is explicitly tested.

One inconsistency to fix inline: Task 8's `prepare_query_text` lowercases after every `tag:`; the spec also says "raw `#tag` tokens get the `#` stripped before parsing." Both behaviors are implemented; the comment in Task 8 step 1 captures both. OK.

One thing I considered and chose not to do: split Task 12 into smaller subtasks (one IPC per task). Reasoning: the four commands share `AppState` plumbing + Tauri registration; splitting them produces commits that don't compile until the others land. Keeping them together is the cleanest seam.

Plan ready for execution.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-02-l4-a-tantivy-backend.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
