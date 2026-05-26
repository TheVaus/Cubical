# Cubical — Layer 3: Knowledge Graph

L3 turns a vault from a pile of independent `.md` files into a connected graph. Links between notes resolve and navigate, backlinks surface automatically, tags organise, and renaming a file no longer breaks every note that referenced it.

L2 closed the editing surface (write-path, Live Preview, theming, Properties). L3 is the first layer where the vault is *more than its files* — the derived index earns its keep. v1.0 still cuts at the end of L5.

> **Before starting any L3 session:** confirm the L2 surface still holds — open `cargo tauri dev`, open a vault, edit a markdown file, confirm autosave + Live Preview decorations + Properties still work. The L2 §9.7 closeout smoke is the baseline; if anything regressed, file a bug against L2 before starting L3 proper.

The knowledge-graph **architecture is already locked** in [`docs/architecture/document-model.md`](architecture/document-model.md) §5.2–§5.7 (wiki-links, block refs, embeds, the canonical AST, tags, the Pending Rewrites Cache, including the libSQL schemas). L3 *implements* that locked design — it does not redesign it. Where L3 must make a call the architecture left open, it is recorded in §5 below.

---

## 1. Goals

By end of L3:

1. **Wiki-links parse and resolve.** `[[target]]`, `[[target|display]]`, `[[target#heading]]`, `[[target#^block-id]]` (and the embed form `![[…]]`) are recognised by **both** the Rust `cubical-ast` parser and the Lezer editor grammar, and resolved through a libSQL link index keyed by `file_path` (pre-L7, per the no-UUID-before-L7 non-negotiable).
2. **Wiki-links render and navigate.** Live Preview decorates wiki-links; a click opens the target. Unresolved links are visually distinct and offer to create the missing note.
3. **Backlinks.** A right-sidebar panel lists every note that links to the current note, with context, refreshed live as the index changes.
4. **Tags.** Inline `#tag` and frontmatter `tags:` feed one unified tag index; nested `#parent/child`; case-insensitive matching, case-preserving display; tags decorate in Live Preview.
5. **Virtual tag pages.** A `tag:` route opens a virtual page listing every file carrying that tag or any descendant (prefix match).
6. **Link + tag autocomplete.** Typing `[[` opens link autocomplete; typing `#` at a word boundary opens tag autocomplete.
7. **Block references.** `^block-id` slugs are lazily assigned (only when a reference is created), stored in the `blocks` / `block_refs` tables, and `[[note#^id]]` resolves to them.
8. **Embeds.** `![[target]]` renders another note inline in Live Preview; section and block embeds work; recursion is bounded (default depth 4).
9. **Unlinked mentions.** A right-sidebar panel surfaces plain-text occurrences of a note's title/aliases that are not yet links, with a one-click "link it" action.
10. **Rename → Pending Rewrites Cache.** Renaming a file, tag, or block-id is instant; referrer files are rewritten via the deferred-write Pending Rewrites Cache; the status bar shows the unflushed count.

What is **not** in L3 — see §7.

---

## 2. Surfaces

### 2.1 Wiki-link parsing + the link index

Wiki-links are not CommonMark. L3 extends parsing on two fronts (see §5 deviation #1):

- **Rust `cubical-ast` parser** — emits the `WikiLink { target, display, anchor, embed }` node (the variant already exists in the canonical AST, `document-model.md` §5.5). This path feeds the index.
- **Lezer editor grammar** — a custom inline parser rule so the editor's syntax tree carries wiki-link nodes for decorations (Session B) and so the TS normalizer keeps L1 parity.

The **link index** is a new libSQL table. `document-model.md` §5.2 names "the link index" but does not lock its columns; L3 defines them (§3.1, §5 deviation #2):

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

**Resolution.** A `target_raw` resolves to a file by: exact vault-relative path, then case-insensitive basename match, then unique path-suffix match. Ambiguous or missing → `target_path` stays `NULL` (unresolved). Resolution runs during vault scan and incrementally on file-change.

### 2.2 Wiki-link Live Preview + navigation

Live Preview (extending `ui/src/editor/decorations.ts`) decorates wiki-links: off the cursor line the brackets and anchor markup are hidden and the display text (or target) is shown as an accent link; on the cursor line the raw `[[…]]` shows through, consistent with every other L2 decoration. Unresolved links render in a distinct style (e.g. `--c-warning`, dashed underline).

A click on a resolved link opens the target file (and scrolls to the heading/block anchor if present). A click on an unresolved link offers to create the note at the resolved-by-convention path. The raw-source toggle (L2 Session E compartment) reveals the literal source as for all decorations.

### 2.3 Backlinks panel + the right sidebar

L2 §22 deferred the right sidebar to L3. L3 introduces the **right-sidebar shell** (collapsible, per `ui.md` §11.1) and its first occupant, the **Backlinks panel**: for the open note, every note whose `links.target_path` resolves to it, each row showing the source note and a context snippet around the link. The panel refreshes whenever the link index changes for a relevant file. Empty state when there are no backlinks. A row click navigates to the source.

### 2.4 Tags

Two declaration sources, one index (`document-model.md` §5.6): inline `#tag` (must follow whitespace/line-start; excluded inside fenced code, inline code, link targets, and wiki-link targets) and frontmatter `tags: [a, b/c]`. Both the Rust and Lezer parsers gain tag recognition. Nesting uses `/`. Matching is case-insensitive; display is case-preserving (first-seen casing wins). Tags decorate in Live Preview as accent-coloured `#chips`.

The `tags` table is exactly the locked schema (`document-model.md` §5.6):

```sql
CREATE TABLE tags (
    file_path TEXT NOT NULL,
    tag_path  TEXT NOT NULL,
    source    TEXT NOT NULL,            -- 'inline' | 'frontmatter'
    PRIMARY KEY (file_path, tag_path, source)
);
CREATE INDEX idx_tags_path ON tags(tag_path);
```

### 2.5 Virtual tag pages

A `tag:` route opens a **virtual page** — backed by a libSQL query, not a real `.md` file — listing every file carrying that tag *or any descendant* (prefix match: `tag:parent` matches `parent`, `parent/child`, deeper). Reached by clicking a tag decoration or a tag chip in Properties. Empty state when unused. File rows navigate.

### 2.6 Link + tag autocomplete

Per `ui.md` §11.2. Typing `[[` opens a link-autocomplete dropdown over the vault's files (and, after `#` inside the brackets, that file's headings / block-ids). Typing `#` at a word boundary outside code opens tag autocomplete over existing tags, prefix-filtered. Built on CM6's autocomplete. Selecting an entry completes the `[[…]]` or `#…` token.

### 2.7 Block references

A block ID is a user-slug `^id` appended to a paragraph or list item. **Lazy assignment** (`document-model.md` §5.3): an ID is minted only when the user creates a reference to that block — never bulk auto-assigned. Minting writes the literal `^id` into the markdown source (content, not file-identity — this does **not** violate the no-UUID-before-L7 non-negotiable; see §5 deviation #3). The `blocks` and `block_refs` tables are the locked schema:

```sql
blocks(file_path, block_id, position_hint, last_modified)
block_refs(source_file_path, target_file_path, target_block_id)
```

`[[note#^id]]` resolves through these. Broken block refs (target paragraph or ID deleted) surface alongside broken wiki-links in the vault-health status-bar item.

### 2.8 Embeds

`![[target]]` renders the full target note inline in Live Preview; `![[target#heading]]` a section; `![[target#^id]]` a single block. Embeds resolve through the same link index as wiki-links (`is_embed = 1`). Recursion is bounded — default max depth 4 (`document-model.md` §5.4); beyond the depth the embed renders as a styled link instead of inlined content. Unresolved embeds render a placeholder.

### 2.9 Unlinked mentions

A second right-sidebar panel. For the open note, scan vault text for occurrences of the note's title and any frontmatter `aliases` that are *not* already links. Each row shows the mentioning note + context and a "link this mention" action that rewrites the plain text into a `[[…]]`. Already-linked occurrences are excluded. The scan is the most perf-sensitive L3 surface — it must stay responsive on a large vault.

### 2.10 Rename → Pending Rewrites Cache

Renaming a file, a tag, or a block-id is **instant**; the disk impact — rewriting referrer files — is **coalesced** through the Pending Rewrites Cache (`document-model.md` §5.7, locked schema `pending_rewrites`). Renames enqueue rows grouped by `rename_op_id`. Every read of a file's effective content materialises pending rewrites for that file in `created_at` order. Flush triggers: a 5-minute timer (configurable), app close (mandatory), a >50-pending-per-file fuse, and a manual "save all pending changes." The status bar shows the unflushed count; a flush emits a toast. Undo is instant within the unflushed window (delete the `rename_op_id` group). External-write conflicts re-apply textually per §5.7.

---

## 3. IPC surface

All new commands follow the L0 §8 pure-handler + thin-shim pattern (types in `crates/cubical-app/src/api/types.rs`, pure handlers in `crates/cubical-app/src/commands/`, Tauri shims in `lib.rs`).

### 3.1 Index + resolution

- `resolve_link { vault_id, source_path, target_raw }` → `{ target_path: Option<String>, anchor: Option<Anchor> }` — resolve a wiki-link.
- `get_backlinks { vault_id, path }` → `{ backlinks: [{ source_path, context, position }] }`.
- `query_tag_page { vault_id, tag_path }` → `{ files: [{ path, title }] }` — prefix-match listing.
- `get_unlinked_mentions { vault_id, path }` → `{ mentions: [{ source_path, context, position }] }`.

### 3.2 Autocomplete

- `link_autocomplete { vault_id, query }` → file / heading / block-id candidates.
- `tag_autocomplete { vault_id, query }` → existing-tag candidates.

### 3.3 Block references

- `create_block_ref { vault_id, target_path, position }` → `{ block_id }` — lazily mint + persist a block ID.

### 3.4 Rename + pending rewrites

- `rename_file { vault_id, from_path, to_path }` → enqueues pending rewrites, returns `{ rename_op_id }`.
- `rename_tag { vault_id, old_tag, new_tag }` / `rename_block_id { … }` — same shape.
- `flush_pending_rewrites { vault_id }` → `{ files_rewritten, refs_updated }`.
- `get_pending_rewrites_count { vault_id }` → `{ count }`.
- `undo_rename { vault_id, rename_op_id }` — within the unflushed window.

### 3.5 Events

- `vault:index-changed { vault_id, kind }` — fired when links/tags/backlinks change so the sidebar + tag pages refresh without polling.
- `vault:pending-rewrites-changed { vault_id, count }` — drives the status-bar count.

---

## 4. Frontend structure

New files:

```
ui/src/
├── editor/
│   ├── wikilink.ts          # Lezer inline rule for [[…]] / ![[…]]
│   ├── tag.ts               # Lezer inline rule for #tag
│   ├── autocomplete.ts      # [[ and # autocomplete (§2.6)
│   └── embed.ts             # ![[…]] embed rendering (§2.8)
├── RightSidebar.tsx         # collapsible right-sidebar shell (§2.3)
├── sidebar/
│   ├── Backlinks.tsx        # backlinks panel (§2.3)
│   └── UnlinkedMentions.tsx # unlinked-mentions panel (§2.9)
├── TagPage.tsx              # virtual tag page (§2.5)
└── statusbar/
    └── PendingRewrites.tsx  # unflushed-count indicator + toast (§2.10)
```

Modified: `ui/src/editor/decorations.ts` (wiki-link + tag decorations), `ui/src/Editor.tsx`, `ui/src/App.tsx` (sidebar slot, tag-page route, navigation), `ui/src/ast/normalize.ts` (parity for the new nodes), `ui/src/api/ipc.ts` (new commands + events).

New Rust: **incremental `crates/cubical-index` migrations** — each table-introducing session ships its own. `001_initial.sql` and `002_frontmatter.sql` already exist (L0 and L1); L3's first migration is `003` for `links` in Session A, then further numbered migrations as `tags`, `blocks` / `block_refs`, and `pending_rewrites` land in D, G, J. Plus query modules; link/tag extraction in `crates/cubical-core`; the wiki-link/tag parser rules in `crates/cubical-ast`; the §3 commands in `crates/cubical-app`. No new crates; the crate dependency graph is unchanged.

---

## 5. Architecture deviations introduced or anticipated

1. **Parsing extends two parsers.** Wiki-links, embeds, tags, and block-ids are recognised by both the Rust `cubical-ast` parser and the Lezer editor grammar. The L1 parity contract (`parity_fixtures`) is *extended* to cover the new node types — not weakened. This is the load-bearing L3 call; promote to `document-model.md` at L3 close if it holds.
2. **L3 defines the `links` table schema.** `document-model.md` §5.2 names the link index but does not lock its columns; §2.1 above defines them. Candidate for promotion at L3 close.
3. **Block IDs are content, not file identity.** Minting a `^block-id` writes a slug into the `.md` source. This does **not** violate the "no file-identity UUIDs before L7" non-negotiable — block IDs are user-facing content slugs scoped per file, exactly as `document-model.md` §5.3 specifies, not injected identity.
4. **Right sidebar lands in L3.** `ui.md` §11.1 already specifies it; L3 builds the shell. Not a new decision — first construction.

No `docs/architecture/` files are modified mid-layer. Load-bearing calls are promoted at the L3-close step (Session K).

---

## 6. Definition of done

- [ ] L2 carry-over smoke confirmed at Session A kickoff (autosave, Live Preview, Properties still work).
- [ ] `cargo test --workspace` green (new tests for parsing, the index queries, resolution, extraction, rename/pending-rewrites).
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --check` clean.
- [ ] `npm run build` clean; `npx tsc --noEmit` clean.
- [ ] `npm test` (vitest) green (new tests for the Lezer rules, decorations, autocomplete, sidebar logic).
- [ ] L1 parity (`parity_fixtures`) extended to wiki-link / tag / embed / block-id nodes and green.
- [ ] Wiki-links: every form parses, resolves, decorates, and navigates; unresolved links are distinct.
- [ ] Backlinks panel lists linking notes and refreshes live.
- [ ] Tags: inline + frontmatter indexed, nested, decorated; virtual tag pages list prefix-matched files.
- [ ] Autocomplete: `[[` and `#` both work; no trigger inside code.
- [ ] Block refs: lazy assignment mints `^id` only on reference; `[[#^id]]` resolves.
- [ ] Embeds: note / section / block embeds render; depth cap holds; cycles are safe.
- [ ] Unlinked mentions surface and the "link it" action works; scan stays responsive on a large vault.
- [ ] Rename: instant; referrers coalesced through Pending Rewrites; flush triggers work; status-bar count correct; undo works.
- [ ] Interactive smoke pass recorded in §9 (Session K closeout).
- [ ] `l3` git tag applied only after all of the above.

---

## 7. Out of scope

- **Search** — Tantivy full-text, Dataview-style queries, the persistent search panel, the `Cmd/Ctrl+K` Omni-Bar. L4.
- **Asset / image rendering in Live Preview.** L3's link index enables it, but the asset-resolution + dedup pipeline is post-L3 polish (L5).
- **Graph View** — the WebGPU knowledge-graph visualisation. L9.
- **3-way merge UI** for the Pending Rewrites external-write conflict. L8 Time Machine; L3 uses the §5.7 textual re-apply.
- **Cross-vault links / backlinks.** `ui.md` §11.5 — out of scope project-wide.
- **File-identity UUIDs.** L7. L3 keys the index by `file_path`.
- **Tabs / split-pane.** Still post-L2, no layer assigned.

---

## 8. Session slicing

Eleven sessions, dependency-ordered. One feature surface per session; each is independently verifiable. Session A is the foundation — the parser + index every later session reads. Session J (Pending Rewrites) is last among feature sessions because everything renameable feeds it. Session K is the closeout, its own session so smoke + tag are not bundled under feature work.

### Session A — Wiki-link parsing + link index

- **Scope:** extend the Rust `cubical-ast` parser to emit `WikiLink` nodes for every wiki-link form incl. `![[…]]`; TS normalizer parity; the `links` table via the first L3 migration (`003_links.sql` — `002_frontmatter.sql` already exists from L1); link extraction during vault scan and on file-change; link resolution (§2.1); the `resolve_link` IPC.
- **Key files:** `crates/cubical-ast/*`, `crates/cubical-index/` (migration + queries), `crates/cubical-core/src/vault/{scan,watcher}.rs`, `crates/cubical-app/src/{api/types.rs,commands,lib.rs}`, `ui/src/ast/normalize.ts`.
- **DoD:** parse fixtures cover every form; `parity_fixtures` green; `links` rows created on scan and updated on edit; `resolve_link` handles exact / case-insensitive / suffix matches; unresolved → `NULL`.
- **Prereqs:** L2 closed.

### Session B — Wiki-link Live Preview + navigation

- **Scope:** Lezer inline rule for `[[…]]` / `![[…]]`; wiki-link decorations in `decorations.ts`; unresolved styling; click-to-navigate (resolved → open; unresolved → offer create).
- **Key files:** `ui/src/editor/wikilink.ts`, `ui/src/editor/decorations.ts`, `ui/src/Editor.tsx`, `ui/src/App.tsx`.
- **DoD:** each form decorates; cursor line reveals raw; unresolved distinct; click navigates (incl. heading/block anchor).
- **Prereqs:** A.

### Session C — Backlinks panel + right-sidebar shell

- **Scope:** the collapsible right-sidebar shell; `get_backlinks` IPC; the Backlinks panel with context snippets; live refresh on `vault:index-changed`.
- **Key files:** `ui/src/RightSidebar.tsx`, `ui/src/sidebar/Backlinks.tsx`, `ui/src/App.tsx`, `crates/cubical-app/*`.
- **DoD:** backlinks listed; refresh on link add/remove; empty state; row click navigates.
- **Prereqs:** A.

### Session D — Tags: parsing, index, nested tags, decoration

- **Scope:** inline + frontmatter tag recognition in both parsers; the `tags` table via its own incremental migration; nested `#parent/child`; case-insensitive match / case-preserving display; tag Live Preview decoration; extraction on scan/change.
- **Key files:** `crates/cubical-ast/*`, `crates/cubical-index/*`, `crates/cubical-core/*`, `ui/src/editor/tag.ts`, `ui/src/editor/decorations.ts`.
- **DoD:** inline + frontmatter tags indexed; nesting; code-block exclusion; decoration renders.
- **Prereqs:** A (parser infrastructure).

### Session E — Virtual tag pages

- **Scope:** the `tag:` route; the virtual tag page (libSQL-backed, prefix match); navigation from a tag decoration / Properties chip.
- **Key files:** `ui/src/TagPage.tsx`, `ui/src/App.tsx`, `query_tag_page` IPC.
- **DoD:** clicking a tag opens its page; descendants included; empty state; file rows navigate.
- **Prereqs:** D.

### Session F — Link + tag autocomplete

- **Scope:** `[[` link autocomplete (files + headings/block-ids) and `#` tag autocomplete via CM6 autocomplete; word-boundary trigger; no trigger inside code.
- **Key files:** `ui/src/editor/autocomplete.ts`, `ui/src/Editor.tsx`, autocomplete IPC.
- **DoD:** `[[` lists files and inserts a valid link; `#` lists tags; correct trigger gating.
- **Prereqs:** A, D.

### Session G — Block references

- **Scope:** lazy `^block-id` assignment (mint only on reference); `blocks` / `block_refs` tables via their own incremental migration; `[[note#^id]]` resolution; broken-block-ref surfacing.
- **Key files:** `crates/cubical-ast/*`, `crates/cubical-index/*`, `crates/cubical-core/*`, `crates/cubical-app/*`, `ui/src/editor/decorations.ts`.
- **DoD:** creating a block ref mints + persists `^id` in the source; `[[#^id]]` resolves; no bulk auto-assignment; broken refs surface.
- **Prereqs:** A.

### Session H — Embeds

- **Scope:** `![[…]]` note / section / block embed rendering in Live Preview; bounded recursion (depth 4); beyond-depth → styled link; unresolved placeholder.
- **Key files:** `ui/src/editor/embed.ts`, `ui/src/editor/decorations.ts`, `ui/src/Editor.tsx`, IPC for embedded content.
- **DoD:** all three embed forms render; depth cap; cycle safety; unresolved placeholder.
- **Prereqs:** A, G.

### Session I — Unlinked mentions

- **Scope:** vault-text scan for title/alias occurrences that are not links; the Unlinked Mentions sidebar panel; the "link this mention" rewrite action.
- **Key files:** `ui/src/sidebar/UnlinkedMentions.tsx`, `get_unlinked_mentions` IPC, `crates/cubical-core` / `crates/cubical-index` scan.
- **DoD:** mentions found; already-linked excluded; "link it" rewrites the mention; scan responsive on a large vault.
- **Prereqs:** A, C.

### Session J — Rename → Pending Rewrites Cache

- **Scope:** the `pending_rewrites` table via its own incremental migration; `rename_file` / `rename_tag` / `rename_block_id` enqueueing grouped by `rename_op_id`; materialise-on-read; flush triggers (timer, app close, >50 fuse, manual); status-bar count + flush toast; undo within the unflushed window; external-write-conflict re-apply.
- **Key files:** `crates/cubical-index/*`, `crates/cubical-core/*`, `crates/cubical-app/*`, `ui/src/statusbar/PendingRewrites.tsx`, `ui/src/App.tsx`.
- **DoD:** rename instant; referrers not rewritten synchronously; reads materialise; flush rewrites referrers; status-bar count correct; undo works; external-write conflict handled per §5.7.
- **Prereqs:** A, D, G.

### Session K — Interactive smoke + L3 closeout

- **Scope:** no new feature code. Interactive `cargo tauri dev` smoke of all L3 surfaces; fill §9; promote load-bearing §5 deviations into `docs/architecture/`; rewrite `CLAUDE.md` "Project state" to L3 closed / L4 next; apply the `l3` tag.
- **Key files:** `docs/layer-3-spec.md` (§9), `CLAUDE.md`, `docs/README.md`.
- **DoD:** every §6 box ticked; §9 recorded; `l3` tag applied on the closeout commit.
- **Prereqs:** A–J.

---

## 9. What was built

*[Filled in per session as L3 lands.]*

### 9.1 Session A — Wiki-link parsing + link index

**Done 2026-05-24.** Wiki-link syntax (`[[…]]` / `![[…]]` with optional `#heading` / `#^block-id` anchors and `|display` text) is now part of the canonical AST on both sides, the libSQL `links` table is populated on every scan and watcher event, and a `resolve_link` IPC answers "what file does this wiki-link point at?" from the frontend.

**AST: `Anchor` + `Inline::WikiLink`.** `crates/cubical-ast/src/types.rs` gained an `Anchor` enum (`Heading{value}` / `Block{value}`, `#[serde(tag = "kind")]`, `snake_case`) and an `Inline::WikiLink { target, display, anchor, embed }` variant; both are re-exported from `cubical_ast`. The TS mirror in `ui/src/ast/types.ts` extends the `Inline` union and adds a parallel `Anchor` type. A serde round-trip test pins the wire shape (`kind: "wiki_link"`).

**Tokenizers: `scan_wikilinks` / `scanWikilinks`.** Pure functions (`crates/cubical-ast/src/wikilink.rs` + `ui/src/ast/wikilink.ts`) walk a text run, recognise `[[…]]` and `![[…]]`, and yield a `TokenizedRun = Text | WikiLink` sequence. Grammar — locked by 15 unit tests per side and 5 parity fixtures — anchor (`#`) precedes display (`|`); empty / whitespace-only targets reject the run as plain text; unclosed `[[` passes through unchanged.

**Normalize integration.** The Rust normalizer (`cubical-ast/src/normalize.rs`) splits every `Inline::Text` emitted by pulldown-cmark through `scan_wikilinks` at heading + paragraph construction sites and recurses into emph/strong/link/image children. Code spans are `Inline::Code` (a separate AST node) so wiki-link patterns inside backticks stay verbatim. The TS side adds a `splitWikilinks` pass to `ui/src/ast/normalize.ts` — but Lezer's @lezer/markdown grammar mis-parses `[[X]]` as a shortcut Link with empty `dest` and `![[X]]` as an Image, so the helper first re-flattens any empty-`dest` Link/Image back to raw bracketed text (mirroring pulldown-cmark's plain-text output for unresolved references), *then* runs `scanWikilinks` on the merged text runs. This recombination is the §5.5 sanctioned-deviation pattern applied at the AST level — see `docs/architecture/document-model.md` §5.5.

**Parity harness.** Five new fixtures (`wikilink_simple`, `wikilink_with_display`, `wikilink_heading_anchor`, `wikilink_block_anchor_with_display`, `wikilink_embed`) live in `crates/cubical-ast/tests/fixtures/parity.json`. The Rust runner regenerates `expected` via `CUBICAL_UPDATE_PARITY_FIXTURES=1`; the TS runner asserts equality. Both sides agree byte-for-byte on every fixture.

**Index schema.** `crates/cubical-index/migrations/003_links.sql` adds a `links` table: `(id, source_path, target_raw, target_path, anchor_kind, anchor_value, display_text, is_embed, position)`. Indexes on `source_path` and `target_path` cover both the "what links does this file have" and "what backlinks point at this file" queries. The FK on `source_path → files(path)` cascades on delete. Migrations registered in the linear runner; `HIGHEST_KNOWN_VERSION` bumped to 3.

**Query module.** `crates/cubical-index/src/links.rs` exposes `LinkRow`, `replace_links_for_file`, `links_from`, and `links_to`. `replace_links_for_file` uses delete-then-insert keyed on `source_path` and *does not* wrap in its own transaction — it participates in the caller's transaction, which is what scan + watcher need (SQLite has no nested BEGIN). Five tests cover round-trip, backlinks, atomic replace, position ordering, and FK cascade.

**Extraction + resolution.** `crates/cubical-core/src/vault/links.rs` adds three pieces: `extract_links(&Document) -> Vec<LinkExtraction>` (pure walker), `resolve_target(target, &[String]) -> Option<String>` (pure resolver), and `refresh_links(&Vault, abs, rel)` (the side-effecting helper called by the write paths). Resolution order — exact match (with or without `.md`) → unique basename match, case-insensitive → unique path-suffix match. Ambiguous matches at the basename or suffix level return `None`; the row still lands with `target_path = NULL` so the backlinks UI can surface unresolved links and a later rename can re-resolve.

**Write-path plumbing.** `vault::scan` calls `refresh_links` after its `files` UPSERT (mirroring `refresh_frontmatter`), and `apply_watch_event_to_db` does the same for `Created` / `Modified` events. `Removed` leaves the row alone (FK cascade fires when L3's later pending-rewrites session ships the actual `DELETE FROM files`); `Renamed` defers to Session J. A new integration test in `scan.rs` proves the round-trip: a two-file vault with `a.md` linking to a missing `c.md` and an existing `b.md` lands two rows — one resolved to `b.md`, one with `target_path = NULL`.

**IPC: `resolve_link`.** `crates/cubical-app/src/commands/links.rs` exposes the pure handler; `lib.rs` adds the Tauri shim. The request takes `vault_id` + `target_raw` (post-tokenizer shape, no `[[…]]`, no leading `!`) and returns `{ target_path: Option<String>, anchor: Option<ResolvedAnchor> }`. The handler splits the anchor inline (the same grammar as the AST tokenizer, but on a single target string — no need to expose `cubical_ast::wikilink` publicly for one consumer) and runs `resolve_target` over the live `files.path` snapshot. Six tests cover known/unknown targets, heading + block anchors, unknown vault, and anchor-without-target-match.

**TS wrapper.** `ui/src/api/ipc.ts` adds `resolveLink`, `ResolveLinkRequest`, `ResolveLinkResponse`, and `ResolvedAnchor`. Optional `source_path` is conditionally added to the wire payload so `exactOptionalPropertyTypes` doesn't reject `undefined` — mirrors the `writeFileText` / `expected_seen_hash` pattern.

**Decisions worth noting.**
- *Grammar precedence:* anchor before pipe. `[[note#heading|display]]` parses as `target=note, anchor=heading, display=display`; `[[note|display#3]]` parses as `target=note, display="display#3"`. The `#` after `|` is part of the display text.
- *Resolution order:* exact > basename-ci > unique-suffix; ambiguity at the latter two yields `None`. This matches the Obsidian-style "shortest unique reference" intuition without requiring the user to author full paths.
- *Empty + whitespace-only targets:* the tokenizer rejects them as plain text, mirroring pulldown-cmark's "I don't recognise this" fall-through. `[[]]` and `[[   ]]` ship as literal text.
- *Lezer mis-parse handling:* §5.5 already sanctioned editor-side decorations bypassing the canonical AST. Session A adds the corresponding canonical-AST workaround on the TS normalizer — re-flatten empty-`dest` Link/Image back to text before tokenizing. The Rust side doesn't need this because pulldown-cmark already emits `[[…]]` as plain text.
- *Per-inline byte positions:* not introduced. `LinkExtraction::position` is the start of the enclosing block's span. Good enough for ordering rows in the index; per-inline spans are post-L1 work and can land alongside the first feature that needs them (the click-to-navigate work in Session B uses Live Preview decorations, which have their own positions).
- *Internal-only `cubical_ast::wikilink`:* kept private. The `resolve_link` IPC re-implements the anchor split inline (six lines) rather than promoting the tokenizer to public surface for a single non-AST consumer. The AST grammar stays the source of truth via fixtures, not via shared code.

**Tests:** 170 Rust passing (was 121 + 49 new across the layer), 127 vitest passing (was 104 + 23 new). `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npx tsc --noEmit`, and `npm run build` all clean.

**What's left for L3.** Sessions B–K — Live Preview + click-to-navigate, backlinks panel, tags, virtual tag pages, link/tag autocomplete, block references, embeds, unlinked mentions, pending-rewrites cache, and the layer closeout. The index this session built is the substrate they consume.

### 9.2 Session B — Wiki-link Live Preview + click-to-navigate

**Done 2026-05-25.** Wiki-links are now first-class citizens of the editor surface: every shape decorates in Live Preview (brackets + anchor + display markup hidden off-cursor, raw source revealed on-cursor, embeds carry an indicator widget), unresolved targets render with a dashed-warning style backed by a per-vault cache, clicks on resolved links open the target file (with heading-anchor scroll), and clicks on unresolved links raise a centered modal offering to create the missing note at the resolved-by-convention path.

**Editor Lezer rule.** `ui/src/editor/wikilink.ts` introduces a tiny `MarkdownConfig` extension that emits a single `WikiLink` node spanning the entire `[[…]]` or `![[…]]` token. The rule registers `before: "Link"` so the default Lezer shortcut-Link parser no longer claims `[[X]]` as a `Link` with empty `dest`. It rejects empty / whitespace-only targets and refuses to nest, matching the Session A `scan_wikilinks` grammar exactly. No sub-nodes are emitted — the decoration plugin re-tokenises the body with `scanWikilinks` (already in `ui/src/ast/wikilink.ts`) to find the visible-text range and the hide ranges. The rule is installed **only** in the editor's `markdown({ extensions: [...] })` configuration; `ui/src/ast/normalize.ts` is untouched, so the L1 cross-language parity contract still rides on the Session A re-flatten workaround — the editor's syntax tree and the canonical AST stay deliberately divergent here, sanctioned by `document-model.md` §5.5.

**Resolver: per-vault cache.** `ui/src/editor/wikilinkResolver.ts` exposes `createWikiLinkResolver(vault_id, ipc?)`. The resolver owns a `Map<targetKey, WikiLinkResolution>` keyed on the target-as-written (target plus any `#anchor`, mirroring `resolve_link`'s input shape), dedupes concurrent fetches, and caches failures as `{ target_path: null, anchor: null }` so a flaky IPC doesn't loop. Subscribers register via `onUpdate(handler)` and get notified on every fetch completion and on `invalidate()`. `invalidate()` clears the cache but leaves in-flight promises alone (they overwrite stale entries harmlessly when they settle).

**Decoration mapping.** `collectDecorations` gained a `WikiLink` case (and a new `resolverLookup?: (k) => WikiLinkResolution | undefined` parameter). For each token it:

| Shape | Visible range | Hide ranges | Extra |
|---|---|---|---|
| `[[note]]` | `note` | `[[`, `]]` | — |
| `[[note\|display]]` | `display` | `[[note\|`, `]]` | — |
| `[[note#heading]]` | `note` | `[[`, `#heading]]` | — |
| `[[note#^id]]` | `note` | `[[`, `#^id]]` | — |
| `![[diagram]]` | `diagram` | `![[`, `]]` | `mark-wikilink-embed` widget at token start |

The visible range gets `mark-wikilink` (resolved or pending) or `mark-wikilink-unresolved` (target known-missing — dashed underline + `--c-warning`). On the cursor line all per-token ranges collapse into a single `mark-marker-muted` mark covering the whole token, mirroring how `Link` / `Emphasis` reveal raw source on the active line. Three new `DecoKind` values landed: `mark-wikilink`, `mark-wikilink-unresolved`, `mark-wikilink-embed`. The base theme adds three matching CSS rules.

**Resolver Facet + StateEffect.** `wikilinkResolverFacet: Facet<{get, fetch} | null>` flows the resolver into the decoration plugin without prop-drilling. `Editor.tsx` reconfigures a `Compartment` carrying this facet whenever the parent's `wikilinkResolver` prop changes (different vault). The decoration plugin reads `view.state.facet(wikilinkResolverFacet)` in `buildFor` for sync lookup. A separate `wikilinkResolverUpdated = StateEffect.define<null>()` is fired by `Editor.tsx`'s `onUpdate` subscription so the plugin can rebuild when the cache changes; the plugin watches `update.transactions.some(tr => tr.effects.some(e => e.is(...)))` in its `update()` method.

**Async fetches.** After every rebuild, `kickResolverFetches` walks the tree, asks the resolver for every unique target it sees, and calls `.fetch()` on the ones with no cached entry. The resolver dedupes; pending tokens render as resolved-style. When the IPC returns, the plugin gets a `wikilinkResolverUpdated` effect and repaints — unresolved targets flip to the warning style at that moment. Brief flicker; acceptable per the plan.

**Click router.** `ui/src/editor/wikilinkClick.ts` exports a pure `handleWikiLinkClick(target, ctx)` that returns `"navigated" | "offered" | "pending"`. `Editor.tsx` attaches a `domEventHandlers({ click })` extension that maps the DOM target via `view.posAtDOM`, walks the Lezer tree for a containing `WikiLink` node, re-tokenises the raw text to extract `target + anchor`, and dispatches through the pure router. Modifier-key clicks (Cmd/Ctrl/Shift/Alt) bypass the handler so default text-selection behaviour stays intact.

**Heading anchor scroll.** `EditorApi.scrollToHeading(value)` walks the syntax tree for an ATX or Setext heading whose plain text matches (`# ` stripping for ATX; trim for both); on match, `EditorView.scrollIntoView(line.from, { y: "start" })`. Block anchors are Session G territory — the navigation handler logs at `debug` level and no-ops.

**Create-by-convention path.** `createPathForTarget(targetRaw)` strips any `#anchor` then appends `.md` if missing. Slashes in the target survive as path separators (`notes/sub/Idea` → `notes/sub/Idea.md`); a bare target lands at the vault root.

**App wiring.** `App.tsx` owns one `WikiLinkResolver` per vault: created in `handleOpen` and reset to `null` between vaults. `vault:file-changed` invalidates it (so a freshly-created target flips from unresolved to resolved without a reload). The navigation handler reuses the existing `handleSelectFile` flow — autosave / `seenHash` / `dirty` plumbing stays correct — fabricating a minimal `FileEntry` when the target sits outside the rendered list window. The create-offer modal is a Solid `<Show>` panel mirroring the conflict-banner styling: centered, dimmed backdrop, two buttons (Cancel + Create note). Accept writes an empty file via `writeFileText` and then navigates to it.

**Decisions worth noting.**
- *Editor-only Lezer rule:* the wikilink extension lives only in `markdown({ extensions: [...] })`. The TS normalizer's re-flatten workaround stays as the L1-parity surface. Adding the extension to the normalizer's bare `parser` would change the parity fixtures; defer to L3 closeout if the deviation matures into a promotion.
- *Cache key = target + anchor:* the resolver key matches the `target_raw` shape the IPC accepts. `[[note]]` and `[[note#heading]]` are *separate* cache entries — the backend's response carries an anchor field, but the path resolution may diverge if a future session adds anchor-aware backend lookup.
- *Pending = resolved-style:* unchecked tokens render without the warning style so the user doesn't see a flash of warning for every newly-seen wiki-link. The next rebuild after the IPC returns paints unresolved targets correctly.
- *Centered modal over native confirm:* `window.confirm()` works in the Tauri webview but looks foreign against the project's design tokens. The modal pattern matches the existing conflict banner — borders, radii, button shapes — so it feels native to the app.
- *Block-anchor click is a no-op (debug log):* per spec §2.2 and the Session B prompt, block-ref *resolution* arrives in Session G. The router treats `Block{value}` anchors as "resolved file, no scroll" rather than failing the click.
- *EditorApi.scrollToHeading exact-match:* heading lookup is `trim() ==` against the heading's plain text. A future session can soften this to case-insensitive / fuzzy if the spec calls for it; spec §2.2 doesn't specify.
- *Click handler scope:* clicks with any modifier (Cmd/Ctrl/Shift/Alt) bypass the router entirely. Plain left-click only. Multi-pane / open-in-new-tab flows are deferred (no tab system yet — `ui.md` §11.4 + L3 spec §7).
- *Resolver Facet shape:* the facet carries `{ get, fetch }` rather than the full `WikiLinkResolver`. The `invalidate` and `onUpdate` halves live with `App.tsx` and the `Editor.tsx` subscription respectively — the plugin only needs the two read/write operations.

**Tests:** 170 Rust passing (unchanged — no Rust gap surfaced this session), 161 vitest passing (was 127 + 34 new: 7 inline-rule, 7 resolver, 9 click-router, 9 decoration shapes, 2 raw-source-toggle structural). `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npx tsc --noEmit`, and `npm run build` all clean.

**Interactive smoke status.** Hands-on `cargo tauri dev` smoke was not performed in this session — the native Tauri window can't be browser-driven and the session ran in an automated context with no operator at the keyboard. The unit-test coverage exercises every pure decision (decoration mapping for each shape; resolver cache hit/miss/invalidate/onUpdate; click router for resolved/unresolved/pending; create-by-convention path), plus the `livePreviewDecorations` bundle structural regression. End-to-end behaviour (heading-anchor scroll lands at the right pixel; modal dismissal on backdrop click; resolver invalidation flips a warning to accent without reload) needs a hands-on smoke at the next opportunity. Recommended smoke vault:

```
NoteA.md:
  # NoteA
  body linking to [[NoteB]] and [[NoteB#heading]] and [[NoteB|nice]]
  Embed: ![[NoteB]]
  Missing: [[NeverCreated]]

NoteB.md:
  # NoteB
  body
  ## heading
  more
```

Confirm: off-cursor hides brackets, the cursor-line reveal works, `NeverCreated` carries the dashed-warning style, clicks navigate (`NoteB#heading` scrolls to `## heading`), the modal dismisses on backdrop click, creating `NeverCreated.md` flips its style without reload, and `Cmd/Ctrl+E` reveals literal source for every wiki-link.

**What's left for L3.** Sessions C–K — backlinks panel + right-sidebar shell (C), tags (D), virtual tag pages (E), link/tag autocomplete (F), block references (G), embeds proper (H — Session B's embed indicator is purely visual; the inline render is H's territory), unlinked mentions (I), pending-rewrites cache (J), and the layer closeout (K).

### 9.3 Session C — Backlinks panel + right-sidebar shell

**Done 2026-05-26.** The right-sidebar shell now lives next to the editor and hosts its first occupant — the Backlinks panel — listing every note whose `links.target_path` resolves to the open file, each row carrying a single-line context snippet drawn from the source. The panel refreshes on a 200ms-debounced `vault:file-changed` tick, row clicks reuse the Session B navigation seam, and the collapsed state of the shell persists per-vault.

**Index: `BacklinkRow` + `backlinks_for`.** `crates/cubical-index/src/links.rs` gained a dedicated query — `backlinks_for(target_path) -> Vec<BacklinkRow>` — surfacing `source_path` alongside the existing `LinkRow` columns. The choice between enriching `links_to` (which omits `source_path`) and adding a new query went to a new query: `links_to` has no production callers (its only uses are inside `links.rs`'s test module), so a clean dedicated shape was cheaper than dragging a tuple through both signatures. Ordering is `(source_path, position)` — same key Session A locked for `links_to` — so per-file grouping in the panel is stable. Two tests cover ordering across multiple sources and the empty case; both `LinkRow` and `BacklinkRow` are now re-exported from `cubical_index`.

**IPC types + handler.** `crates/cubical-app/src/api/types.rs` adds `GetBacklinksRequest { vault_id, path }`, `GetBacklinksResponse { backlinks: Vec<Backlink> }`, and the row shape `Backlink { source_path, context, position }` — the wire mirror of `BacklinkRow` with a snippet baked in. The handler lives in a new `commands/backlinks.rs` module, registered alongside `links` and `vault` in `commands/mod.rs`. It pulls the open vault from `AppState`, calls `backlinks_for`, then per row reads the source file from disk and builds a snippet via `build_snippet`. A read failure (file deleted between extraction and the panel query) degrades to an empty `context` with a `tracing::debug!` line; the row still appears so the panel surfaces the stale link. Five tests cover empty, single source + snippet, multiple sources ordered, missing-source-file degrades-to-empty, and unknown-vault errors.

**Snippet helper.** `build_snippet(source, position)` is a pure 120-byte window centred on `position`. Newlines collapse to single spaces; runs of whitespace collapse; word-boundary polish prefers breaking on whitespace within 16 chars of either edge, falling back to a hard cut + `…` when there is no nearby space; UTF-8 boundaries are respected via floor/ceil widening so the slice never lands mid-codepoint. Empty source returns the empty string. The helper is tested in isolation with 9 cases: empty, short-source-no-ellipses, near-start, near-end, middle-position, newline collapse, whitespace collapse, multibyte safety, and out-of-range position clamping.

**Tauri shim.** `crates/cubical-app/src/lib.rs` adds `get_backlinks` to the `invoke_handler!` registration list (between `resolve_link` and `close_vault`) and the matching three-line shim. The `use api::types::{…}` block grew by two names; no other touchpoints.

**Frontend: pure helpers.** `ui/src/sidebar/backlinksState.ts` holds the panel's data-shape logic — `backlinkKey(b)` (stable `source_path@position` row key), `basenameWithoutExtension(path)` (display label for a `.md` row), and a `reduceBacklinksState` reducer over a discriminated `BacklinksViewState` (`idle | loading | empty | loaded | error`). Same pattern as `properties/coerce.ts` and `properties/inferType.ts` — pure TS so it tests without a render harness. 11 vitest cases.

**Frontend: panel + shell.** `ui/src/sidebar/Backlinks.tsx` is a thin Solid wrapper around the helpers: a `createEffect` watches `vaultId`, `path`, and `refreshSignal` (the parent's tick), runs `getBacklinks`, and folds the result through `reduceBacklinksState`. An incrementing in-flight `token` discards late responses so a slow fetch can never overwrite a newer fetch's state. The render emits four terminal text states (idle / loading / empty / error) and the populated `<ul>` of rows; each row shows the source file's basename + the context snippet (or a `—` placeholder when the snippet is empty). `ui/src/RightSidebar.tsx` is the collapsible shell — panel-agnostic by design (Session I adds Unlinked Mentions). It owns the toggle button, flex sizing (`18rem` expanded, `2rem` collapsed), and the children slot.

**App.tsx wiring.** `App.tsx` gained: two new signals (`rightSidebarCollapsed`, `backlinksRefreshTick`) + a `scheduleBacklinksRefresh` debounce helper; a `toggleRightSidebar` that persists the flag via `setSetting("ui.right_sidebar_collapsed", …)`; one extra line in the `vault:file-changed` listener calling `scheduleBacklinksRefresh()` after the existing `wikilinkResolver()?.invalidate()`; cleanup of the debounce timer next to the autosave one; a vault-open block that seeds the collapsed state from settings; and a render block placing `<RightSidebar collapsed={…} onToggle={…}><Backlinks vaultId={…} path={…} refreshSignal={…} onRowClick={…} /></RightSidebar>` in the existing flex row, after the editor pane. Row clicks call into `handleNavigateWikilink(path, null)` so autosave / `seenHash` / `dirty` plumbing stays correct.

**Setting: `ui.right_sidebar_collapsed`.** Vault-local boolean, mirroring `editor.raw_source_default` / `appearance.theme_mode`. Extends the `Setting` discriminated union in `ui/src/api/ipc.ts`; reads on vault open (absent → expanded), writes on every toggle.

**Live refresh route.** Piggyback on `vault:file-changed` with a 200ms debounce. The spec's `vault:index-changed` event (§3.5) is *not* shipped this session — promote it when a second consumer appears (probably Session I unlinked mentions).

**Decisions worth noting.**
- *New `backlinks_for` over enriching `links_to`*: `links_to` has no production callers, so a dedicated `BacklinkRow` query was cheaper than dual-purposing the existing one. `links_to` stays where it is for future direct use.
- *120-byte snippet width, single-line collapse, word-boundary polish*: 120 fits ~one terminal line of context in a 32px-tall row without truncation; word-boundary trimming within 16 chars of each edge avoids "…rd" mid-word ellipses while still respecting the size cap. UTF-8 boundary widening is the load-bearing safety property — slicing mid-codepoint would panic.
- *Missing-source-file → empty snippet, not error*: a deleted source between extraction and the panel query yields an empty `context`. The row still appears so the panel can surface the stale link; the eventual file-removal cascade (and Session J pending-rewrites) is what cleans the row up properly.
- *One row per link, no grouping*: faithful to the spec's singular "each row showing the source note". Optional grouping deferred — easy to layer on later because `backlinkKey` already provides per-link stability.
- *Piggyback on `vault:file-changed` vs. ship `vault:index-changed`*: `(a)` won. The same listener already drives the Session B resolver invalidation, so adding one debounced bump is the minimum surface change. Promote to `(b)` when the second consumer appears.
- *Vault-local `ui.right_sidebar_collapsed`*: matches `editor.raw_source_default` / `appearance.theme_mode`'s pattern. Process-local memory would feel discontinuous when a user reopens the same vault.
- *Sidebar width hardcoded `18rem`*: matches the file-list pane's `flex: 0 0 18rem` so the layout reads balanced. No token minted yet — a future resizer would be the reason to introduce one.
- *Token reuse over new editor variables*: every new surface consumes existing tokens (`--c-bg-secondary`, `--c-border-subtle`, `--space-*`, etc.). The shell and panel never hardcode colors, radii, or spacings.
- *Case-collision fix*: `ui/src/sidebar/backlinks.ts` was renamed to `backlinksState.ts` (commit `96090dc`) because macOS's case-insensitive APFS collides it with `Backlinks.tsx`. The TS `forceConsistentCasingInFileNames` check rejected the original pairing; the rename + 2-line importer updates fixed it cleanly. Worth noting because Sessions D/I will introduce more panel components — keep helpers under non-PascalCase suffixes like `<thing>State.ts` to avoid the same collision.
- *Reducer + token discipline for race safety*: every fetch increments a local `token`; the `.then` / `.catch` only commits its state mutation if its captured token still matches the latest. Cheap, no AbortController needed for L3 — backlinks fetches are short — and prevents a late slow response from overwriting an in-progress fast one.

**Tests:** 186 Rust passing (was 170 + 16 new: 2 query + 9 snippet + 5 handler), 172 vitest passing (was 161 + 11 new — `backlinkKey` ×2, `basenameWithoutExtension` ×4, `reduceBacklinksState` ×5). `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --check`, `npx tsc --noEmit`, and `npm run build` all clean.

**Interactive smoke status.** Hands-on `cargo tauri dev` smoke was not performed this session — the native Tauri window can't be browser-driven and the session ran in an automated context with no operator at the keyboard. Unit-test coverage exercises every pure decision (the query's ordering and source-path projection; the snippet helper across 9 grammatical cases including UTF-8 boundaries; the handler across empty / single / multiple / missing-source / unknown-vault paths; the view-state reducer across all 4 action transitions; the pure helpers for keying and display naming) plus the full build and type gates. End-to-end behaviour (the panel populating on selection, the 200ms debounce flipping a freshly-created backlink into view, the row click navigating through `handleSelectFile` without disturbing autosave, the collapsed state persisting across vault reopen, the empty-state copy when there are no backlinks) needs a hands-on smoke at the next opportunity. Recommended smoke vault:

```
NoteA.md:
  # NoteA
  Body referring to [[Target]] and trailing text.

NoteB.md:
  # NoteB
  [[Target|the target]] is referenced here.

NoteC.md:
  # NoteC
  No backlinks point here.

Target.md:
  # Target
  body
```

Confirm: opening `Target.md` populates the panel with two rows (`NoteA`, `NoteB`); each row's snippet contains the surrounding context; clicking `NoteA` opens it and the editor's autosave / `seenHash` flow remains correct (write to it and confirm autosave fires); opening `NoteC.md` shows the "No backlinks yet." empty state; creating a new `NoteD.md` containing `[[Target]]` updates the panel within ~200ms without reload; collapsing the sidebar and reopening the vault remembers the collapsed state.

**What's left for L3.** Sessions D–K — tags (D), virtual tag pages (E), link/tag autocomplete (F), block references (G), embeds proper (H), unlinked mentions (I — second occupant of the shell built this session), pending-rewrites cache (J), and the layer closeout (K).
