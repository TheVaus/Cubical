# Kickoff — L4-B: persistent left-panel search results UI

> Copy the body below (everything under the horizontal rule) into a
> fresh Cubical session as the opening message. This is a full layer
> session (a UI feature), not a patch — it goes through
> `superpowers:brainstorming` → design spec → `superpowers:writing-plans`
> → TDD, the same as every feature.

---

Start **L4-B — the persistent left-panel search results UI**. This is
the first UI consumer of the L4-A Tantivy search backend. It is a
feature with real UX and one load-bearing data decision, so begin with
`superpowers:brainstorming` (do **not** jump to code), produce a design
spec under `docs/superpowers/specs/`, then a plan, then implement
test-first.

## State of the project

- **L4-A closed** (`l4a`). The search backend + IPC are live and
  unconsumed by any UI. TS wrappers already exist in
  `ui/src/api/ipc.ts`: `search` (~L980), `searchIndexStatus` (~L988),
  `searchRebuildIndex` (~L1000), `searchGetHealth` (~L1008), with the
  wire types (`SearchRequest`, `SearchQuery`, `FieldScope`, `SortMode`,
  `SearchResponse`, `SearchHit`, `MatchedField`, `IndexState`,
  `IndexStatus`, `IndexHealth`) and `ui/src/api/search.test.ts`.
  **L4-B adds no new IPC** — it consumes L4-A's.
- **L4-A-fix + `l4a-fix.1` closed** (editor surface contracts; embed
  render/cursor; embed scroll-jump fix). See `docs/layer-4-spec.md`
  §9.2.
- **`open_vault` re-open `LockBusy` fix landed** (idempotent re-open by
  canonical path) — **operator smoke still pending**. Since you will be
  booting `cargo tauri dev` for L4-B anyway, run it once: open a vault
  folder, then File → Open Vault the **same** folder again → it must
  **not** throw `search index error: … LockBusy`; the app stays on that
  vault. Then open a different folder → distinct vault. Record the
  result in `docs/superpowers/specs/2026-06-06-idempotent-open-vault-design.md`
  (Definition of Done) and flip the CLAUDE.md "operator smoke pending"
  line to confirmed.
- **Tests at start:** 400 vitest + 460 Rust. All six gates green on
  `main` (pushed).

All CLAUDE.md non-negotiables apply: plain `.md` is the source of
truth, vault is portable, no UUID injection before L7, desktop-only v1,
WASI/WASM plugins.

## What L4-B builds (from `docs/layer-4-spec.md` §2, §4)

A second left-side pane (alongside the existing file tree in
`ui/src/App.tsx`; the right sidebar with Backlinks/UnlinkedMentions is a
separate surface) holding:

- **`ui/src/sidebar/SearchPanel.tsx`** — the panel shell.
- A **query input** with **debounced** fetch into `search`.
- **Sort + scope chips:** `SortMode` (relevance / recency) and
  `FieldScope` (default / headings_only / body_only / code_only / tags).
- A **virtualised result list** with `<mark>`-highlighted snippets.
  Reuse the existing windowing (`ui/src/virtualList.ts` `computeWindow`,
  the same primitive the file tree uses) rather than inventing a new
  one — confirm it generalizes.
- A **"still indexing…" banner** driven by polling `searchIndexStatus`
  (`IndexState` building / ready / error).
- Clicking a hit **navigates** to that file (reuse the existing
  open-file path).

## The load-bearing decision (resolve in brainstorming): snippet field coverage

`docs/layer-4-spec.md` §5 deviation #1. L4-A's schema **stores** only
`path`, `title`, `tags`, `mtime_secs`, `size_bytes`. The prose fields
(`body`, `headings`, `code`, `frontmatter`) are **indexed but not
stored**, and Tantivy's `SnippetGenerator` reads from STORED text — so
today snippets are produced for **title matches only**. L4-B must pick
one, deliberately:

- **(a) Promote `body`/`headings`/`code` (± `frontmatter`) to `STORED`**
  in the schema. Immediate highlighted snippets on first paint;
  ~2–3× index disk. This is a **schema change** → bump `SCHEMA_VERSION`
  in `cubical-search` (triggers the existing wipe+rebuild path in
  `SearchIndex::open`); touches `schema.rs`, the projector in `doc.rs`,
  and snippet generation in `query.rs`. Crosses back into the Rust
  search crate.
- **(b) Re-read source on demand** for each visible hit and compute the
  snippet from the file's current bytes. Slim index; I/O per render;
  pure-UI / thin-IPC.

Rule of thumb from the spec: highlighted snippets essential on first
paint → (a); hover-to-expand acceptable → (b). Decide against L4-B's
actual UX, not by default.

## What's genuinely unknown (verify, don't assume)

- **Panel coexistence with the file tree.** Toggle between tree/search?
  Both visible and stacked? Collapsible like the right sidebar
  (`rightSidebarCollapsed`)? Pick a model in brainstorming.
- **Persisted UI state.** If the panel's collapsed/last-query state
  should survive reloads, use the existing `get_setting`/`set_setting`
  `ui.*` pattern (as `ui.right_sidebar_collapsed` does) — no new
  storage mechanism.
- **Debounce cadence.** Search is fast (L4-A budget p50 < 15 ms), but
  debounce keystrokes to avoid thrash; confirm a value in smoke.
- **`still_indexing` semantics.** `search` returns partial results with
  `still_indexing: true` while `Building` — surface that as the banner,
  and confirm results converge as the scan completes (Recipe 11 in
  §9.1).

## Constraints (inherited)

Main checkout + branches, **no worktrees**. One surface per session
(the search panel). Brainstorm → design spec → plan → TDD. Per-task
commits. All six gates green at every commit boundary:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, and in `ui/`: `npx tsc
--noEmit`, `npm run build`, `npx vitest run`. End commit messages with
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

**Contract E (`docs/conventions.md` §Sessions):** executed interactive
smoke before any layer/fix tag — recorded-only smoke does not satisfy
close. jsdom has no layout engine, so virtualised-list scroll/measure
behaviour and the live IPC round-trip are operator-smoke-only; unit
tests cover the pure logic (query-state reducer, chip→`SearchQuery`
mapping, snippet/highlight transforms, debounce), the smoke covers the
visible result list.

**Standing backfill (run when you touch those surfaces):** the L4-A
search IPC recipes (`docs/layer-4-spec.md` §9.1 Recipes 1–11) — L4-B is
exactly the session that makes them load-bearing, so run them against
`~/Developer/sandbox/cubical-l4a-smoke/`. The L1/L2 watcher/properties
recipes remain standing for whichever session next touches them.

## Definition of done (L4-B)

- `SearchPanel.tsx` renders results from `search`, virtualised, with
  highlighted snippets; clicking a hit navigates.
- Debounced query input; sort + scope chips drive the `SearchQuery`.
- "Still indexing…" banner from `searchIndexStatus`.
- The §5 deviation #1 snippet-coverage decision is **made and
  implemented** (and, if option (a), the schema-version bump + rebuild
  path verified).
- Six gates green; executed smoke recorded; the `open_vault` re-open
  smoke above run and recorded.
- `docs/layer-4-spec.md` §6 L4-B row ticked + a §9.3 closeout written;
  `CLAUDE.md` Project state rewritten (not appended).
- Land on `main`. Tag (e.g. `l4b`) only after executed smoke.

## After this

- **L4-C** — `Cmd/Ctrl+K` Omni-Bar (modal over L4-A search + L3 link/tag
  autocomplete). Bug #2/#3 navigation-path split (Contract C, deferred
  from L4-A-fix) is slated to revisit here.
- **L4-D** — Dataview-style libSQL queries (`list`/`table`/`count`).
- L4 closes (`l4`) after L4-D.
