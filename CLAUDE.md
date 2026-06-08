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

**L4-C — `Cmd/Ctrl+K` Omni-Bar — CLOSED 2026-06-08, tagged `l4c`, merged
to `main`.** A keyboard-summoned fuzzy navigator over **notes + tags**
(headings + commands deferred). Client-side ranking (Approach A) over in-memory
sources — instant + typo-tolerant, sidestepping L4-A's title-only
backend fuzzy. `ui/src/omnibar/ranker.ts` (pure: `OmniItem`,
`fuzzyMatch` code-point subsequence, `scoreMatch` fzf-style,
`approxSubstringDistance` edit-distance for **real typo tolerance**
(substitutions, not just skips — added after first smoke when `ricj`
missed `rich`), `rankItems` subsequence-then-bounded-fuzzy with
subsequence tiered above; +21 vitest) feeds `OmniBar.tsx` (modal:
auto-focused input, unified `listbox`, kind badge + matched-char
highlights + path subtitle, ↑/↓/Enter/Esc, recent-notes empty state;
a11y: dialog/listbox/option + `aria-activedescendant` + focus-on-open /
restore-on-close; operator-smoke-only, Contract E). One new IPC
`list_tags { vault_id } -> { tags }` (`cubical-index::all_tag_paths`
distinct set → `cubical-app` command; +3 Rust). `App.tsx` wires the
global hotkey (no-op without a vault), a lazy tag cache invalidated on
`searchRefreshTick`, and Enter → `handleNavigateWikilink` /
`handleNavigateTag`. Spec
`docs/superpowers/specs/2026-06-08-l4-c-omnibar-design.md`; plan
`docs/superpowers/plans/2026-06-08-l4c-omnibar.md`; closeout §9.4.

**Search typo tolerance — SHIPPED 2026-06-08, tagged `l4a-fix.2`, merged
to `main`** (the `task_256abd1c` cross-field-fuzzy item — done). The L4-B
search bar wasn't typo-tolerant: a wrong letter (`ricj` for `rich`)
returned nothing, because L4-A's fuzzy was `title`-only so the panel sent
`fuzzy:false`. `cubical-search` `build_fuzzy_query` now adds an
edit-distance-1 (Damerau) `FuzzyTermQuery` across **all** scope fields,
OR'd with the exact+prefix query (exact still ranks top via BM25); single
term ≥4 chars only. Panel flipped to `fuzzy:true`
(`searchQuery.ts`). Caveat: a purely-typo'd word may not get a `<mark>`
(Tantivy highlights the literal typed term). Test:
`single_term_fuzzy_spans_all_fields`.

**L4-B — CLOSED 2026-06-08, tagged `l4b`, merged to `main`.** Persistent
left-panel search: bar above the file tree, filter popover (sort+scope),
results **grouped by file** (collapsible header + match-count badge +
`<mark>` cards + "N results"), ✕ clear button, polled indexing banner.
§5 deviation #1 resolved (option a: prose fields `STORED`,
`SCHEMA_VERSION` 1→2 auto-fires wipe+rebuild). Pure logic unit-tested
(`resultGroups`/`snippet`/`searchQuery`/`debounce`/`relativeTime`);
component operator-smoke-only.

**Operator smoke (record):** the operator drove `cargo tauri dev` across
the session, which surfaced three fixes that landed — Omni-Bar needed
real (substitution) typo tolerance; the search bar needed the
cross-field backend fuzzy; and `Cmd/Ctrl+K` "did nothing" was a
checkout-on-the-wrong-branch artifact (resolved by merging both branches
to `main`). After merging + tagging, the operator **confirmed the merged
`main` build works** (Cmd/Ctrl+K opens + navigates; the search bar finds
typos) — L4-C + `l4a-fix.2` fully closed.

**Carried forward to L4 layer-close (after L4-D):** L4-B's
not-formally-smoked items — version-bump rebuild, `open_vault` re-open
`LockBusy` (line **not** flipped), indexing banner on a big vault, ~2-3×
disk, L4-A recipes 1–11. Open chips: keyboard nav for search rows
(`task_bd4e47f4`); **per-occurrence snippet cards** (`task_b5f2f1ef` —
the remaining half of the old `task_256abd1c`, whose fuzzy half shipped
as `l4a-fix.2`).

Test counts: **447 vitest + 468 Rust** (L4-C: +22 vitest, +3 Rust;
search fuzzy: net 0). All six gates green on merged `main`: `cargo test
--workspace`, `cargo clippy --workspace --all-targets -- -D warnings`,
`cargo fmt --all --check`, `npx tsc --noEmit`, `npx vitest run` (447),
`npm run build`. L0 `l0` (2026-05-13); L1 `l1` (2026-05-09); L2 `l2`
(2026-05-22); L3 `l3` (2026-06-01); L4-A `l4a` (2026-06-03); L4-A-fix
`l4a-fix` + `l4a-fix.1` (2026-06-06); L4-B `l4b` (2026-06-08); L4-C
`l4c` + search-fuzzy `l4a-fix.2` (2026-06-08).

Next: **L4-D — Dataview-style libSQL queries** (the final L4 session).
Kickoff prompt: `docs/superpowers/2026-06-08-l4d-kickoff.md`.
