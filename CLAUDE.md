# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. Tauri + Rust + Solid/TS. Plain `.md` files are the absolute source of truth. No Electron, no Node, no cloud.

This is the session primer. Read it before starting any work. For deep detail, follow the Docs pointers below. If a decision here conflicts with what a session participant says, raise the conflict — don't silently override it.

---

## Docs

- **Architecture:** `docs/architecture/README.md` — locked design decisions, split by domain
- **Layer specs:** `docs/layer-N-spec.md` — intent + what landed per layer
- **Full index:** `docs/README.md` — map of every doc in the project

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

---

## Session protocol

**Start:** Read this file. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file.

**During:** As work lands, update the current layer spec's in-progress section.

**End:** Rewrite the Project state block below (4-6 lines max). Never append to it — rewrite it.

---

## Build order

**v1.0 cut at end of L5.**

0. **Bedrock.** Workspace, Tauri, libSQL, file watcher, vault scan, file-type registry, frontmatter I/O, token surface. **No UUID injection.**
1. **Document Model.** Canonical Markdown AST in Rust, Lezer in CodeMirror, `get_canonical_ast` IPC, frontmatter into libSQL.
2. **Editing.** CodeMirror + Live Preview decorations, raw-source toggle, properties UI, light + dark themes. *First demo-able milestone.*
3. **Knowledge Graph.** Wiki-links, embeds, lazy block refs, backlinks, unlinked mentions, link/tag autocomplete, nested tags + virtual tag pages, rename → Pending Rewrites Cache.
4. **Search.** Tantivy full-text, Dataview-style libSQL queries, persistent search panel, Cmd/Ctrl+K Omni-Bar.
5. **Daily-Driver Polish.** Theme picker, export sanitization, perf pass, keyboard shortcuts. **Public v1.0 cut.**
6. **Plugins.** WASI host, manifest format, Web Worker runtime, Javy/QuickJS-WASM toolchain, plugin themes, ABI deprecation framework. *(Ships before sync — the plugin ABI is a one-way door once third parties depend on it; earn a stable core first.)*
7. **Sync.** Loro CRDT; frontmatter `cubical_id` UUIDs minted at onboarding; WebRTC P2P; optional E2EE relay.
8. **Time Machine.** Sync-clean-state snapshots, version history UI, 3-way merge UI. *(Post-v1.0)*
9. **Graph View.** WebGPU-rendered knowledge graph. *(Post-v1.0)*
10. **Long tail.** Canvas, mobile, anything else. *(Post-v1.0)*

**Cut features (no for v1.x):** EOF HTML-comment UUIDs, recovery waterfall (4-tier), cross-app importers, local AI / RAG / llama.cpp as a core feature, `.cubical/quarantine/` directory.

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
├── docs/
│   ├── README.md           # docs index — start here if unsure where to look
│   ├── architecture/       # locked architectural decisions (README.md is the overview)
│   ├── layer-0-spec.md     # Bedrock (complete)
│   ├── layer-1-spec.md     # Document Model (in progress)
│   ├── migration-touchpoints.md
│   ├── vault-gitignore.md
│   └── superpowers/        # planning artifacts (specs + plans)
├── CLAUDE.md
├── Cargo.toml
└── README.md
```

Crates without Tauri deps (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`) must remain buildable and testable without the app harness.

---

## Conventions

**Rust.** Edition 2021. `cargo fmt` and `cargo clippy -- -D warnings` clean before any commit. Errors via `thiserror` for libraries, `anyhow` for the app crate. No `unwrap()` or `expect()` outside tests and `main`.

**TypeScript.** Strict mode on. No `any`. Prettier + ESLint. Solid idioms: signals for fine-grained state, stores for structured state, `createResource` for async Tauri data.

**Tauri commands.** Coarse-grained, named as verb-noun. Every command takes a typed request struct and returns a typed response struct.

**Tests.** `cubical-core`, `cubical-ast`, `cubical-index` have unit tests. The app crate has integration tests against a temp vault. UI tests deferred until L3+.

**Commits.** Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.). One logical change per commit. Layer transitions get a tag.

**Documentation.** Every public Rust item has rustdoc. Every Tauri command has a doc comment. The architecture docs in `docs/architecture/` and layer specs in `docs/layer-N-spec.md` are the canonical reference; if code disagrees, the spec wins until explicitly updated.

---

## Project state

Current layer: 2 — Editing · L2 spec drafted (`docs/layer-2-spec.md`); 6 sessions planned (A editor+decorations · B settings · C theme · D raw toggle · E properties · F closeout).
L0 closed 2026-05-13 (`l0` tag); L1 closed 2026-05-09 (`l1` tag).
Carried into L2: L1 `cargo tauri dev` interactive smoke pass — open a vault, click a `.md` file, confirm editor renders, typing fires `onAstChange`, external edits surface via `vault:file-changed`. Do this at Session A kickoff before any L2 code.
Next: L2 Session A — `write_file_text` IPC + autosave in `Editor.tsx` + Lezer-driven Live Preview decorations + external-edit conflict banner scaffolding.
Layer specs: `docs/layer-0-spec.md` (closed) · `docs/layer-1-spec.md` (closed) · `docs/layer-2-spec.md` (Session A pending)
