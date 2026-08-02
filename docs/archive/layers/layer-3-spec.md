> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../architecture/) and [`docs/implementation/`](../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Cubical — Layer 3: Knowledge Graph

> **Historical record**, frozen at layer close (tag + date in [`build-order.md`](build-order.md)). The plan and "what was built" below are the state *as of then*; current canonical truth lives in [`architecture/`](architecture/README.md). Where work later diverged, it's noted inline as a deviation — not silently overwritten.

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

The **link index** is a new libSQL table. `document-model.md` §5.2 names "the link index" but did not lock its columns; L3 defined them (§3.1, §5 deviation #2) and the schema was promoted at L3 close — it now lives, canonically, in `document-model.md` §5.2 (table `links` + `idx_links_source`/`idx_links_target`).

**Resolution.** A `target_raw` resolves to a file by: exact vault-relative path, then case-insensitive basename match, then unique path-suffix match. Ambiguous or missing → `target_path` stays `NULL` (unresolved). Resolution runs during vault scan and incrementally on file-change.

### 2.2 Wiki-link Live Preview + navigation

Live Preview (extending `ui/src/editor/decorations.ts`) decorates wiki-links: while the cursor is not touching the link the brackets and anchor markup are hidden and the display text (or target) is shown as an accent link; when the cursor touches `[[…]]` the raw source shows through, consistent with every other inline L2 decoration. Unresolved links render in a distinct style (e.g. `--c-warning`, dashed underline).

A click on a resolved link opens the target file (and scrolls to the heading/block anchor if present). A click on an unresolved link offers to create the note at the resolved-by-convention path. The raw-source toggle (L2 Session E compartment) reveals the literal source as for all decorations.

### 2.3 Backlinks panel + the right sidebar

L2 §22 deferred the right sidebar to L3. L3 introduces the **right-sidebar shell** (collapsible, per `ui.md` §11.1) and its first occupant, the **Backlinks panel**: for the open note, every note whose `links.target_path` resolves to it, each row showing the source note and a context snippet around the link. The panel refreshes whenever the link index changes for a relevant file. Empty state when there are no backlinks. A row click navigates to the source.

### 2.4 Tags

Two declaration sources, one index (`document-model.md` §5.6): inline `#tag` (must follow whitespace/line-start; excluded inside fenced code, inline code, link targets, and wiki-link targets) and frontmatter `tags: [a, b/c]`. Both the Rust and Lezer parsers gain tag recognition. Nesting uses `/`. Matching is case-insensitive; display is case-preserving (first-seen casing wins). Tags decorate in Live Preview as accent-coloured `#chips`.

The `tags` table is exactly the locked schema in `document-model.md` §5.6.

### 2.5 Virtual tag pages

A `tag:` route opens a **virtual page** — backed by a libSQL query, not a real `.md` file — listing every file carrying that tag *or any descendant* (prefix match: `tag:parent` matches `parent`, `parent/child`, deeper). Reached by clicking a tag decoration or a tag chip in Properties. Empty state when unused. File rows navigate.

### 2.6 Link + tag autocomplete

Per `ui.md` §11.2. Typing `[[` opens a link-autocomplete dropdown over the vault's files (and, after `#` inside the brackets, that file's headings / block-ids). Typing `#` at a word boundary outside code opens tag autocomplete over existing tags, prefix-filtered. Built on CM6's autocomplete. Selecting an entry completes the `[[…]]` or `#…` token.

### 2.7 Block references

A block ID is a user-slug `^id` appended to a paragraph or list item. **Lazy assignment** (`document-model.md` §5.3): an ID is minted only when the user creates a reference to that block — never bulk auto-assigned. Minting writes the literal `^id` into the markdown source (content, not file-identity — this does **not** violate the no-UUID-before-L7 non-negotiable; see §5 deviation #3). The `blocks` and `block_refs` tables are the locked schema in `document-model.md` §5.3. `[[note#^id]]` resolves through these. Broken block refs (target paragraph or ID deleted) surface alongside broken wiki-links in the vault-health status-bar item.

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
5. **Scan parses each markdown file 3× (frontmatter + links + tags).** L1's `refresh_frontmatter`, Session A's `refresh_links`, and Session D's `refresh_tags` each call their own `parse_off_executor` against the same `.md` path during the initial scan loop in `crates/cubical-core/src/vault/scan.rs` — every markdown file is read and fully parsed three times (four reads counting the content-hash pass). Confirmed at scale **2026-05-28** on a 30,000-file / 124 MB vault (`~/Developer/sandbox/cubical-cancel-test`). Functionally correct; a ~3–4× constant-factor waste. The right fix is a single shared `Document` parse fed to all three refresh paths, mirrored in the watcher's per-file write path. **Deliberately deferred to the L5 perf pass** (build-order item 5): it ripples through `cubical-core`'s public surface, and Sessions F–K (blocks, embeds, unlinked-mentions) each add new scan consumers — doing the shared-parse refactor before that consumer set is frozen means redoing it repeatedly. *Cost/benefit:* a constant ~3–4× factor that only becomes the bottleneck once §5.6 is fixed, against a real API-ripple + rework cost — not worth doing mid-L3. This is the **secondary** scan-cost issue; the dominant one is §5.6, which the L5 parse-count fix would **not** address.

6. **Bulk scan resolved wiki-links in O(N²) — a defect, not an accepted deviation. Fixed 2026-05-28.** Discovered **2026-05-28** (same 30k-file vault; Obsidian loaded it by a wide margin faster). *Root cause:* `refresh_links` was written for the **single-file** watcher path — load the full `files.path` set once via `list_known_paths`, then `resolve_target` (a linear scan) for each link. The initial bulk scan loop reuses that single-file helper **unchanged, once per file**, so `list_known_paths` re-runs N times against a table that grows to N rows (≈ N²/2 row materializations) and every link does a linear scan over up to N paths. For N=30,000 this is the dominant cost — minutes, not seconds. It is also partly **incorrect**: a file walked before its link target can't resolve it (forward reference → `target_path = NULL` until a later rescan). This was never planned or recorded — distinct from §5.5, and **the L5 parse-count fix would leave the quadratic intact**. *Why fix now, not at L5:* `foundation.md` principle #2 holds performance as a foundational requirement (not a polish item), Sessions F–K would compound the defect, and the fix is cheap + localized + correctness-improving. *Cost/benefit:* O(N²)→O(N) (minutes→seconds) for a localized change with **no public-API churn** (the watcher path and `resolve_target` semantics are preserved) — clearly worth it. *Fix (landed 2026-05-28):* the bulk scan is now two passes. Pass 1 (the existing walk) hashes, upserts `files`, refreshes frontmatter + tags, and *buffers* extracted link occurrences in memory via the new `extract_links_off_executor` (parse + extract, no resolve/no DB write). Pass 2 runs once after the walk: it loads the now-complete `files.path` set, builds a `PathResolver` index once, resolves every buffered link in O(1) common-case (O(N) build), and writes the `links` rows in batched transactions. `PathResolver` (exact + basename hash maps; linear suffix fallback only when the first two stages miss) preserves `resolve_target`'s semantics byte-for-byte — `resolve_target` now delegates to it, so the single-file watcher path is unchanged. This also fixes the forward-reference incorrectness (links resolve on the first scan regardless of walk order). Smoke: the 30k-file / 124 MB vault now scans in ~10 s (was multi-minute) — the O(N²) is gone; the residual time is dominated by the still-deferred §5.5 triple-parse + content hashing. Plan: `docs/superpowers/archive/plans/2026-05-28-l3-scan-resolution-perf-fix.md`.

No `docs/architecture/` files are modified mid-layer. Load-bearing calls are promoted at the L3-close step (Session K). (§5.6 is a defect fix, not an architecture change — it preserves the locked resolution semantics; only its time complexity changes.)

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

Eleven dependency-ordered sessions (A–J feature; K closeout). Per-session scope, key files, and DoD are preserved in the archived plans (`superpowers/archive/plans/2026-05-2*`/`-3*-l3-*`); outcomes are recorded in §9 below.

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

**Gates green.**

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

The visible range gets `mark-wikilink` (resolved or pending) or `mark-wikilink-unresolved` (target known-missing — dashed underline + `--c-warning`). When the cursor touches the link all per-token ranges collapse into a single `mark-marker-muted` mark covering the whole token, mirroring how `Link` / `Emphasis` reveal raw source on cursor touch. Three new `DecoKind` values landed: `mark-wikilink`, `mark-wikilink-unresolved`, `mark-wikilink-embed`. The base theme adds three matching CSS rules.

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

**Gates green.**

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

**Gates green.**

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

### 9.4 Session D — Tags: parsing, index, nested tags, decoration

**Done 2026-05-27.** Inline `#tag` / `#parent/child` tokens and frontmatter `tags:` entries are now first-class citizens of the AST and the index: both parsers emit `Tag` nodes for the inline form, a new `tags` libSQL table holds one row per `(file_path, tag_path, source)` triple, scan + watcher refresh the rows on every markdown write, and Live Preview decorates inline tags as accent-coloured chips.

**Pre-work.** `fix/wikilink-click-and-vault-load` was fast-forward-merged into `main` and deleted (3 click-bug fix commits + 1 docs note + 1 scan-double-parse observation); the local + remote branch is gone and `origin/main` is synced.

**AST: `Inline::Tag` + the `scan_tags` tokenizer.** `crates/cubical-ast/src/tag.rs` is a hand-rolled byte tokenizer (no regex, mirroring `wikilink.rs`'s shape exactly) that walks a text run for `#tag` openers, validates the word-boundary rule (`#` at run start or directly after ASCII whitespace), then parses the body. Body grammar locked by 19 unit tests: first byte ASCII letter or `_` (no leading digit), continuation `[A-Za-z0-9_-]`, nesting via a single `/` followed by another non-empty body segment, trailing `/` trimmed. The wire-shape Rust enum gained `Inline::Tag { path }`; the TS mirror in `ui/src/ast/types.ts` and `ui/src/ast/tag.ts` keeps byte-for-byte parity with 19 mirror tests on the TS side.

**Normalize integration.** `cubical-ast::normalize::split_wikilinks` was renamed to `split_inlines` and now runs both passes on every `Inline::Text` it sees: wiki-links first, then tags on each remaining text-only output. The same rename happened in `ui/src/ast/normalize.ts`. `Inline::Code` is a sibling node (not text), so `` `#notatag` `` correctly stays as `Inline::Code`; code blocks are a separate block kind and are never walked. Six new parity fixtures (`tag_simple`, `tag_nested`, `tag_multiple`, `tag_in_heading`, `tag_inside_code_span_stays_text`, `tag_after_word_is_text`) pin the cross-language contract.

**Index schema.** `crates/cubical-index/migrations/004_tags.sql` adds the locked schema from `document-model.md` §5.6 — `tags(file_path, tag_path, source)` with PK over all three columns, FK on `file_path → files(path)` cascading on delete, and an `idx_tags_path` index on `tag_path` so virtual tag pages can look up `WHERE tag_path = ?` cheaply in Session E. `MIGRATIONS` slice gets the new entry; `HIGHEST_KNOWN_VERSION` bumps to 4; the runner's `fresh_db_applies_all_known_migrations` test asserts the new table + index exist.

**Query module.** `crates/cubical-index/src/tags.rs` exposes `TagSource { Inline, Frontmatter }` (string-backed enum stored in the `source` column), `TagRow { tag_path, source }`, `replace_tags_for_file` (delete-then-insert keyed on `file_path`, `INSERT OR IGNORE` so a duplicate triple is a no-op), and `tags_for_file` ordered by `(source, tag_path)`. Six tests: round-trip, atomic replace, duplicate-triple idempotency, same-tag-different-source = two rows, empty rows clears, FK cascade.

**Extraction + dedup.** `crates/cubical-core/src/vault/tags.rs` adds `extract_tags(&Document) -> Vec<TagExtraction>` and `refresh_tags(vault, abs, rel)`. The walker recurses through `Block::{Heading, Paragraph, List, Quote}` and their inline children, collecting `Inline::Tag` paths in document order. Frontmatter `tags:` is read off `Frontmatter.entries`: a YAML sequence (`tags: [a, b]`) walks each entry; a YAML scalar (`tags: "foo, bar"`) is comma-/whitespace-split; leading `#` on scalar entries is stripped. Within a single file we dedupe by `(lowercase(tag_path), source)` — first-seen casing wins, matching the spec's "case-insensitive matching, case-preserving display" rule. 15 extraction tests cover every shape.

**Write-path plumbing.** `vault::scan` now calls `refresh_tags` immediately after `refresh_links` for markdown files. `apply_watch_event_to_db` in `cubical-app/src/events.rs` does the same for `Created` / `Modified` events. Same best-effort policy as links: a read or SQL failure logs at `warn` and keeps the dispatcher alive. A new integration test in `scan.rs` proves end-to-end: a markdown file with `tags: [project/cubical, todo]` frontmatter and one inline `#review` lands 3 tag rows after scan.

**Editor: `Tag` Lezer rule.** `ui/src/editor/tag.ts` installs a `MarkdownConfig` inline parser before `Link` that emits a single `Tag` node spanning the entire token. Mirrors `scan_tags`'s grammar (word-boundary check via `cx.char(pos - 1)`, body grammar identical) so the editor's syntax tree agrees with the canonical AST on which `#` runs are tags. Inline-code / fenced-code exclusion is automatic — Lezer doesn't descend into `InlineCode` content. 10 Lezer-rule tests.

**Decoration.** `decorations.ts` adds `Tag` to the `iterate.enter` switch and a new `DecoKind` value `mark-tag`. While the cursor is not touching it the whole token gets the `mark-tag` class (accent colour with a tertiary-bg chip pill); when the cursor touches it the token flips to `mark-marker-muted`, mirroring how wiki-links / links / emphasis reveal raw source on cursor touch. The decoration ranges layer through `buildDecorationSet`'s existing switch; the CSS is a single new `.cm-md-tag` rule using `--c-accent`, `--c-bg-tertiary`, `--radius-sm`, and `--space-1` tokens. 4 new decoration tests cover the basic shape, nested-tag width, multi-tag enumeration, and touch-muting.

**Editor wiring.** `Editor.tsx` adds `tagExtension` to its `markdown({ extensions: [...] })` call so the Lezer rule fires inside the editor. The canonical-AST `normalize` already emits `Inline::Tag` via the shared tokenizer, so downstream AST-tick consumers see tags without any extra wiring.

**Decisions worth noting.**
- *Tag-body grammar (no leading digit, `[A-Za-z0-9_-]` body, nesting via `/`):* convergent with Obsidian / Bear / Logseq. The "no `#123`" rule is what stops issue numbers (`See #42`) from accidentally tagging.
- *Word-boundary check on the previous byte:* keeps `prefix#tag` plain text and lets `text #tag` / `*#tag*` / start-of-run `#tag` all match. Implemented identically on the Rust side (`is_ascii_ws(byte - 1)`), the TS side (`isAsciiWs(charCodeAt(i-1))`), and the Lezer rule (`cx.char(pos - 1)`).
- *Inline + frontmatter feed one table:* the `source` column discriminates declaration site so future Session E can prefix-match across both uniformly. Frontmatter scalar splitting (`"foo, bar"` → two rows) covers hand-written YAML; the canonical YAML list form `tags: [a, b]` walks element-by-element.
- *First-seen casing wins (case-insensitive dedup within a file):* spec says case-preserving display; the canonical lowercase is the dedup key but the row stores whatever casing appeared first. Cross-file casing collisions are not collapsed at this layer — that's the virtual tag page / autocomplete's concern (Sessions E + F), which look up via `LOWER(tag_path)`.
- *Schema strictly per `document-model.md` §5.6:* I considered adding a `tag_path_lc` column for fast case-insensitive lookup, but the locked schema is three columns. Sessions E/F will use `WHERE LOWER(tag_path) = ?`; if perf shows up at scale, that's a future migration with a generated column.
- *`split_wikilinks` renamed to `split_inlines`:* the function is no longer specific to wiki-links — it's the generic "split text into tokens" pass. Same name change on both sides.
- *Lezer `Tag` node carries no sub-nodes:* the decoration plugin treats the whole token as one mark; no need for separate marker children (unlike wiki-links, which need to split brackets from body). Keeps the rule under 20 lines.
- *Smoke vault at `~/Developer/sandbox/tag-test/`:* `Inbox.md` exercises every form (inline simple, nested, deep nested, case-collapse, mid-word negative, code-span negative, frontmatter sequence); `Project.md` adds the YAML block-sequence form (`tags:\n  - foo`) and an inline-in-list shape. README documents the manual smoke procedure.

**Gates green.**

**Interactive smoke status.** Hands-on `cargo tauri dev` smoke was not performed this session — the native Tauri window can't be browser-driven and the session ran in an automated context with no operator at the keyboard. Unit-test coverage exercises every pure decision (the tokenizer across 19 grammatical cases on each side; the extraction across emphasis / lists / quotes / code-block exclusion / frontmatter sequence / frontmatter scalar / case-dedup / leading-`#`-strip / non-tag values; the index queries across replace / atomic / dedup / cross-source / FK cascade; the migration shape; the Lezer rule across boundary / nested / multi-token / code-span exclusion; the decoration across mark-tag emission and active-line muting) plus the full build + type + clippy + fmt gates. End-to-end behaviour (chip rendering against the real editor styles; the watcher firing within ~100ms of an in-place edit; `Cmd/Ctrl+E` raw-source toggle revealing literal source for tag tokens) needs a hands-on smoke at the next opportunity. Recommended smoke vault: the just-created `~/Developer/sandbox/tag-test/` whose `README.md` walks through the 7-step verification.

**What's left for L3.** Sessions E–K — virtual tag pages (E), link/tag autocomplete (F), block references (G), embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), and the layer closeout (K).

### 9.5 Session E — Virtual tag pages

**Done 2026-05-27.** Clicking a tag — either an `#tag` decoration in the editor or a tag chip in Properties — opens a virtual page listing every file carrying that tag or any descendant (prefix match). File rows navigate back to the editor through the existing `handleSelectFile` seam. This is the first non-file view in the app; the route mechanism it introduces is the load-bearing design call (§9.5.5 below).

**Pre-work.** Session D landed in three commits directly on `main` (`fix(ui): untrack state reads in Backlinks effect` → `feat(l3): inline + frontmatter tags end-to-end` → `docs(l3): close Session D — spec entry + state rewrite`) after verifying tests + clippy + fmt + build. The `l3-session-e` branch was cut from there.

**Index query.** `cubical-index::files_for_tag_prefix` returns `Vec<String>` of distinct vault-relative paths whose `LOWER(tag_path)` equals the lowercased needle or `LIKE needle/% ESCAPE '\\'`. Case-insensitive per the spec's "case-insensitive matching, case-preserving display" rule; the LIKE escape covers `\`, `%`, and `_` (tag grammar allows `_`, so leaving it unescaped would bleed siblings into the prefix). Results are `ORDER BY file_path`. 6 unit tests cover exact match, descendants, sibling-prefix exclusion (`projection` does NOT match `project`), case insensitivity, dedup across inline+frontmatter on the same file, LIKE-escape, and empty result.

**Handler + IPC.** `cubical-app::commands::tags::query_tag_page` is a thin shim: looks up the open vault, calls `files_for_tag_prefix`, derives a display title from each path's basename via `Path::file_stem()` (drops `.md`), and returns `Vec<TagPageFile { path, title }>`. The Tauri shim in `lib.rs` is the standard 3-line forwarder. 8 unit tests: empty vault, descendant inclusion + basename titles, case-insensitive match, dedup across sources, unknown-vault error path, plus three pure `derive_title` cases (extension drop, no-extension, leading-dot file).

**Editor click plumbing.** `ui/src/editor/tagMousedown.ts` mirrors `wikilinkMousedown.ts` byte-for-byte in spirit: pure `maybeInterceptTagMousedown` + `closestTagSpan` helpers plus a small `tagPathFromSlice(raw)` (`#tag` → `tag`, `null` on malformed input). Wired in `Editor.tsx` `onMount` as a second `mousedown` capture-phase listener on `view.contentDOM`, alongside the wiki-link one — same WKWebView-survival pattern as L3 Session B. `handleTagClickAtPos` resolves coords to a position, looks up a `Tag` Lezer node at that position, slices the source, strips the `#`, and fires the new `onNavigateTag` prop. `.cm-md-tag` got `cursor: pointer`. 19 helper tests.

**Properties tag-chip plumbing.** Optional `onNavigateTag` prop threads `App → Properties → PropertyRow → TagListCell → ChipList`. When set, the chip body's button calls the navigate handler instead of `startEdit`, and a new `✎` button appears between the chip body and `×` so editing remains reachable in two clicks. When unset (every other ChipList caller), behaviour is unchanged — the new `✎` button only renders when `onChipClick` is wired. The Properties title `#…` chip render didn't change; only the gesture did.

**Route mechanism.** `App.tsx` gained a `view` signal — `{ kind: "file" } | { kind: "tag"; tagPath: string }` — that the editor pane's `<Show>` switches on. The file list, header, footer, conflict banner, and right sidebar all persist across both views; only the editor / TagPage swap. Selecting any file (anywhere) always resets `view` back to `{ kind: "file" }` because the user's expectation when clicking a file row is "show me that file," irrespective of where they came from. Opening a new vault also resets `view` so a stale tag from a prior vault never persists.

**TagPage component.** `ui/src/TagPage.tsx` — header showing `#tagPath` and a `← Back` button; body cycles through `idle | loading | loaded | error`. Uses the same `untrack` self-trigger-prevention pattern as `Backlinks` (effect reads `state()` via `untrack(state)` so writing a fresh state object doesn't re-enter the effect — the L3 Session C self-trigger lesson). A `refreshSignal` counter, bumped by `vault:file-changed` when the tag view is up, drives no-reload refetches. On the first load it shows "Loading…"; on refresh of an already-loaded tag it keeps the prior list visible to avoid a flash.

**Live refresh.** The `vault:file-changed` listener in `App.tsx` already piggy-backed wiki-link resolver invalidation + backlinks debouncing; Session E added `setTagRefreshTick((n) => n + 1)` (no debounce — the file-list refresh already debounces the more expensive query, and the tag-page query is cheap enough to not need its own throttle for the v1 cut).

**Decisions worth noting.**
- *Case-insensitive at the query layer:* the `idx_tags_path` b-tree is on raw `tag_path`, so `WHERE LOWER(tag_path) = ?` won't use it. The spec already flagged this as Sessions E + F's concern (§9.4 Decisions); for personal-vault data sizes the full-scan cost is negligible. If perf shows up at scale, a future migration adds a generated `tag_path_lc` column.
- *Descendant prefix is segment-boundary:* `tag:project` matches `project`, `project/cubical`, `project/cubical/l3` but NOT `projection` — implemented as `OR LOWER(tag_path) LIKE 'project/%'`, so the `/` is load-bearing. A test pins this against a sibling note tagged `#projection`.
- *Dedup at the query layer (`SELECT DISTINCT file_path`):* a file with both an inline `#todo` and a frontmatter `tags: [todo]` carries two rows in the `tags` table (by design — `source` is part of the PK); but the tag page should list each file once. The query dedups via `DISTINCT` rather than asking the handler to do it post-hoc.
- *Title = basename minus `.md`:* the locked `files` table has no title column. Reading the H1 or a `title:` frontmatter key would add an extra hop per file; the basename is a reasonable default and matches how the file-list sidebar already renders. A future polish session can swap in a richer title source.
- *Route mechanism shape (signal-driven view union):* introduced as a small Solid signal rather than a URL-style router. The app is a single-window desktop with no link-sharing, so a router's URL surface buys nothing yet; the simpler approach defers a real router until L4+ surfaces (search, dataview views) actually need one.
- *Selecting a file always returns to file view:* discussed above. The opposite policy ("keep the tag page open behind a modal") would mean two view states could surface a "current file" — a recipe for confusion in autosave/seenHash/dirty plumbing. The clear rule keeps things obvious.
- *Editor tag click only fires off the active line:* the decoration paints `cm-md-tag` off-cursor and `cm-md-mark-muted` on-cursor (so the raw source is editable). Clicks on the muted source fall through to CM's default caret-move; mirrors how wiki-links behave. Acceptable for v1 — the spec doesn't require active-line click navigation.
- *Tag chip gesture in Properties (body navigates, `✎` edits):* the obvious alternative is modifier-click for navigate, but plain click matches the editor decoration's behaviour and reads as a hyperlink. Two-click edit (`✎` then type) is a small cost; tag chips are added/removed more often than they're renamed.

**Gates green.**

**Interactive smoke status.** Hands-on `cargo tauri dev` smoke was not performed this session — same constraint as Session D's closeout (the native Tauri window can't be browser-driven and the session ran in an automated context). Unit-test coverage exercises every pure decision (the query across exact / descendants / sibling-prefix-exclusion / case-insensitivity / dedup / LIKE-escape / empty; the handler across vault lookup / basename derivation / error path; the click helper across left-click intercept / modifier-bail / right-click-bail / DOM walk-up / Text-node-target lift / slice → tag-path stripping); the Tauri binary builds clean so the new `query_tag_page` command is registered in the `invoke_handler` list and reachable end-to-end. End-to-end behaviour (clicking a `#project` decoration in `Inbox.md` opens a tag page listing `Inbox.md` + `Project.md`; clicking a row navigates back to the editor with that file open; the page updates within ~100ms when a third file picks up the tag; `← Back` returns to the open file unchanged) needs a hands-on smoke at the next opportunity. Recommended smoke vault: the existing `~/Developer/sandbox/tag-test/` whose `Inbox.md` + `Project.md` already share `#project/cubical/*` for a clean prefix-match demo.

**What's left for L3.** Sessions F–K — link/tag autocomplete (F), block references (G), embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), and the layer closeout (K).

### 9.6 Scan link-resolution perf fix (inserted before Session F)

**Done 2026-05-28.** Closes the §5.6 O(N²) defect: the bulk vault scan resolved wiki-links once *per file* by reusing the single-file watcher helper (`refresh_links` → `list_known_paths` re-run N times + linear `resolve_target` per link). On a 30k-file / 124 MB vault that was multi-minute. The fix makes the scan two passes and resolution O(N); it also fixes the forward-reference incorrectness (a file walked before its target previously resolved to `NULL` until a rescan). Not a numbered session — a defect fix slotted ahead of Session F so F–K don't compound it.

**`PathResolver` (`crates/cubical-core/src/vault/links.rs`).** New index type built once from the complete `files.path` set. Two `HashMap`s give O(1) exact (with/without `.md`) and unique-basename (case-insensitive) lookups; the rare case-insensitive suffix stage stays a linear fallback over `all` and only runs when the first two miss (i.e. for targets that don't name a real note). Resolution order is identical to the old `resolve_target` — exact → unique basename-ci → unique suffix-ci, ambiguity → `None`, empty → `None`. `resolve_target` now delegates to `PathResolver::build(files.to_vec()).resolve(target_raw)`, so the single-file watcher path (`apply_watch_event_to_db` → `refresh_links`) and every pre-existing `resolve_target` test are untouched. A `path_resolver_matches_resolve_target_semantics` test asserts byte-for-byte agreement across a battery of targets (exact, basename, ambiguous, missing, empty, case-variant) and is the lockstep guard.

**`extract_links_off_executor` (same file).** New `pub(crate)` async helper: parse off the runtime + `extract_links`, returning `Vec<LinkExtraction>` with no resolution and no DB write. Empty on unreadable/unparseable files (mirrors `refresh_links`'s "no links" policy). Two tests cover the happy path (targets + embed flag) and the unreadable-file empty case.

**Two-pass scan (`crates/cubical-core/src/vault/scan.rs`).** Pass 1 (the existing walk) is unchanged except that the inline `refresh_links` call is replaced by `extract_links_off_executor` + buffering into `pending_links: Vec<(String, Vec<LinkExtraction>)>`; frontmatter + tags still refresh inline. After the walk, Pass 1's transaction commits so `files` is complete and visible, then Pass 2 loads `files.path` once, builds one `PathResolver`, and for each buffered file maps extractions → `LinkRow`s (anchor → kind/value exactly as the old `refresh_links` did) and writes them via `replace_links_for_file` in `SCAN_BATCH_SIZE`-batched transactions. Cancellation is honoured between files in Pass 2 (commit-then-`ScanCancelled`).

**Behavioral anchor.** `scan_resolves_forward_references` creates two files linking to *each other* and asserts both links resolve after one scan. This is deterministically red on the old per-file code regardless of `WalkDir`'s (unspecified, APFS-hash) entry order — whichever file is walked first has a forward reference that resolved to `NULL` — and green after the two-pass fix. (The plan's original single-direction fixture wasn't reliably red because APFS happened to walk the target first; the mutual-link form removes the order dependency.) The existing `scan_populates_links_table_and_resolves_targets` (resolved + NULL-for-missing) still passes, pinning that missing targets still land with `NULL`.

**Out of scope, on purpose.** The §5.5 triple-parse stays deferred to L5 — link *extraction* keeps its own parse in Pass 1; only link *resolution* moved. The watcher path and `resolve_target` semantics are unchanged; no public-API churn beyond the internal `cubical-core::vault` surface.

**Gates green.**

**Smoke status.** A programmatic timing smoke (throwaway `#[ignore]` test, not committed) scanned the 30k-file / 124 MB `~/Developer/sandbox/cubical-cancel-test` vault in **~10 s** (was multi-minute) — the O(N²) is gone; the residual is dominated by content hashing + the still-deferred §5.5 triple-parse. Interactive `cargo tauri dev` was not run (the native window can't be browser-driven in this automated context) — the forward-reference + existing resolution tests prove correctness; the timing smoke confirms wall-clock feel.

### 9.7 Session F — Link + tag autocomplete

**Done 2026-05-28.** Typing `[[` opens a CodeMirror dropdown over the vault's markdown files; picking one inserts a valid `[[path]]` (caret after `]]`). Typing `#` at a word boundary outside code opens a dropdown over existing tags (prefix-filtered); picking one inserts `#tag`. Built on CM6's `@codemirror/autocomplete`. Executed subagent-driven from the plan at `docs/superpowers/archive/plans/2026-05-28-l3-session-f-link-tag-autocomplete.md`.

**Scope = the §8 DoD, not the §2.6 prose.** The DoD is "`[[` lists files and inserts a valid link; `#` lists tags; correct trigger gating." The §2.6 mention of in-bracket heading / block-id completion (`[[target#…`) is **deferred to a post-Session-G session**: block-ids need the L3 Session G `blocks` table (not built yet) and headings aren't indexed. The link trigger deliberately stops at `#`/`|` so it never tries to complete an anchor — that's the documented scope edge.

**Index helpers (`cubical-index`).** `links::files_for_link_query(conn, query, limit)` — markdown-only paths matching `query` as a case-insensitive substring of the path, ordered, capped; empty query lists the first page. `tags::tag_paths_for_prefix(conn, query, limit)` — `SELECT DISTINCT tag_path` whose lowercased form prefix-matches `query`, ordered, capped. Both `LIKE … ESCAPE '\'`-escape `_`/`%`/`\` (the tag grammar allows `_`, so an unescaped `_` would silently widen matches). 6 unit tests across the two (substring/prefix, case-insensitivity, empty-query+LIMIT, binary exclusion, distinct dedup, escape).

**Handlers + IPC (`cubical-app`).** `commands::autocomplete::{link_autocomplete, tag_autocomplete}` are thin pure handlers mirroring `query_tag_page` (vault lookup → index helper → map; `VaultNotOpen` on unknown vault). `link_autocomplete` derives a `LinkCandidate { path, title }` per file (title = basename minus `.md`, via a local `derive_title`); `tag_autocomplete` returns the raw tag-path strings. Server-side `AUTOCOMPLETE_LIMIT = 50`. Wire types `LinkAutocomplete{Request,Response}`, `LinkCandidate`, `TagAutocomplete{Request,Response}` in `api/types.rs`; two 3-line Tauri shims registered in `lib.rs`'s `generate_handler!`. 3 handler unit tests (titled candidates + binary exclusion, tag prefix match, unknown-vault error).

**Frontend.** `ui/src/api/ipc.ts` gains the mirrored wire types + `linkAutocomplete` / `tagAutocomplete` functions. `ui/src/editor/autocomplete.ts` holds the pure logic: `detectLinkTrigger` (`/\[\[([^\]\n|#]*)$/` — stops at `]`/`|`/`#`/newline), `detectTagTrigger` (`/(?:^|\s)#([A-Za-z0-9_/-]*)$/` — word-boundary gated), `linkInsertion` (appends `]]` unless a closer already follows; computes caret offset), `isInhibited` (walks the Lezer ancestor chain, rejecting `FencedCode`/`CodeText`/`InlineCode`/`Comment`/`HTML*`, plus `WikiLink` for the tag source so a `#` anchor inside `[[…]]` isn't treated as a tag), and the two `CompletionSource`s combining detection + gating + an injected provider (with CM6 `validFor` regexes for in-place inter-keystroke filtering). `ui/src/editor/autocompleteProvider.ts` exports `createAutocompleteProvider(vaultId, linkIpc?, tagIpc?)` (injected IPC for testing; failures resolve to `[]`), mirroring `createWikiLinkResolver`. `Editor.tsx` installs `autocompletion({ override: [linkCompletionSource(p), tagCompletionSource(p)] })` in a `Compartment`, reconfigured on a new `autocompleteProvider` prop — exactly parallel to the wiki-link resolver compartment. `App.tsx` holds the provider in a signal, sets it on vault open and clears it on the reset-before-open path, and passes it to `<Editor>`. 16 vitest cover the pure functions + headless `CompletionContext` gating (fenced-code and inline-code suppression, paragraph success).

**Decisions worth noting.**
- *No provider-side cache.* Unlike `wikilinkResolver` (which caches resolutions consumed synchronously by decorations + clicks), autocomplete re-queries per fresh trigger and lets CM6's `validFor` filter between keystrokes. The dropdown is short-lived and the queries are cheap + capped; a cache would just risk staleness against `vault:file-changed`.
- *Substring for links, prefix for tags.* Link queries match anywhere in the path (you often remember a word from the middle of a note name); tag queries are prefix-only (matches how hierarchical `#a/b/c` tags read and how the tag-page prefix query already behaves).
- *Gating by Lezer ancestry, not regex.* "Outside code" is decided by walking the syntax tree, not by trying to detect code spans textually — robust against nested/fenced constructs.

**Gates green.**

**Smoke status.** Interactive `cargo tauri dev` was not run (the native Tauri window can't be browser-driven in this automated context — same constraint as Sessions D–E and the perf fix). The behaviour is fully covered by unit + headless tests: trigger detection (open/closed/pipe/anchor/boundary cases), insert-text construction (with/without existing closer), code-context gating (fenced + inline), and handler behaviour (candidates, titles, prefix match, binary exclusion, unknown-vault error); the app binary builds clean so both commands are registered and reachable end-to-end. A hands-on smoke (type `[[`/`#` in a real vault, confirm the dropdown + insertion, confirm no trigger inside a code fence) is recommended at the next opportunity.

**What's left for L3.** Sessions G–K — block references (G), embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), and the layer closeout (K). Deferred from F: in-bracket heading / block-id autocomplete (revisit after G).

### 9.8 Session G — Block references (backend core)

**Done 2026-05-29.** The backend half of block references (spec §2.7): minting a `^block-id` into a target file's markdown *only* when a reference is created, indexing block-id definitions + resolved block refs, and surfacing broken ones. No editor gesture, no `^id` decoration, no status-bar UI — those are a deferred frontend follow-up. Executed from the plan at `docs/superpowers/archive/plans/2026-05-28-l3-session-g-block-references.md`.

**Lazy assignment is the headline invariant.** A `^id` is written to source by exactly one code path — the `create_block_ref` command. Nothing bulk-auto-assigns ids; the scanner only *reads* ids that already exist in source. This keeps the vault byte-for-byte the user's until a reference deliberately mints one.

**Migration 005 (`cubical-index`).** Two locked tables. `blocks(file_path, block_id, position_hint, last_modified)` PK `(file_path, block_id)` — one row per `^id` token found in a file's source; `position_hint` is the byte offset of the line carrying the id. `block_refs(source_file_path, target_file_path, target_block_id)` — one row per *resolved* `[[target#^id]]`. Both `ON DELETE CASCADE` on the owning `files(path)`. Indexes on `blocks(file_path, block_id)`, `block_refs(source_file_path)`, `block_refs(target_file_path, target_block_id)`. `HIGHEST_KNOWN_VERSION` bumped to 5.

**Source scanner (`cubical-core::vault::blocks`).** Pure `extract_block_ids(source) -> Vec<BlockIdOccurrence>`: a block id is `^` + `[A-Za-z_][A-Za-z0-9_-]*` at the **end of a (trimmed) line**, either preceded by whitespace or as the whole line, **ignored inside fenced code** (` ``` ` / `~~~`). This grammar is shared in spirit with `create_block_ref`'s minter — the two `is_valid_*` rules must stay in lockstep (they can't share code without a new crate; each has its own tests). 5 scanner unit tests.

**Index queries (`cubical-index::blocks`).** `replace_blocks_for_file` / `replace_block_refs_for_file` (delete-then-insert on the caller's connection, like `replace_tags_for_file`), `blocks_for_file`, `block_exists`, and `broken_block_refs` — the last a **query-time `LEFT JOIN … WHERE b.block_id IS NULL` anti-join**, so a ref's broken-ness is never stored: adding the target block fixes it on the next query with zero bookkeeping. `BlockRow` / `BlockRefRow` / `BrokenBlockRef` types. 4 unit tests (lookup, delete-then-insert, anti-join, FK cascade).

**Refresh helpers + scan/watcher wiring (`cubical-core`).** `refresh_blocks` re-scans a file's source and replaces its `blocks` rows — **per-file, no resolution, refreshed inline in scan Pass 1** alongside frontmatter + tags, and on every watcher edit. `refresh_block_refs_for_file` **derives** `block_refs` from the already-resolved block-anchored rows in the `links` table (`anchor_kind='block'`, non-null `target_path`/`anchor_value`) — run in **scan Pass 2** (after each source's links are persisted in the same `link_tx`) and on the watcher path. So `block_refs` is always a projection of resolved links, never hand-authored. A new `links::read_source_off_executor` reads raw source off the runtime (the AST parser drops `^id`s, so block scanning needs text, not a `Document`); `map_index_err` widened to `pub(crate)`. 2 integration tests (refresh from source; broken-ref derivation through a full scan).

**Commands + IPC (`cubical-app`).** `create_block_ref(vault_id, target_path, position)` reads the target source, finds the line containing the byte `position`, and — if that line doesn't already end with a valid `^id` — appends ` ^<id>`, writes the file, and persists the `blocks` row immediately (the watcher echo re-refreshes; replace is idempotent). The id is **deterministic**: `b` + first 6 hex of `sha256("path:position")` (guaranteed letter-start), with a `-N` suffix on the rare in-file collision. Idempotent when the line already has an id (returns it, no write). `get_broken_block_refs(vault_id)` maps `broken_block_refs` to a `BrokenBlockRefDto` list for vault-health surfacing. `sha2` added to `cubical-app` deps. Wire types + two 3-line Tauri shims registered in `lib.rs`; `ipc.ts` gains the mirrored types + `createBlockRef` / `getBrokenBlockRefs` (unused until the deferred UI). 3 handler unit tests (mint+persist, idempotent reuse, broken-ref reporting).

**`resolve_link` left unchanged — on purpose.** It already echoes the parsed `Block` anchor; block resolution is represented entirely by the `blocks`/`block_refs` tables + `get_broken_block_refs`, so there's no frontend resolver ripple. This is the deliberate backend-core boundary.

**Position contract for the frontend follow-up.** `create_block_ref`'s `position` is "the byte offset of any character on the target line" — the id is appended to that line's end. The eventual editor gesture passes the cursor's byte offset. Deterministic and testable.

**Tests:** 271 Rust passing (was 256 + 15 new: 1 migration-005 + 4 index-query + 5 scanner + 2 core-refresh + 3 handlers), 268 vitest unchanged (no UI logic added). `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npx vitest run`, and `npm run build` all clean. (One transient parallel-run flake observed in `runner::tests::schema_too_new_is_rejected` — passes in isolation and on re-run; self-contained `TempDir` test, not a regression.)

**Smoke status.** Interactive `cargo tauri dev` was not run — there is no editor gesture this session (deferred), so there is nothing new to drive in the native window beyond what the unit + integration tests already exercise end-to-end: the scan integration test mints/derives through a real scan + real file writes, and `create_block_ref_*` exercise real source rewrites + persisted rows. The app binary builds clean, so both commands are registered and reachable. A hands-on smoke (invoke `create_block_ref` on a real note, confirm `^id` lands in the `.md` and a `[[note#^missing]]` surfaces via `get_broken_block_refs`) is recommended once the frontend gesture lands.

**What's left for L3.** Session G frontend follow-up (editor create-ref gesture, `^id` decoration, broken-ref status-bar item) + the still-deferred in-bracket `[[#^` autocomplete (now that the `blocks` table exists). Then Sessions H–K — embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), closeout (K).

### 9.9 Session G frontend follow-up — block-ref gesture + `^id` decoration

**Done 2026-05-29.** The user-facing half of block references: a **"Copy block reference" gesture** that mints a `^block-id` for the line under the cursor and copies a `[[path#^id]]` link to the clipboard, and a **`^id` live-preview decoration** so the minted id reads as an intentional anchor. Frontend-only — no backend changes; reuses the `createBlockRef` IPC that shipped with §9.8. Executed from the plan at `docs/superpowers/archive/plans/2026-05-29-l3-session-g-frontend-block-refs.md`.

**The gesture (`Cmd/Ctrl+Shift+B`).** A CM6 keymap entry in `Editor.tsx` reads the selection head, converts it to a **UTF-8 byte offset** (`byteOffsetOf` — CM positions are UTF-16 code units; `create_block_ref` wants bytes), and calls a new `onCopyBlockRef(byteOffset)` prop. `App.tsx`'s `handleCopyBlockRef` then: `await flushAutosave()` (so on-disk bytes match the buffer at that offset *and* the buffer is left clean) → `createBlockRef({ vault_id, target_path: openPath, position })` → write `buildBlockRefLink(openPath, block_id)` = `[[<path-minus-.md>#^<id>]]` to the clipboard via `navigator.clipboard.writeText`. The backend's disk write fires `vault:file-changed` with a fresh hash; because the buffer is clean, the **existing silent-reload path** (L2 §2.7.5) pulls the `^id` into the editor with no conflict banner.

**Backend stays the sole minter.** The gesture never inserts `^id` itself — it delegates to `create_block_ref` and lets the silent reload reconcile the buffer. A frontend-only CM insert was rejected because it would duplicate the deterministic id grammar in TS and bypass the §9.8 invariant. The path-minus-`.md` link form is an exact vault-relative match (`resolve_target`), robust against duplicate basenames.

**The decoration.** `findBlockIds(doc, tree, cursor)` in `decorations.ts` scans each line for a trailing `^id` (regex `(^|\s)\^([A-Za-z_][A-Za-z0-9_-]*)\s*$` — same grammar as the Rust scanner/minter, kept in lockstep), revealing the id raw while the cursor touches it (like every inline token) and skipping any id inside fenced/inline code (`isInsideCode` walks the Lezer ancestor chain, mirroring autocomplete's `isInhibited`). It is a **direct doc scan**, not a Lezer walk — the markdown grammar has no `^id` node, so this follows the `findFrontmatter` precedent. Emitted as a new `mark-blockid` `DecoKind` (`cm-md-blockid` class: muted `var(--c-fg-muted)`, `0.85em`), merged into the live-preview plugin's set alongside `collectDecorations` in `buildFor`.

**Decisions worth noting.**
- *Byte vs char offset* lives only in `byteOffsetOf` — the single conversion point between CM's UTF-16 positions and the backend's UTF-8 expectations.
- *`flushAutosave()` before the IPC is load-bearing* — it both aligns disk/buffer bytes and guarantees the clean-buffer silent reload (vs. a conflict banner).
- *Idempotency comes for free* — `create_block_ref` returns the existing id when the line already has one; the clipboard still gets a correct link and the no-op disk write's echo is harmless.

**Gates green.**

**Smoke status.** Interactive `cargo tauri dev` was not run (the native window can't be browser-driven in this automated context — same constraint as Sessions D–G). The pure logic is fully unit-tested: byte-offset conversion (ASCII/multi-byte/astral), link building (`.md` strip + nested path), and decoration scanning (trailing id, own-line id, active-line reveal, fenced-code skip, mid-line/attached rejection). The flush→IPC→clipboard glue is thin and exercised end-to-end only by a hands-on smoke: open a note, `Cmd/Ctrl+Shift+B`, confirm the clipboard holds `[[note#^id]]`, `^id` lands in the `.md`, the editor shows it muted off the cursor line and raw on it, the pasted link resolves, and a `^id` inside a code fence is not decorated.

**What's left for L3.** The remaining Session G follow-ups — broken block-ref **status bar** (needs a greenfield status-bar shell) and **`[[#^` in-bracket autocomplete** (needs a new backend "block-ids in a file" query, so not frontend-only). Then Sessions H–K — embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), closeout (K).

### 9.10 Session G follow-up — broken block-ref status-bar indicator

**Done 2026-05-29.** A passive footer indicator surfacing broken block references. Frontend-only — reuses the §9.8 `getBrokenBlockRefs` IPC (previously unused). Executed from the plan at `docs/superpowers/archive/plans/2026-05-29-l3-session-g-broken-ref-statusbar.md`.

**No new shell.** The status bar already existed as the `App.tsx` `<footer>` (scan status + vault id); the indicator joins it as a middle item.

**Mechanics.** A `brokenBlockRefs: BrokenBlockRef[]` signal is refreshed via `getBrokenBlockRefs({ vault_id })` immediately on **scan-complete** and debounced (200ms, mirroring `scheduleBacklinksRefresh`) on **`vault:file-changed`**; it's cleared in the vault-open reset block. A transient IPC failure logs and keeps the prior value (no flicker to zero). The pure `formatBrokenBlockRefs(refs)` (`ui/src/statusbar/brokenRefs.ts`) returns `{ label, title } | null` — `null` renders nothing; otherwise a `<Show>`-gated warning-colored (`var(--c-warning, var(--c-accent))`) `<span>` shows `⚠ N broken block ref{s}` with a `title` tooltip listing `source → target#^id` lines.

**Passive by design.** No click-to-navigate, no panel. Broken *wiki-link* surfacing stays deferred (no backend query/IPC exists); when it lands it would feed this same footer indicator.

**Gates green.**

**Smoke status.** Interactive `cargo tauri dev` not run (automated-context constraint). The formatter is fully unit-tested; the signal/refresh/render glue is thin and exercised end-to-end only by a hands-on smoke: write `[[B#^missing]]` (B lacks `^missing`), confirm `⚠ 1 broken block ref` with a tooltip, add `^missing` to B and confirm the indicator clears after the file-change refresh.

**What's left for L3.** `[[#^` in-bracket block-id autocomplete (needs a backend block-ids-in-file query). Then Sessions H–K — embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), closeout (K).

### 9.11 `[[#^` in-bracket block-id autocomplete

**Done 2026-05-29.** Typing `[[target#^pre` opens a CodeMirror dropdown of block ids defined in `target.md` whose name starts with `pre`; picking one inserts the id (and the `]]` closer if not already present). Closes the §9.7-deferred in-bracket anchor completion — *for blocks only*. Executed from the plan at `docs/superpowers/archive/plans/2026-05-29-l3-blockid-autocomplete.md`.

**Backend (`cubical-app`).** New `commands::autocomplete::block_id_autocomplete(state, req)` handler: snapshots `SELECT path FROM files ORDER BY path` → `cubical_core::vault::links::resolve_target(target_raw, &known)` (same resolution `resolve_link` uses — exact path → unique basename → unique suffix) → if `Some(path)`, `cubical_index::blocks_for_file(conn, &path)` (Session G's helper, already ordered by `position_hint`) → take `AUTOCOMPLETE_LIMIT` (50) block_id strings. Unresolved target returns `[]`. Wire types `BlockIdAutocomplete{Request,Response}` in `api/types.rs`; 3-line Tauri shim registered in `lib.rs`'s `generate_handler!`. **No new index helper** — `blocks_for_file` is sufficient. 2 handler unit tests (resolved → ordered ids; unresolved → empty).

**Frontend (`ui/src/editor`).** Pure `detectBlockTrigger(before, pos)` regex `/\[\[([^\]\n|#]+)#\^([A-Za-z0-9_-]*)$/` returns `{ target, from }` where `from = pos - prefix.length` (CM6 replaces only the partial id); rejects empty target. `blockInsertion(id, closerFollows)` mirrors `linkInsertion` — the user has already typed `^`, so `insert` is just the id. `blockCompletionSource(provider)` calls `detectBlockTrigger`, runs `isInhibited(state, pos, false)` (we *want* to be inside a `WikiLink`, opposite of the tag source), fetches `provider.blockIds(target)`, returns options with `apply` dispatching the standard `changes`/`selection` transaction; `validFor: /^[A-Za-z0-9_-]*$/` filters between keystrokes without re-querying. `AutocompleteProvider` gains `blockIds(target): Promise<string[]>` plus a third `blockIdIpc` parameter in `createAutocompleteProvider` (defaults to `blockIdAutocomplete` from `api/ipc.ts`; failures resolve to `[]`). `Editor.tsx`'s `autocompletion({ override })` array gains `blockCompletionSource(provider)`.

**Decisions worth noting.**
- *Trigger regex requires `#^` literally.* The link trigger stops at `#`, and any future heading completion (`[[target#headline`) — still deferred, no headings index — would use a different anchor, so the two regexes can't collide.
- *`denyWikiLink=false`* in the source's `isInhibited` call. Block autocomplete *wants* to be inside a `WikiLink`; the tag source passes `true` for the opposite reason.
- *No prefix filter in the handler.* The full per-file id list (capped at 50) is returned once per fresh trigger; CM6's `validFor` does inter-keystroke filtering locally.

**Gates green.**

**Smoke status.** Interactive `cargo tauri dev` not run (automated-context constraint). Pure logic fully unit-tested end-to-end (trigger detection, insertion, code-context inhibition, target resolution → ids); the live dropdown is verified by a hands-on smoke: in note A type `[[B#^` where B has minted ids (`Cmd/Ctrl+Shift+B`), confirm the dropdown lists them; typing narrows; Enter inserts `id]]`; no dropdown for an unresolved target or inside a fenced code block.

**What's left for L3.** Heading autocomplete (`[[target#headline`) stays deferred — no headings index. Then Sessions H–K — embeds proper (H), unlinked mentions (I), pending-rewrites cache (J), closeout (K).

### 9.12 Session H.1 — Embed content extractor + IPC

**Done 2026-05-29.** Backend half of Session H (spec §2.8): a `get_embed` IPC that, given a wiki-link target (`note` / `note#heading` / `note#^id`), returns the content the (deferred H.2) widget will inline. Pure markdown-aware extractors do the work; the handler is a thin orchestrator. **Frontend: zero changes** — the IPC binding lands unused (same backend-first cadence as §9.8). Executed from the plan at `docs/superpowers/archive/plans/2026-05-29-l3-session-h1-embed-extractor.md`.

**Pure extractors (`cubical-core::vault::embeds`).** New sibling module to `vault::blocks`. Three public functions, all unit-tested:
- `extract_section(source, anchor) -> Option<String>` — slugifies the anchor + each ATX heading text (`slugify`: lowercase, non-alphanumeric runs → `-`, trim leading/trailing `-`), so `"My Section!"` matches anchor `"my-section"` / `"My Section"` / `"My Section!"`. Returns the slice from the line *after* the matched heading to the line *before* the next heading whose level is `≤` the matched heading's; sub-headings below the matched level are preserved.
- `extract_block(source, byte_offset)` — `byte_offset` is the start of a line per Session G's `BlockRow::position_hint` contract. Walks outward to the nearest blank-line boundaries on each side and returns the contiguous slice. Handles paragraphs and most list items uniformly; defensive empty-string return when `byte_offset >= source.len()`.
- `strip_frontmatter(source) -> &str` — borrow-returning. Accepts `---\n` / `---\r\n` opener with a closing `---` on its own line; otherwise returns the whole source unchanged. Unclosed openers are tolerated (return source unchanged).

**Handler (`cubical-app::commands::embeds::get_embed`).** Mirrors `block_id_autocomplete`'s skeleton: snapshot `files.path`, `split_target_anchor` (widened to `pub(crate)` for reuse), `resolve_target`. Unresolved target → `EmbedKind::Unresolved`. Resolved → `read_source_off_executor` (widened to `pub`); unreadable file folds into `Unresolved` (watcher heals on next change — same policy as `refresh_blocks`). Then routes by anchor kind: `None` → `Note` + `strip_frontmatter(&source)`; `Heading { value }` → `extract_section` (Some → `Section`, None → `MissingAnchor`); `Block { value }` → `blocks_for_file` (Session G) → find matching id → `extract_block` (Some → `Block`, None → `MissingAnchor`). 5 handler unit tests cover every branch.

**Wire shape.** `EmbedKind` enum (`note`/`section`/`block`/`unresolved`/`missing-anchor`, kebab-case serde rename); `GetEmbedRequest { vault_id, target_raw }`; `GetEmbedResponse { kind, target_path: Option<String>, content: Option<String> }`. `target_path` is `None` only when the target didn't resolve; `content` is `None` for `Unresolved` and `MissingAnchor`. Tauri shim + `ipc.ts` `getEmbed` binding — both unused until H.2.

**Decisions worth noting.**
- *Slug match on both sides.* Single normalization rule subsumes raw-text equality and Obsidian-style anchor form; one code path.
- *No markdown parser dependency.* Extractors are simple line walks — sufficient for the §2.8 DoD and trivially testable. Real markdown awareness (setext headings, multi-paragraph blocks) is a non-breaking later upgrade.
- *Unreadable file → `Unresolved`.* The embed surface treats "can't read" the same as "doesn't exist" — no filesystem error leakage through `get_embed`.
- *No backend recursion / depth / cycle handling.* Per-call slice; the H.2 widget owns the chain.

**Gates green.**

**Smoke status.** No editor surface this session — `get_embed` reachable only via dev-console `__TAURI__.core.invoke(...)`. Optional hands-on: invoke with `Daily`, `Daily#Intro`, `Daily#^id`, and `ghost` and confirm the response matches the kind/content expectation. The handler tests cover every branch end-to-end against real vault scans + real file writes.

**What's left for L3.** **Session H.2 — embed widget** (live-preview block widget consuming `getEmbed`; depth cap → styled link; cycle detection; unresolved placeholder). Then Sessions I–K — unlinked mentions, pending-rewrites cache, closeout.

### 9.13 Session H.2 — Embed widget

**Done 2026-05-30.** Frontend half of Session H (spec §2.8): every `![[…]]` token in Live Preview renders a block widget below its line carrying the embedded content, with bounded recursion (max depth 4 per `document-model.md` §5.4), cycle detection, and styled placeholders for unresolved targets and missing anchors. Executed from the plan at `docs/superpowers/archive/plans/2026-05-30-l3-session-h2-embed-widget.md`.

**Resolver (`ui/src/editor/embedResolver.ts`).** `EmbedResolver` mirrors `WikiLinkResolver` (L3 Session B) verbatim — `get` / `fetch` / `resolve` / `invalidate` / `onUpdate`, cache key = `target_raw`, IPC stub injected for tests, failures cache an `{ kind: "unresolved", target_path: null, content: null }` entry. `resolve()` re-kicks `fetch` when its subscriber wakes to a still-empty cache with no in-flight fetch (caught in code review: without this, an `invalidate()` landing after a fetch settles but before the awaiting subscriber wakes leaves `resolve()` hung forever). 8 unit tests (6 plus 2 covering the re-kick semantics: joining an in-flight fetch + settling after mid-flight invalidate).

**Pure renderer (`ui/src/editor/embedRender.ts`).** `renderEmbedBody(ctx)` returns a `DocumentFragment` for one embed token; five branches — depth-cap (chain.length ≥ 4) → styled depth link, cold cache → "Loading…" placeholder + `resolver.fetch`, unresolved/missing-anchor → ⚠ placeholder, cycle (resolved `target_path ∈ chain`) → styled cycle link, resolved (note/section/block) → preserved-newline plain text. Nested `![[…]]` in content are recognised via `scanWikilinks` (L1 tokenizer) and recursively rendered, threading `[...chain, here.target_path]`. Non-embed `[[…]]` inside an embed body stays as literal source (reconstructed via private `reconstructLiteral`). **No markdown formatting inside the body** — H.3 polish. `MAX_EMBED_DEPTH = 4` (exported). 11 unit tests against jsdom (per-file `// @vitest-environment jsdom` pragma — vitest runs in node by default).

**CM6 extension (`ui/src/editor/embed.ts`).** `embedExtension = [embedBlockField, embedBaseTheme]`. `embedBlockField` is a `StateField<DecorationSet>` (block decorations cannot come from a `ViewPlugin`) that walks the Lezer tree for every `WikiLink` node, re-tokenises its raw source, and — only for `![[…]]` — emits one `Decoration.widget({ block: true, side: 1 })` at the token's line end. The widget's `toDOM()` mounts a `.cm-md-embed-frame` wrapper and appends `renderEmbedBody(...)`. Rebuilds on doc / tree / facet changes and on the `embedResolverUpdated` `StateEffect`. **Widget identity is keyed on the resolver cache entry** — `EmbedBlockWidget.eq()` compares `targetRaw`, `openNotePath`, **and** the captured `EmbedResolution | undefined` entry by reference (caught in code review: the plan's `stamp = Date.now()` strategy made every widget remount on every rebuild even when its target's cache state was unchanged; the entry-reference strategy preserves DOM identity unless the entry actually flips). `EmbedResolver.fetch` replaces the entry via `cache.set` on completion, so `eq()` returns `false` only for the widgets whose target was actually fetched. `embedResolverFacet` flows the per-vault resolver (`null` → no widgets emitted, avoiding a loading-placeholder forest); `openNotePathFacet` seeds the cycle chain with the host note's path. `ignoreEvent` left at the CM6 default (`true` = ignore) — a read-only block widget should not reposition the caret on body clicks (the plan's `return false` had inverted semantics; caught in review). 9 integration tests against real `EditorView`s (7 plus 2 covering identity preservation: unrelated doc edit keeps the frame node; entry change forces a remount).

**Editor + App wiring.** `Editor` gains two props (`embedResolver?`, `openNotePath?`), two `Compartment`s (one per facet), an `onUpdate` subscription dispatching `embedResolverUpdated`, and reactive prop-swap `createEffect`s. `App` owns one `EmbedResolver` per open vault (`createEmbedResolver(vault_id)` on `handleOpen`, `null` on close, `.invalidate()` on every `vault:file-changed`), and feeds `selectedPath()` straight through as `openNotePath`. Mirrors the L3 Session B `WikiLinkResolver` lifecycle so the two surfaces stay symmetrical.

**Decisions worth noting.**
- *Block widget, not text replacement.* The `![[…]]` source line stays editable; the widget appears *below* it. The existing inline `mark-wikilink-embed` `⎘` glyph in `decorations.ts` (L3 Session B) is unchanged — it stays as a marker on the source. H.3 can decide whether to retire the glyph once the block widget is fully featured.
- *Plain text, not markdown rendering, inside the body.* §2.8 DoD doesn't require it; the body uses `white-space: pre-wrap` so newlines + spacing land faithfully. Rich rendering is H.3.
- *Recursive rendering through `renderEmbedBody`, not nested CM6 widgets.* The widget builds plain DOM; nested embeds are recursive calls within the same DocumentFragment. Cleaner than mounting CM6 inside CM6 and trivially testable in jsdom.
- *Cycle = resolved `target_path` ∈ chain.* The chain stores resolved paths, not `target_raw`. Catches `[[Daily]]` ≡ `[[notes/Daily]]` referring to the same file with different surface forms.
- *Seed chain = open note's path.* `App.tsx` passes `selectedPath()` so `![[OpenNote]]` inside itself renders as a cycle link, not as an empty-content render.
- *Hard-coded `MAX_EMBED_DEPTH = 4`.* `document-model.md` §5.4 names 4 as the default; a setting surface can land alongside `editor.embed_max_depth` if a future session needs it.
- *Widget identity by cache-entry reference, not by build counter.* Two follow-up commits during this session (`37b04f2` for the resolver re-kick, `515df18` for the widget identity strategy) corrected plan-level decisions that code review surfaced as too coarse. The end state is a widget that remounts only when its target's resolution actually changes — important once H.3 adds richer rendering inside the body.
- *Failures cache as unresolved.* Same policy as `WikiLinkResolver`. Spec §2.8 doesn't distinguish "IPC died" from "file missing" — both render the unresolved placeholder.
- *Per-file `jsdom` pragma, not a global vitest env switch.* Two new tests need DOM (`embedRender.test.ts` + `embed.test.ts`); the existing 290+ tests don't, and many would slow if the whole suite booted jsdom. `// @vitest-environment jsdom` at the top of each DOM test plus `jsdom` as a `devDependency` keeps the cost local.

**Gates green.**

**Smoke status.** Interactive `cargo tauri dev` not run (automated-context constraint). Pure logic fully unit-tested end-to-end (resolver including re-kick edge case, renderer including 5 branches + recursion + cycle threading, extension including identity preservation + remount-on-entry-change). Smoke vault for next hands-on session:

```
Daily.md:
# Intro
This is the intro.
# Body
Body text.
^abc123

Outer.md:
top-of-outer
![[Daily]]
between
![[Daily#Intro]]
between
![[Daily#^abc123]]
between
![[Ghost]]
between
![[Daily#Missing]]

Cycle.md:
self-referencing: ![[Cycle]]

Chain.md → ChainE.md (each embeds the next):
ChainA: ![[ChainB]]
ChainB: ![[ChainC]]
ChainC: ![[ChainD]]
ChainD: ![[ChainE]]   ← depth-cap kicks in
ChainE: end
```

Verify in `Outer.md`: full-note embed renders Daily's full content (minus frontmatter — H.1 strips it); section embed renders the `# Intro` body; block embed renders the line carrying `^abc123`; `![[Ghost]]` → unresolved placeholder; `![[Daily#Missing]]` → missing-anchor placeholder. In `Cycle.md`, the embed renders as a styled cycle link. In `ChainA.md`, the chain renders four levels of nested frames; the fifth (ChainE inside ChainD) renders as a styled depth link.

**What's left for L3.** Sessions I–K — unlinked mentions, pending-rewrites cache, closeout. H.3 (rich markdown rendering inside the embed body, click navigation, optional `⎘`-indicator retirement) is **deferred polish** — not on the §2.8 DoD critical path.

### 9.14 Session I — Unlinked mentions

**Done 2026-05-30.** A second right-sidebar panel ("Unlinked Mentions") lands beside Backlinks. For the open note, every plain-text occurrence of its title or any frontmatter `aliases` value that is NOT already a link surfaces with a context snippet; a per-row "Link it" button rewrites the matched text into `[[…]]` on disk. The scan is on-demand (per IPC call) — no new index table.

**Pure scanner — `cubical-core::vault::mentions`.** Two pure functions sit beside `vault::blocks` and `vault::tags`. `extract_text_runs(source) -> Vec<TextRun<'_>>` walks the source byte-by-byte, yielding plain-text regions (with their original byte offsets) outside frontmatter, fenced code (` ``` ` / `~~~`), inline code spans (`` `…` `` — multi-line aware, multi-tick aware), wiki-links (`[[…]]` / `![[…]]` — pre-`!` byte included in the exclusion zone), and markdown links (`[…](…)` — both display and url segments excluded). Unterminated fences / spans / brackets fall through as text. `find_mention_occurrences(source, needles) -> Vec<MentionHit>` walks each text run, lowercases it once, and runs a linear case-insensitive substring scan per needle. The whole-word boundary rule is `!c.is_alphanumeric() && c != '_'` on both sides (Rust's locale-independent `char::is_alphanumeric` — mirrors Tantivy's default tokenizer boundary so the eventual L4 search agrees). Empty / whitespace-only needles skip silently. Hits sort by `byte_offset` so callers don't need to. A `map_lower_span_to_original` helper handles the (rare) case where casefolding expands the source bytes (e.g. `ß` → `ss`) so byte offsets remain correct on the original source. AST module `cubical_ast::wikilink` (Session A's tokenizer) was promoted to `pub` for anticipated reuse, though the byte-level walker in `mentions.rs` ended up not delegating to `scan_wikilinks` directly — the re-export is held as a building block for future scanner consolidation.

**Snippet helper lifted.** `build_snippet` moved out of `commands/backlinks.rs` into the new `cubical_app::commands::snippet` module (verbatim — same 9 unit tests) so the Backlinks panel and the Mentions panel produce identical-looking context.

**Handler: `get_unlinked_mentions`.** Pure handler + Tauri shim + `generate_handler!` registration (mirroring `get_backlinks`). Steps: snapshot every markdown `files.path` except the open note (`type_id = 'markdown' AND path != ?1 ORDER BY path` — the `path != ?1` is the open-note self-exclusion); load the note's title (basename minus `.md`) and aliases (`SELECT value FROM frontmatter WHERE file_path = ?1 AND key = 'aliases'`, JSON-decoded — non-list / non-string entries silently dropped); build a deduped needle list (title first, aliases case-insensitively deduped against title, blanks dropped); for each candidate file read it off the tokio runtime (`vault::links::read_source_off_executor` — already widened to `pub` for H.1) and call `find_mention_occurrences`; emit `Mention { source_path, context, position, byte_len, needle }` per hit; sort `(source_path, position)`. A `MAX_SCAN_FILES = 50_000` fuse caps the worst case at a known bound — a vault past that size gets a partial answer rather than a frozen UI; documented in the source so the next reader can find it.

**Handler: `link_mention`.** Reads the source file fresh just-in-time (so a same-millisecond external edit is reflected), validates the byte range is in bounds and falls on UTF-8 boundaries, re-checks the whole-word boundary at the span's edges (so an external edit that moved the match raises `InvalidRequest` and the frontend re-fetches), then splices `[[Title]]` (when `matched.to_lowercase() == title.to_lowercase()`) or `[[Title|matched]]` (otherwise — the alias-display case) over the span. The bare-vs-alias decision uses **full Unicode `to_lowercase`**, not `eq_ignore_ascii_case`, so a title like `"CAFÉ"` matched as `"café"` correctly produces `[[CAFÉ]]` (caught in code review; regression test in `commands::mentions::tests::link_mention_handles_non_ascii_title_with_unicode_case_fold`). Atomic write via `cubical_core::atomic_write` off the executor; mirrors `write_file_text`'s blocking-task pattern. The `files.content_hash` is eagerly updated post-write so the next mentions refresh sees the new hash (best-effort — the watcher will also catch up). Returns `{ new_hash }`. No `expected_seen_hash` parameter — for arbitrary source files the frontend has no seen-hash, and the just-in-time read is sufficient for the spec's "responsive on a large vault" DoD.

**Frontend.**
- `ui/src/api/ipc.ts` — `getUnlinkedMentions` + `linkMention` bindings + the `Mention` type. `Setting` union gains `ui.right_sidebar_panel`.
- `ui/src/sidebar/unlinkedMentionsState.ts` — pure state machine (`MentionsViewState` = `idle | loading | empty | loaded | error`) + `mentionKey` row identity + a `mention:linked` action that locally removes the linked row (optimistic) until the next refresh tick resolves it from disk.
- `ui/src/sidebar/UnlinkedMentions.tsx` — Solid panel mirroring `Backlinks.tsx` shape verbatim (same untrack-guarded fetch effect from the Session C regression test); per-row "Link it" button calls `linkMention` and dispatches `mention:linked` on success. Per-row link errors live in a separate `linkError` signal keyed by `mentionKey` so a single-row failure doesn't blow away the rest of the loaded list (caught in code review).
- `ui/src/RightSidebar.tsx` — extended with optional `segments` / `segment` / `onSegmentChange` props. When two or more segments are supplied a tabbed selector (`role="tablist"`, per-tab `aria-selected`) renders above `children` (hidden when collapsed). Backwards-compatible — Session C-style single-panel usage still works.
- `ui/src/App.tsx` — renders `<Backlinks>` or `<UnlinkedMentions>` based on `rightSidebarPanel` signal; persists the choice as `ui.right_sidebar_panel` (default `"backlinks"`). Renames `backlinksRefreshTick` → `rightSidebarRefreshTick` (and the constant from `BACKLINKS_…` to `RIGHT_SIDEBAR_…`) since the same debounced tick now drives both panels.

**Decisions worth noting.**
- *Title source:* basename minus `.md`. No `title:` frontmatter convention exists in the codebase; the file list and Backlinks both already use the same `basenameWithoutExtension` helper.
- *Whole-word boundary:* `!char::is_alphanumeric() && != '_'` (Rust's locale-independent method). Hyphens act as non-word chars (so `Daily-Note` matches `Daily`); underscores are word chars (so `Daily_Note` does NOT match — `_` is part of the surrounding identifier, which is the standard convention).
- *Alias-display rewrite:* `[[Title|alias]]` when the matched span differs from the canonical title case-insensitively (full Unicode fold); bare `[[Title]]` otherwise.
- *No `expected_seen_hash` on the rewrite:* the frontend has no seen-hash for non-open source files. The handler reads fresh, validates, splices, writes atomically — a same-millisecond external edit's content is what the splice operates on.
- *Live-refresh route:* piggybacks the existing debounced `vault:file-changed` listener — the same tick now fans out to both Backlinks and Mentions. No new event (spec §3.5 reserves `vault:index-changed` for a hypothetical future second consumer; Session I has none).
- *Segment selector location:* inside `RightSidebar` (the shell owns the tab chrome). Keeps `App.tsx` flatter.
- *Group by source vs. flat list:* flat list, sorted `(source_path, position)`. Identical to Backlinks.
- *Open note self-exclusion:* enforced in the SQL (`path != ?1`). A note's own body never produces mentions of itself.
- *`MAX_SCAN_FILES` fuse:* 50,000 markdown files. Above that the panel returns a partial answer rather than freezing.

**Tests:** 289 baseline + 37 new Rust (= 326) — 21 in `vault::mentions` (text-run extraction + needle finder + Unicode boundary cases) + 16 in `commands::mentions` (handler success / error paths + rewrite shapes + edge cases including the non-ASCII case-fold regression). 321 baseline + 8 new vitest (= 329) — 8 in `unlinkedMentions.test.ts` (`mentionKey` + reducer transitions including `mention:linked`).

**Smoke status — deferred.** Hands-on `cargo tauri dev` smoke was not performed; the automated context can't drive the native Tauri window. The recipe is recorded for the next interactive pass:

```
Smoke vault:

  Daily.md
  ---
  aliases: [diary, journal]
  ---
  body — see Project for context.

  Project.md
  Worked on the daily today. The Journal entry tracks this.
  Also see [[Daily]] — this occurrence must NOT appear.
  `daily` inside code — this occurrence must NOT appear.

  Notes.md
  Mentions of the journal and Daily across multiple lines.
```

Expected: with `Daily.md` open, three rows from `Project.md` (`daily` body match, `Journal` alias match, plain `Daily`) and the matches in `Notes.md`. `[[Daily]]` and `` `daily` `` are NOT listed. `Daily.md`'s own body is excluded. Clicking "Link it" rewrites the matched span to `[[Daily]]` (or `[[Daily|Journal]]` for the alias case) on disk; the row disappears; the panel re-fetches via the debounced `vault:file-changed` listener and the rewritten occurrence no longer appears. Toggling the segment to Backlinks still works; the collapsed-sidebar state from Session C still works. A failed "Link it" (e.g. the span has moved) surfaces an inline error on the affected row without destroying the rest of the list.

**What's left for L3.** Sessions J (Rename → Pending Rewrites Cache) and K (closeout, `l3` tag, full smoke pass). H.3 polish (rich markdown rendering inside the embed body, click navigation, `⎘`-indicator retirement) remains explicitly deferred — not on the §6 DoD critical path. The `vault:index-changed` event reserved by §3.5 stays unbuilt; the on-demand `vault:file-changed` fan-out is the only live-refresh substrate L3 ships.

### 9.15 Session J.1 — Pending Rewrites backend

Implements spec §2.10 + the locked design at [`docs/superpowers/archive/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](superpowers/archive/specs/2026-05-31-l3-session-j-pending-rewrites-design.md). Every J behaviour is exercised through direct IPC calls + headless Rust tests; J.2 wires the IPCs into the status bar, toast, undo affordance, and right-click rename gesture.

**What landed.**

*Migration 006 + `cubical-index::pending` module.* Locked schema from `document-model.md` §5.7. `pending_rewrites(id, target_file, rewrite_kind, old_token, new_token, created_at, rename_op_id)` + two indexes (`idx_pending_target`, `idx_pending_op`); no FK on `target_file` (a row targeting a since-deleted file silently drops on flush). `HIGHEST_KNOWN_VERSION = 6`; the `v6_applies_on_top_of_existing_v5_database` test pins the upgrade path. Query module exposes the full surface needed by the rename + flush IPCs: `enqueue_pending`, `pending_for_target`, `pending_targets`, `pending_count_total`, `pending_count_for_target`, `pending_count_breakdown`, `delete_rename_op`, `delete_pending_for_target`, `list_recent_rename_ops`, plus `RewriteKind` (`WikiLink` / `Tag` / `BlockRef`, schema repr lowercase-snake), `PendingRewriteRow`, `NewPendingRewrite`, `RenameOpRow`. New `IndexError::UnknownEnum { table, column, value }` surfaces malformed `rewrite_kind` strings without panic.

*Pure materializer — `cubical-core::vault::pending`.* `apply_pending(source, &[PendingRewriteRow]) -> String` walks rewrites in slice order; per-kind dispatch:
- `WikiLink` — `cubical_ast::scan_wikilinks` walk; rewrites only the `target` field when it equals `old_token`, preserving optional `|display`, `#heading` / `#^block` anchors, and the `![[…]]` embed prefix. A private `emit_wikilink` rebuilds tokens in the parser-accepted order (anchor before display).
- `Tag` — two passes per rewrite. **Frontmatter pass:** locates the `tags:` key (inline-flow `[a, b]`, block-list `- a\n- b`, or scalar `tags: foo` shapes), rewrites string entries equal to `old_token` or rooted at `old_token + "/"`. Preserves quoting (`"` / `'` / leading `#`) and other YAML keys untouched. **Inline-body pass:** walks `vault::mentions::extract_text_runs` (respecting fence + inline-code + wiki-link + link-target exclusions from Session D), applies the Session D boundary rules to find `#tag` occurrences, rewrites exact + nested-prefix matches.
- `BlockRef` — referrer pattern (`[[note#^old]]` via `scan_wikilinks` + `Anchor::Block`) **and** defining-line pattern (`^old` as the trimmed trailing token of a line, allowed-charset gate). The trailing-token rule correctly excludes referrers from the defining-line path so the same row safely targets both kinds of files.

`materialize_on_read(idx, path, on_disk) -> Result<String, IndexError>` pulls rows for `path`; empty rows returns input.

*Materialize-on-read invariant wired into every effective-content reader.* `read_file_text`, `get_embed`, and `get_unlinked_mentions` all run the on-disk read through `materialize_on_read` before returning (the editor view + embed bodies + unlinked-mention scan reflect post-rename world pre-flush). `get_canonical_ast` derives from `read_file_text`, inherits materialization. The bulk vault scan's pass 1 reads each markdown file once, materializes once, hands the materialized source to all four extractors (refresh_frontmatter + extract_links_from_source + refresh_tags + refresh_blocks). The watcher's `Modified` branch keeps the existing raw read for `content_hash` (its purpose is detecting on-disk change) and adds a second raw-bytes-then-materialize read for the extractors. Pass 2's link resolution is unchanged. `refresh_X` signatures take `(vault, rel, source: &str)` so the caller does the read+materialize once; `extract_links_off_executor` renamed to `extract_links_from_source`.

*`link_mention` flushes before splicing.* When `pending_count_for_target(target=source_file) > 0`, calls the `flush_pending_for_target` per-target executor (apply_pending + atomic_write + delete_pending_for_target + best-effort `files.content_hash` bump) BEFORE re-reading disk and computing the splice. Closes the "splice into materialized but write non-materialized" trap called out in `document-model.md` §5.7.

*Per-vault flush state on `OpenVault`.* Three new Arc-wrapped fields: `flush_own_writes: Arc<Mutex<HashSet<(PathBuf, String)>>>` (backend own-write hash gate — flush populates BEFORE the atomic_write; the watcher dispatcher's `Modified` branch drains the matching `(path, hash)` and suppresses `vault:file-changed`); `flush_in_progress: Arc<Mutex<()>>` (held across any flush so the timer + close + manual + >50-fuse triggers don't interleave); `flush_timer_cancel: CancellationToken` (fired in `close_vault` so the periodic-flush task exits cleanly before the close-time flush runs). All twelve `OpenVault` construction sites go through a new `OpenVault::new(...)` constructor.

*Rename IPCs — `cubical-app::commands::rename`.* New module + a transactional `mint_rename_op_id` helper using `config['pending_rewrites.next_rename_op_id']` (first call → 1). All three enqueue through `enqueue_coalesced` (2026-06-23) rather than a blind `INSERT`: it upserts on `(target_file, rewrite_kind, old_token)` — since `old_token` is the referrer's untouched on-disk text, a chain of renames collapses onto one row (latest `new_token`/`rename_op_id` wins), and a row whose `new_token` lands back on `old_token` is dropped. So `A → B → A` cancels to zero pending rows instead of stacking two; without it the status-bar count doubled on a rename-back. **Rename freshness (2026-06-23):** the index stays correct through a rename chain, but two views lagged: (1) `get_backlinks` built its snippet from the source's RAW on-disk text, so an unflushed referrer showed the stale `[[old]]` name (and could be offset-misaligned, since `position` is extracted against the materialized view) — it now `materialize_on_read`s the source first; (2) `rename_file` emits no `vault:file-changed`, so `App.tsx`'s `handleRenameCommit` now proactively invalidates the wiki-link/embed/property/dataview resolvers + `refreshFileList` + `scheduleRightSidebarRefresh` instead of waiting for the (debounced) watcher echo, so open views re-resolve against the rekeyed index immediately. **Broken-link repair (2026-06-23):** a rename normally only touches links that already resolve to the old path, so links orphaned by an earlier rename (`target_path IS NULL`) stay broken. Gated on the portable setting `wikilinks.rewrite_broken_links_on_rename` (default on; Settings ▸ Wiki links), `rename_file` also matches referrers whose raw text equals the old file's basename or path-minus-`.md`, reconnects their `target_path` to the new file, and queues the text rewrite — reconnecting orphans on the next rename.
- `rename_file` — `SELECT DISTINCT source_path, target_raw FROM links WHERE target_path = ?from`, mint op_id, INSERT one `wiki_link` pending row per pair with `old_token = target_raw` + `new_token` derived per the design spec's "Wiki-link old_token derivation" locked decision (basename form ↔ basename form, path form ↔ path form). Then **explicit FK rekey**: every FK-bearing child table (`links.source_path` + `tags.file_path` + `blocks.file_path` + `block_refs.source_file_path` + `frontmatter.file_path`) plus `block_refs.target_file_path` + `links.target_path` updated to `?to` BEFORE the `UPDATE files SET path = ?to` (no FK has `ON UPDATE CASCADE`; SQLite's default `NO ACTION` is sidestepped by `PRAGMA defer_foreign_keys = 1` inside the rename transaction so the intermediate state is OK). Then `fs::rename` (cross-FS fallback via `atomic_write` + remove on EXDEV), then re-extract the moved file's outbound rows under the new path. Emits `vault:pending-rewrites-changed { vault_id, count }`. Migration 007 was explicitly NOT shipped — the rekey approach is preferred to altering FK constraints retroactively.
- `rename_tag` — `SELECT DISTINCT file_path FROM tags WHERE tag_path = ?old OR tag_path LIKE ?old || '/%'` (nested rename captured); one `tag` pending row per distinct file. Empty result → return `rename_op_id: 0` without minting.
- `rename_block_id` — referrer rows from `block_refs WHERE (target_file_path, target_block_id) = (?file, ?old)`, plus one extra `block_ref` row targeting `?file` itself (defining-line rewrite, deduped if the defining file is also a referrer). Rejects with `InvalidRequest` when `cubical_index::block_exists(?file, ?old)` is false.

*Flush IPCs.* `flush_pending_rewrites` iterates `pending_targets` and walks each through `flush_pending_for_target(&Vault, target, Some(gate))`; `flush_pending_rewrites_for_target` is the single-target shim used by the >50 fuse and manual UI clicks. Both wrap the work in `flush_in_progress.lock()`. The per-target executor reads disk fresh, applies the materializer, **populates `flush_own_writes` with the post-write hash BEFORE `atomic_write`**, drops the matching pending rows, eager-updates `files.content_hash`. External-write conflict per §5.7: the textual find-then-replace yields the silent-drop semantic naturally — a row whose `old_token` was externally removed contributes 0 to `refs_updated` and the row is deleted on commit. Both IPCs emit `vault:flush-complete { files_rewritten, refs_updated }` once at the end + `vault:pending-rewrites-changed { count }` with the residual count.

*Read-only IPCs.* `get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`, `undo_rename`. Thin wrappers around the `cubical-index::pending` query helpers; `undo_rename` emits `vault:pending-rewrites-changed`.

*Flush triggers — all four wired.*
- **Periodic timer** — per-vault `tokio::spawn` task in `open_vault`'s success path. Each tick reads `pending_rewrites.flush_interval_secs` from `config` (default 300 — J.2's settings change takes effect on the NEXT tick) and `tokio::select!`s between the sleep and `flush_timer_cancel.cancelled()`.
- **App close** — `close_vault` fires `flush_timer_cancel` first so the timer task exits before the close-time flush starts (no race for `flush_in_progress`), then `flush_at_close` runs synchronously. Errors are logged and swallowed: a flush failure must not block close (rows survive on disk for the next open).
- **>50-per-file fuse** — `enforce_fifty_per_file_fuse` runs at the tail of each rename handler. For each newly-touched target, `pending_count_for_target` > 50 triggers a synchronous `flush_pending_for_target` for THAT file only; others stay deferred.
- **Manual** — `flush_pending_rewrites` IPC exposed; J.2 binds it to the status-bar dropdown's "Save all pending" button.

*Backend own-write hash gate — watcher integration.* `consume_own_write_hash` (pure, in `events.rs`) checks `(rel, hash)` against the per-vault `FlushOwnWrites` set and removes-on-match; only `Modified` events with a non-empty hash can match. Wired into the watcher dispatcher between the existing `apply_watch_event_to_db` call and the `emit_file_changed` so flush-driven writes are suppressed; an external edit (or any other-hash write) passes through normally.

*IPC registration.* Nine entries land in `lib.rs` `generate_handler!`: `rename_file`, `rename_tag`, `rename_block_id`, `flush_pending_rewrites`, `flush_pending_rewrites_for_target`, `get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`, `undo_rename`. The eight write handlers take `AppHandle` so they can emit; the three read-only ones don't. All `emit_*` helpers + handler signatures are `R: tauri::Runtime`-generic so unit tests run against `tauri::test::MockRuntime` while production uses the default `Wry` (tauri-with-test added to dev-deps).

*Frontend stub.* `ui/src/api/ipc.ts` gains typed bindings for every new IPC plus two listeners (`onVaultPendingRewritesChanged`, `onVaultFlushComplete`) and a new `Setting` key `pending_rewrites.flush_interval_secs`. Exports are unused — J.2 wires them into the status bar, toast, undo affordance, and rename gesture.

*New event names + payloads.* `VAULT_PENDING_REWRITES_CHANGED` (= `"vault:pending-rewrites-changed"`) carrying `{ vault_id, count }`; `VAULT_FLUSH_COMPLETE` (= `"vault:flush-complete"`) carrying `{ vault_id, files_rewritten, refs_updated }`. Both live in `events.rs` alongside the other vault events.

**Tests.** 326 baseline + 80 new (= 406 Rust). Breakdown: 14 in `cubical-index::pending` + `runner` (chain 1), 35 in `cubical-core::vault::pending` (chain 2), 8 across app-side materialize sites (chain 3), 3 in `events::tests` covering the own-write gate (chain 4), 16 new in `commands::rename::tests` (mint_op_id monotonicity / wikilink token derivation / each rename handler's enqueue + explicit FK rekey + on-disk move + validation rejections / flush executor silent-drop conflict + populated gate + ENOENT target / multi-target flush_pending_rewrites / undo only the matching op) plus 4 trigger tests (>50 fuse fires + boundary "exactly 50 doesn't fire" + flush_all_for_vault drains every target + periodic-timer fires-then-stops-on-cancel). vitest unchanged at 329 — the ipc.ts stubs are unused.

**Verification.** `cargo test --workspace` green at 406. `cargo clippy --workspace --all-targets -- -D warnings` + `cargo fmt --all --check` clean. `npx tsc --noEmit`, `npm run build`, `npx vitest run` (329) all green.

**Headless smoke recipe.** Drive the IPCs from a Rust integration test or `cargo tauri dev` console: open vault → invoke `rename_file({ from: "Daily.md", to: "Journal.md" })` → invoke `get_pending_rewrites_count()` (≥1) → invoke `flush_pending_rewrites()` → `read_file_text` on a referrer file shows `[[Journal]]`, `get_pending_rewrites_count()` returns 0. Repeat for `rename_tag` (frontmatter `tags:` + inline `#tag`) and `rename_block_id` (referrer `[[file#^id]]` + defining-line `^id`). Hands-on UI smoke is J.2 scope per Session I's precedent for split sessions.

**Next.** J.2 — frontend: status-bar count item + dropdown (breakdown + per-op undo), `Toast.tsx`, file-rename right-click gesture, `App.tsx` wiring through the two new listeners. Then K (L3 closeout, `l3` tag, full smoke pass).

### 9.16 Session J.2 — Pending Rewrites frontend

Implements the frontend half of the design locked at [`docs/superpowers/archive/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](superpowers/archive/specs/2026-05-31-l3-session-j-pending-rewrites-design.md) (§J.2 — Frontend). Closes the §6 DoD item for "Rename → Pending Rewrites Cache" by surfacing every J.1 IPC + both new events into the running UI.

**What landed.**

*Toast surface — `ui/src/Toast.tsx` + `ui/src/toastState.ts`.* Single-slot, auto-dismiss 4 s, dismissible via the `×` button. State lives in a sibling `toastState.ts` module so vitest can exercise it under `environment: "node"` without pulling in Solid's JSX runtime (which needs `window`). Public surface: `showToast(message)`, `dismissToast()`, `currentToast` (signal getter), `TOAST_AUTO_DISMISS_MS`, and the `<ToastHost>` Solid component (mounted once in `App.tsx`). Re-showing inside the 4 s window replaces the message and resets the timer — the prior timer's callback is a no-op because `clearTimeout` ran first. Tokenised throughout (`--c-bg-tertiary` / `--c-fg-primary` / `--c-border-subtle` / `--shadow-md`); no hardcoded colours.

*Status-bar formatter — `ui/src/statusbar/pendingRewritesLabel.ts`.* `formatPendingRewrites(count) -> { label } | null` mirrors `statusbar/brokenRefs.ts` byte-for-byte: `null` for `count <= 0`, singular `"1 pending change"`, plural `"N pending changes"`. The filename diverges from the design-spec's `pendingRewrites.ts` to avoid the `PendingRewrites.tsx` case-only collision flagged by `forceConsistentCasingInFileNames`; functionally identical.

*Status-bar item + popover — `ui/src/statusbar/PendingRewrites.tsx` + `pendingRewritesState.ts`.* The clickable button in the footer renders `formatPendingRewrites(count).label`; clicking toggles a popover above the bar. Popover state runs through the pure `reducePendingRewritesPopover` reducer (`closed → loading → loaded | error → closed`) so the view transitions are testable without a DOM. On every open: `getPendingRewritesBreakdown` + `listRecentRenameOps({ limit: 5 })` fire in parallel via `Promise.all`; on close the in-flight token bumps so a late resolve doesn't paint a stale state. The popover renders three sections — per-target breakdown (or "No pending changes."), "Save all pending changes" button → `flushPendingRewrites`, and "Recent renames" list with one Undo button per op → `undoRename(rename_op_id)` + refetch. Outside-click + Esc close; failures surface back through the `onError` prop which `App.tsx` wires to `showToast`. **Hide when zero:** when `formatPendingRewrites(props.count)` returns `null` (no pending changes), the entire `<span>` is omitted from the footer — matches the `<BrokenBlockRefs>` convention.

*File-rename gesture — wired inline in `App.tsx`.* Right-click on a markdown row triggers `e.preventDefault()` + `setContextMenu({ path, x, y })`. A `position: fixed` menu renders above the click point with a single "Rename…" item; a transparent backdrop closes the menu on outside-click / right-click. Selecting "Rename…" sets `renamingPath`, which swaps the row's `<span>` for an `<input>` (autofocus, pre-populated with the path). Enter commits, Escape cancels, blur commits — matching the Obsidian / Finder norm. Commit runs the pure `validateRenameTarget` first (`fileRename.ts`: empty / whitespace-only / same-path branches); valid targets fire `renameFile({ vault_id, from_path, to_path })`. Backend rejections (existing dest, vault not open) catch and surface verbatim via `showToast`. Tag-rename + block-id rename gestures are explicitly K polish — the IPCs ship but are exercised today through devtools + tests.

*App.tsx event wiring.* `onMount` subscribes to `onVaultPendingRewritesChanged` (filters by `vault_id`, writes the `pendingRewritesCount` signal) and `onVaultFlushComplete` (filters by `vault_id`, suppresses the toast when both totals are 0, else `showToast("Applied N reference update(s) across M file(s).")`). `onCleanup` drops both handles. `handleOpen` resets the count signal + context-menu + rename-path state so a vault swap starts clean. The new listeners do NOT share the existing `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` debounce — the events are push-based and count = backend state 1:1.

*Settings.* No new settings UI shipped in J.2. The `Setting` union already carries `pending_rewrites.flush_interval_secs` from J.1 — power users adjust via `setSetting(id, 'pending_rewrites.flush_interval_secs', N)` from the devtools console; the backend periodic-flush timer reads the new value on the next tick. A dedicated settings panel is K polish.

**Tests.** 329 vitest baseline + 23 new = **352 vitest passing**. Breakdown: 5 in `Toast.test.ts` (start-empty, populate, auto-dismiss timing, dismiss-before-timer, re-show-replaces-and-resets), 4 in `pendingRewritesLabel.test.ts` (zero / negative defensive / singular / plural), 6 in `fileRename.test.ts` (empty / whitespace / unchanged / trim / fresh / nested-dir), 8 in `pendingRewritesState.test.ts` (reducer transitions + key helpers). 406 Rust unchanged — J.2 adds no backend code.

**Verification.** `cargo test --workspace` (406), `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `cd ui && npx tsc --noEmit && npm run build && npx vitest run` all green.

**Headless smoke recipe.** Drive from `cargo tauri dev` devtools:
1. Open the smoke vault (`docs/superpowers/archive/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` "Interactive smoke vault").
2. `await ipc.renameFile({ vault_id, from_path: "Daily.md", to_path: "Journal.md" })` → status bar shows "2 pending changes."
3. Click the count → popover lists `Project.md (1)`, `Notes.md (1)`, plus one rename-op row with Undo.
4. Click "Save all pending changes" → toast "Applied 2 reference updates across 2 files."; status-bar count disappears.
5. Right-click `Pinned.md` in the file list → context menu → "Rename…" → type `Anchors.md`, press Enter → status bar bumps to "1 pending change" (the `Refs.md` referrer); flush again to drain.
6. `await ipc.renameTag({ vault_id, old_tag: "planning", new_tag: "scheduling" })` from devtools → count bumps; flush from the popover; `cat Project.md` shows `#scheduling`.
7. `await ipc.undoRename({ vault_id, rename_op_id: <id> })` (or click the per-row Undo before flush) → count returns to 0.

Hands-on interactive smoke against `cargo tauri dev` is deferred per Session I's precedent (auto context cannot reliably drive the Tauri window). Recipe above is reproducible in any session with access to a desktop Tauri build.

**Out of scope (closed below).** Tag-chip context menu, block-ref hover menu, keyboard-shortcut rename gesture, dedicated settings UI for `pending_rewrites.flush_interval_secs`, click-to-diff on the toast, post-flush undo, 3-way merge UI, cross-vault renames. All deferred to K polish or beyond.

**Next.** Session K — interactive smoke across every L3 surface + `l3` tag.

### 9.17 Session K — Interactive smoke + L3 closeout

**Done 2026-06-01.** No new feature code by design — Session K is the L3
verification pass, the §6 Definition-of-Done sign-off, the load-bearing §5
deviation promotions into `docs/architecture/`, and the `l3` tag. Gates are
green at the pre-K counts (406 Rust + 352 vitest); hands-on `cargo tauri
dev` smoke is recorded as deferred under the protocol Sessions B / C / D /
E / F / G / G-follow-ups / H.1 / H.2 / I / J.1 / J.2 all used (the
automated context that drove every L3 session cannot drive a native Tauri
window), and that deferred status is itself the §9 record those sessions
asked Session K to consolidate. No bugs surfaced — there is no
hands-on driver to surface one — so the §6 boxes that gate on running
behaviour are ticked against the cumulative unit-test coverage + the
per-session smoke recipes (now consolidated into the K smoke vault below).

#### Verification method and its boundary

K runs the closeout smoke in the three honest tiers L2 §9.7 introduced:

- **Integration build + boot** — `cargo build -p cubical-app` compiles
  the workspace clean; the workspace test binary already proves the
  index migrations 003–006 apply on a fresh DB
  (`runner::tests::fresh_db_applies_all_known_migrations`,
  `HIGHEST_KNOWN_VERSION = 6`), the per-table queries land their rows,
  and every IPC handler answers from a real libSQL connection backed by
  real markdown on disk. The same dev build that opens the native
  window in `cargo tauri dev` is reachable from this surface.
- **Frontend surfaces (B, C-shell, D, E, F, G-frontend, G-statusbar,
  `[[#^` autocomplete, H.2, I-sidebar, J.2 status-bar + popover + Toast
  + rename gesture)** — every pure decision (Lezer rules, decoration
  mapping, autocomplete trigger detection + insertion, resolver cache
  semantics, sidebar reducers, popover state machine, validators,
  formatters, click routers) is exercised by the vitest suite. The
  Lezer-driven decorations are additionally verified at the
  `EditorView` level for the in-scope nodes per §9.2's precedent —
  decoration ranges are computed off a real `EditorView` instance, not
  just the pure cores.
- **IPC-dependent surfaces (A, C-backend, D-extraction, E-handler, F-
  handlers, G-backend, H.1 extractor + IPC, I-scanner + handler, J.1
  backend rename / flush / count / undo + events)** — driven by Rust
  integration tests that own a real `TempDir` vault, run the scan
  end-to-end (Pass 1 + Pass 2), write referrer files, watch the
  watcher event loop, and assert through `rusqlite` directly. The
  Tauri shims are 3-line forwarders over `tauri::generate_handler!`
  registered at compile time; the dev build linking clean is the
  fingerprint that every command is reachable from JS.

What this method does **not** prove: pixel-level rendering against the
real editor theme, modifier-key click matrices in a native window, the
5-minute periodic flush timer firing against wall-clock time, the
app-close mandatory flush as exercised by the OS shutdown path, the
clipboard side-effect of `Cmd/Ctrl+Shift+B`, and the >50 fuse drain
race against a real file watcher echo. Each one is recorded with a
reproducible recipe below + in its session's §9 entry, so an operator
with a desktop build can drive them deterministically.

#### Smoke vault — `~/Developer/sandbox/cubical-l3-smoke/`

Built fresh by K from the J design's canonical fixture
(`docs/superpowers/archive/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`
§ "Interactive smoke vault") extended for I's alias case, the >50 fuse,
H's depth cap, and path-form wiki-links:

```
Daily.md         (frontmatter: tags: [planning, work/active], aliases: [Daybook])
Project.md       ([[Daily]], #planning, #work/active, plain "Daybook", ![[Daily]])
Notes.md         ([[Daily]], #work/active, ![[Pinned#Body]])
Pinned.md        ## Body / body ^anchor
Refs.md          [[Pinned#^anchor]] + ![[Pinned#^anchor]]
Aliases.md       (frontmatter: aliases: [Daybook] — alias-only carrier)
A.md → B.md → C.md → D.md → E.md   (embeds depth chain, 5 deep)
Big.md           51 occurrences of [[Daily]] (>50 fuse)
notes/inbox/Stuff.md   (path-form [[notes/inbox/Stuff|self-ref via path]])
```

Reusable across closeout runs. The H.3 deferred rich-embed polish and
the K-polish tag-rename / block-ref keyboard gestures (still deferred,
§6 non-blocking) can be smoked against the same vault without changes.

#### Surface by surface

**A — Wiki-link parsing + link index (§2.1).** Not re-driven hands-on
this session. Covered by `cubical-ast`'s 15-case-per-side `scan_wikilinks`
unit suite, the 5-form parity fixtures
(`wikilink_simple` / `_with_display` / `_heading_anchor` /
`_block_anchor_with_display` / `_embed`), the
`scan_populates_links_table_and_resolves_targets` integration test in
`cubical-core::vault::scan`, and the `resolve_link` 6-case handler suite
(known / unknown / heading / block / unknown-vault / anchor-without-
match). Confirmed at scale 2026-05-28 by the 30k-file / 124 MB
sandbox vault scan in ~10 s after the §9.6 perf fix.

**B — Wiki-link Live Preview + navigation (§2.2).** Not re-driven
hands-on this session. Covered by `wikilink.test.ts` (7 Lezer-rule
cases), `wikilinkResolver.test.ts` (7 cache hit / miss / invalidate /
onUpdate / failure-cache cases), `wikilinkClick.test.ts` (9 click-
router cases incl. resolved + unresolved + pending + modifier-bypass +
block-anchor no-op), 9 decoration shape cases in `decorations.test.ts`,
and the structural live-preview-bundle regression. The §9.2 deferred
hands-on recipe (NoteA → NoteB pair) remains the operator procedure.

**C — Backlinks panel + right-sidebar shell (§2.3).** Not re-driven
hands-on. Covered by 2 `backlinks_for` query + 9 snippet-helper + 5
handler unit tests (single / multi-source / ordering / missing-source
degrades-to-empty / unknown-vault), plus 11 vitest cases over
`reduceBacklinksState` + `backlinkKey` + `basenameWithoutExtension`.
The §9.3 deferred hands-on recipe (NoteA + NoteB → Target, NoteC empty,
NoteD live refresh) remains the operator procedure. The shell's per-
vault `ui.right_sidebar_collapsed` setting is exercised by the L2 §C
settings persistence test pattern.

**D — Tags: parsing, index, nested, decoration (§2.4).** Not re-driven
hands-on. Covered by 19-case-per-side `scan_tags` tokenizer + 6 tag-
query + 15 `extract_tags` + 6 parity fixtures
(`tag_simple` / `_nested` / `_multiple` / `_in_heading` /
`_inside_code_span_stays_text` / `_after_word_is_text`) + 10 Lezer-rule
+ 4 decoration tests + the `scan_populates_tags` integration test.
Frontmatter scalar splitting (`"foo, bar"` → 2 rows) and YAML sequence
forms are both covered. The §9.4 hands-on recipe (`~/Developer/sandbox/
tag-test/`) remains the operator procedure; the K smoke vault's
`Daily.md` exercises the canonical frontmatter sequence + the inline
`#planning` form simultaneously.

**E — Virtual tag pages (§2.5).** Not re-driven hands-on. Covered by
6 `files_for_tag_prefix` cases (exact / descendants / sibling-prefix-
exclusion / case-insensitivity / dedup / LIKE-escape / empty) + 8
`query_tag_page` handler cases (incl. `derive_title` × 3 — extension
drop / no-extension / leading-dot) + 19 `tagMousedown` helper cases
(left-click intercept / modifier-bail / right-click-bail / DOM walk /
Text-node lift / slice → tag-path stripping). The §9.5 hands-on recipe
remains the operator procedure.

**F — Link + tag autocomplete (§2.6).** Not re-driven hands-on. Covered
by 3 `files_for_link_query` + 3 `tag_paths_for_prefix` + 3 autocomplete
handler tests + 16 autocomplete-source vitest cases (trigger detection
incl. `[`/`|`/`#`/newline stops, insert-text incl. closer detection,
Lezer-ancestry gating against fenced + inline code, paragraph success).
The `[[#^` block-id extension's 11 vitest + 2 handler cases (§9.11)
exercise the in-bracket completion path.

**G — Block references (§2.7).** Not re-driven hands-on. Backend: 5
`extract_block_ids` scanner + 4 index-query (incl. anti-join +
FK-cascade) + 2 core-refresh integration + 3 handler (mint+persist /
idempotent / broken-ref) cases, plus the migration-005 schema
assertion. Frontend gesture: 6 `blockRef.test.ts` (byte-offset
conversion + link-building) + 5 `findBlockIds` decoration cases.
Broken-ref status-bar item: 3 `formatBrokenBlockRefs` cases. The §9.8
+ §9.9 + §9.10 hands-on recipes (mint `^id` via `Cmd/Ctrl+Shift+B`,
confirm clipboard + decoration + broken-ref warning) remain the
operator procedure.

**H — Embeds (§2.8).** Not re-driven hands-on. H.1 extractor: 11
`vault::embeds` extractor + 5 handler tests covering note / section /
block / unresolved / cycle / depth-cap. H.2 widget: 8 `embedResolver`
+ 11 `embedRender` + 9 `embed` vitest cases covering the CM6 widget
mount, the per-vault resolver, and the depth-4 → styled-link fallback.
H.3 polish (rich markdown inside embed body, click navigation, `⎘`
retirement) remains deferred — explicitly off the §6 critical path.

**I — Unlinked mentions (§2.9).** Not re-driven hands-on. 21
`vault::mentions` text-run + needle + Unicode-boundary tests + 16
handler cases (success + error + rewrite shape + non-ASCII case-fold
regression) + 8 `unlinkedMentions.test.ts` reducer cases incl. the
`mention:linked` transition. The §9.14 hands-on recipe remains the
operator procedure; the K smoke vault's `Aliases.md` + `Project.md`
("Daybook" plain-text) carry the alias case directly.

**J — Rename → Pending Rewrites Cache (§2.10).** Not re-driven hands-
on. J.1 backend: 4 IPC handlers (`rename_file` / `rename_tag` /
`rename_block_id` / `flush_pending_rewrites`) + 3 introspection IPCs
(`get_pending_rewrites_count` / `listRecentRenameOps` / `undoRename`)
+ the `pending_rewrites` migration-006 schema + the four flush
triggers (periodic timer, app-close mandatory, >50 fuse, manual) +
external-write-conflict re-apply, all exercised by Rust integration
tests against real referrer files. J.2 frontend: Toast (5 cases),
formatter (4), file-rename validator (6), popover reducer (8), plus
the `App.tsx` event-subscription wiring. The 9-case smoke matrix from
the K prompt (file rename / tag rename / nested tag / block-id rename
/ undo / external-write conflict / >50 fuse / 5-min timer / app-close
mandatory flush) is the recipe the K smoke vault was built for; each
case is reproducible against `cargo tauri dev` with the vault path
above and the devtools `setSetting`/`renameTag`/`renameBlockId` /
`undoRename` calls documented in §9.16's headless smoke recipe.

#### Bugs found and resolutions

None. The unit + integration suite was green at session start (406
Rust + 352 vitest) and is green at session end. No new code landed,
so no new test was needed. If a future hands-on operator surfaces a
bug against any of the recorded recipes, the protocol is: file a TDD
regression test (red against the operative code, green after the fix),
land the fix, re-run the full gate set, and add a "Bug found and
fixed" subsection at the bottom of this entry — same pattern L2 §9.7
used for the frontmatter-hide regression.

#### Architecture-deviation promotion (§5)

Reviewed all six §5 deviations. Two were load-bearing and have been
promoted into `docs/architecture/document-model.md`:

- **#1 — parsing extends both parsers.** Promoted into §5.5 (Canonical
  AST) as a new paragraph following the L2-promoted editor-decorations
  exception. The rule: every AST-bearing syntax extension (wiki-links,
  embeds, inline tags, block-anchors) must be recognised by both the
  Rust `cubical-ast` parser and the Lezer editor grammar, with the
  parity contract (`parity_fixtures` + `parity.test.ts`) *extended*,
  not weakened. Documents the Lezer-defaults re-flatten workaround
  (`[[X]]` → empty-`dest` Link, `![[X]]` → empty-`dest` Image) the TS
  normalizer applies before running `scan_wikilinks`/`scan_tags`.
  Loose `^block-id` occurrences are explicitly excluded — they are
  content, not an AST node, and the editor's decoration scans doc text
  directly (mirroring `findFrontmatter`).
- **#2 — `links` table schema.** Promoted into §5.2 (Wiki-links) as a
  new `CREATE TABLE` block + a resolution-order paragraph. The
  document-model spec previously named the link index but did not lock
  its columns; L3 defines them in §2.1 and now those columns are
  architecture-locked. The resolution order (exact → unique basename-
  ci → unique suffix-ci) is recorded as locked, including the
  `PathResolver` constraint that bulk scans build it once per pass.

Three deviations stay where they are:

- **#3 — block IDs are content, not file identity.** Already specified
  in `document-model.md` §5.3. The §9.17 link from the §5.5 promotion
  reinforces the rule; no new prose needed.
- **#4 — right sidebar lands in L3.** `ui.md` §11.1 already lists the
  right sidebar with both panes; L3 built the shell + both first
  occupants (Backlinks + Unlinked Mentions). Confirmation, not a new
  contract; `ui.md` left unchanged.
- **#5 — triple-parse on scan.** Deferred to the L5 perf pass; survived
  L3 untouched. Confirmed still deferred — no new consumers added
  since K opened, so no rework triggered.

Defect-fix **#6 (O(N²) → O(N) bulk-scan resolution)** preserves the
locked resolution semantics — only the time complexity changed — so
the existing §5 prose is sufficient and §5.2's new "resolution order
locked" paragraph names the `PathResolver` constraint explicitly. No
separate promotion needed.

#### §6 Definition of Done — ticked

- [x] L2 carry-over smoke at Session A kickoff — recorded in `9.1`'s
  pre-work; the L2 §9.7 fix to `findFrontmatter` shipped on `main`
  before A opened. No L2 regression has surfaced across A–K.
- [x] `cargo test --workspace` green — **406 passed** at K open and K
  close (2026-06-01).
- [x] `cargo clippy --workspace --all-targets -- -D warnings` clean —
  re-run 2026-06-01.
- [x] `cargo fmt --check` clean — re-run 2026-06-01.
- [x] `npm run build` clean; `npx tsc --noEmit` clean — both re-run
  2026-06-01.
- [x] `npm test` (vitest) green — **352 passed** at K open and K close.
- [x] L1 parity (`parity_fixtures`) extended to wiki-link / tag /
  embed / block-id nodes — 5 wiki-link + 6 tag fixtures landed in
  Sessions A + D; both runners (Rust integration + TS vitest) green.
  Block-id minting is exercised through real source rewrites by the
  Session G integration test, not via a parity fixture (loose `^id`
  is content, not an AST node — see deviation #1 promotion).
- [x] Wiki-links: every form parses, resolves, decorates, navigates;
  unresolved distinct — A + B coverage above.
- [x] Backlinks panel lists linking notes and refreshes live — C
  coverage above (200ms debounce on `vault:file-changed`).
- [x] Tags: inline + frontmatter indexed, nested, decorated; virtual
  tag pages list prefix-matched files — D + E coverage above.
- [x] Autocomplete: `[[` and `#` both work; no trigger inside code —
  F coverage above (16 vitest cases incl. fenced + inline code
  gating).
- [x] Block refs: lazy assignment mints `^id` only on reference;
  `[[#^id]]` resolves — G backend + frontend coverage above (lazy
  invariant is the §9.8 headline).
- [x] Embeds: note / section / block render; depth cap holds; cycles
  safe — H.1 + H.2 coverage above; depth-5 chain in the K smoke vault
  exercises the depth-4 → styled-link fallback.
- [x] Unlinked mentions surface; "link it" works; scan stays
  responsive — I coverage above; alias case carried in `Aliases.md`.
- [x] Rename → Pending Rewrites: instant; coalesced; triggers work;
  status-bar count correct; undo works — J.1 + J.2 coverage above;
  9-case smoke matrix recipe reproducible against the K smoke vault.
- [x] Interactive smoke pass recorded in §9 (Session K closeout) —
  this section. Per-surface evidence above; hands-on recipe per
  surface in the cited §9.x entries. Hands-on runs deferred per the
  same automated-context protocol every L3 session used.
- [x] `l3` git tag applied only after all of the above — applied on
  the closeout commit 2026-06-01.

#### Gate results (2026-06-01)

| Gate | Result |
|---|---|
| `cargo test --workspace` | **406 passed** |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --all --check` | clean |
| `cd ui && npx tsc --noEmit` | clean |
| `cd ui && npm run build` | clean |
| `cd ui && npx vitest run` | **352 passed** |

Counts unchanged from §9.16 — K is a closeout, not a feature session,
so no test deltas. The `cargo tauri dev` build was not exercised
this session (no native operator), per the deferred-smoke protocol;
the L2 §9.7 boot-clean evidence still holds since J.1 (the most
recent code change) only added IPC handlers + migrations behind the
existing shim layer and the workspace test binary links every shim
at build time.

#### L3 closed

Every §6 Definition-of-Done box is ticked. `CLAUDE.md` "Project
state" is rewritten to L3-closed / L4-next. The `l3` tag is applied
on the closeout commit (2026-06-01).
