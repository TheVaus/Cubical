## L4 Session A — Tantivy full-text search backend (design)

**Date:** 2026-06-02
**Layer:** 4 — Search
**Depends on:** L0 `cubical-search` skeleton crate, L1 canonical AST (`cubical-ast::parse`), L1 frontmatter parser (`cubical_ast::frontmatter`), L3 wikilink + tag scanners (`cubical_ast::{wikilink,tag}`), L0/L3 vault scan + watcher (`cubical-core::vault::{scan,watcher}`). No L4-specific dependencies on libSQL — this session does not touch `cubical-index`.

## Goal

Implement the Tantivy backend that the rest of L4 (panel UI, Omni-Bar, Dataview queries) builds on. End state: a per-vault Tantivy index lives at `<vault>/.cubical/search/`, is populated by the existing scan + watcher pipeline alongside the link/tag/block refreshers, and is queryable via four Tauri IPC commands. No frontend UI ships in this session — the index is exercised through dev-console IPC calls during smoke.

Mirrors the L3-A pattern: foundation backend session for the layer, no end-user-visible surface, every consumer that lands later in L4 reads through the API this session establishes.

## Scope split — L4-A only

Session L4-A is the **backend**. The full L4 build-order item (Tantivy + persistent search panel + Cmd/Ctrl+K Omni-Bar + Dataview queries) splits across four sessions:

- **L4-A (this session).** `cubical-search` crate, schema, indexing pipeline, query API, IPC commands. No UI.
- **L4-B.** Persistent left-panel search results UI over L4-A's IPC.
- **L4-C.** Cmd/Ctrl+K Omni-Bar over L4-A's IPC.
- **L4-D.** Dataview-style libSQL queries (separate from Tantivy — typed frontmatter querying).

The seam is clean: L4-A's IPC is the only surface L4-B/C/D touches. L4-A lands behind a TS binding the frontend doesn't yet call; later sessions wire it in.

---

## Background — relevant existing machinery

- **`cubical-search` skeleton.** L0 created the crate with `cubical-ast` as its only dependency; `lib.rs` is a doc-comment placeholder. L4-A is its first feature pass.
- **Per-file parse pattern.** `crates/cubical-core/src/vault/scan.rs` pass 1 reads each `.md` file once, runs L3-J's `materialize_on_read` once, then hands the materialized source to four extractors: `refresh_frontmatter` + `extract_links_from_source` + `refresh_tags` + `refresh_blocks`. Each parses the source independently — the §5.5 / §5.6 finding documented in `docs/layer-3-spec.md` §5.5 (currently 4 parses; L4-A makes it 5). The consolidation refactor is the L5 perf pass.
- **Refresher signature.** All four existing refreshers take `(vault, rel, source: &str)`. L4-A's `refresh_search_index` matches that signature exactly; the search refresher parses the source locally with `cubical_ast::parse` to produce the `Document` it projects into `IndexDoc`. No `&Document` plumbed across the scan loop.
- **Materialize-on-read invariant.** Because the scan loop hands every refresher the **materialized** source (L3-J §5.7), L4-A's index automatically reflects post-rename-pre-flush state — no separate materialization plumbing required, no risk of the search index seeing stale wikilink targets between rename and flush.
- **Watcher fan-out.** `crates/cubical-core/src/vault/watcher.rs::apply_watch_event_to_db` dispatches per-file events to the L3 refreshers; L4-A extends this dispatch to include search.
- **Watcher buffering during scan.** The L0/L1 scan already holds an exclusive index handle; watcher events buffer until scan releases. L4-A reuses this — Tantivy's single-writer constraint is satisfied by the existing serialization.
- **`cubical-ast` public surface.** `Document` (`parse`), `frontmatter::parse_frontmatter`, `wikilink::scan_wikilinks`, `tag::scan_tags` — all `pub`. L4-A consumes them; it does not extend them.
- **Vault open/close.** `cubical-app::commands::vault::{open_vault, close_vault}` manage per-vault handles. The `SearchIndex` handle is opened inside `open_vault` after libSQL and dropped before `close_vault` returns. Initial scan triggers a full reindex if `<vault>/.cubical/search/` is missing or schema-mismatched.
- **`IpcError` envelope.** `crates/cubical-app/src/error.rs` already wraps backend errors for the frontend. L4-A's commands return `Result<T, IpcError>` the same way.

---

## Crate boundary & dependency graph

`cubical-search` becomes the Tantivy wrapper:

- **New dep:** `tantivy = "0.22"` (or current workspace pin — confirmed during implementation).
- **Existing dep:** `cubical-ast` (already present).
- **No new edges into `cubical-search`.** `cubical-core` and `cubical-app` may depend on it; nothing in `cubical-search` depends on them. Matches the `cubical-index` isolation rule.
- **`IndexDoc` projector lives in `cubical-search`.** `cubical-core::refresh_search_index` hands `(path, &Document, &SearchIndex)` over; `cubical-search` owns the schema mapping. Same separation L3 uses for parsing (in `cubical-ast`) vs. index shape (in `cubical-index`).

The full crate dependency graph after L4-A is unchanged in shape — only the `cubical-search` node gains real content.

---

## Tantivy schema

One Tantivy document per `.md` file. Fields:

| Field | Type | Indexed | Stored | Notes |
|---|---|---|---|---|
| `path` | `STRING` | yes | yes | vault-relative; primary key for upsert/delete via `Term::from_field_text` |
| `title` | `TEXT(en_stem)` | yes | yes | frontmatter `title` if present, else filename stem |
| `headings` | `TEXT(en_stem)` | yes | no | all heading text (ATX + setext) concatenated with `\n` |
| `body` | `TEXT(en_stem)` | yes | no | prose: paragraphs, list items, blockquotes, table cells, image alt text, wiki-link **display text**. Excludes fenced + inline code, frontmatter, raw `#tag` tokens, raw `^block-id` markers, raw `[[…]]` syntax. |
| `code` | `TEXT(code_tokenizer)` | yes | no | fenced + inline code, separate field so `code:fn` works and prose queries don't drown in symbols |
| `tags` | `STRING` (multi-valued) | yes | yes | lowercase tag strings (`project/cubical`) — stored so the future panel can render "matched tag" chips |
| `frontmatter` | `TEXT(en_stem)` | yes | no | flattened `key value` pairs of frontmatter scalars; lists flatten to repeated `key value` entries; nested keys dot-join (`author.name jane`); booleans/numbers/dates stringified. **Excludes the `title` and `tags` keys** — already covered by dedicated fields; including them here would double-count for ranking. |
| `mtime_secs` | `i64` | yes (fast) | yes | for date filters + sort-by-recency |
| `size_bytes` | `u64` | yes (fast) | yes | debug + future filters |

**Tokenizers.**

- `en_stem`: Tantivy's `SimpleTokenizer` + `LowerCaser` + `Stemmer::new(Language::English)`. No stop-word filter (Tantivy's default English stop list drops "the", which the user might genuinely want to phrase-match).
- `code_tokenizer`: `SimpleTokenizer` + `LowerCaser`. **No** stemmer (symbol-heavy tokens shouldn't be lemmatized). Registered as `"code"` in the index's `TokenizerManager`.
- `STRING` fields are not run through a tokenizer; they're case-sensitive. **`tags` values are lowercased at index time** so `tag:Project/Cubical` (parser normalizes to lowercase) matches `project/cubical` on disk.

**Body extraction — what counts as prose.** The `body` field is built by walking the canonical `Document` AST:

- **Included:** paragraph text, list item text, blockquote text, table cell text, standard-markdown image alt text (`![alt](url)`), the *display text* of wiki-links (the alias if present, else the target's last path component — for block-ref links `[[Note#^abc]]`, the last path component of `Note`, **not** the resolved block content).
- **Excluded:** fenced code blocks (→ `code`), inline code spans (→ `code`), wiki-image embeds (`![[image.png]]` — filename is not prose; no contribution to `body`), raw `[[…]]` syntax (display text already covers it), raw `#tag` tokens (→ `tags`), raw `^block-id` markers (metadata, not prose), frontmatter (→ `frontmatter` / `title` / `tags`), HTML comments / `<!-- … -->` blocks, transcluded/embedded content from other files (search hits in an embedded file surface as hits in that file, not the host — keeps ranking honest).

This honors the architecture promise that search indexes the **canonical AST, not the raw markdown**.

---

## Indexing pipeline

### Hook into scan

`crates/cubical-core/src/vault/scan.rs` adds a fifth refresher to its per-file loop, after the existing four:

```rust
refresh_search_index(&vault, &rel, &source, &search_index)?;
```

Signature exactly matches the L3 refreshers (`vault`, `rel`, `source: &str`) — the function parses the source locally via `cubical_ast::parse` before projecting into `IndexDoc`. `source` is the **materialized** source (L3-J §5.7 invariant), produced once per file by the scan loop and reused across all five refreshers. Errors propagate to the scan's per-file error envelope — a single file's failure does not abort the scan; the file is logged and skipped, identical to the existing refreshers' contract.

**Memory bound during initial scan.** A single end-of-scan `IndexWriter::commit()` buffers all docs in memory until commit; on a 30k-file vault this exceeds practical RAM budgets. L4-A commits **every 5,000 docs** during scan, plus a final commit at scan completion. Commit cadence is not user-visible; it's purely a memory-control device.

### Hook into watcher

`crates/cubical-core/src/vault/watcher.rs::apply_watch_event_to_db` fans out to the existing refreshers; L4-A extends the fan-out to include `refresh_search_index`. The watcher's existing per-file debounce window owns the timing.

**File-deletion event.** Watcher delete events call `SearchIndex::delete_path(&path)` which is `IndexWriter::delete_term(Term::from_field_text(path_field, &path))` + the next debounced commit.

**Rename event.** L3-J's pending-rewrites layer pairs `(old_path, new_path)` rename events. L4-A handles a rename as delete-old + add-new in one debounced commit window.

### Commit cadence — watcher

- **Idle debounce:** commit 2 seconds after the last write event.
- **Hard ceiling:** commit at least every 30 seconds during a sustained write stream.
- **Vault close:** synchronous final commit before the index handle is dropped (same gate L3-J's pending-rewrites flush uses on close).

Both intervals are stored in the L0 `config` table (`key TEXT PRIMARY KEY, value TEXT`) under `search.commit_idle_secs` / `search.commit_max_secs` — hidden settings, no UI in L4-A, same pattern as L3-J's `pending_rewrites.flush_interval_secs`. Defaults applied when the keys are absent.

### Index location & schema version

- **Path:** `<vault>/.cubical/search/`. Sibling of `<vault>/.cubical/index.db`. `.cubical/` is already vault-gitignored per `docs/vault-gitignore.md`.
- **Schema version stamp:** `<vault>/.cubical/search/schema.json` with `{"version": 1}` — integer, monotonically bumped on any schema change in L4 / L5. Read on `SearchIndex::open`; mismatch (or missing, or unparseable) → `std::fs::remove_dir_all` the entire `search/` dir, recreate, force full reindex via the next scan.
- **No migration framework** for the Tantivy index. It's derived state — wipe-and-rebuild is the only "migration." (libSQL keeps its migration runner; Tantivy does not.)

### Concurrency & writer ownership

- **One `IndexWriter` per vault**, owned by `SearchIndex`. Tantivy enforces single-writer per index — the existing scan/watcher serialization already satisfies this.
- **One `IndexReader` with `ReloadPolicy::Manual`.** Reload called after every commit. `IndexReader` is `Clone` and cheap; each query creates a fresh `Searcher` from the reader.
- **Watcher events during scan** buffer via the existing L0/L1 mechanism; the writer is not contended.

---

## Query API

Public Rust surface in `cubical-search`:

```rust
pub struct SearchQuery {
    pub text: String,
    pub limit: usize,           // default 50; > 500 returns IpcError::InvalidArgument
    pub offset: usize,
    pub fields: FieldScope,
    pub fuzzy: bool,
    pub sort: SortMode,
}

pub enum FieldScope {
    Default,                    // title^3 + headings^2 + body + tags^2 + frontmatter
    HeadingsOnly,
    BodyOnly,
    CodeOnly,
    Tags(Vec<String>),          // exact-match filter on `tags` STRING field
}

pub enum SortMode { Relevance, RecencyDesc }

pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub score: f32,
    pub mtime_secs: i64,
    pub matched_fields: Vec<MatchedField>,
    pub tags: Vec<String>,
}

pub struct MatchedField {
    pub field: String,          // "title" | "headings" | "body" | "code" | "tags" | "frontmatter"
    pub snippet: String,        // 150 chars, <mark>…</mark> bounded
}
```

### Query syntax — L4-A scope

Plain text + Tantivy `QueryParser` features:

- **Field prefix:** `headings:foo`, `tag:project/cubical`, `code:fn`, `body:foo`, `frontmatter:author`.
- **Phrase:** `"exact phrase"` over any text field.
- **Negation:** `-term` excludes documents containing `term`.
- **Field boosts:** parser config above (title 3×, headings 2×, tags 2×).

**Tag-prefix queries** are lowercased before reaching `QueryParser` so `tag:Project/Cubical` matches the on-disk `project/cubical`. Free-text queries containing tag prefixes (e.g. `#project`) are stripped to `project` before parsing — `#` is a `QueryParser` metacharacter and would error.

**Empty query string** → empty `Vec<SearchHit>`, **not** a list-all of the vault. A "list all files" command, if needed, is its own future IPC; mixing it with `search` invites accidental full-vault scans.

### Fuzzy

Off by default. When `fuzzy: true`:

- Single-term queries route through `FuzzyTermQuery` at edit-distance 1 for terms **≥ 4 chars**.
- Terms < 4 chars stay exact (`a`, `at`, `the` with edit-distance 1 matches half the vocabulary).
- Multi-term fuzzy is **out of scope** for L4-A — `FuzzyTermQuery` does not compose with the default `QueryParser` parsing path. Layering fuzzy across `BooleanQuery` children is deferred to L4-D Omni-Bar polish.

### Snippets

Tantivy's `SnippetGenerator` per matched field, 150-char window, `<mark>…</mark>` boundaries. Backend returns the snippet string; the frontend renders the marks. `MatchedField` is populated for the top-ranked field per hit (the field that contributed the highest term score) plus any **`code`** match (since code matches read very differently from prose and we want both visible when both fire).

**Known L4-A limitation — snippet field coverage.** Tantivy's `SnippetGenerator::snippet_from_doc` requires the field to be `STORED` to retrieve its text. The L4-A schema stores only `title` and `tags`; `body`, `headings`, `code`, and `frontmatter` are indexed but not stored. As a result, L4-A's `MatchedField` entries are restricted to `title` matches in practice. L4-B (persistent left-panel UI) will resolve this by either (a) promoting `body`/`headings`/`code` to `STORED` — costs ~2-3× disk but immediate snippets — or (b) re-reading the source from disk on demand and regenerating snippets per visible hit — costs an I/O per shown result but keeps the index slim. The choice is deferred to L4-B's UX requirements: if highlighted snippets are essential to the panel's first-paint scan, option (a) wins; if hover-to-expand is acceptable, (b) wins.

### Ranking

BM25 default with the field boosts above. No custom scorer. Sort:

- `Relevance` — descending BM25 score.
- `RecencyDesc` — descending `mtime_secs`, scoring still computed (used for tie-break on equal mtime).

### Perf budget — logged, not gated

- **p50 < 15 ms, p99 < 80 ms** on a 30k-file vault (the §5.6 cancel-test vault: `~/Developer/sandbox/cubical-cancel-test`) with a warm reader.
- 200 representative queries: 100 single-term, 50 two-term, 30 field-scoped, 20 phrase.
- Recorded in the L4-A spec §9 entry at session close. Not a hard gate — Tantivy is well within these on this size in practice — but a regression alarm for the L5 perf pass.

Initial-scan throughput is recorded as a baseline at the same time. No target; the L5 pass owns the optimization.

---

## IPC surface

Four Tauri commands, `crates/cubical-app/src/commands/search.rs` (new module). Frontend wrappers in `ui/src/ipc/search.ts`:

| Command | Args | Returns | Purpose |
|---|---|---|---|
| `search` | `SearchQuery` | `SearchResponse` | Primary query. |
| `search_index_status` | — | `IndexStatus` | Polled by future UI for "still indexing…" + diagnostics. |
| `search_rebuild_index` | — | `()` | **Returns immediately.** Wipes `<vault>/.cubical/search/`, transitions `IndexState` → `Building`, kicks off a full reindex via the existing scan path. Caller polls `search_index_status` for completion. Power-user escape hatch; not surfaced in L4-A UI. |
| `search_get_health` | — | `IndexHealth` | Debug. Schema version, segment count, doc count, on-disk bytes. |

```rust
pub struct SearchResponse {
    pub hits: Vec<SearchHit>,
    pub total_estimated: u64,
    pub took_ms: u64,
    pub still_indexing: bool,   // true if state == Building at query time
}

pub enum IndexState { Building, Ready, Error }

pub struct IndexStatus {
    pub state: IndexState,
    pub indexed_files: u64,
    pub total_files: u64,        // 0 until scan enumerates
    pub last_commit_secs: Option<i64>,
}

pub struct IndexHealth {
    pub schema_version: String,
    pub segments: u64,
    pub doc_count: u64,
    pub disk_bytes: u64,
}
```

**During `Building`:** `search` returns whatever the current reader sees (partial results) with `still_indexing: true`. No error. The frontend decides whether to show a banner; L4-B will, L4-A doesn't.

**Cancellation.** Not implemented in L4-A. Frontends are expected to debounce typing (≥ 150 ms). Backend per-query latency is small enough that cancellation infrastructure is not earned at this scale; reconsider if the L5 perf pass changes that arithmetic.

**Error envelope.** All four commands wrap their results in `Result<T, IpcError>`. No new error variants; existing categories cover schema-version-mismatch (transparent wipe + rebuild — no error surfaced) and writer-poisoned (returned as `IpcError::Internal`).

---

## L4-A non-goals (deferred or out of scope)

- **Persistent search panel UI.** L4-B.
- **Cmd/Ctrl+K Omni-Bar.** L4-C.
- **Dataview-style libSQL queries.** L4-D.
- **Regex search.** Not in L4. Possible L4-D power feature; not committed.
- **NEAR / proximity operators.** Not in L4.
- **Date-range query syntax** (e.g. `mtime:>2026-01-01`). L4-D if demanded.
- **Multi-term fuzzy.** Out of L4-A. L4-D may layer it.
- **Cross-vault search.** Permanently out — `docs/architecture/ui.md` §47.
- **Search across embedded/transcluded content** beyond what's in the host file's AST. Embeds are followed by L3-H's rendering layer, not at index time. Search hits in an embedded file surface as hits in the embedded file, not the host — keeps ranking honest.
- **Search index inside `.md` files.** Index is derived state; lives only in `<vault>/.cubical/search/`. No UUID injection (non-negotiable per CLAUDE.md).
- **Mobile.** Deferred to L10+ per build-order.

---

## Migration touchpoints

None. L4-A is purely additive:

- No `cubical-index` migration (search lives in Tantivy, not libSQL).
- No `.md` writes.
- No removed or renamed IPC commands.
- No changes to L3's link/tag/block APIs.

L3 closeout test counts (406 Rust + 352 vitest) and gate green status are preserved as the L4-A starting baseline.

---

## Definition of Done

### Tests

1. **`cubical-search` unit tests** (Rust). Schema round-trip, single-doc upsert, delete-by-path, fuzzy threshold (≥ 4 chars), each `FieldScope` variant, snippet generation, empty-query behavior, schema-version-mismatch → wipe.
2. **`cubical-core` integration tests** (Rust, tempdir vault). `refresh_search_index` from a real scan loop, watcher fan-out for create/modify/delete/rename, 5000-doc commit boundary (synthetic), L3 carry-over (link / tag / block / pending-rewrites refreshers still run correctly alongside search).
3. **`cubical-app` IPC tests** (Rust). All four commands round-trip a real `SearchIndex` over a 10-file fixture. `still_indexing: true` asserted in a forced Building state. `search_rebuild_index` verified to wipe + repopulate.
4. **`ui/src/ipc/search.ts` vitest** (TS). Type + shape smoke; no DOM. L4-A has no UI to test.

### Gates green at L4-A close

- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `cargo fmt --all --check`
- `npx tsc --noEmit`
- `npm run build`
- `npx vitest run`

### Smoke

- **L3 carry-over smoke at L4-A kickoff:** open the L3 closeout smoke vault (`~/Developer/sandbox/cubical-l3-smoke/`); confirm wiki-link navigation, backlinks panel, tag pages, embeds, unlinked mentions, pending-rewrites status bar all behave as recorded at L3 K-close. No regressions before adding L4-A code.
- **L4-A new smoke vault:** `~/Developer/sandbox/cubical-l4a-smoke/`. Builds on the L3 smoke vault contents and adds: a heavy-code-block file (Rust + Python + JSON fences) for `code:` testing; a frontmatter-rich file (nested keys, list values) for `frontmatter:` testing; an `aliases` frontmatter on a multi-word note to verify wiki-link display-text indexing.
- **Interactive smoke recipes** for each IPC command issued through the dev-console (`window.__TAURI__.invoke('search', …)` etc.) recorded in the L4-A `§9.1` entry of `docs/layer-4-spec.md`. Same pattern L3 Sessions B–J used for surfaces that can't be driven by automated harness on the native Tauri window.

### Perf record (logged, not gated)

- p50 / p99 query latency over the 200-query benchmark on the 30k-file cancel-test vault.
- Initial-scan throughput (files/sec) on the same vault.
- Both recorded in `§9.1` for the L5 perf pass to read.

---

## Resolved during writing-plans

- **Tantivy version pin.** Latest 0.22.x at plan time, pinned in workspace `Cargo.toml`. Confirmed against MSRV during the implementation plan's setup step.
- **`IndexWriter` heap size.** Tantivy default (50 MB). Revisit in L5 perf pass if scan throughput on the 30k-vault is unacceptable.

## Decided in this spec (not deferred)

- **Body walker lives in `cubical-search`, private.** Not promoted to `cubical_ast::prose`. YAGNI — L4-D's libSQL query layer queries typed frontmatter, not free-text projection. If a future consumer needs the same projection, promote then. Keeping the walker private keeps `cubical-ast`'s surface minimal.
- **`code` tokenizer word boundaries.** `SimpleTokenizer` default — splits on every non-alphanumeric. `snake_case` indexes as `["snake", "case"]`; `kebab-case` as `["kebab", "case"]`; `foo.bar()` as `["foo", "bar"]`. `QueryParser` applies the same tokenizer to the query side, so both halves agree. Cost: a search for the literal `snake_case` matches files containing `snake` near `case` (no proximity constraint at L4-A), not just files with the exact symbol. Acceptable for free-text code search; symbol-precision search is an L4-D Omni-Bar concern if requested.
