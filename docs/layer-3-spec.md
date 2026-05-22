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

New Rust: **incremental `crates/cubical-index` migrations** — each table-introducing session ships its own (`002` `links` in Session A, then further numbered migrations as `tags`, `blocks` / `block_refs`, and `pending_rewrites` land in D, G, J) plus query modules; link/tag extraction in `crates/cubical-core`; the wiki-link/tag parser rules in `crates/cubical-ast`; the §3 commands in `crates/cubical-app`. No new crates; the crate dependency graph is unchanged.

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

- **Scope:** extend the Rust `cubical-ast` parser to emit `WikiLink` nodes for every wiki-link form incl. `![[…]]`; TS normalizer parity; the `links` table via the first L3 migration (`002`); link extraction during vault scan and on file-change; link resolution (§2.1); the `resolve_link` IPC.
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

*Pending.*
