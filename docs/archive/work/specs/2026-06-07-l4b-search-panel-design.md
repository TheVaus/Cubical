> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L4-B — Persistent left-panel search results UI (design)

> Status: approved 2026-06-07. Layer 4, Session B. First UI consumer of
> the L4-A Tantivy search backend. This spec feeds
> `superpowers:writing-plans`; implementation is TDD per `docs/conventions.md`.

## 1. Goal

A persistent search surface in the left column that runs free-text
queries against the L4-A index and shows ranked, `<mark>`-highlighted
results. Clicking a result opens the file. This is the first consumer of
L4-A's IPC (`search`, `search_index_status`); **no new IPC is added**.

It also resolves `docs/layer-4-spec.md` §5 deviation #1 (snippet field
coverage) by adopting **option (a)**: promote the prose fields to
`STORED` so Tantivy produces tokenizer-correct highlighted snippets
server-side.

## 2. Decisions (locked in brainstorming, 2026-06-07)

1. **Layout — segmented toggle in the left column.** One left column
   with a `Files | Search` segmented control at the top (mirrors the
   `RightSidebar` Backlinks|Mentions pattern). Exactly one mode is
   mounted at a time; no new horizontal space is consumed and the editor
   stays full-width.
2. **Snippets — option (a), server-side stored fields.** Promote
   `body`, `headings`, `code`, **and** `frontmatter` to `STORED`.
   Rationale: highlighting must use the same analyzer (`en_stem` / `code`
   tokenizers, fuzzy, phrase) that produced the match; client-side
   substring highlighting (option (b)) would mis-highlight stemmed/fuzzy
   hits and reimplement Tantivy. Cost — ~2-3× index disk and a one-time
   rebuild — is acceptable: the index is derived state, rebuildable from
   the `.md` source of truth.
3. **Stored fields — all four** (`body` + `headings` + `code` +
   `frontmatter`). Frontmatter is tiny relative to the prose fields, and
   storing it means a default-scope hit that matched only in frontmatter
   still shows a highlighted preview rather than falling back to title.
4. **Persistence — active pane mode only.** Persist `ui.left_pane_mode`
   (`files` | `search`, default `files`) per vault. The query box and
   chips start fresh each launch (no stale query resurfaced, no search
   fired on open).
5. **Fixed-height result rows.** Each hit is a constant-height card so
   the existing `computeWindow` virtualizer (`ui/src/virtualList.ts`) is
   reused unchanged. Multi-line / expandable snippets are deferred.
6. **Tags scope = whitespace-split the query box.** The `Tags` chip maps
   the query text to `FieldScope::Tags { tags }` by splitting on
   whitespace (AND-matched, lowercased by the backend). A dedicated tag
   picker is L4-C territory.
7. **First page only.** Fetch `limit` 50; pagination / "load more" /
   infinite scroll deferred.

## 3. Architecture

Three layers, each independently testable:

```
ui/src/
├── App.tsx                     # left-column shell: mode toggle + persistence
└── sidebar/
    ├── SearchPanel.tsx         # panel shell (Solid component; smoke-tested)
    ├── searchQuery.ts          # chip state → SearchQuery   (pure; vitest)
    ├── snippet.ts              # pickSnippet + parseHighlights (pure; vitest)
    └── debounce.ts             # generic debounce            (pure; vitest)

crates/cubical-search/src/
├── schema.rs                   # STORED flags + stored-flag tests
├── index.rs                    # SCHEMA_VERSION 1 → 2
└── query.rs                    # no logic change; new per-field snippet tests
```

### 3.1 Left-column shell (`App.tsx`)

- New signal `leftPaneMode: "files" | "search"`.
- Seeded in `handleOpen` from `getSetting(vaultId, "ui.left_pane_mode")`
  (absent → `"files"`), reset to `"files"` at the top of `handleOpen`
  alongside the other per-vault resets.
- A `role="tablist"` segmented control at the top of the existing 18rem
  left column, styled to match the `RightSidebar` tablist (uppercase,
  accent-filled selected tab). Toggling persists via
  `setSetting(vaultId, "ui.left_pane_mode", mode)` (fire-and-forget with
  a `console.error` catch, like the other `ui.*` toggles).
- The existing file-list `<div role="listbox">` block renders when mode
  is `files`; `<SearchPanel vaultId={…} onNavigate={…}>` renders when
  mode is `search`. The file list keeps its own scroll/window state.
- `onNavigate(path)` calls the existing `handleNavigateWikilink(path,
  null)` so autosave/seenHash plumbing stays correct and the view
  switches back to the editor.

### 3.2 `SearchPanel.tsx`

Owns local signals: `queryText`, `sort` (`"relevance" | "recency_desc"`),
`scope` (a discriminated value covering `default | headings_only |
body_only | code_only | tags`), `hits: SearchHit[]`, `indexStatus`,
`searching`/`error`.

- **Query input:** debounced 200ms via `debounce.ts`; on fire, builds the
  `SearchQuery` with `buildSearchQuery` and calls `search`. Empty/blank
  text clears results without an IPC call.
- **Chips:** sort (Relevance · Recent) and scope (All · Headings · Body ·
  Code · Tags) as small toggle buttons; changing either re-runs the
  current query immediately (no debounce on chip change).
- **Result list:** virtualized with `computeWindow` over a fixed
  `RESULT_ROW_HEIGHT`. Each card renders: title (1 line, ellipsized),
  best snippet (`pickSnippet` → `parseHighlights` → text + `<mark>`
  spans, 1 line ellipsized), and a meta line (path + relative recency).
  Clicking a card calls `props.onNavigate(hit.path)`.
- **Indexing banner:** on mount and while building, poll
  `searchIndexStatus` (~500ms) and show "Indexing… `indexed_files` /
  `total_files`" above the list; also surface `response.still_indexing`.
  Stop polling once `state === "ready"`; show an error note on `error`.
- **Zero/empty/error states:** idle "Type to search", empty "No
  matches", and an error line on a failed `search`.
- Cleans up the poll interval and debounce timer on unmount.

### 3.3 Pure modules

- **`searchQuery.ts`** — `buildSearchQuery(input): SearchQuery` where
  `input = { text, sort, scope, limit, offset }`. Maps:
  - scope `default|headings_only|body_only|code_only` → the matching
    `FieldScope` with the original `text`;
  - scope `tags` → `FieldScope::Tags { tags: text.split(/\s+/).filter(Boolean) }`;
  - `sort` straight through; `fuzzy: true` always (backend gates it to
    single-term, ≥4 chars, default scope); `limit`/`offset` straight
    through (`limit` default 50 supplied by the caller).
- **`snippet.ts`**
  - `pickSnippet(matched: MatchedField[]): MatchedField | null` —
    priority `body → headings → code → frontmatter → title`; `null` when
    empty.
  - `parseHighlights(snippet: string): Array<{ text: string; mark: boolean }>`
    — splits on `<mark>` / `</mark>` and unescapes Tantivy's HTML
    entities (`&amp; &lt; &gt; &quot; &#x27;`). Adjacent/empty segments
    collapse. Consumed by the component to build text nodes + `<mark>`
    spans; **never** `innerHTML`.
- **`debounce.ts`** — `debounce<F>(fn, ms)` returning a callable with a
  `.cancel()`; trailing-edge; tested with fake timers.

### 3.4 Rust — option (a) implementation

`index.rs:118` already writes `headings`/`body`/`code`/`frontmatter` into
the document, and `collect_snippets` (`query.rs`) already iterates all
five text fields. Snippets come back empty today only because those
fields are not `STORED`, so `searcher.doc()` cannot retrieve their text.
The change is therefore narrow:

- **`schema.rs`** — `headings`, `body`, `frontmatter` use `en_stem_stored`
  (same options object as `title`); add a `code_stored` =
  `code_indexing.clone().set_stored()` for `code`. Update the `Fields`
  doc comments ("Not stored" → "Stored"). Add a test asserting the four
  promoted fields report `is_stored()`.
- **`index.rs`** — bump `SCHEMA_VERSION` `1 → 2`. The existing
  version-mismatch branch (`index.rs:46`) wipes and rebuilds on the next
  `SearchIndex::open`, so the new stored layout is populated from the
  `.md` source automatically.
- **`query.rs`** — no logic change. Update the stale
  `snippet_contains_mark_tags` comment (title is no longer the only
  stored text field) and add tests asserting body/headings/code/
  frontmatter queries now return a non-empty `<mark>`-bearing snippet for
  the matched field.

## 4. Data flow

```
keystroke → debounce(200ms) → buildSearchQuery(text,sort,scope,limit) →
search(vault_id, query) → SearchResponse →
  hits.map(hit → { title, pickSnippet(hit.matched_fields) → parseHighlights }) →
  computeWindow(scrollTop, viewportH, ROW_H, hits.length, overscan) → render slice
click(hit) → onNavigate(hit.path) → handleNavigateWikilink(path, null)

mount / building → setInterval(500ms) searchIndexStatus → banner; clear at ready
```

## 5. Error handling

- `search` rejection → set an inline error line in the panel; keep the
  prior hits visible rather than flashing empty.
- `searchIndexStatus` rejection → log + treat as unknown (no banner);
  retry on the next tick.
- `setSetting`/`getSetting` for `ui.left_pane_mode` → fire-and-forget
  with `console.error`, matching the other `ui.*` toggles. A failed read
  falls back to the `files` default.
- Empty/blank query → clear results, no IPC.

## 6. Testing strategy

**vitest (pure logic — jsdom has no layout engine, so these cover the
deterministic core):**
- `buildSearchQuery`: each scope incl. tags whitespace-split (and
  empty/extra-space tags), sort pass-through, fuzzy always on, limit/
  offset pass-through.
- `pickSnippet`: priority order; null on empty; single-field cases.
- `parseHighlights`: plain text, one mark, multiple marks, adjacent
  marks, entity unescape, empty string.
- `debounce`: trailing-edge timing and `.cancel()` with fake timers.

**Rust (`cargo test --workspace`):**
- schema: the four promoted fields are `STORED`; existing field-name and
  tokenizer tests stay green.
- query: per-field `<mark>` snippets now produced for body/headings/code/
  frontmatter; existing query tests stay green.
- index: version bump triggers the existing wipe+rebuild path (covered by
  the existing open/rebuild tests).

**Operator smoke (Contract E — required before any tag; jsdom can't
exercise these):**
- Virtualized result list: scroll a large result set, confirm windowing
  and no blank flashes; click a hit → correct file opens and view returns
  to the editor.
- Live IPC round-trip: queries return highlighted snippets for body/
  heading/code/frontmatter/title matches; sort and scope chips behave.
- Indexing banner: open a fresh/large vault and confirm the banner shows
  during `Building` and results converge as the scan completes
  (`docs/layer-4-spec.md` §9.1 Recipe 11).
- Pending `open_vault` re-open LockBusy smoke (see
  `docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md`):
  re-open the same folder → no `LockBusy`; open a different folder →
  distinct vault. Record the result and flip the CLAUDE.md "operator
  smoke pending" line.
- L4-A search recipes 1–11 against `~/Developer/sandbox/cubical-l4a-smoke/`
  (standing backfill — L4-B is the session that makes them load-bearing).

**Six gates green at every commit boundary:** `cargo test --workspace`,
`cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all
--check`, and in `ui/`: `npx tsc --noEmit`, `npm run build`, `npx vitest
run`.

## 7. Out of scope

- `Cmd/Ctrl+K` Omni-Bar (L4-C).
- Dedicated tag-picker UI beyond the whitespace-split mapping.
- Result pagination / "load more" / infinite scroll.
- Multi-line or expand-on-hover snippet rendering.
- Any new IPC command.

## 8. Definition of done

- `Files | Search` toggle in the left column; mode persisted as
  `ui.left_pane_mode`.
- `SearchPanel` renders virtualized, highlighted results from `search`;
  clicking a hit navigates and returns to the editor.
- Debounced query input; sort + scope chips drive the `SearchQuery`.
- "Indexing…" banner from `search_index_status`.
- §5 deviation #1 resolved as option (a): prose fields `STORED`,
  `SCHEMA_VERSION` bumped, rebuild path verified.
- Six gates green; executed operator smoke recorded; `open_vault` re-open
  smoke run and recorded.
- `docs/layer-4-spec.md` §6 L4-B row ticked + §9.3 closeout written;
  `CLAUDE.md` Project state rewritten.
- Land on `main`; tag `l4b` only after executed smoke.
