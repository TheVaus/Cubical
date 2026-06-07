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

Current layer: 4 — Search (in progress).

**L4-B — persistent left-panel search UI — code complete 2026-06-07 on
`feat/l4b-search-panel`; first operator smoke done (found bugs, all
fixed); re-smoke owed before merge/tag.** First UI consumer of L4-A's
search IPC. A persistent search bar sits above the file tree in the left
column; `ui/src/sidebar/SearchPanel.tsx` renders the tree (App's
`children`) below 3 chars and replaces it with results at/over 3 chars —
debounced query, sort+scope in a filter **popover** to the right of the
bar, a virtualised fixed-height result list reusing `computeWindow`,
`<mark>`-highlighted snippets (+ relative recency), a polled
`search_index_status` "Indexing…" banner; clicking a hit reuses
`handleNavigateWikilink`. `min-width: 0` runs down the column so long
text never widens the 18rem sidebar. Pure logic unit-tested in
`debounce.ts` / `snippet.ts` / `searchQuery.ts` / `relativeTime.ts`; the
component is operator-smoke-only (no Solid render lib; Contract E).

**§5 deviation #1 resolved (option a):** `cubical-search` promotes
`headings`/`body`/`code`/`frontmatter` to `STORED` and bumps
`SCHEMA_VERSION` `1 → 2`, so Tantivy emits tokenizer-correct snippets for
every matched field. The doc writer + `collect_snippets` already handled
all fields → schema-flags + version bump only; the bump auto-fires the
existing wipe+rebuild on next open (index is derived state; `.md` is
truth). ~2-3× index disk.

**First-smoke fixes:** search was finding files/tags/text only
intermittently because the panel sent `fuzzy: true` and L4-A rewrites
single-term (≥4-char) default-scope queries to `title`-only fuzzy,
discarding the multi-field search — fixed by sending `fuzzy: false`
(Rust regression guard
`single_term_default_fuzzy_is_title_only_known_limitation`; generalising
backend fuzzy across fields deferred to an L4-A revisit). Also: replaced
the `Files|Search` tab with the search-bar-above-tree model (dropped
`ui.left_pane_mode`), moved filters into a popover, fixed the
sidebar-widening bug, and gated search at ≥3 chars.

**Remaining to close L4-B (Contract E — tag only after executed smoke):**
run + record the **re-smoke** in `docs/layer-4-spec.md` §9.3 (single-word
body/tag/frontmatter matches now found + highlighted; one-time rebuild
after the version bump; the pending `open_vault` re-open `LockBusy` smoke
from 2026-06-06; search-bar UX incl. fixed width; virtualised scroll +
navigation; indexing banner; ~2-3× disk; L4-A recipes 1–11). Then tick §6
L4-B, merge to `main`, tag `l4b`. Follow-up chip filed: keyboard nav for
search result rows (`task_bd4e47f4`).

Test counts: **422 vitest + 465 Rust** (+22 vitest / +7 Rust over
L4-A-fix.1). All six gates green on the branch:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run
build`, `npx vitest run`. L0 `l0` (2026-05-13); L1 `l1` (2026-05-09);
L2 `l2` (2026-05-22); L3 `l3` (2026-06-01); L4-A `l4a` (2026-06-03);
L4-A-fix `l4a-fix` + `l4a-fix.1` (2026-06-06).

Next after L4-B smoke+tag: **L4-C — `Cmd/Ctrl+K` Omni-Bar.**
