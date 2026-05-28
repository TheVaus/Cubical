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

Current layer: 3 — Knowledge Graph (Sessions A + B + C + D + E + F done + scan perf fix done, Sessions G–K pending). Session F landed link + tag autocomplete on branch `l3-session-f-autocomplete` (see layer-3-spec §9.7). Typing `[[` opens a CM6 dropdown over markdown files (insert `[[path]]`, caret after `]]`); typing `#` at a word boundary outside code opens a tag dropdown (insert `#tag`). Backend: two read-only index helpers — `cubical-index::links::files_for_link_query` (markdown paths, case-insensitive substring) and `tags::tag_paths_for_prefix` (distinct tags, case-insensitive prefix), both `LIKE`-escaping `_`/`%`/`\`; two pure handlers `cubical-app::commands::autocomplete::{link_autocomplete, tag_autocomplete}` (mirror `query_tag_page`, `AUTOCOMPLETE_LIMIT = 50`); wire types + two Tauri shims in `lib.rs`. Frontend: `ui/src/api/ipc.ts` bindings; `ui/src/editor/autocomplete.ts` (pure `detectLinkTrigger`/`detectTagTrigger`/`linkInsertion`/`isInhibited` + the two CM6 `CompletionSource`s with `validFor`); `ui/src/editor/autocompleteProvider.ts` (`createAutocompleteProvider`, mirrors `createWikiLinkResolver`); `Editor.tsx` installs `autocompletion({override})` in a compartment reconfigured on a new `autocompleteProvider` prop; `App.tsx` holds the provider signal, sets on open + clears on reset, passes to `<Editor>`. Scope = the §8 DoD (files + tags + gating); in-bracket heading/block-id completion (`[[target#…`) is deferred to a post-G session (needs G's `blocks` table). "Outside code" gating walks the Lezer ancestor chain (rejects FencedCode/CodeText/InlineCode/Comment/HTML*, plus WikiLink for the tag source). No provider-side cache (CM6 `validFor` filters between keystrokes).
Tests: 256 Rust (+9: 3 `files_for_link_query`, 3 `tag_paths_for_prefix`, 3 autocomplete handlers) + 268 vitest (+16 in `autocomplete.test.ts`). L0 closed 2026-05-13 (`l0`); L1 closed 2026-05-09 (`l1`); L2 closed 2026-05-22 (`l2`).
Next: **L3 Session G — Block references** (build-order §3, layer spec §2.7 + §8 Session G). Smoke note: interactive `cargo tauri dev` smoke for autocomplete (`[[`/`#` dropdowns + insertion + no-trigger-in-code-fence) still pending a hands-on opportunity (automated-context constraint); logic is fully unit + headless-tested.
