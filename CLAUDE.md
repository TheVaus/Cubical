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

**L4-B — persistent left-panel search UI — CLOSED 2026-06-08, tagged
`l4b`, merged to `main`.** Grouped-results rework + ✕ clear button added
2026-06-08 on operator request; operator confirmed search/grouping/clear
interactively and elected to tag (see §9.3 closeout for the honest
smoke record + carried-forward items). First UI consumer of L4-A's search IPC.
A persistent search bar sits above the file tree in the left column;
`ui/src/sidebar/SearchPanel.tsx` renders the tree (App's `children`)
below 3 chars and replaces it with results at/over 3 chars — debounced
query, sort+scope in a filter **popover** to the right of the bar,
results **grouped by file** (Obsidian-core-search style: collapsible
title header + match-count badge + one `<mark>` snippet card per matched
field, "N results" line, chevron collapse, title/card click opens), a
polled `search_index_status` "Indexing…" banner; an inline clear (✕)
button in the search box empties+refocuses it; clicking a hit reuses
`handleNavigateWikilink`. `min-width: 0` runs down the column so long
text never widens the 18rem sidebar. Pure logic unit-tested in
`debounce.ts` / `snippet.ts` / `searchQuery.ts` / `relativeTime.ts` /
`resultGroups.ts`; the component is operator-smoke-only (no Solid render
lib; Contract E).

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

**Grouped results (2026-06-08):** `resultGroups.ts` (`buildFileGroups`,
+7 vitest) maps each `SearchHit` → a `FileGroup` of ordered snippet
cards; `SearchPanel` renders collapsible per-file groups. Virtualisation
removed for the grouped view (variable-height groups; list capped at 50
files, rendered directly; `computeWindow` still used by App's tree).
Dead `pickSnippet` deleted (−4 tests). **Deferred to an L4-A search
revisit** (chip `task_256abd1c`): (a) typo-tolerance — generalise backend fuzzy
across all fields (today `title`-only → `fuzzy:false`), the
Obsidian-Omnisearch behaviour the operator wants; (b) per-occurrence
cards (one card per match *location* — Tantivy yields one fragment/field
today).

**Carried forward from L4-B (not formally smoked — do at L4 layer-close /
L4-C kickoff):** one-time wipe+rebuild on opening a SCHEMA_VERSION-1
vault; the `open_vault` re-open `LockBusy` smoke from 2026-06-06 (still
pending — line **not** flipped); indexing banner on a large vault; ~2-3×
disk; L4-A recipes 1–11. Open follow-up chips: keyboard nav for search
result rows (`task_bd4e47f4`); cross-field fuzzy + per-occurrence cards
(`task_256abd1c`).

Test counts: **425 vitest + 465 Rust** (frontend-only grouping pass: +7
−4 vitest, 0 Rust). All six gates green on the branch:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run
build`, `npx vitest run` (cargo gates unaffected by the frontend change;
re-confirmed tsc/vitest/build 2026-06-08). L0 `l0` (2026-05-13); L1 `l1`
(2026-05-09); L2 `l2` (2026-05-22); L3 `l3` (2026-06-01); L4-A `l4a`
(2026-06-03); L4-A-fix `l4a-fix` + `l4a-fix.1` (2026-06-06); L4-B `l4b`
(2026-06-08).

Next: **L4-C — `Cmd/Ctrl+K` Omni-Bar.**
