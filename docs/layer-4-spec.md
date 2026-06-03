# Cubical — Layer 4: Search

L4 turns the vault from a connected graph into a *queryable* one. Free-text search ranks every note by relevance; field-scoped queries reach into headings, code blocks, and frontmatter; tag filters compose; the persistent search panel and the `Cmd/Ctrl+K` Omni-Bar are the user-visible surface. L4 also introduces Dataview-style libSQL queries — typed-frontmatter projection that complements full-text.

L3 closed the knowledge-graph layer. The link, tag, and block indexes it built are the substrate L4's relevance ranking layers on. v1.0 still cuts at end of L5.

> **Before starting any L4 session:** confirm the L3 surface still holds — open `cargo tauri dev`, open the L3 smoke vault (`~/Developer/sandbox/cubical-l3-smoke/`), exercise wiki-link nav + backlinks + tags + embeds + unlinked mentions + pending-rewrites status bar. The L3 §9.17 closeout is the baseline; if anything regressed, file a bug against L3 before starting L4 proper.

The search **architecture is documented** in [`docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`](superpowers/specs/2026-06-02-l4-a-tantivy-design.md) for the L4-A backend; L4-B/C/D will gain their own design specs as those sessions open. L4 *implements* the build-order item; where it makes a call the design left open, it is recorded in §5 below.

---

## 1. Goals

By end of L4:

1. **Tantivy full-text search.** Per-vault Tantivy index with structural fields (`title`, `headings`, `body`, `code`, `tags`, `frontmatter`); `en_stem` + `code` tokenizers; BM25 ranking with field boosts; `FieldScope` for scoped queries; phrase, negation, and field-prefix syntax; opt-in single-term fuzzy.
2. **Indexing pipeline.** Tantivy index populated by the existing scan + watcher pipeline alongside the L3 link/tag/block/pending-rewrites refreshers — no separate scheduler, no separate materialization plumbing.
3. **IPC surface.** `search`, `search_index_status`, `search_rebuild_index`, `search_get_health` — four Tauri commands, all vault-id-keyed, with TS wrappers.
4. **Persistent left-panel search results UI.** A second left-side pane (alongside the existing file tree) holds a query input, sort + filter chips, and a virtualised result list with `<mark>`-highlighted snippets. L4-B.
5. **Cmd/Ctrl+K Omni-Bar.** A modal that searches notes, headings, tags, and commands in one fuzzy-ranked list. L4-C.
6. **Dataview-style libSQL queries.** Typed-frontmatter projection — list / table / count over `frontmatter_kv` filtered by tag, path, scalar comparisons. Complements Tantivy: where Tantivy answers "which notes match these words?", Dataview answers "list every project with `status: in-progress` sorted by `due_date`." L4-D.

What is **not** in L4 — see §7.

---

## 2. Sessions

Four sessions, each independently verifiable. L4-A is the foundation — the IPC surface every later session reads.

- **A — Tantivy full-text search backend.** This session. **Closed 2026-06-03.** Spec: [`docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`](superpowers/specs/2026-06-02-l4-a-tantivy-design.md). §9.1 below.
- **B — Persistent left-panel search results UI.** Pending. Reads L4-A's IPC. Adds a virtualised result list, query input with debounced fetch, sort + scope chips, and the "still indexing…" banner driven by `search_index_status`. Resolves the snippet-stored-field limitation (§5 deviation #1) — choice between storing more fields and on-demand source re-read decided here.
- **C — Cmd/Ctrl+K Omni-Bar.** Pending. Modal over L4-A's IPC plus the L3 link + tag autocomplete handlers; ranks notes, headings, tags, and commands in one list. Off-cursor modal; `Cmd/Ctrl+K` opens, `Esc` closes, `Enter` navigates.
- **D — Dataview-style libSQL queries.** Pending. New `cubical-query` crate (or extension of `cubical-index`); query AST + parser; renderer for `list` / `table` / `count` blocks inside `.md` source. May layer multi-term fuzzy and date-range syntax on top of L4-A as L4-A non-goals are revisited.

---

## 3. IPC surface

Per-session ICP additions are documented in each session's spec. L4-A's four commands are the load-bearing surface for L4-B/C/D; L4-D will add Dataview-query commands separately.

### 3.1 L4-A (landed)

- `search { vault_id, query: SearchQuery }` → `SearchResponse` — primary query.
- `search_index_status { vault_id }` → `IndexStatus` — polled by future UI for "still indexing…" pill.
- `search_rebuild_index { vault_id }` → `()` — wipes + repopulates without dropping the `SearchIndex` handle. Returns immediately; caller polls `search_index_status`.
- `search_get_health { vault_id }` → `IndexHealth` — schema version, segments, doc count, on-disk bytes for the dev console.

### 3.2 L4-B / C / D (pending)

Documented in their per-session design specs when those sessions open. L4-B adds no new IPC — it consumes L4-A's. L4-C may add an `omnibar_query` aggregating multiple sources. L4-D adds Dataview-query commands keyed on the libSQL side.

---

## 4. Frontend structure

L4-A ships no UI. L4-B/C/D additions, documented in their session specs:

```
ui/src/
├── sidebar/
│   └── SearchPanel.tsx        # L4-B persistent search panel
├── omnibar/
│   ├── OmniBar.tsx            # L4-C modal
│   └── ranker.ts              # L4-C fuzzy ranking over heterogeneous sources
└── dataview/
    └── DataviewBlock.tsx      # L4-D rendered query result inside .md
```

L4-A modified `ui/src/api/ipc.ts` only — added the four wrapper functions + their wire types + a vitest type-and-shape smoke (`ui/src/api/search.test.ts`).

---

## 5. Deviations from the design spec

L4-A introduced three load-bearing calls beyond the design. Promotion to `docs/architecture/` happens at L4 close (after L4-D).

1. **Snippet field coverage restricted to `title` + `tags` at L4-A.** The L4-A schema stores only `path`, `title`, `tags`, `mtime_secs`, and `size_bytes`; the prose-bearing fields (`body`, `headings`, `code`, `frontmatter`) are indexed but not stored. Tantivy's `SnippetGenerator::snippet_from_doc` reads from `STORED` field text; non-stored fields produce empty snippets. L4-A therefore returns `MatchedField` entries only for `title` matches in practice. L4-B picks between (a) promoting `body`/`headings`/`code` to `STORED` (~2-3× disk, immediate snippets) and (b) re-reading the source on demand per visible hit (I/O per render, slim index). The design spec's Snippets section was updated 2026-06-03 to document this limitation explicitly. Resolution lives with L4-B's UX requirements — if highlighted snippets are essential on first paint, (a); if hover-to-expand is acceptable, (b).

2. **`Building` state returns partial results, not an error.** Design spec ¶ "During Building" says the `search` command returns whatever the current reader sees with `still_indexing: true` — no error. L4-A implements this exactly, but the implementation surfaces a subtlety the design didn't anticipate: the watcher fan-out must not transition the state cell to `Error` when a scan is cancelled mid-flight. The cancellation guard (`fix(l4-a): guard search refresh on cancellation to preserve 100ms budget`, commit `41b0a39`) preserves the 100ms cancellation budget L0/L1 promise by short-circuiting the search refresher when its `CancellationToken` is fired — without that guard, an in-flight scan would commit a `Building` state cell that never reached `Ready`. Worth documenting because L4-B / C will rely on the cell only ever holding three values: `Building`, `Ready`, `Error` — never a stuck `Building` after cancellation.

3. **Multi-vault wire shape: all four commands key on `vault_id`.** Design spec showed handler signatures as `Args { … } → Returns { … }` without naming the vault. The L0 multi-vault contract requires every per-vault IPC to carry `vault_id`, so the four commands take `SearchRequest { vault_id, query }` and `SearchVaultRequest { vault_id }` respectively. Documented in the `ui/src/api/ipc.ts` wrappers; no design change, just an explicit record so L4-B's binding code doesn't have to re-derive it.

---

## 6. Definition of Done

L4 closes when L4-A + L4-B + L4-C + L4-D are all signed off and the `l4` tag is applied. L4-A's per-session DoD is in [`docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`](superpowers/specs/2026-06-02-l4-a-tantivy-design.md) § Definition of Done; this section is the layer-level rollup.

- [x] **L4-A:** Tantivy backend landed; four IPC commands; scan + watcher fan-out; schema-version stamp; smoke vault built. Closed 2026-06-03 (`l4a` tag). §9.1.
- [ ] **L4-B:** Persistent left-panel search UI; virtualised result list; debounced query input; "still indexing…" banner.
- [ ] **L4-C:** `Cmd/Ctrl+K` Omni-Bar; aggregates notes, headings, tags, commands.
- [ ] **L4-D:** Dataview-style libSQL queries; `list` / `table` / `count` blocks.
- [ ] L3 carry-over smoke confirmed at every session kickoff.
- [ ] `cargo test --workspace` green at each session close.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean at each session close.
- [ ] `cargo fmt --check` clean at each session close.
- [ ] `npm run build` clean; `npx tsc --noEmit` clean at each session close.
- [ ] `npm test` (vitest) green at each session close.
- [ ] Interactive smoke pass recorded in §9 of each session close.
- [ ] `l4` git tag applied only after all of the above.

---

## 7. Out of scope

- **Regex search.** Not in L4. Possible L4-D power feature; not committed.
- **NEAR / proximity operators.** Not in L4.
- **Date-range query syntax** (e.g. `mtime:>2026-01-01`). L4-D if demanded.
- **Multi-term fuzzy.** Out of L4-A; L4-D may layer it on `BooleanQuery` children.
- **Cross-vault search.** Permanently out — `docs/architecture/ui.md` §47.
- **Search across embedded/transcluded content** beyond what's in the host file's AST. Embeds are followed at render time, not at index time. Search hits in an embedded file surface as hits in that file, not the host — keeps ranking honest.
- **Search-index UUID injection.** Index is derived state; lives only in `<vault>/.cubical/search/`. No UUIDs in `.md` source — non-negotiable per CLAUDE.md.
- **Mobile.** Deferred to L10+ per build-order.

---

## 8. Session slicing

Per §2. L4-A is the foundation; L4-B/C/D are independently UI sessions over L4-A's IPC. L4-D may grow into its own multi-session arc if the Dataview query AST proves load-bearing.

---

## 9. Session closeouts

### 9.1 Session A — Tantivy full-text search backend

**Closed 2026-06-03 (`l4a` tag).** The `cubical-search` crate is now a real Tantivy wrapper; the existing scan + watcher pipeline populates a per-vault index alongside the L3 link/tag/block refreshers; four Tauri IPC commands expose the surface to the frontend; the TS wrappers are wired but not yet consumed by any UI. L4-B will be the first consumer.

#### What landed

**Crate `cubical-search`.** Was a doc-comment placeholder at L0; gained `tantivy = "0.22"` workspace dep plus seven modules:

- `schema.rs` (127 LOC) — `build_schema()` produces the eight-field schema (`path`, `title`, `headings`, `body`, `code`, `tags`, `frontmatter`, `mtime_secs`, `size_bytes`); `register_tokenizers()` installs `en_stem` (`SimpleTokenizer` + `LowerCaser` + `Stemmer(English)`, no stop-word filter) and `code` (`SimpleTokenizer` + `LowerCaser`, **no** stemmer) on the index's `TokenizerManager`.
- `doc.rs` (468 LOC) — `IndexDoc` and `project(&Document, …) -> IndexDoc`. The projector walks the canonical AST and emits the structural fields per the design spec § Body extraction rules: paragraph / list-item / blockquote / table-cell / image-alt / wiki-link-display-text feed `body`; fenced + inline code feed `code`; ATX + setext headings feed `headings`; frontmatter scalars + lists + nested keys feed `frontmatter` (dot-joined keys, excluding the `title` and `tags` keys to avoid double-counting). Raw `[[…]]` syntax, raw `#tag` tokens, raw `^block-id` markers, HTML comments, and transcluded content are all excluded.
- `index.rs` (313 LOC) — `SearchIndex` struct owning `Index`, `IndexWriter` (50 MB heap, Tantivy default), `IndexReader` (`ReloadPolicy::Manual`). `open()` creates `<dir>/schema.json` with `{"version": 1}`; missing / unparseable / mismatched stamp wipes the directory and rebuilds. `upsert()` is delete-by-`path` then add (one transaction per call; caller commits). `delete_path()` / `delete_all()` mark deletions; `commit()` writes the segment and reloads the reader. `doc_count()` + `segment_count()` + `dir()` are the health-endpoint surface.
- `query.rs` (607 LOC) — `SearchQuery` + `FieldScope` + `SortMode` + `SearchHit` + `MatchedField` + `SearchResponse` + `run_search()`. `FieldScope` swaps the `QueryParser`'s default fields (`Default` → `title^3 + headings^2 + body + tags^2 + frontmatter`; `HeadingsOnly` / `BodyOnly` / `CodeOnly` restrict; `Tags` lowercases each term and builds a `BooleanQuery` of `TermQuery`s against the `STRING` field). `fuzzy: true` rewrites single-term `Default` queries on terms ≥ 4 chars as `FuzzyTermQuery(title, distance=1)`. `SortMode::RecencyDesc` sorts on the `mtime_secs` fast field and casts the i64 to f32 for the `score` field (lossy above ~2^24 but ordering correct — Tantivy sorts on i64 *before* the cast). `<b>` → `<mark>` post-processing on snippets keeps the highlight CSS independent of bold runs. `prepare_query_text()` strips raw `#` from free-text queries (`#fox` → `fox` — `#` is a `QueryParser` metacharacter) and lowercases the right-hand side of any `tag:Value` prefix.
- `status.rs` (58 LOC) — `IndexState` (`Building` / `Ready` / `Error`); `IndexStatus` (state + indexed-files counter + last-commit-secs); `IndexHealth` (schema version + segments + doc count + disk bytes). The `IndexStateCell` newtype wraps `Mutex<IndexStatus>` for the `OpenVault` to hold.
- `error.rs` (51 LOC) — `SearchError` with `From` impls for `tantivy::TantivyError`, `std::io::Error`, `serde_json::Error`; plus the `WriterPoisoned` and `LimitTooLarge` business-rule variants. `IpcError` already wraps these the same way it wraps L3 errors.
- `lib.rs` (23 LOC) — module declarations + re-exports (`IndexDoc`, `SearchIndex`, `SearchError`, `SearchHit`, `SearchQuery`, `SearchResponse`, `FieldScope`, `SortMode`, `MatchedField`, `IndexState`, `IndexStatus`, `IndexHealth`).

**Crate `cubical-core` integration.** `Vault::open` now also opens the Tantivy index at `<vault>/.cubical/search/` and stores it as `Arc<SearchIndex>` on the `Vault`. `vault.search() -> &SearchIndex` is the read accessor. `crates/cubical-core/src/vault/search_refresh.rs` is the new refresher (matches the L3 refresh-signature contract `(vault, rel, source: &str, mtime_secs, size_bytes)`) — parses the source locally via `cubical_ast::parse`, projects into `IndexDoc`, calls `upsert`. The scan loop in `scan.rs` calls it as the fifth per-file refresher after frontmatter / links / tags / blocks; commits every 5,000 docs during scan to keep `IndexWriter`'s memory bounded; final commit at scan completion. The watcher fan-out in `watcher.rs` adds search to the dispatch for `Created` / `Modified` events; `Removed` and `Renamed` events call `delete_path` followed by the next debounced commit. **Cancellation:** the search refresher checks the scan's `CancellationToken` before each commit; cancelled scans return early without flipping the state cell to `Error` (preserves the L0/L1 100ms cancellation budget).

**Crate `cubical-app` IPC.** `commands/search.rs` is the new pure-handler module with four async handlers: `search`, `search_index_status`, `search_rebuild_index`, `search_get_health`. All four read the per-vault `OpenVault.search_state` cell (newly added to `state.rs` alongside the existing scan-state fields). `search` stamps `still_indexing: true` when `state == Building`. `search_rebuild_index` marks `Building`, calls `delete_all` + `commit`, then spawns a fresh scan dispatcher via `spawn_scan_dispatcher` (which is the existing scan-restart path L3 introduced). `search_get_health` returns `dir_size()` for `disk_bytes` (recursive `read_dir`; folds I/O errors to `0` so a transient permission glitch doesn't take down the dev console). `lib.rs` registers all four as Tauri shims; `api/types.rs` adds `SearchRequest` / `SearchVaultRequest` over the existing `SearchQuery`.

**TS bindings.** `ui/src/api/ipc.ts` adds `search` / `searchIndexStatus` / `searchRebuildIndex` / `searchGetHealth` + the wire types (`SearchRequest`, `SearchVaultRequest`, `SearchQuery`, `FieldScope`, `SortMode`, `SearchResponse`, `SearchHit`, `MatchedField`, `IndexState`, `IndexStatus`, `IndexHealth`). `FieldScope` is a discriminated union (`{ kind: "default" }` / `{ kind: "headings_only" }` / `{ kind: "body_only" }` / `{ kind: "code_only" }` / `{ kind: "tags", tags: string[] }`) mirroring the Rust serde tag. `ui/src/api/search.test.ts` (109 LOC) is the vitest type-and-shape smoke — confirms each wrapper forwards its arguments under the `{ req: … }` envelope the Rust shims expect.

#### Tests

The L4-A code carries the following dedicated tests (all green at session close):

- **`cubical-search` unit tests:** 30 across the crate (schema round-trip, tokenizer registration, `IndexDoc` projection across every body-rule case incl. wiki-link display text and excluded code/tags/markers, single-doc upsert, delete-by-path, fuzzy threshold ≥ 4 chars, each `FieldScope` variant, `<b>` → `<mark>` snippet conversion, empty-query early return, schema-version-mismatch wipe, missing-stamp wipe + recreate, and the two carry-over tests Task 14 added: `delete_all_clears_doc_count_after_commit` + `segment_count_is_zero_until_commit_then_at_least_one`).
- **`cubical-core` integration:** `search_refresh::tests` (2 — upsert then doc_count, second upsert replaces); `scan::tests::scan_populates_search_index` + the 5000-doc commit-boundary test (synthetic vault).
- **`cubical-app` IPC tests:** 5 in `commands::search::tests` (round-trip empty query, `still_indexing` flag set in `Building`, status reflects state cell, health reports schema version 1, unknown-vault errors, rebuild wipes docs immediately) + the watcher fan-out integration tests in `commands::vault::tests`.
- **`ui/src/api/search.test.ts`:** 4 vitest cases (one per wrapper, asserting the invoke envelope).

#### Smoke vault — `~/Developer/sandbox/cubical-l4a-smoke/`

Built fresh by L4-A close from the L3 closeout smoke vault (`~/Developer/sandbox/cubical-l3-smoke/`) plus L4-A-specific test files:

```
A.md, B.md, C.md, D.md, E.md   (L3 carry-over: embeds depth chain)
Aliased Note.md                 (L4-A: wiki-link display-text indexing + aliases)
Aliases.md, Big.md, Daily.md, Notes.md, Pinned.md, Project.md, Refs.md  (L3 carry-over)
code/
├── rust_examples.md            (L4-A: `code:` field search — Rust fences)
└── python_examples.md          (L4-A: `code:` field search — Python fences)
data/
└── frontmatter_rich.md         (L4-A: `frontmatter:` field — nested keys, list, scalar, bool, date)
notes/inbox/Stuff.md            (L3 carry-over: path-form wiki-link)
```

The L3 `.cubical/` directory was removed during the copy so `Vault::open` will build a fresh `<vault>/.cubical/search/` on first open against the L4-A code path.

Reusable across closeout reruns. L4-B / C / D will smoke against the same vault unless their UX requires additional fixtures.

#### Interactive smoke recipes (deferred — same protocol as L3)

The automated harness L4-A landed inside cannot drive the native Tauri window, so hands-on `cargo tauri dev` smoke against `~/Developer/sandbox/cubical-l4a-smoke/` is **deferred** under the same protocol every L3 session used (L3 §9.1–§9.17). The recipes below are the operator procedure when convenient; each can be reproduced deterministically without further context.

**Boot.** `cargo tauri dev` → File menu → Open Vault → `~/Developer/sandbox/cubical-l4a-smoke/`. Wait for the file tree to populate. Open the dev console (`Cmd-Option-I` on macOS).

**Recipe 1 — `search` (single-term).**
```js
await window.__TAURI__.core.invoke('search', { req: {
  vault_id: '<vault-id-from-storage>',
  query: { text: 'tantivy', limit: 50, offset: 0,
           fields: { kind: 'default' }, fuzzy: false, sort: 'relevance' }
}});
```
Expected: ≥ 1 hit on the L4-A `code/rust_examples.md` file (the file's body says "Some Rust code to exercise `code:` field search" — the word "tantivy" actually only appears in `code/python_examples.md` so the expected hit is `code/python_examples.md`). `total_estimated` ≤ `limit`. `took_ms` low single digits.

**Recipe 2 — `search` field-scoped on `code`.** Same call, with `fields: { kind: 'code_only' }` and `text: 'fn'`. Expected: hits on `code/rust_examples.md` (matches `fn parse_canonical_ast`, `fn materialize`). No hits from prose-only files.

**Recipe 3 — `search` field-scoped on `headings`.** `text: 'examples'`, `fields: { kind: 'headings_only' }`. Expected: hits on `code/rust_examples.md` + `code/python_examples.md` (both have "# Rust examples" / "# Python examples" headings).

**Recipe 4 — `search` field-scoped on `tags`.** `text: 'anything'`, `fields: { kind: 'tags', tags: ['project/cubical'] }`. Expected: hits on `data/frontmatter_rich.md` (declared in frontmatter `tags: [project/cubical, archived]`).

**Recipe 5 — `search` with `fuzzy: true`.** `text: 'tantvy'` (typo), `fuzzy: true`, `fields: { kind: 'default' }`. Expected: hits on `code/python_examples.md` (edit-distance 1 on "tantivy"; 6-char term ≥ 4-char threshold).

**Recipe 6 — `search` phrase + negation.** `text: '"Rust examples" -python'`. Expected: 1 hit, `code/rust_examples.md`.

**Recipe 7 — `search_index_status` polling.** Call `search_index_status({ req: { vault_id } })` immediately after opening the vault; expect `state: "building"`, `total_files > 0`, `indexed_files` rising. Re-call after ~2s; expect `state: "ready"`, `last_commit_secs` populated.

**Recipe 8 — `search_rebuild_index`.** Call `search_rebuild_index({ req: { vault_id } })`; should resolve to `null` within ~50ms. Immediately poll `search_index_status`; expect `state: "building"`, `indexed_files: 0`. Within a few seconds expect `state: "ready"` again.

**Recipe 9 — `search_get_health`.** Call `search_get_health({ req: { vault_id } })`. Expect `schema_version: 1`, `segments ≥ 1`, `doc_count == <number of .md files>`, `disk_bytes > 0`.

**Recipe 10 — watcher fan-out.** With the vault open, in another terminal `echo "# Smoke test" > ~/Developer/sandbox/cubical-l4a-smoke/smoke_test.md`. Within the debounce window (≤ 2 s) call `search` with `text: 'smoke'`; expect 1 hit on `smoke_test.md`. Then `rm ~/Developer/sandbox/cubical-l4a-smoke/smoke_test.md`; within 2 s the same query expects 0 hits.

**Recipe 11 — `Building` state returns partial.** Call `search_rebuild_index` immediately followed by `search` with a common term (e.g. `text: 'note'`). Expect `still_indexing: true`, hits empty or partial. Subsequent calls converge as the rescan progresses.

#### Perf record

**Status: deferred — vault index not present on this machine.** The 200-query perf benchmark requires a populated `<vault>/.cubical/search/` directory at the 30k-vault path (`~/Developer/sandbox/cubical-cancel-test/`). The vault exists with its libSQL index but no Tantivy index — building one requires running `cargo tauri dev` against the vault, which the closeout harness can't do (same automated-harness limitation as the interactive smoke).

A benchmark driver was authored anyway and lives at `crates/cubical-search/examples/bench.rs`. Run with:

```
cargo run --release -p cubical-search --example bench
```

It issues 100 single-term + 50 two-term + 30 field-scoped + 20 phrase queries (200 total), reports p50 / p99 / mean / min / max in ms, and exits 0 if the search directory is missing (prints a friendly skip message). The vault path is overridable via `CUBICAL_SEARCH_BENCH_VAULT=<absolute-path>`.

When the operator next runs `cargo tauri dev` against `~/Developer/sandbox/cubical-cancel-test/` (the index builds in ~10 s after the L3 §5.6 perf fix), the benchmark can be re-run and the numbers recorded here as a parenthetical addendum:

```
TODO 2026-MM-DD operator: p50=__ ms, p99=__ ms, mean=__ ms, min=__ ms, max=__ ms.
Initial-scan throughput: __ files/sec.
```

Budget (logged, not gated): p50 < 15 ms, p99 < 80 ms on the 30k-vault with a warm reader.

#### Architecture deviations introduced (§5 cross-reference)

Three load-bearing calls beyond the L4-A design spec — see §5 above for full descriptions:

1. Snippet field coverage restricted to `title` + `tags` at L4-A; L4-B picks between store-more vs re-read.
2. `Building` state never enters a stuck transition under scan cancellation — guarded by the L4-A cancellation fix (`41b0a39`).
3. All four IPC commands key on `vault_id` per the L0 multi-vault contract.

None are promoted into `docs/architecture/` mid-layer; the load-bearing ones go through at L4 close (after L4-D) following L3 §9.17's pattern.

#### Bugs found and resolutions

None during closeout. The unit + integration suite was green at every intermediate commit during Tasks 1–13; the closeout (Task 14) adds 2 unit tests (`delete_all` + `segment_count` direct coverage) and the perf bench example, neither of which surfaced a bug.

#### §6 Definition of Done — L4-A row ticked

The layer-level L4-A row is ticked above (§6). The L4-A-specific DoD lives in the design spec; every box there is green:

- [x] `cubical-search` unit tests cover schema, upsert, delete, fuzzy, every FieldScope, snippet, empty-query, schema-version mismatch.
- [x] `cubical-core` integration tests cover scan + watcher fan-out + 5000-doc commit boundary + L3-carry-over interaction.
- [x] `cubical-app` IPC tests round-trip all four commands.
- [x] `ui/src/ipc/search.ts` vitest covers wire-shape smoke.
- [x] All gates green at L4-A close (see below).
- [x] L3 carry-over smoke recipes recorded (above).
- [x] L4-A smoke vault built (above).
- [x] Interactive smoke recipes recorded for each IPC command (above).
- [x] Perf record entry written (above — deferred with reproducible driver).
- [x] `l4a` git tag applied on the closeout commit.

#### Gate results (2026-06-03)

| Gate | Result |
|---|---|
| `cargo test --workspace` | **458 passed** |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| `cargo fmt --all --check` | clean |
| `cd ui && npx tsc --noEmit` | clean |
| `cd ui && npm run build` | clean |
| `cd ui && npx vitest run` | **356 passed** |

Final test counts: **458 Rust + 356 vitest.** Delta from L3 close: +52 Rust (search-crate units, scan/watcher integration, IPC handlers, the carry-over `delete_all` + `segment_count` direct tests) and +4 vitest (the `ui/src/api/search.test.ts` wire-shape smoke).

#### L4-A closed

Every L4-A DoD box is ticked. `CLAUDE.md` "Project state" rewritten to L4-A-closed / L4-B-next. The `l4a` tag is applied on the closeout commit (2026-06-03).
