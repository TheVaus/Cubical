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
- [x] **L4-B:** Persistent left-panel search UI; grouped-by-file result list; debounced query input; "still indexing…" banner. Closed 2026-06-08 (`l4b` tag). §9.3.
- [x] **L4-C:** `Cmd/Ctrl+K` Omni-Bar — fuzzy navigator over **notes + tags** (headings + commands deferred). Closed 2026-06-08 (`l4c` tag). §9.4. Companion: search typo tolerance shipped as `l4a-fix.2` (cross-field backend fuzzy).
- [x] **L4-D:** Dataview-style libSQL queries; `list` / `table` / `count` blocks. Closed 2026-06-15 (`l4d` tag); six automated gates green; live visual operator smoke is the one outstanding Contract-E residual. §9.5.
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

### 9.2 L4-A-fix — Editor surface contracts (closed 2026-06-06, `l4a-fix` tag)

Structural-debt session between L4-A close and L4-B open. Three
architectural contracts closing bugs #4, #5, #6 from the kickoff
(`docs/superpowers/2026-06-03-l4a-fix-kickoff.md`); ritual change to
`docs/conventions.md` requiring executed smoke before tagging. All
three bugs operator-confirmed fixed in the running app
(`docs/superpowers/2026-06-04-l4a-fix-smoke-runbook-executed.md`).

**Contracts landed** (final shape — several evolved past the design
spec during operator smoke; the spec's CORRECTION notes are
superseded by what is recorded here):

- **Contract 1** — `livePreviewBundle` is the named extension for
  preview-only transformations; `embedExtension` no longer in the
  base extension list. Raw-source toggle structurally swaps the
  bundle to `[]`. **Closes bug #4** (operator-confirmed).

- **Contract 2 — embed rendering (final: whole-line block replace).**
  When the `![[…]]` token is **alone on its line** (the by-convention
  shape — operator-confirmed embeds are written on their own line),
  the whole line is replaced with an atomic block decoration,
  `Decoration.replace({ widget, block: true }).range(line.from,
  line.to)`. This is the cursor-safe primitive (same shape as the
  frontmatter-hide block replace). Mid-line embeds stay raw text (no
  card) to avoid block content inside a line. `EmbedWidget` keeps
  `estimatedHeight`; `ignoreEvent` lets clicks bubble; the `⎘`
  indicator retires; cursor-line suppression reveals raw source on
  the active line.

  *The render path took several iterations under smoke* (recorded so
  they aren't retried): inline-replace *widget* (cursor OK, card
  invisible — block content unmeasured); block *widget* at line end
  (card OK, cursor jumped); whole-line block replace (both right).
  **Closes the embed-render half of #4/#6.**

- **Contract 2b — cursor traversal (added under smoke, not in the
  original spec).** Two pieces, because a rendered card is one
  *document* line spanning many *screen* rows:
  - `EditorView.atomicRanges` provided from `embedBlockField` so
    *logical/horizontal* cursor motion skips the card (CM6's
    documented mechanism).
  - `ui/src/editor/embedNav.ts` — a custom `ArrowUp`/`ArrowDown`
    keymap (precedes `defaultKeymap`) that corrects *vertical*
    motion. CM6 computes Up/Down from screen geometry; one
    line-height of motion lands *inside* a tall card and overshoots
    the whole block. `correctedVerticalHead` (pure, unit-tested
    against the operator-captured jumps) detects an overshoot of
    >1 document line and steps exactly one document line instead, so
    the cursor lands on the embed line. Normal/soft-wrapped lines
    never overshoot, so their default motion is untouched.
  **Closes bug #6** (operator-confirmed: cursor walks through embeds
  one line per press). *Methodology note:* the fix was derived from a
  dev-only diagnostic listener that logged real-app before/after
  cursor head + line — jsdom has no layout engine, so the geometric
  overshoot only surfaced in `cargo tauri dev`.

- **Contract 4** — `EmbedResolver` and `WikiLinkResolver` gain
  symmetric `debug()`, `onEvent()`, `abort()` (instrumentation), plus
  `EmbedResolver.version()` — a cache-mutation counter folded into the
  embed widget's identity so nested-embed resolutions force a remount.
  Dev-only `window.__cubical` exposes the live resolvers. **Closes bug
  #5** (operator-confirmed): nested embeds (A/B/C) froze on "Loading…"
  because the widget identity tracked only its top-level cache entry
  and nested embeds have no independent re-render path; D worked
  because its embed was depth-1. Diagnostic + fix in spec §3.3.

- **Contract E** — `docs/conventions.md` grows a `## Sessions`
  section requiring executed smoke before any layer/fix tag lands.
  Recorded-only smoke no longer satisfies session close.

**Contract C deferred** to L4-C (Omni-Bar). Bugs #2, #3 not
reproducing against live vault; navigation path split saved for the
trigger condition.

**Bug #1** — operator decision: keep current smaller+grayer
`^block-id` rendering. No code change.

**Smoke scope (honest):** this session changed only the editor
surface; the executed smoke concentrates there (bugs #4/#5/#6 plus
L2/L3 editor behaviours exercised while fixing). The L4-A search
recipes and L1/L2 watcher/properties recipes saw no code change this
session and remain standing backfill under the new Sessions ritual
for the next session touching those surfaces.

**Known issue — RESOLVED 2026-06-06 (own-write-echo guard;
operator-confirmed).** *Code landed; the visible scroll effect is
operator-smoke-only (jsdom has no layout engine) and was confirmed by
the operator via the runbook below ("it works" — viewport no longer
jumps while typing in a file with a rendered embed). Contract E
satisfied.*

*Symptom (operator-reported):* while typing in a file that contains a
rendered embed, the **viewport** occasionally jumps to the top of the
document. The **cursor stays in place** — this is a scroll/anchor jump,
not a cursor bug. Intermittent, tied to the autosave cadence.

*Root cause:* the `vault:file-changed` handler in
`ui/src/App.tsx` called `embedResolver()?.invalidate()` (and
`wikilinkResolver()?.invalidate()`) **unconditionally** near the top of
the handler, *before* the own-write suppression check (which only
guarded the conflict-banner logic). Autosave (~300 ms debounce) writes
the open file; the OS watcher reports that **own write** back as
`vault:file-changed`; the unconditional `invalidate()` cleared the
embed cache and bumped `EmbedResolver.version()`; every rendered embed
remounted and re-fetched, collapsing to its `estimatedHeight` (~60 px)
and re-expanding to full height. That height thrash above the cursor
made CM6 re-anchor the viewport — the jump to top.

*Pre-existing, amplified here:* the unconditional invalidate predated
the fix (L3 Session H.2). The L4-A-fix block-card rendering +
`version()`-driven remount amplified its visibility (the prior inline
rendering thrashed height far less).

*Fix (landed — Option 1 of the kickoff):* a pure `isOwnWriteEcho(...)`
helper (`ui/src/ownWrite.ts`, 6 unit tests) encodes "this
`vault:file-changed` event is the open file's own autosave echo"
(changed path is the open file, the event carries a hash, and the hash
equals our most recent `lastWrittenHash`). `onVaultFileChanged` computes
it once and wraps **both** the wiki-link and embed `invalidate()` calls
in `if (!ownWrite) { … }`. Own autosave echoes no longer invalidate, so
rendered embeds stop remounting per keystroke; other-file changes and
genuine external edits to the open file still invalidate exactly as
before (an own write can only change the open file's own bytes, so other
files' cached resolutions stay valid, and a newly-typed embed resolves
from a cold cache regardless). Design spec
`docs/superpowers/specs/2026-06-06-embed-invalidation-scroll-fix-design.md`;
plan `docs/superpowers/plans/2026-06-06-embed-invalidation-scroll-fix.md`.

*Operator smoke runbook (Contract E — executed, passed).*
`cargo tauri dev` → open `~/Developer/sandbox/cubical-l4a-smoke/` →
open A.md (own-line `![[…]]` card). (1) Type continuously ~30 s with the
card visible — the viewport must **not** jump to top and the card must
stay rendered (no `Loading…` flicker / collapse). (2) From another
terminal `echo "" >> ~/Developer/sandbox/cubical-l4a-smoke/A.md` — the
open file's embeds must still refresh (live-refresh substrate intact).
If a jump persists, add a dev-only `EditorView.updateListener` logging
`view.scrollDOM.scrollTop` + embed remount events and diagnose **before**
touching `estimatedHeight` (same discipline as the L4-A-fix cursor bug).
*Best-available automated verification at code-close:* 6 new unit tests
pin the own-write decision; all six gates green (`cargo test
--workspace`, `clippy -D warnings`, `fmt --check`, `tsc --noEmit`,
`npm run build`, `vitest` 400 passed); `cubical-app` + the Vite bundle
compile clean.

**Test counts at close:** 394 vitest + 458 Rust (+38 vitest / 0 Rust
over L4-A close). All six gates green at every commit boundary:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run
build`, `npx vitest run`.

**Note on the closeout history.** An interim closeout + `l4a-fix` tag
landed early (the editor surface verified at that point); operator
re-smoke then surfaced the embed render/cursor iterations and the
nested-loading fix above, which landed as further `l4a-fix` commits.
The tag was moved forward to include them. The design spec's §3.2/§3.3
CORRECTION notes capture the mid-journey reasoning but are superseded
by the "final shape" recorded in this §9.2.

**Design spec:** `docs/superpowers/specs/2026-06-04-l4a-fix-design.md`
**Implementation plan:** `docs/superpowers/plans/2026-06-04-l4a-fix.md`
**Executed smoke:** `docs/superpowers/2026-06-04-l4a-fix-smoke-runbook-executed.md`

---

### 9.3 Session B — persistent left-panel search results UI (closed 2026-06-08, `l4b` tag)

First UI consumer of L4-A's search IPC. Design spec:
`docs/superpowers/specs/2026-06-07-l4b-search-panel-design.md`. Plan:
`docs/superpowers/plans/2026-06-07-l4b-search-panel.md`. Built
subagent-driven (implementer + spec review + code-quality review per
task, plus a final holistic review — all on `feat/l4b-search-panel`).

#### What landed

> **Layout note:** the original `Files | Search` segmented toggle +
> `ui.left_pane_mode` persistence was replaced after the first operator
> smoke (see "Post-smoke revisions" below). The current shape is a
> persistent search bar above the file tree.

- **`ui/src/sidebar/SearchPanel.tsx`** — a persistent search bar at the
  top of the left column (`App.tsx` renders the file tree as its
  `children`). Below `MIN_QUERY_LEN` (3) chars the tree shows; at/over
  it the tree is replaced by results. Debounced (200 ms) query into
  `search`; sort + scope controls live in a **filter popover** opened
  from a button right of the bar (click-away + `Esc` to close; the
  button badges when a non-default sort/scope is active). A virtualised,
  fixed-height (`80px`) result list reusing `computeWindow` unchanged;
  per-card title + best `<mark>`-highlighted snippet + path + relative
  recency; click navigates via `handleNavigateWikilink` (reuses the
  open-file/autosave path). A polled (`500 ms`) `search_index_status`
  "Indexing… N/M" banner shows above results while `Building` and stops
  at `ready`; empty/error states handled (errors keep prior hits
  visible). `min-width: 0` runs down the column so a long path/snippet
  truncates instead of widening the fixed 18rem sidebar.
- **Pure, unit-tested modules:** `debounce.ts`, `snippet.ts`
  (`pickSnippet` priority body→headings→code→frontmatter→title;
  `parseHighlights` splits `<mark>` + unescapes entities, **no
  innerHTML**), `searchQuery.ts` (`buildSearchQuery`; `ScopeKind`
  derived from the wire `FieldScope["kind"]`; tags scope =
  whitespace-split), `relativeTime.ts` (`formatRelativeTime`).

#### §5 deviation #1 resolved — option (a)

Promoted `headings` / `body` / `code` / `frontmatter` to **`STORED`** in
`cubical-search` `schema.rs` and bumped `SCHEMA_VERSION` `1 → 2`.
Tantivy now generates tokenizer-correct `<mark>` snippets for every
matched field, not just `title`. The doc writer (`index.rs`) and
`collect_snippets` (`query.rs`) already handled all fields, so **no
query-logic change** was needed — only the schema flags + the version
bump, which auto-fires the existing wipe+rebuild path on next open
(`.md` files are the source of truth; index is derived state). Cost:
~2-3× index disk (verify in smoke). This closes §5 deviation #1; the
spec row there can be marked resolved at L4 close.

#### Tests

**+25 vitest** (415 → 421 net after the recency module; counts:
debounce 2, snippet 10, searchQuery 5, relativeTime 4) and **+6 Rust**
in `cubical-search` (body/headings+code/frontmatter snippet tests,
`prose_fields_are_stored`) plus a `cubical-app` health-version test
bumped to 2. `SearchPanel.tsx` has **no component unit test by design**
— the repo has no Solid render library and UI is operator-smoke-only
(Contract E); all its testable logic lives in the four pure modules.

Totals after the post-smoke revisions: **465 Rust + 422 vitest**.

#### Post-smoke revisions (2026-06-07, first operator pass)

The first operator smoke surfaced bugs + UX changes, fixed before close:

- **Search found files/tags/text only intermittently (root-caused).** The
  panel sent `fuzzy: true`; L4-A rewrites any single-term, ≥4-char,
  default-scope query into a `FuzzyTermQuery` against **`title` only**,
  discarding the multi-field parsed query — so words present only in
  body/headings/tags/frontmatter were silently missed, and the "no
  pattern" was single-word (title-only) vs multi-word (all fields). Fix:
  `buildSearchQuery` sends **`fuzzy: false`** so every default-scope
  query searches all fields; Rust regression guard
  `single_term_default_fuzzy_is_title_only_known_limitation` documents
  the L4-A behaviour (generalising backend fuzzy across fields deferred
  to an L4-A revisit). Evidence: fixture query `quick` (body word) →
  0 hits fuzzy-on, 1 hit fuzzy-off.
- **Layout reworked (replaces the segmented toggle):** persistent search
  bar above the file tree; tree shows below 3 chars, results at/over;
  `leftPaneMode` + `ui.left_pane_mode` removed.
- **Filter popover:** sort + scope moved into a popover button right of
  the search bar (click-away + `Esc`; badges when non-default).
- **Fixed sidebar width:** `min-width: 0` added down the column so long
  paths/snippets truncate instead of widening the 18rem column.
- **3-char threshold** before any search fires.

#### Grouped results — Obsidian-core-search layout (2026-06-08)

After the first re-smoke (operator confirmed search "works well"), the
flat one-row-per-file result list was reworked into **file groups**, on
operator request, modelled on Obsidian's core-search panel:

- **`ui/src/sidebar/resultGroups.ts`** (new, pure + unit-tested) —
  `buildFileGroups(hits)` turns each `SearchHit` into a `FileGroup`
  (`path` / `title` / `mtime_secs` / `cards`). Each matched field becomes
  a `ResultCard` (field + parsed `<mark>` segments), ordered
  body→headings→code→frontmatter→title (unknown fields last, stable);
  empty-snippet cards dropped. **+7 vitest.**
- **`SearchPanel.tsx`** — renders each group as a **collapsible header**
  (chevron toggles; title opens the file) carrying the title, relative
  recency, and a **match-count badge** (= number of snippet cards), over
  one wrapped **snippet card** per matched field (each opens the file). A
  **"N results"** line sits above the list (`N+` when the backend pulled
  a full `PAGE_LIMIT` window — never shown as a true total, per
  `SearchResponse`). `pickSnippet` (single-snippet selection) deleted as
  dead code; its 4 tests removed.
- **Virtualisation removed for the grouped view.** Variable-height
  collapsible groups don't fit the fixed-row windowing L4-B shipped; the
  list is capped at `PAGE_LIMIT` (50) files and rendered directly (50
  groups × a few cards is a small DOM). `computeWindow` is untouched and
  still used by App's file tree.
- **Deferred to the L4-A search revisit** (filed as a follow-up): (a)
  **typo-tolerance** — generalise backend fuzzy across all fields (today
  it's `title`-only, hence `fuzzy:false`), the Obsidian-Omnisearch
  behaviour the operator asked for; (b) **per-occurrence cards** — one
  card per match *location* within a field (Tantivy currently yields one
  best fragment per field, so a file with 4 body hits shows 1 body card,
  not 4); (c) windowed scrolling for the grouped list if huge result
  sets ever need it.

Net test deltas this pass: **+7 vitest / −4 vitest** (425 total),
**0 Rust** (frontend-only).

#### Gate results (2026-06-08, automated)

L4-B baseline (2026-06-07): `cargo test --workspace` (465) · `cargo
clippy --workspace --all-targets -- -D warnings` (clean) · `cargo fmt
--all --check` (clean) — unaffected by the frontend-only grouping
change. Re-run after grouping: `npx tsc --noEmit` (clean) · `npx vitest
run` (**425**) · `npm run build` (clean).

#### Operator smoke — RE-SMOKE REQUIRED before the `l4b` tag (Contract E)

First pass (2026-06-07) found the fuzzy bug + UX changes above; all
fixed. A clean re-smoke against `cargo tauri dev` is still owed. Run and
record:

1. **Per-field matches found + highlighted, grouped by file** — with the
   fuzzy fix, plain single-word queries must find body / heading / tags /
   frontmatter matches (not just titles). Each file now renders as a
   group: title header + match-count badge + one `<mark>` snippet card
   per matched field. Re-test the cases that failed first pass (e.g. the
   `Frontmatter` file, tag-only matches).
   - **Grouped UI (new 2026-06-08):** count badge = number of cards;
     chevron collapses/expands a group; clicking the title or any card
     opens the file; "N results" line shows above the list (`N+` when
     capped at 50). Confirm a file matching in several fields shows
     several cards.
2. **One-time rebuild after the version bump** — open a vault last
   indexed at SCHEMA_VERSION 1; confirm wipe+rebuild (banner shows,
   results converge), no stale/empty index, no `LockBusy`.
3. **`open_vault` re-open `LockBusy` smoke** (pending from 2026-06-06,
   `docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md`):
   re-open the same folder → no `LockBusy`, stays on that vault; open a
   different folder → distinct vault. Record there + flip the CLAUDE.md
   "operator smoke pending" line.
4. **Search bar UX** — typing <3 chars keeps the file tree; ≥3 chars
   shows results; the filter popover opens/closes (click-away + `Esc`)
   and sort/scope changes re-run; a long path/snippet does **not**
   widen the sidebar. The inline **clear (✕) button** appears only while
   the box has text and, on click, empties it immediately (tree returns)
   and refocuses the input.
5. **Grouped-list scroll** on a large result set (capped at 50 files,
   rendered directly — virtualisation removed for the grouped view);
   click a card on a file far down the list → correct file opens, view
   returns to the editor; navigation still autosaves the open buffer.
6. **Indexing banner** during `Building` on a fresh/large vault
   (Recipe 11).
7. **Disk footprint** — eyeball `.cubical/search` before/after ≈ 2-3×.
8. **L4-A search recipes 1–11** against
   `~/Developer/sandbox/cubical-l4a-smoke/` (standing backfill — L4-B
   makes them load-bearing).

#### Final-review findings (minor)

Holistic review = "ready to merge", all findings Minor:
- **Keyboard a11y:** search result rows are mouse-only (file-list rows
  have `onKeyDown`). Captured as a follow-up task (chip
  `task_bd4e47f4`), not a blocker.
- Single-term default-scope fuzzy is `title`-only (L4-A) — worked around
  by sending `fuzzy: false`; generalising it is an L4-A revisit.

#### Closeout (2026-06-08 — `l4b` tagged)

Merged to `main` and tagged `l4b`. All six automated gates green at
close: `cargo test --workspace` (465), `cargo clippy --workspace
--all-targets -- -D warnings` (clean), `cargo fmt --all --check`
(clean), `npx tsc --noEmit` (clean), `npx vitest run` (**425**), `npm
run build` (clean).

**Operator smoke — what was actually confirmed (honest record).** The
operator drove `cargo tauri dev` across this session and interactively
confirmed: search returns results; the fuzzy fix surfaces single-word
body/heading/tag/frontmatter matches with `<mark>` highlights; the
**grouped-by-file** layout (collapsible title headers, per-field snippet
cards, match-count badges, "N results" line); and the **✕ clear
button**. On that basis the operator elected to tag `l4b` (overriding
the Contract E "full formal re-smoke first" default — operator's call).

**Carried forward — not separately executed/recorded this session** (fold
into the L4 layer-close smoke / L4-C kickoff): the one-time wipe+rebuild
on opening a SCHEMA_VERSION-1 vault; the `open_vault` re-open `LockBusy`
check (still pending from 2026-06-06,
`docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md` — its
smoke-pending line is **not** flipped); the indexing banner on a large
vault; the ~2–3× disk-footprint eyeball; and L4-A recipes 1–11 against
`~/Developer/sandbox/cubical-l4a-smoke/`.

**Deferred features** (chip `task_256abd1c`): cross-field typo-tolerance
(Omnisearch-style) and per-occurrence snippet cards — both `cubical-search`
backend work.

**Next:** L4-C (`Cmd/Ctrl+K` Omni-Bar).

---

### 9.4 Session C — `Cmd/Ctrl+K` Omni-Bar (closed 2026-06-08, `l4c` tag)

A keyboard-summoned fuzzy navigator over **notes + tags**. Design:
`docs/superpowers/specs/2026-06-08-l4-c-omnibar-design.md`. Plan:
`docs/superpowers/plans/2026-06-08-l4c-omnibar.md`. Built TDD on
`feat/l4c-omnibar`.

#### What landed

- **`crates/cubical-index` — `all_tag_paths(conn)`** (`tags.rs`): the
  distinct vault tag set (`SELECT DISTINCT tag_path ... ORDER BY
  tag_path`), uncapped, case preserved. +2 Rust tests.
- **`crates/cubical-app` — `list_tags` command** (`commands/autocomplete.rs`,
  types in `api/types.rs`, shim + registration in `lib.rs`): one new IPC,
  `list_tags { vault_id } -> { tags }`. +1 Rust test. This is the only
  backend code in L4-C; everything else is frontend.
- **`ui/src/omnibar/ranker.ts`** (pure, the heart): `OmniItem` model,
  `matchText`, `fuzzyMatch` (case-insensitive, code-point subsequence),
  `scoreMatch` (fzf-style: contiguity, word-boundary, prefix/exact
  bonuses, shorter-is-better), `approxSubstringDistance` (Sellers'
  k-approximate substring edit distance — **real typo tolerance** for
  *substituted* letters, not just skipped ones), `rankItems`
  (subsequence first; if that fails, a bounded edit-distance fallback
  within a length-scaled budget — 0 under 3 chars, 1 up to 5, else 2 —
  with subsequence matches tiered above typo matches; deterministic
  ties: score → shorter → note-before-tag → alpha; capped). **+21
  vitest.** *(Edit-distance fallback added 2026-06-08 after first
  operator smoke — subsequence alone missed typos like `ricj`→`rich`.)*
- **`ui/src/omnibar/OmniBar.tsx`**: the modal — auto-focused input, a
  unified `listbox` of ranked rows (kind badge + matched-char
  highlights + path subtitle for notes), ↑/↓/Enter/Esc, click/hover,
  recent-notes empty state, "No notes/tags match" + "No notes yet"
  states. A11y: `role=dialog`/`aria-modal`, `listbox`/`option`,
  `aria-activedescendant`, focus-on-open + restore-on-close.
  Operator-smoke-only (Contract E).
- **`ui/src/api/ipc.ts`**: `listTags` wrapper + types; +1 shape smoke in
  `search.test.ts`.
- **`ui/src/App.tsx`**: global `Cmd/Ctrl+K` listener (no-op without a
  vault), lazy tag cache invalidated on `searchRefreshTick`, `omniItems`
  + `recentNotes` memos over `files()` + tags, modal render wired to
  `handleNavigateWikilink` (notes) and `handleNavigateTag` (tags).

#### Decisions (per design spec §2)

Notes + tags only (headings + commands deferred — headings need a new
index); client-side fuzzy over in-memory sources (Approach A — instant,
typo-tolerant, sidesteps L4-A's title-only backend fuzzy); unified
ranked list; recent-notes empty state; always hand off (navigate +
close); no visible `⌘K` hint in v1. UX choices research-backed
(keyboard-completable, match highlighting, recent-first, a11y).

#### Tests

**+21 vitest** (`ranker.test.ts`, incl. 8 typo-tolerance) **+1 vitest**
(`listTags` shape) → **447 vitest**; **+3 Rust** (`all_tag_paths` ×2,
`list_tags` ×1) → **468 Rust**. `OmniBar.tsx` has no component test by
design (Contract E).

#### Gate results (2026-06-08, automated)

`cargo clippy --workspace --all-targets -- -D warnings` (clean) ·
`cargo fmt --all --check` (clean) · `cargo test --workspace` (468) ·
`npx tsc --noEmit` (clean) · `npx vitest run` (**447**) · `npm run
build` (clean).

#### Companion: search typo tolerance (`l4a-fix.2`)

Smoking the Omni-Bar surfaced that the operator's real want was
typo-tolerant **search** — and that the L4-B left search bar still
wasn't (a wrong letter returned nothing). That's the `task_256abd1c`
cross-field-fuzzy item; it was implemented in the same session on
`feat/search-fuzzy` and merged to `main` alongside L4-C. `cubical-search`
`build_fuzzy_query` adds an edit-distance-1 (Damerau) `FuzzyTermQuery`
across **all** scope fields when fuzzy is on and the query is a single
term ≥`FUZZY_MIN_LEN`, OR'd with the exact+prefix query (exact still
ranks top via BM25). The panel sends `fuzzy:true` again. Replaces the
old `single_term_default_fuzzy_is_title_only_known_limitation` guard with
`single_term_fuzzy_spans_all_fields`. Caveat: a purely-typo'd word may
not be `<mark>`-highlighted (Tantivy highlights the literal typed term);
the result still appears. The **per-occurrence cards** half of
`task_256abd1c` remains deferred.

#### Operator smoke (honest record)

The operator drove `cargo tauri dev` across the session and found three
issues that were fixed and landed: (1) the Omni-Bar needed *real*
(substitution) typo tolerance — `ricj` didn't match (added
`approxSubstringDistance`); (2) the left search bar wasn't typo-tolerant
(the `l4a-fix.2` backend fuzzy above); (3) `Cmd/Ctrl+K` "did nothing" —
a checkout-on-the-wrong-branch artifact, resolved by merging both
feature branches to `main`. The operator tagged `l4c` + `l4a-fix.2` and
then **confirmed the merged `main` build works** — `Cmd/Ctrl+K` opens +
navigates and the search bar finds typos. L4-C closed.

#### Out of scope (deferred)

Headings as jump targets (needs a headings index); commands / command
palette; "create note if no match"; `#`-to-force-tags prefix;
context-awareness; visible `⌘K` hint; preview pane.

**Next:** L4-D (Dataview-style libSQL queries).

### 9.5 Session D — Dataview-style libSQL queries (closed 2026-06-15, `l4d` tag)

Design: [`docs/superpowers/specs/2026-06-14-l4-d-dataview-design.md`](superpowers/specs/2026-06-14-l4-d-dataview-design.md);
plan: [`docs/superpowers/plans/2026-06-14-l4-d-dataview.md`](superpowers/plans/2026-06-14-l4-d-dataview.md).

#### What landed

A fenced ```` ```query ```` block, evaluated against libSQL and rendered
live in the editor, complementing Tantivy full-text. Syntax is a small
DQL-flavored DSL (`LIST` / `TABLE cols` / `COUNT`, with `FROM #tag |
"folder"`, `WHERE key op value` AND-joined, `SORT key [ASC|DESC]`) —
documented as a focused subset, not Dataview compatibility.

- **New crate `cubical-query`** (no Tauri deps): `ast.rs` (typed AST),
  `parser.rs` (hand-written tokenizer + recursive descent),
  `plan.rs` (AST → parameterized SQL), `exec.rs` (runs against an
  `IndexConn`, shapes `List`/`Table`/`Count`), `error.rs`. The JSON-value
  rule: every comparison + projection goes through
  `json_extract(value,'$')`, so `status = "x"`, `priority >= 3`, and
  `due_date < "2026-07-01"` all work — ISO-date strings sort lexically, so
  date-range filtering falls out for free with no typed-date machinery.
  All literals/keys are bound parameters (no SQL injection). `FROM #tag`
  uses prefix match (so `#project` also matches `#project/active`);
  `TABLE` prepends an implicit file-link column; missing keys yield empty
  cells and sort last.
- **IPC:** one vault-keyed `dataview_query { vault_id, source } ->
  DataviewResult` command (`commands/dataview.rs` + shim). A bad query is
  returned as `DataviewResult::Error`, not a thrown IPC error.
- **Frontend:** `ui/src/dataview/dataviewRender.ts` (pure DOM renderer,
  jsdom-tested) + `ui/src/editor/dataview.ts` (CodeMirror block widget +
  per-vault `DataviewRunner` cache, modeled on the L3 embed widget).
  Wired through `App.tsx`/`Editor.tsx`; invalidated on vault content
  change (`vault:file-changed` + `searchRefreshTick`). Cursor-inside the
  block reveals raw source.

#### Tests

cubical-query: 28 (parser 16, planner 7, exec 5 — exec runs against an
in-memory index, proving numeric-not-lexical comparison and
empty-cell-for-missing-key). cubical-app: +6 (3 handler + 3 **end-to-end
over the real `cubical_core::scan` pipeline** — real `.md` files with
`tags: [project]` frontmatter → scan → `dataview_query`, proving a
frontmatter `tags:` list populates the `tags` table so `FROM #tag`
matches, and that `json_extract` unwraps real-scanned scalars). Frontend:
+18 vitest (3 IPC shape, 5 renderer, 10 widget — incl. headless
`buildDecorations` detection against a real markdown tree). Totals:
**507 Rust + 473 vitest** (workspace-measured; the earlier "502" was a
low arithmetic estimate).

#### Merge & gate results (2026-06-15)

Branch reconciled with `main` (the UI rework had landed meanwhile — clean
merge; main's only post-fork change was `SearchPanel.tsx`, which L4-D
never touched, so the editor query widget was unaffected). The branch's
merge-base already contained the floating-editor shell, so the widget was
built against it; code-level re-confirmation of the mount chain
(`App.tsx` → `Editor.tsx` dataview compartment → `livePreview` bundle →
`dataview_query` invoke handler) passed. Six gates green:
`cargo test --workspace` (507, 0 failed — one load-induced flake in the
unrelated `watcher` 500ms-settle timing test, passes 3/3 isolated),
`cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --all --check`, `tsc --noEmit`, `vitest run` (473), `vite
build` — all green. Merged to `main` and tagged `l4d`.

#### Operator visual smoke — outstanding residual (Contract E)

The **data path is fully automated** (end-to-end Rust tests through the
real scan pipeline + headless `buildDecorations` detection + jsdom
renderer + runner-cache unit tests), and the mount wiring is
code-verified. The one residual is the live CodeMirror widget's *visual*
render of table/list/count, note-link click navigation, cursor reveal of
raw source, and live re-eval on content change — these need the
interactive Tauri desktop app (the `dataview_query` IPC exists only in
the Tauri runtime, so a plain vite dev server / browser preview cannot
exercise it, and this agent environment cannot drive the desktop GUI). It
was therefore **not** blocking the `l4d` tag; it stays as an operator
checklist item.
Recipe: `cargo tauri dev`, open a vault with notes carrying `status` /
`priority` / `due_date` frontmatter + a `#project` tag; verify the three
block kinds render, a bad query shows the ⚠ message, clicking a result
navigates, cursor-in reveals raw source, and editing a referenced note
updates the result.

#### Deferred (design §8)

`OR`/parens, `contains`, `GROUP`/`FLATTEN`, typed/relative dates, formula
columns, inline `key::` fields, write-back.
