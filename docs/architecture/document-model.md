> Locked decisions. Architecture review required to change. Index: [docs/architecture/README.md](README.md)

# Cubical — Architecture: Document Model

## 5. Document model

### 5.1 Frontmatter

YAML, at the top of the file. Non-negotiable per markdown convention — placement anywhere else is not parsed as YAML by external tools.

```markdown
---
title: My Note
tags: [research, pkm]
created: 2026-04-27
---

Note content...
```

Frontmatter is parsed into structured columns in libSQL for fast Dataview-style queries. The .md file is the source of truth; libSQL is the index.

### 5.2 Wiki-links

`[[target]]`, `[[target|display]]`, `[[target#heading]]`, `[[target#^block-id]]`. Resolution is via libSQL's link index, keyed by `file_path` pre-L7 and by `file_uuid` post-L7 (schema migration handles the transition at the L7 onboarding moment). Renames do not rewrite referencing files immediately — they enqueue entries in the [Pending Rewrites Cache](#57-pending-rewrites-cache) that are flushed periodically and on close.

### 5.3 Block references

A block ID is a slug (`^my-block`) appended to a paragraph or list item. **Lazy assignment:** an ID is only created when the user creates a reference to that paragraph (typing `[[note#^...]]` in autocomplete, or invoking a "create block ref" action). No bulk auto-assignment. The literal `^id` lives in the markdown source as text; it survives content edits as long as the user doesn't delete it.

Allowed characters: Unicode letters, digits, `_`, `-`. Must start with a letter or underscore.

Scope: per file. `(file_path, block_id)` is unique within a file pre-L7; `(file_uuid, block_id)` post-L7.

The libSQL schema (introduced at L3):

- `blocks(file_path, block_id, position_hint, last_modified)`
- `block_refs(source_file_path, target_file_path, target_block_id)`

Block reference rewrites on rename go through the [Pending Rewrites Cache](#57-pending-rewrites-cache). Broken block references (target paragraph deleted, ID removed) surface in the vault health UI alongside broken wiki-links.

### 5.4 Embeds

`![[target]]` embeds the full content of another note inline. `![[target#heading]]` embeds a section. `![[target#^block-id]]` embeds a single block. Embeds are rendered live in Live Preview and resolve through the same link index as wiki-links — they are wiki-links with an `embed: true` flag in the AST.

Embeds are recursive but bounded: a configurable maximum depth (default 4) prevents pathological infinite-embed cycles. Beyond the depth, the embed is rendered as a styled link instead of inlined content.

### 5.5 Canonical AST

Defined in the `cubical-ast` crate. A normalized markdown AST, framework-independent, no Tauri or webview dependencies.

```rust
pub enum Node {
    Document(Vec<Node>),
    Heading { level: u8, children: Vec<Node>, block_id: Option<String> },
    Paragraph { children: Vec<Node>, block_id: Option<String> },
    List { ordered: bool, items: Vec<ListItem> },
    CodeBlock { lang: Option<String>, content: String },
    BlockQuote(Vec<Node>),
    WikiLink { target: String, display: Option<String>, anchor: Option<Anchor>, embed: bool },
    Tag { path: String, source: TagSource },  // TagSource: Inline | Frontmatter
    InlineCode(String),
    Emphasis(Vec<Node>),
    Strong(Vec<Node>),
    Text(String),
    // ... etc.
}
```

The exact shape is finalized during Layer 1. The point is: this AST is the lingua franca. Lezer trees from the editor are normalized into it. Indexers consume it. The exporter consumes it. Plugins (Layer 6) receive it across the WASI boundary.

The AST is intentionally slim — it represents only the markdown subset Cubical itself produces and renders. Cross-app importers (Obsidian, Logseq, Notion) are out of v1 scope, so the AST does not carry math, mermaid, callout, footnote, or other extension nodes.

**Editor decorations are a sanctioned exception (promoted from L2).** The editor's Live Preview decoration layer does *not* consume the canonical AST — it reads the editor's Lezer syntax tree (`syntaxTree(state)`) directly. Live Preview hides and reveals individual marker tokens (`#`, `*`, backticks, list dashes, link brackets) at byte precision, and the canonical AST deliberately abstracts those positions away. This is a parallel consumer, not a replacement: the in-process `onAstChange` path still normalizes Lezer into `cubical_ast::Document`, so the L1 parity contract is unaffected. The rule: anything that **indexes, exports, or crosses the plugin (Layer 6) boundary** consumes the canonical AST; only the editor's own rendering may read Lezer directly.

### 5.6 Tags

Two declaration sources, one logical concept.

- **Inline:** `#tag` anywhere in body text. Must follow whitespace or line-start. Excluded inside fenced code blocks, inline code spans, link targets, and wiki-link targets.
- **Frontmatter:** `tags: [tag1, tag2/sub, tag3]` (YAML list).

Both feed the same tag index.

**Nesting** uses `/`: `#parent/child/grandchild`.

**Casing** is case-insensitive for matching, case-preserving for display. The canonical display form is whichever case was typed first in the vault; a tag-edit UI lets the user override.

**Allowed characters:** Unicode letters, digits, `_`, `-`, `/`. Must contain at least one letter or underscore (rules out `#1234`).

**Hierarchy semantics:** prefix-match. Querying `#parent` matches `#parent`, `#parent/child`, and all deeper descendants. Querying `#parent/child` matches `#parent/child` and its descendants but not bare `#parent`. A file tagged `#a/b/c` is recorded with that exact leaf path; ancestor segments are not indexed separately.

**Tag pages** are auto-generated and virtual — backed by a libSQL query, not real `.md` files. Route `tag:projects/cubical` opens a list of files using that tag or any descendant.

**Schema (L3):**

```sql
CREATE TABLE tags (
    file_path TEXT NOT NULL,
    tag_path  TEXT NOT NULL,
    source    TEXT NOT NULL,         -- 'inline' | 'frontmatter'
    PRIMARY KEY (file_path, tag_path, source)
);
CREATE INDEX idx_tags_path ON tags(tag_path);
```

(`file_path` becomes `file_uuid` post-L7 via schema migration.)

### 5.7 Pending Rewrites Cache

Renames (file rename, tag rename, block-id rename) are *deferred-write*. The user-visible event — the rename — is instant. The disk impact — rewriting referrer files — is coalesced.

**Why deferred:** a rename of a heavily-linked file or tag would otherwise trigger dozens to hundreds of file writes synchronously, causing UI lag, file-watcher cascades, and cloud-sync churn. Coalescing eliminates all four.

**Schema (L3):**

```sql
CREATE TABLE pending_rewrites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    target_file     TEXT NOT NULL,         -- file to be rewritten
    rewrite_kind    TEXT NOT NULL,         -- 'wiki_link' | 'tag' | 'block_ref'
    old_token       TEXT NOT NULL,         -- e.g. '[[old-name]]', '#projects', '^intro'
    new_token       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    rename_op_id    INTEGER NOT NULL       -- groups all rewrites from one rename
);
CREATE INDEX idx_pending_target ON pending_rewrites(target_file);
CREATE INDEX idx_pending_op     ON pending_rewrites(rename_op_id);
```

**Reads materialize.** Every read of a file's effective content (display, indexing, export) reads on-disk content, applies pending rewrites for that file in `created_at` order, returns the materialized result. One indexed query per read; cheap.

**Flush triggers:**
- Periodic timer (default 5 min, configurable).
- On app close (mandatory).
- On `pending_rewrites` count for a single target file exceeding 50 (pathological-case fuse).
- On user-invoked "Save all pending changes."

**External-write conflict.** If `notify` reports `target_file` was modified externally while pending rewrites exist, on flush the rewrite is re-applied textually: find the old token in the new content; if present, replace; if not (user removed it manually), the rewrite silently drops.

**Plugin file reads must go through Cubical's capability**, not raw WASI fs, so plugins see materialized content. WASI fs is denied by default in the permission model anyway.

**Status bar always shows the unflushed count** ("12 pending changes"). Toast notification on flush completion: "Applied 12 reference updates across 7 files." Click → diff view.

**Undo:** instant within the unflushed window (`DELETE FROM pending_rewrites WHERE rename_op_id = ?`). After flush, undo is a full reverse rewrite — same flush mechanism, opposite direction.
