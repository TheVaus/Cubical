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

Current layer: 4 — Search (pending; not yet started).

**L3 closed 2026-06-01** (`l3` tag). Sessions A–F + the §5.6 O(N²)→O(N) scan-resolution perf fix + Session G (backend core + frontend gesture + decoration + broken-ref status-bar) + the `[[#^` in-bracket block-id autocomplete + H.1 + H.2 + I + J.1 + J.2 + K all done. Spec catalogue: `docs/layer-3-spec.md` §9.1–§9.17. Session K is no-feature-code — closeout smoke recorded in §9.17, §5 deviations promoted into `docs/architecture/document-model.md` (#1 — two-parser extension as the AST contract; #2 — `links` table schema), every §6 DoD box ticked. K smoke vault at `~/Developer/sandbox/cubical-l3-smoke/` (Daily/Project/Notes/Pinned/Refs/Aliases/Big/A→B→C→D→E + nested `notes/inbox/Stuff.md`) — reusable across closeout reruns. Hands-on interactive smoke against `cargo tauri dev` deferred under the same protocol Sessions B–J used (auto context can't drive the native Tauri window); per-surface recipes in each session's §9.x entry.

Final L3 test counts: **406 Rust + 352 vitest** (unchanged from §9.16 — K adds no code). All gates green at K close: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run build`, `npx vitest run`. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`); L3 closed 2026-06-01 (`l3`).

Deferred at L3 close: H.3 polish (rich markdown inside embed body, click nav, `⎘` retirement), K-polish (tag-chip context menu / block-ref hover menu / keyboard-shortcut rename gesture / dedicated settings UI for `pending_rewrites.flush_interval_secs`), the §5.5 triple-parse refactor (handed to L5 perf pass). None on the §6 DoD critical path.

Next: **Session L4-A — Tantivy full-text search** (per `docs/build-order.md`). L4 introduces the Tantivy index, the persistent search panel, and the `Cmd/Ctrl+K` Omni-Bar over it. L3's link + tag indexes are the substrate L4's relevance ranking layers on.
