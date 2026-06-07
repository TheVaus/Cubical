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
`feat/l4b-search-panel`; operator smoke pending (not yet merged/tagged).**
First UI consumer of L4-A's search IPC. A `Files | Search` segmented
toggle in the left column (persisted as `ui.left_pane_mode`) swaps the
file tree for `ui/src/sidebar/SearchPanel.tsx`: debounced query, sort +
scope chips, a virtualised fixed-height result list reusing
`computeWindow`, `<mark>`-highlighted snippets (+ relative recency), and
a polled `search_index_status` "Indexing…" banner; clicking a hit reuses
`handleNavigateWikilink`. Pure logic is unit-tested in `debounce.ts` /
`snippet.ts` / `searchQuery.ts` / `relativeTime.ts`; the component is
operator-smoke-only (no Solid render lib; Contract E).

**§5 deviation #1 resolved (option a):** `cubical-search` promotes
`headings`/`body`/`code`/`frontmatter` to `STORED` and bumps
`SCHEMA_VERSION` `1 → 2`, so Tantivy emits tokenizer-correct snippets for
every matched field. The doc writer + `collect_snippets` already handled
all fields → schema-flags + version bump only; the bump auto-fires the
existing wipe+rebuild on next open (index is derived state; `.md` is
truth). ~2-3× index disk.

**Remaining to close L4-B (Contract E — tag only after executed smoke):**
run + record the operator smoke in `docs/layer-4-spec.md` §9.3 (per-field
highlighted snippets via multi-term queries; one-time rebuild after the
version bump; the pending `open_vault` re-open `LockBusy` smoke from
2026-06-06; virtualised scroll + navigation; toggle/polling lifecycle;
`ui.left_pane_mode` persistence; indexing banner; ~2-3× disk; L4-A
recipes 1–11). Then tick §6 L4-B, merge to `main`, tag `l4b`. Follow-up
chip filed: keyboard nav for search result rows (`task_bd4e47f4`).
Single-term default-scope fuzzy is `title`-only (L4-A quirk) — smoke with
multi-term queries.

Test counts at code-complete: **421 vitest + 464 Rust** (+21 vitest /
+6 Rust over L4-A-fix.1). All six gates green on the branch:
`cargo test --workspace`, `cargo clippy --workspace --all-targets --
-D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run
build`, `npx vitest run`. L0 `l0` (2026-05-13); L1 `l1` (2026-05-09);
L2 `l2` (2026-05-22); L3 `l3` (2026-06-01); L4-A `l4a` (2026-06-03);
L4-A-fix `l4a-fix` + `l4a-fix.1` (2026-06-06).

Next after L4-B smoke+tag: **L4-C — `Cmd/Ctrl+K` Omni-Bar.**
