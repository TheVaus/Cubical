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

**L4-A closed 2026-06-03** (`l4a` tag). Tantivy backend live: per-file index with structural fields (`title`, `headings`, `body`, `code`, `tags`, `frontmatter`, plus `mtime_secs` + `size_bytes` fast fields), `en_stem` + `code` tokenizers, five-refresher scan loop (frontmatter + links + tags + blocks + search) with 5000-doc commit boundary, watcher fan-out (create/modify → upsert; delete/rename → delete_path), four IPC commands (`search`, `search_index_status`, `search_rebuild_index`, `search_get_health`) with `vault_id`-keyed envelopes + TS wrappers. Schema-version stamp at `<vault>/.cubical/search/schema.json` (v1); mismatch wipes + rebuilds. L4-A smoke vault at `~/Developer/sandbox/cubical-l4a-smoke/` (L3 carry-over + `code/rust_examples.md` + `code/python_examples.md` + `data/frontmatter_rich.md` + `Aliased Note.md`). Spec: `docs/layer-4-spec.md` §9.1; design: `docs/superpowers/specs/2026-06-02-l4-a-tantivy-design.md`.

Final L4-A test counts: **458 Rust + 356 vitest** (+52 Rust / +4 vitest over L3 close). All gates green: `cargo test --workspace`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `npx tsc --noEmit`, `npm run build`, `npx vitest run`. L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`); L3 closed 2026-06-01 (`l3`); L4-A closed 2026-06-03 (`l4a`).

Deferred at L4-A close: persistent panel UI (L4-B), `Cmd/Ctrl+K` Omni-Bar (L4-C), Dataview-style libSQL queries (L4-D), regex / NEAR / date-range query syntax (out of L4 scope), multi-term fuzzy (L4-D), snippet coverage on non-stored fields (§5 deviation #1 — L4-B picks store-more vs re-read), interactive smoke against `cargo tauri dev` (same protocol as L3 — recorded recipes in §9.1), perf benchmark numbers (driver lives at `crates/cubical-search/examples/bench.rs`; 30k-vault Tantivy index not built on this machine). L3-close deferrals (H.3 polish, K-polish, §5.5 triple-parse) still live — none on the §6 critical path.

Next: **Session L4-B — persistent left-panel search results UI** (per `docs/build-order.md`). L4-B is the first consumer of L4-A's IPC; resolves the snippet-stored-field limitation when the panel's UX requirements lock down.
