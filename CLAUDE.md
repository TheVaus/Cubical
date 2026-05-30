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

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + Session G full + `[[#^` block-id autocomplete + Sessions H.1 + H.2 done; Sessions I–K pending). Frontend embeds (branch `l3-session-h2-embed-widget`, spec §9.13): every `![[…]]` in Live Preview renders a block widget below its source line via a CM6 `StateField<DecorationSet>` (block decorations can't come from a `ViewPlugin`). `EmbedResolver` (`ui/src/editor/embedResolver.ts`) mirrors `WikiLinkResolver` over the H.1 `get_embed` IPC — `get`/`fetch`/`resolve`/`invalidate`/`onUpdate`, cache key `target_raw`, failures cache as `unresolved`. `resolve()` re-kicks `fetch` on mid-flight invalidate so awaiting callers don't hang (caught in review). Pure `renderEmbedBody` (`ui/src/editor/embedRender.ts`) returns a `DocumentFragment` covering five branches: depth-cap (`chain.length ≥ MAX_EMBED_DEPTH=4`) → styled link, cold cache → "Loading…" + `fetch`, `unresolved`/`missing-anchor` → ⚠ placeholder, cycle (`resolved target_path ∈ chain`) → styled link, resolved → preserved-newline plain text with nested `![[…]]` recursively rendered (via `scanWikilinks`) threading `[...chain, here.target_path]`. Non-embed `[[…]]` inside an embed body stays as literal source. **No markdown formatting inside the body** — H.3 polish. `embed.ts` extension: `embedResolverFacet` (per-vault resolver; `null` → no widgets) + `openNotePathFacet` (seeds the cycle chain with the host note) + `embedResolverUpdated` `StateEffect` (dispatched on every `EmbedResolver.onUpdate`); the field rebuilds on doc/tree/facet changes and on the effect. **Widget identity = the captured `EmbedResolution | undefined` for its target by reference** (caught in review: `Date.now()` stamping was remounting every widget on every rebuild; entry-reference preserves DOM identity unless the entry actually flips on `cache.set`). `ignoreEvent` left at the CM6 default (`true` = ignore — a read-only block widget should not move the caret on body clicks). `Editor` gains `embedResolver?` + `openNotePath?` props, two `Compartment`s, an `onUpdate` subscription, and swap-on-prop-change `createEffect`s. `App` owns one `EmbedResolver` per vault (created in `handleOpen`, cleared in close, invalidated on every `vault:file-changed`), passing `selectedPath()` straight through as `openNotePath`. The inline `mark-wikilink-embed` `⎘` glyph (L3 Session B) is **unchanged** — it stays as a marker on the source; the block widget renders the content below. DOM tests use a per-file `// @vitest-environment jsdom` pragma (vitest default = node).
Earlier L3: Backend block-refs (`l3-session-g-block-references`, spec §9.8) — `create_block_ref` is the **only** path that writes `^block-id`; deterministic id `b`+sha256(path:position)[..6]; migration 005 adds `blocks(file_path, block_id, position_hint, last_modified)` + `block_refs(source_file_path, target_file_path, target_block_id)` both CASCADE on `files(path)`; `HIGHEST_KNOWN_VERSION=5`. `cubical-core::vault::blocks` (`extract_block_ids` + `refresh_blocks` + `refresh_block_refs_for_file`); `cubical-index::blocks` query module; `cubical-app::commands::blocks` (`create_block_ref` + `get_broken_block_refs`). Scanner grammar (`is_valid_block_id`) ↔ minter grammar (`is_valid_id`) ↔ frontend `TRAILING_BLOCK_ID` regex **must stay in lockstep**. Frontend gesture + decoration + status bar (§9.9 + §9.10) — `Cmd/Ctrl+Shift+B` copies `[[path#^id]]`, `^id` decoration via `findBlockIds`, broken-ref status-bar item via pure `formatBrokenBlockRefs`. `[[#^` block-id autocomplete (§9.11) via `block_id_autocomplete` + `detectBlockTrigger` + `blockCompletionSource`. Session H.1 (`l3-session-h1-embed-extractor`, §9.12) — pure `cubical-core::vault::embeds::{extract_section, extract_block, strip_frontmatter, slugify}` + `commands::embeds::get_embed` orchestrator; `EmbedKind` enum kebab-case (`note`/`section`/`block`/`unresolved`/`missing-anchor`); `ipc.ts` `getEmbed` binding.
Tests: 289 Rust (unchanged this session — no Rust gap) + 321 vitest (+28 since H.1: 8 `embedResolver` + 11 `embedRender` + 9 `embed`). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: Sessions I–K — unlinked mentions (I), pending-rewrites cache (J), closeout (K). H.3 (rich markdown rendering inside the embed body + click navigation + optional `⎘`-indicator retirement) is **deferred polish** — not on the §2.8 DoD critical path. Smoke still pending hands-on (automated-context constraint): in a vault with `Daily.md` (`# Intro` + body + `^abc123`) and `Outer.md` containing `![[Daily]]`, `![[Daily#Intro]]`, `![[Daily#^abc123]]`, `![[Ghost]]`, `![[Daily#Missing]]`, and `![[Cycle]]` (self-referencing) — verify each form renders its expected branch. Plus a 5-deep chain `ChainA → … → ChainE` for the depth-cap link. All fully unit/integration-tested.
