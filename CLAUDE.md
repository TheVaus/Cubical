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

Current layer: 3 — Knowledge Graph (Sessions A + B + C + D + E done + scan perf fix done, Sessions F–K pending). The scan link-resolution perf fix landed on branch `l3-scan-resolution-perf-fix`, closing the §5.6 O(N²) defect (see layer-3-spec §9.6). The bulk scan is now two passes: Pass 1 (the walk) hashes, upserts `files`, refreshes frontmatter + tags, and *buffers* link occurrences via the new `pub(crate)` `cubical-core::vault::links::extract_links_off_executor` (parse + extract, no resolve/no DB write); Pass 2 runs once after the walk — loads `files.path` once, builds a single `PathResolver`, resolves every buffered link in O(1) common-case, and writes `LinkRow`s in `SCAN_BATCH_SIZE`-batched transactions (cancellation honoured between files). `PathResolver` (in `links.rs`) is an exact + basename `HashMap` index with a linear suffix fallback; it preserves `resolve_target`'s exact → basename-ci → suffix-ci semantics byte-for-byte, and `resolve_target` now just delegates to it — so the single-file watcher path (`apply_watch_event_to_db` → `refresh_links`) is unchanged and `refresh_links`/`list_known_paths` stay as-is. The fix also resolves forward references on the first scan (previously a file walked before its target resolved to `NULL`). The §5.5 triple-parse is still deferred to L5 — only link *resolution* moved, extraction keeps its own parse.
Tests: 247 Rust (+5: 2 `PathResolver`, 2 `extract_links_off_executor`, 1 `scan_resolves_forward_references` — a mutual-link forward-ref anchor that's deterministically red on the old code regardless of `WalkDir` order) + 252 vitest. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: **L3 Session F — Link + tag autocomplete** (build-order §3, layer spec §2.6 + §8 Session F). Smoke note: the 30k-file vault now scans in ~10 s (was multi-minute); interactive `cargo tauri dev` smoke still pending for a hands-on opportunity (same automated-context constraint as prior sessions).
