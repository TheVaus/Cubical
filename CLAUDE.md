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

Current layer: 3 — Knowledge Graph (Sessions A–F done + scan perf fix + G full + `[[#^` block-id autocomplete + H.1 + H.2 + I + **J done**; K pending).

J.2 (frontend) merges follow J.1's two-merge backend pass; together they close §6 DoD item "Rename → Pending Rewrites Cache." Spec §9.16 (`docs/layer-3-spec.md`) catalogues the frontend; §9.15 the backend.

**J.2 highlights** (full prose in spec §9.16):
- `ui/src/Toast.tsx` + sibling pure `toastState.ts` — single-slot toast (4 s auto-dismiss, dismissible, tokenised). `<ToastHost>` mounts once in `App.tsx`; every consumer routes through `showToast(message)`.
- `ui/src/statusbar/pendingRewritesLabel.ts` — pure `formatPendingRewrites(count)` mirroring `brokenRefs.ts` (singular / plural / hidden at zero). Filename diverges from spec to avoid the `PendingRewrites.tsx` case-only collision.
- `ui/src/statusbar/PendingRewrites.tsx` + pure `pendingRewritesState.ts` reducer — clickable status-bar item; click opens a popover with the per-target breakdown (`getPendingRewritesBreakdown`), "Save all pending changes" (`flushPendingRewrites`), and the last 5 rename ops (`listRecentRenameOps({ limit: 5 })`) each with an Undo button (`undoRename`). Refetches on every open; outside-click + Esc close.
- File-rename gesture in `App.tsx` — right-click a markdown row → context menu "Rename…" → inline `<input>` replaces the row's label. Enter / blur commit (`renameFile`), Esc cancels. Pure `validateRenameTarget` rejects empty / unchanged client-side; backend `InvalidRequest` (existing dest) surfaces via `showToast`.
- `App.tsx` wiring — subscribes to `onVaultPendingRewritesChanged` (updates `pendingRewritesCount` signal) + `onVaultFlushComplete` (toast `"Applied N reference update(s) across M file(s)."`; suppressed when both totals are 0). Cleanup drops both handles + resets state on `close_vault`.
- No new settings UI for `pending_rewrites.flush_interval_secs` — `setSetting(id, …, N)` from devtools is the documented affordance; dedicated settings panel deferred to K polish.

Tests: 406 Rust unchanged (J.2 adds no backend). 329 vitest baseline + 23 new = **352 vitest** (Toast 5, pendingRewritesLabel 4, fileRename 6, pendingRewritesState 8). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).

Earlier L3 (unchanged): backend block-refs (Session G, spec §9.8), frontend gesture + decoration + status bar (§9.9 + §9.10), `[[#^` block-id autocomplete (§9.11). H.1 + H.2 (embed extractor + CM6 widget, §9.12 + §9.13). Session I unlinked mentions (§9.14). J.1 backend rename / flush / count / undo IPCs + the two new events (§9.15).

Next: Session K — interactive smoke across every L3 surface (file rename, tag rename, nested tag, block-id rename, undo, external-write conflict, >50 fuse, 5-min timer, app-close mandatory flush — recipe in §9.16) + `l3` tag + L3 closeout. Hands-on smoke for J + I + H.2 + G consolidated into K. H.3 polish (rich markdown inside embed body, click nav, `⎘` retirement) remains explicitly deferred — not on §6 DoD critical path.
