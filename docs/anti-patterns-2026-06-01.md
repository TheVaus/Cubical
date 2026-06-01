# Anti-patterns survey — 2026-06-01

Personal notes — not indexed from `docs/README.md`, not referenced from
`CLAUDE.md`, intentionally invisible to the session primer. Address
whenever; none of these block any layer's Definition of Done.

Four anti-patterns found during a post-L3-close review. Each was
investigated for documented intent; none of the four has a recorded
"considered alternative X, rejected for reason Y" trail in the L3 plans
or specs.

State at time of survey: `main` at `9d7e93e` (L3 closed, `l3` tag);
gates green at 406 Rust + 352 vitest. Re-validate against current
`main` before any fix work — the citations below may drift.

---

## 1. N+1 query in scan Pass 2 — block-ref derivation

**Where**
- [`crates/cubical-core/src/vault/scan.rs:342`](../crates/cubical-core/src/vault/scan.rs) — Pass-2 per-file loop calls `refresh_block_refs_for_file(&vault, &source_path)`.
- [`crates/cubical-core/src/vault/blocks.rs:40–65`](../crates/cubical-core/src/vault/blocks.rs) — helper issues `SELECT target_path, anchor_value FROM links WHERE source_path = ?` once per file, then a per-row `INSERT` into `block_refs`.

**The smell.** Classic N+1 read. Pass 2 already has every source file in memory (the `pending_links` buffer) and is sitting inside its own transaction (`link_tx`). Inside that loop, the helper goes back to the DB once per file to ask "what are this file's block-anchored links?" — when one sweep `SELECT source_path, target_path, anchor_value FROM links WHERE anchor_kind='block' AND target_path IS NOT NULL AND anchor_value IS NOT NULL ORDER BY source_path` plus a streaming group-by-source gives the same answer in one round-trip.

**Intent.** Session G plan ([`docs/superpowers/plans/2026-05-28-l3-session-g-block-references.md`](superpowers/plans/2026-05-28-l3-session-g-block-references.md) §Architecture, Task surface lines 67–69) deliberately designs `refresh_block_refs_for_file` as **one helper shared between scan Pass 2 and the watcher's single-file path**. That sharing is the recorded rationale. But the §5.6 scan-resolution fix landed the *same day* (2026-05-28) with the explicit insight that "the bulk scan should not re-query per file" — and Session G's plan never references §5.6 or asks whether bulk-derive belongs in Pass 2. The codebase therefore contradicts itself: §5.6 rejects this shape, Session G reintroduces it.

**Recommended shape.** Keep `refresh_block_refs_for_file` for the watcher (single-file callers genuinely need per-file semantics). Add a sibling `derive_all_block_refs_in_tx(&link_tx) -> Result<(), …>` that scan Pass 2 calls once after the link writes, replacing the per-file call at `scan.rs:342`. The watcher path is unchanged.

**Blast radius.** `cubical-core::vault::blocks` (one new fn), `cubical-core::vault::scan` (one call-site swap), one new integration test asserting "Pass 2 produces the same block_refs row set as N per-file calls." No `cubical-index` schema change. No frontend ripple.

---

## 2. Live Preview decorations walk the entire Lezer tree per update

**Where**
- [`ui/src/editor/decorations.ts:247`](../ui/src/editor/decorations.ts) — `tree.iterate({ enter })` with no `from`/`to` argument.
- [`ui/src/editor/decorations.ts:617`](../ui/src/editor/decorations.ts) — `kickResolverFetches` repeats the pattern.
- [`ui/src/editor/decorations.ts:190`](../ui/src/editor/decorations.ts) — `findBlockIds` is a full-doc `for ln = 1; ln <= doc.lines; ln++` loop.

**The smell.** CM6 documents `tree.iterate` accepting `{ from, to }` precisely so decoration providers stay viewport-bounded — Marijn's published example code is clear that unbounded iterate-from-root is for AST consumers (indexing, parsers), not for decoration plugins. The `findBlockIds` doc-wide line scan is the same smell in a different idiom. Decorations outside `view.visibleRanges` are never painted, so any work spent iterating them is wasted by construction. On a 5k-line note this is tens of thousands of needless node visits per keystroke and cursor move.

**Intent.** L2 Session B plan ([`docs/superpowers/plans/2026-05-25-l3-session-b-wikilink-live-preview.md`](superpowers/plans/2026-05-25-l3-session-b-wikilink-live-preview.md) lines 118–134 and 995) shows the example code using `tree.iterate({ enter })` without a range, and every subsequent session (D Tag rule, G `^id` decoration) extended that exact shape. L2 spec §9.2 line 528 describes the plugin as "recomputes the entry list on every relevant update" without specifying scope. Grepped every L3 plan + spec for `visibleRanges`, `viewport`, "full tree", "entire tree" — zero hits in any design discussion. CM6's simpler official examples sometimes do iterate without range, so it's a plausible carry-over from those — but it was never re-evaluated for scale.

**Recommended shape.** Push viewport-scoping down into a single helper that all three sites use:

```ts
function iterateVisible(view: EditorView, enter: (n: SyntaxNode) => void) {
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({ from, to, enter });
  }
}
```

Same shape for `findBlockIds` — `view.visibleRanges` → derive `startLn`/`endLn` per range → loop only those.

**Blast radius.** `ui/src/editor/decorations.ts` (three call-sites refactored, one helper added). Existing `decorations.test.ts` cases need a synthetic `EditorView` (some already use one). No CSS, no theme, no IPC, no spec ripple. The pure-core tests that drive `collectDecorations` against a `Tree` directly stay valid — the change is in the call shape, not the per-node logic.

---

## 3. Row-at-a-time INSERTs after a bulk DELETE

**Where**
- [`crates/cubical-index/src/links.rs:57–80`](../crates/cubical-index/src/links.rs) — `replace_links_for_file`.
- [`crates/cubical-index/src/tags.rs:65–74`](../crates/cubical-index/src/tags.rs) — `replace_tags_for_file`.
- [`crates/cubical-index/src/blocks.rs:52–63`](../crates/cubical-index/src/blocks.rs) — `replace_blocks_for_file`.
- [`crates/cubical-index/src/blocks.rs:122–133`](../crates/cubical-index/src/blocks.rs) — `replace_block_refs_for_file`.
- [`crates/cubical-index/src/pending.rs:125–128`](../crates/cubical-index/src/pending.rs) — `enqueue_pending_rewrites`.

**The smell.** Five separate `DELETE ... WHERE owner = ?` + `for r in rows { c.execute("INSERT … VALUES (?,?,?)") }` pairs. libSQL/SQLite supports multi-row `INSERT … VALUES (...), (...), …` (and prepared-statement reuse inside the loop), both of which collapse N statements into 1. For `Big.md` in the K smoke vault (51 links) the scan currently fires 52 statements where a single multi-row INSERT does the same work in one. Multiplied across the scan's per-file (frontmatter + links + tags + blocks) refreshes, the constant factor is real.

**Intent.** Session A plan ([`docs/superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md`](superpowers/plans/2026-05-23-l3-session-a-wikilink-parsing.md) line ~1645) literally specifies the single-row form. Every later table-introducing session (D, G, J) copied that model — the `replace_links_for_file` doc-comment even says "mirrors `refresh_frontmatter`," documenting the propagation explicitly. The implicit rationale floating in the doc-comments is "DELETE + INSERTs execute directly on the caller's connection so they participate in any outer transaction" — true, but multi-row VALUES participates in the outer tx just as well. The single-row form was set as the pattern at A and inherited without re-examination.

**Recommended shape.** A single helper at the `cubical-index` level — `bulk_insert(conn, table, columns, rows, chunk_size)` that builds the `VALUES (...), (...)` string with a bounded chunk (SQLite caps at ~32k parameters per statement, so chunk at ~500 rows × column count). Every `replace_*_for_file` becomes `DELETE + bulk_insert(...)`. Or, if a generic helper feels too much: rewrite each of the five sites to materialize one chunked multi-row INSERT, keeping the per-table shape.

Optional separate improvement at the same sites: drop the `r.target_raw.clone()` / `r.target_path.clone()` / etc. on the params row — `params!` accepts `&str` so the clones are pure ceremony.

**Blast radius.** Five `replace_*_for_file` sites in `cubical-index`, no callers change. All five have direct unit tests asserting round-trip semantics; they should stay green byte-for-byte. No schema change. No frontend ripple.

---

## 4. Sequential `for x in xs { f(x).await }` over independent async work

**Where**
- [`crates/cubical-app/src/commands/mentions.rs:82–104`](../crates/cubical-app/src/commands/mentions.rs) — unlinked-mentions scan reads + materializes + scans each candidate one at a time.
- [`crates/cubical-app/src/commands/rename.rs:712`](../crates/cubical-app/src/commands/rename.rs) — `flush_pending_rewrites` loops over `targets`.
- [`crates/cubical-app/src/commands/rename.rs:801`](../crates/cubical-app/src/commands/rename.rs) — `flush_all_for_vault` (timer / close-time path) repeats the loop.

**The smell.** The canonical async anti-pattern: a `for`-loop that `await`s one independent unit of I/O at a time when nothing forces serialization. `futures::stream::iter(xs).map(|x| async move { f(x).await }).buffer_unordered(K)` is the textbook replacement when the work items don't share mutable state. In all three sites the items genuinely don't — each candidate file in the mentions scan reads its own bytes and pushes into a final `Vec` that gets sorted once at the end; each flush target reads its own referrer file, applies its own materialize, atomic-writes its own bytes.

**Intent.** Grepped every L3 plan + spec for `buffer_unordered`, `join_all`, `FuturesUnordered`, `stream::iter`, "concurrent", "parallel" — **zero hits anywhere**. Session I's plan (`docs/superpowers/plans/2026-05-30-l3-session-i-unlinked-mentions.md`) — which matters most because L3 spec §2.9 itself flags I as "the most perf-sensitive L3 surface" — designs the scan as a straight `for path in candidates { ... .await }` loop with no discussion of concurrency. Same straight-line shape inherited into J's flush. Not deferred, not weighed — never on the design table.

**Recommended shape.** For each of the three sites:

```rust
use futures::{stream, StreamExt};

let hits: Vec<Mention> = stream::iter(candidates.into_iter().take(MAX_SCAN_FILES))
    .map(|path| {
        let root = root.clone();
        let vault = vault.clone();
        let needle_refs = needle_refs.clone();
        async move {
            let abs = root.join(&path);
            let on_disk = read_source_off_executor(&abs).await?;
            let source = materialize_on_read(vault.index(), &path, &on_disk).await.ok()?;
            // … find_mention_occurrences → build Mentions
            Some(this_files_mentions)
        }
    })
    .buffer_unordered(MENTIONS_PARALLELISM) // 8–16
    .filter_map(|m| async move { m })
    .collect::<Vec<_>>()
    .await
    .into_iter()
    .flatten()
    .collect();
hits.sort_by(...);
```

For the flush loops the shape is identical, but be careful: the per-target work calls `refresh_links` / `refresh_tags` / `refresh_blocks` / `refresh_block_refs_for_file`, each of which writes to the index. Concurrent writers against the same libSQL connection will collide. Either:
- (a) parallelize only the read + materialize + apply_pending + atomic_write portion, then serialize the index-refresh tail behind a mutex, or
- (b) build the per-target results in parallel as a `Vec<FlushResult>`, then drive the index refreshes in one sequential pass after the I/O completes.

(b) is cleaner.

**Blast radius.** Three call-sites in `crates/cubical-app/src/commands/`. Add `futures` (likely already a transitive dep — check `Cargo.lock`). Tunable constants `MENTIONS_PARALLELISM` / `FLUSH_PARALLELISM` (start at 8). Existing handler tests use small fixtures so should pass unchanged; ordering changes mean the final sort at the end of mentions becomes load-bearing (it already exists).

---

## What was checked and not flagged

- `PathResolver` itself — O(N) build, O(1) common-case lookup.
- `scan_wikilinks` / `scan_tags` — byte tokenizers, no regex.
- Toast / popover state machines — pure reducers.
- L1 frontmatter parsing — single-pass YAML.
- Autocomplete `validFor` regexes — already filter locally between keystrokes.
- `EmbedBlockWidget.eq()` — already uses entry-reference identity so the resolver cache flip avoids unnecessary DOM remounts.

The §5.5 deferred triple-parse and the §5.6 already-fixed bulk-scan O(N²) are both intentionally out of scope of this survey — the layer spec records them.

## What was found but is not a "bad practice"

Documented in the survey but demoted from this list — they're missed
optimizations, not anti-patterns:

- The watcher's `refresh_links` rebuilds the `PathResolver` per file change (missed cache, not a smell — build-from-scratch is the safe default without invalidation infra).
- `materialize_on_read` queries `pending_rewrites` per file even when usually empty (missed bulk prefetch, not a smell).
- `buildFor` rebuilds the full `DecorationSet` on every viewport scroll (rebuild-from-tree is the CM6 baseline, incremental updates are an optional optimization).
