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

Current layer: 3 — Knowledge Graph (Sessions A + B + C + D + E done, Sessions F–K pending). Session E landed virtual tag pages end-to-end on branch `l3-session-e`. New `cubical-index::files_for_tag_prefix` runs `WHERE LOWER(tag_path) = ? OR LOWER(tag_path) LIKE ?/% ESCAPE '\\'` returning distinct `file_path`s ordered by path — case-insensitive, segment-boundary prefix (so `tag:project` matches `project/cubical` but NOT `projection`), LIKE-escapes `\`, `%`, `_` since tag bodies allow `_`. `cubical-app::commands::tags::query_tag_page` is a 3-line shim mirroring the backlinks handler shape; titles derive from `Path::file_stem()` minus `.md`. IPC types `QueryTagPage{Request,Response}` + `TagPageFile { path, title }` wired into `lib.rs`'s `invoke_handler!`. Frontend: `ui/src/TagPage.tsx` is the virtual page (header `#tag` + `← Back`, loading/error/empty/loaded states, `untrack`-protected effect mirroring Backlinks). `App.tsx` gained the first non-file `view` signal — `{ kind: "file" } | { kind: "tag"; tagPath: string }` — that the editor pane's `<Show>` switches on; selecting any file always resets to file view; opening a new vault resets too. `vault:file-changed` bumps `tagRefreshTick` while the tag view is up (no debounce; the file-list refresh already throttles). `Editor.tsx` got an `onNavigateTag` prop + a second `mousedown` capture-phase listener on `view.contentDOM` calling `handleTagClickAtPos` → `tagPathFromSlice(raw)`; `tagMousedown.ts` mirrors `wikilinkMousedown.ts` (closestTagSpan, maybeInterceptTagMousedown, tagPathFromSlice — pure, 19 helper tests). `.cm-md-tag` got `cursor: pointer`. Properties side: optional `onNavigateTag` threads through `Properties → PropertyRow → TagListCell → ChipList`; when set, chip body navigates and a new `✎` button (between body and `×`) covers edit. ChipList behaviour is unchanged when `onChipClick` is absent (every existing caller). Smoke vault: existing `~/Developer/sandbox/tag-test/` (`Inbox.md` + `Project.md` share `#project/cubical/*` for clean prefix-match demo).
Tests: 242 Rust + 252 vitest. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: **Scan perf fix (inserted before Session F)** — the bulk vault scan resolves wiki-links in O(N²) (`refresh_links`'s single-file helper reused per-file in the scan loop; `list_known_paths` re-run N times + linear `resolve_target`). Confirmed on a 30k-file vault loading in minutes vs Obsidian's seconds. Fix = one post-walk resolution pass backed by a `PathResolver` index (O(N), also fixes forward-reference resolution). Defect, not a planned deferral — see layer-3-spec §5.6. Plan: `docs/superpowers/plans/2026-05-28-l3-scan-resolution-perf-fix.md`. The separate 3× parse waste (§5.5) stays deferred to the L5 perf pass. After the fix: L3 Session F — link + tag autocomplete (build-order §3, layer spec §2.6 + §8 Session F).
