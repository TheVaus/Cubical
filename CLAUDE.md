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

Current layer: 3 — Knowledge Graph (Sessions A + B + C + D done, Sessions E–K pending). Session D landed inline + frontmatter tag parsing end-to-end. Rust `cubical-ast` got a hand-rolled `scan_tags` tokenizer (`tag.rs`) plus an `Inline::Tag { path }` variant; the TS side has `ui/src/ast/tag.ts` as a byte-for-byte mirror. Normalize's old `split_wikilinks` was renamed `split_inlines` on both sides and now chains wiki-link splitting followed by tag splitting over every `Inline::Text`. New libSQL migration `004_tags.sql` adds `tags(file_path, tag_path, source)` with the locked PK + `idx_tags_path`; `cubical-index/src/tags.rs` exposes `TagRow`, `TagSource { Inline | Frontmatter }`, `replace_tags_for_file` (`INSERT OR IGNORE` so duplicate triples collapse), and `tags_for_file`. Extraction in `cubical-core/src/vault/tags.rs` walks the AST for inline tags + reads `Frontmatter.entries["tags"]` for sequence / scalar / leading-`#` forms; within a file we dedupe by `(lowercase(tag_path), source)` and keep the first-seen casing (case-preserving display, matching the spec). `vault::scan` + `apply_watch_event_to_db` now call `refresh_tags` after `refresh_links` with the same best-effort error policy. Lezer rule (`ui/src/editor/tag.ts`) emits a single `Tag` node mirroring the byte tokenizer; decoration paints accent-coloured `mark-tag` chips off the cursor line, muted on it. Smoke vault: `~/Developer/sandbox/tag-test/`. Six new parity fixtures pin cross-language behaviour. Grammar locked: word-boundary `#` (run-start or after ASCII whitespace), body starts with letter or `_` (no leading digit), continuation `[A-Za-z0-9_-]`, nesting via `/`+non-empty-segment.
Tests: 228 Rust + 231 vitest. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: L3 Session E — Virtual tag pages (`tag:` route + libSQL-backed prefix-match listing). build-order §3, layer spec §2.5 + §8 Session E.
