# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. Tauri + Rust + Solid/TS. Plain `.md` files are the absolute source of truth. No Electron, no Node, no cloud.

This is the session primer. Read it before starting any work. For deep detail, follow the Docs pointers below. If a decision here conflicts with what a session participant says, raise the conflict — don't silently override it.

---

## Docs

- **Index:** `docs/README.md` — map of every doc, organized by the question you're trying to answer
- **Architecture:** `docs/architecture/README.md` — locked design decisions, split by domain
- **Layer specs:** `docs/layer-N-spec.md` — one per active or closed layer; intent + what landed
- **Conventions:** `docs/conventions.md` — Rust + TS code style, commits, tests
- **Build order:** `docs/build-order.md` — full layer ladder + v1.0 cut explanation

---

## Non-negotiables

These are load-bearing decisions. Not up for debate in a working session. Surface conflicts as architecture changes, not code changes.

- Plain `.md` files are the absolute source of truth. Everything else (libSQL, indexes, caches) is derived state rebuildable from the markdown.
- The vault is 100% portable and self-contained. No external services required to open a vault.
- No Electron, no Node.js runtime, no centralized cloud database for core storage.
- Files must survive being edited or renamed by external tools (vim, Finder, Dropbox) while the app is closed.
- Plugin code is sandboxed. The plugin ABI is WASI/WASM. JavaScript is supported as a *source language* via Javy/QuickJS-WASM, never as an unsandboxed runtime.
- Desktop only for v1. Mobile is deferred but the architecture must not preclude it.
- No file-identity UUIDs injected into any `.md` file before Layer 7. The vault is the user's vault, byte-for-byte, until sync onboarding.

For non-features explicitly cut from scope, see [`docs/architecture/constraints.md`](docs/architecture/constraints.md).

---

## Session protocol

**Loading:** This file is auto-loaded every session. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file. If editing code, load `docs/conventions.md`. If touching IPC / Tauri, load `docs/migration-touchpoints.md`.

**During work:** Update the current layer spec's in-progress section as things land.

**At session end:** Rewrite the Project state block below (4-6 lines max). Never append — rewrite.

---

## Repository layout

```
cubical/
├── crates/
│   ├── cubical-core/       # vault, file watcher, file-type registry, frontmatter I/O
│   ├── cubical-ast/        # canonical Markdown AST (no Tauri deps)
│   ├── cubical-index/      # libSQL schema and queries
│   ├── cubical-search/     # Tantivy wrapper (L4)
│   ├── cubical-sync/       # CrdtBackend trait + Loro impl (Loro lands at L7)
│   └── cubical-app/        # Tauri app, depends on the above
├── ui/                     # Solid + TypeScript + Vite frontend
├── docs/                   # see docs/README.md for the full index
├── CLAUDE.md
├── Cargo.toml
└── README.md
```

Crates without Tauri deps (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`) must remain buildable and testable without the app harness.

---

## Project state

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + Session G full + `[[#^` block-id autocomplete + Sessions H.1 + H.2 + I done; Sessions J + K pending). Session I (`l3-session-i-unlinked-mentions`, spec §9.14): on-demand vault scan surfaces every plain-text occurrence of the open note's title / aliases that isn't already a link, in a second right-sidebar panel beside Backlinks; per-row "Link it" rewrites the span to `[[…]]` on disk. Pure scanner (`cubical-core::vault::mentions`) — `extract_text_runs` yields plain-text regions outside frontmatter / fenced (` ``` ` and `~~~`) / inline code spans / wiki-links (`[[…]]` / `![[…]]`, pre-`!` byte included) / markdown links (display + url), and `find_mention_occurrences` runs whole-word case-insensitive substring matches with full Unicode `to_lowercase` plus a `map_lower_span_to_original` helper for casefold-expanding chars (`ß` → `ss`); boundary `!c.is_alphanumeric() && != '_'` (Tantivy-compatible for L4); empty/whitespace needles dropped silently; hits sort by byte_offset. AST `wikilink` module promoted to `pub` though byte-walker doesn't currently delegate to `scan_wikilinks` (held for future scanner consolidation). Snippet helper lifted from `commands/backlinks.rs` to `commands::snippet` so both panels produce identical context. `get_unlinked_mentions` IPC: snapshots markdown candidates via `type_id='markdown' AND path != ?1` (open-note self-exclusion in SQL), loads aliases from `frontmatter WHERE key='aliases'` (JSON-decoded, non-list/non-string entries dropped), dedupes needles case-insensitively, reads each candidate off the tokio runtime (`read_source_off_executor`), sorts `(source_path, position)`, `MAX_SCAN_FILES=50_000` fuse. `link_mention` IPC: reads fresh just-in-time, bounds + UTF-8 boundary check, re-validates whole-word boundary at edges (`InvalidRequest` if span moved), splices `[[Title]]` when `matched.to_lowercase() == title.to_lowercase()` else `[[Title|matched]]` (the **full Unicode fold** is load-bearing — `eq_ignore_ascii_case` was wrong for `"CAFÉ"` vs `"café"`, caught in code review, regression test `link_mention_handles_non_ascii_title_with_unicode_case_fold`); atomic write off executor; eager `files.content_hash` update post-write (best-effort). No `expected_seen_hash` — frontend has no seen-hash for non-open source files. Frontend mirrors Session C: `unlinkedMentionsState` reducer (+ `mention:linked` optimistic removal), `UnlinkedMentions.tsx` panel (reuses the untrack-guarded fetch effect from Session C — load-bearing; `backlinks.test.ts:108-156` has the regression test), tabbed segment selector inside `RightSidebar` (Backlinks ↔ Mentions, persisted as `ui.right_sidebar_panel`, default `backlinks`). Per-row link errors live in a separate `linkError` signal keyed by `mentionKey` so a single-row failure doesn't blow away the rest of the loaded list (caught in code review). `BACKLINKS_REFRESH_DEBOUNCE_MS` renamed → `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` and the same tick fans out to both panels via the existing `vault:file-changed` listener (no new event).
Earlier L3 (unchanged): backend block-refs (Session G, spec §9.8) — `create_block_ref` is the only `^block-id` minter; deterministic id `b`+sha256(path:position)[..6]; migration 005, `HIGHEST_KNOWN_VERSION=5`. Frontend gesture + decoration + status bar (§9.9 + §9.10), `[[#^` block-id autocomplete (§9.11). Session H.1 (`embeds::{extract_section,extract_block,strip_frontmatter,slugify}` + `commands::embeds::get_embed`). Session H.2 (CM6 embed-widget extension, per-vault `EmbedResolver` invalidated on every `vault:file-changed`, pure `renderEmbedBody` covering depth-cap / cold / unresolved / cycle / resolved branches). DOM tests use per-file `// @vitest-environment jsdom` pragma.
Tests: 326 Rust (+37 Session I: 21 scanner + 16 handler, incl. non-ASCII case-fold regression) + 329 vitest (+8 Session I: `mentionKey` + reducer transitions incl. `mention:linked`). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: Session J — Rename → Pending Rewrites Cache (spec §2.10, §3.4, §8 Session J). Then K (closeout: hands-on smoke of ALL L3 surfaces incl. the I smoke vault, `l3` tag). H.3 polish (rich markdown inside embed body, click nav, `⎘` retirement) remains deferred — not on §2.8 DoD critical path. Smoke for Session I still pending hands-on (automated-context constraint; recipe in §9.14): vault with `Daily.md` (aliases: [diary, journal]), `Project.md` (mixed mentions + linked + code-span), `Notes.md` (cross-line mentions); verify mentions panel lists qualifying occurrences only, "Link it" rewrites to disk, segment selector toggles Backlinks ↔ Mentions, single-row link failure surfaces inline without destroying the list.
