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

Current layer: 3 — Knowledge Graph (Sessions A + B + C done, Sessions D–K pending). Session C landed the collapsible right-sidebar shell (`ui/src/RightSidebar.tsx` — panel-agnostic, `flex: 0 0 18rem` expanded / `2rem` collapsed, owns the toggle button) hosting its first occupant, the Backlinks panel (`ui/src/sidebar/Backlinks.tsx`). For the open note the panel lists every row of `links` whose `target_path` resolves to it — one row per link, source basename + a single-line ~120-byte context snippet — backed by a new `get_backlinks` IPC over a dedicated `backlinks_for(target_path) -> Vec<BacklinkRow>` query (chosen over enriching `links_to` because `links_to` has no production callers). Snippet helper: pure 120-byte window centred on `position`, newlines + whitespace runs collapsed, word-boundary polish within 16 chars of each edge, UTF-8 boundaries floor/ceil-widened so we never slice mid-codepoint. Live refresh piggybacks on `vault:file-changed` with a 200ms debounce (the spec's `vault:index-changed` is deferred until a second consumer needs it). Row clicks reuse the Session B `handleNavigateWikilink → handleSelectFile` seam so autosave / `seenHash` / `dirty` plumbing stays correct. Collapsed state persists as a new `ui.right_sidebar_collapsed` vault-local setting. Filename note: `ui/src/sidebar/backlinksState.ts` (helpers + reducer) is deliberately non-PascalCase to avoid case-collision with `Backlinks.tsx` on APFS — future sidebar panels should follow the same `<thing>State.ts` convention.
Tests: 186 Rust + 172 vitest. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: L3 Session D — Tags (parsing, index, nested tags, decoration). build-order §3, layer spec §2.4 + §8 Session D.
