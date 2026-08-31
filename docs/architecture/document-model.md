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

**Schema (L3, promoted from `docs/layer-3-spec.md` §2.1 at L3 close):**

```sql
CREATE TABLE links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path   TEXT NOT NULL,        -- vault-relative file containing the link
    target_raw    TEXT NOT NULL,        -- the [[…]] target exactly as written
    target_path   TEXT,                 -- resolved vault-relative path; NULL = unresolved
    anchor_kind   TEXT,                 -- NULL | 'heading' | 'block'
    anchor_value  TEXT,                 -- heading text or block-id slug; NULL if no anchor
    display_text  TEXT,                 -- NULL unless [[target|display]]
    is_embed      INTEGER NOT NULL,     -- 0 | 1  (![[…]] sets 1)
    position      INTEGER NOT NULL      -- byte offset in source, for ordering + context
);
CREATE INDEX idx_links_source ON links(source_path);
CREATE INDEX idx_links_target ON links(target_path);
```

`source_path` becomes `source_file_uuid` (and `target_path` → `target_file_uuid`) post-L7 via schema migration. `target_raw` survives unchanged — it preserves the user-written form so renames can rewrite the source byte-for-byte (basename-form referrers keep basenames, path-form referrers keep paths). `is_embed` discriminates `[[…]]` from `![[…]]` so a single index serves both wiki-links and embeds. `position` is the byte offset of the enclosing block; per-inline byte positions are post-L1 work, deferred to whichever later session needs them.

**Resolution order** (locked at L3): exact vault-relative path → case-insensitive unique basename → case-insensitive unique suffix; ambiguity at the latter two yields `NULL` (the row still lands so unresolved links surface in the UI and a later rename can re-resolve). Bulk scan resolves all links through a single in-memory `PathResolver` built once per scan pass (O(N) build, O(1) common-case lookup) so the initial vault scan stays linear; the single-file watcher path delegates to the same resolver.

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

**A non-markdown target is served as bytes, never as text.** `get_embed` checks `type_id` before reading and returns `EmbedKind::File` carrying base64 plus a mime type, so `![[photo.png]]` renders the image and `![[data.csv]]` a table. The frontend routes that payload through the *same* `renderViewerPayload` the file's own tab uses, so an embed matches its tab by construction rather than by convention. Non-markdown embeds are terminal — no wiki-links, so no recursion and no depth chain. Files above the embed byte cap return `File` with no content and render a warning.

This replaces reading every resolved target through `read_source_off_executor`, whose `from_utf8_lossy` decode turned a PNG into replacement characters injected as note text.

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

The exact shape is finalized during Layer 1. This AST is the lingua franca: Lezer trees are normalized into it, indexers and the exporter consume it, and plugins (Layer 6) receive it across the WASI boundary.

It is intentionally slim — only the markdown subset Cubical itself produces and renders. Cross-app importers (Obsidian, Logseq, Notion) are out of v1 scope, so the AST carries no math, mermaid, callout, footnote or other extension **nodes**. This bounds the AST, not the rendering surface: **AST-bearing syntax pays the two-parser cost; a decoration over an existing node does not.** Whether such a form can be *rendered* is answered by the decoration paragraphs below.

**Editor decorations are a sanctioned exception (promoted from L2).** Live Preview reads the editor's Lezer syntax tree (`syntaxTree(state)`) directly, not the canonical AST, because it hides and reveals marker tokens (`#`, `*`, backticks, list dashes, link brackets) at byte precision and the canonical AST abstracts those positions away. A parallel consumer, not a replacement: the in-process `onAstChange` path still normalizes Lezer into `cubical_ast::Document`, so the L1 parity contract is unaffected. The rule: anything that **indexes, exports, or crosses the plugin (Layer 6) boundary** consumes the canonical AST; only the editor's own rendering may read Lezer.

**Two-parser extension is the contract for AST-bearing syntax (promoted from L3).** Wiki-links, embeds, inline tags, and block-id occurrences live in the canonical AST (`Inline::WikiLink`, `Inline::Tag`, `Anchor::{Heading,Block}`) and so must be recognised by **both** the Rust `cubical-ast` parser (pulldown-cmark + hand-rolled inline tokenizers — `scan_wikilinks`, `scan_tags`) **and** the Lezer editor grammar (`@lezer/markdown` + `MarkdownConfig` inline rules registered `before: "Link"`). Both sides emit the same node names with the same grammar; the L1 cross-language parity contract (`crates/cubical-ast/tests/fixtures/parity.json`, exercised by the Rust `parity_fixtures` integration test + TS `parity.test.ts`) is *extended* to every new AST-bearing form, not weakened. Where Lezer's defaults conflict with the canonical grammar (e.g. its shortcut-Link parser claims `[[X]]` as an empty-`dest` Link, its Image parser claims `![[X]]` as an empty-`dest` Image), the TS normalizer re-flattens those nodes back to text before running `scan_wikilinks`/`scan_tags` so the canonical output stays in lockstep. This is the load-bearing L3 call — every later AST-bearing syntax extension follows the same pattern.

**A fenced-code info string is not an AST-bearing extension.** ` ```csv `, ` ```tsv ` and ` ```query ` add no grammar: `FencedCode`/`CodeInfo` are already emitted by both parsers, and `CodeBlock { lang }` already carries the info string. Rendering one as a table or a result set is a *decoration on an existing node* — a `StateField` replacing the block with a widget, revealing source when the cursor enters it — so it costs no `parity.json` fixture and no grammar change. `editor/dataview.ts`, `editor/csvBlock.ts` and `editor/math.ts` are the three instances, each registered as a `BlockRenderer` through `editor/blockRenderers.ts`. Reach for the two-parser contract above only when introducing genuinely new *syntax*; a new fenced language is a renderer, not a grammar.

Plain `^block-id` occurrences are the explicit exception: content, not an AST node. The canonical AST carries `block_id: Option<String>` on `Heading`/`Paragraph` only once a reference mints one; a loose `^id` in source is a textual anchor. The editor's `^id` decoration therefore scans doc text directly (mirroring the `findFrontmatter` precedent), bypassing both parsers — outside the AST contract by design.

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

**Why deferred:** renaming a heavily-linked file or tag would otherwise trigger hundreds of synchronous writes, causing UI lag, file-watcher cascades and cloud-sync churn. Coalescing eliminates all three.

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

**External-write conflict.** If `notify` reports `target_file` changed externally while pending rewrites exist, the flush re-applies textually: find the old token in the new content, replace if present, drop silently if the user removed it.

**Plugin file reads must go through Cubical's capability**, not raw WASI fs, so plugins see materialized content. WASI fs is denied by default in the permission model anyway.

**Status bar always shows the unflushed count** ("12 pending changes"). Toast notification on flush completion: "Applied 12 reference updates across 7 files." Click → diff view.

**Undo:** instant within the unflushed window (`DELETE FROM pending_rewrites WHERE rename_op_id = ?`). After flush, undo is a full reverse rewrite — same flush mechanism, opposite direction.
