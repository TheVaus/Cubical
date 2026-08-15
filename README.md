# Cubical

**A blazing-fast, strictly local-first Personal Knowledge Management app.**
Point it at a folder of plain `.md` files — a *vault* — and get a fast editor, a
live knowledge graph (links, backlinks, tags, embeds), and full-text + structured
search. Your Markdown files are the **absolute source of truth**; every index,
graph, and cache is derived state that can be deleted and rebuilt without losing
a byte.

No Electron. No Node.js runtime in the shipped app. No required cloud account. Built on Tauri + Rust.

> Obsidian-class local Markdown PKM — but with performance, sandboxing, and
> no-lock-in treated as architectural non-negotiables, not features.

---

## Why Cubical

Cubical answers three predictable failures of knowledge tools:

- **No lock-in.** Your content is *only* plain Markdown. The vault is fully
  portable — zip it, send it, open it elsewhere. It keeps working with the app
  uninstalled and the company gone. No app identifiers are written into your
  `.md` files (none before sync onboarding, by design).
- **Fast at scale.** Performance is a *feature*, measured at the keystroke, the
  scroll, and the search — the bar is "imperceptible." Heavy work runs in Rust,
  off the UI thread.
- **Never mangles your files.** Files survive being edited or renamed by external
  tools (vim, Finder, Dropbox) while the app is closed. The `.md` on disk is what
  you wrote, byte-for-byte.

**Who it's for:** power note-takers who own their data and think in Markdown,
wiki-links, and tags — researchers, writers, engineers, students — and
local-first believers who care about privacy, offline use, and portability.

---

## What it can do today

Cubical is built in **layers**, each a shippable increment. Layers 0–4 are built
and merged; Layer 5 (the v1.0 polish cut) is in progress.

- **Editor** — writable CodeMirror 6 editor with debounced autosave, a Live
  Preview rendering mode and a Raw Source toggle, and a Properties UI for editing
  inline frontmatter. Light/Dark themes with a CM6 theme generator.
- **Document model** — a canonical Markdown AST shared across Rust and TypeScript,
  with a cross-language parity harness so both sides agree on every parse.
- **Knowledge graph** — wiki-link parsing with click-to-navigate, a backlinks
  panel, inline + frontmatter tags (including nested) with virtual tag pages,
  link and tag autocomplete, block references (`^id`), bounded embeds, and
  unlinked mentions. Renames propagate through a pending-rewrites cache.
- **Search** — Tantivy full-text search (BM25, stemming, typo tolerance) with a
  persistent results panel and a `Cmd/Ctrl+K` Omni-Bar, plus Dataview-style
  structured queries over the libSQL index. The index lives under `.cubical/` and
  never touches your `.md` files.
- **Vault basics** — create files and folders, vault validation and scan-on-open,
  a debounced file watcher, atomic writes, and portable vault-local settings in
  `.cubical/config.toml`.

A fuller, always-current status lives in the [Master PRD](prd.md) and
[`docs/architecture/layers.md`](docs/architecture/layers.md).

### On the roadmap

Desktop is the v1 target, and macOS, Linux and Windows are all first-class — a
feature works on all three or it is not shipped. Windows support is still being
completed; how the three are kept identical is
[`docs/architecture/distribution.md`](docs/architecture/distribution.md).
Beyond v1.0: a **sandboxed
plugin system** (WASI/WASM ABI, with JS/TS as a first-class source language via
Javy/QuickJS), **local-first sync** (Loro CRDT, P2P, optional end-to-end-encrypted
relay), a **time machine** for version history, and a **WebGPU graph view**.
Mobile is deferred — but the architecture is built not to preclude it.

---

## Architecture at a glance

```
cubical/
├── crates/
│   ├── cubical-core/    # vault, file watcher, file-type registry, frontmatter I/O
│   ├── cubical-ast/     # canonical Markdown AST (no Tauri deps)
│   ├── cubical-index/   # libSQL schema and queries
│   ├── cubical-query/   # dataview-style query parser + evaluator
│   ├── cubical-search/  # Tantivy full-text search
│   ├── cubical-sync/    # CrdtBackend trait + Loro impl (sync lands later)
│   ├── cubical-engine/  # transport-free engine: commands, AppState, EventSink
│   ├── cubical-ipc/     # wire boundary: Command/Outcome/Response, dispatch()
│   ├── cubical-cli/     # `cubical` terminal frontend
│   └── cubical-app/     # Tauri app, depends on the above
├── ui/                  # Solid + TypeScript + Vite frontend
├── design-system/       # @ds — component library + canonical design tokens
├── docs/                # architecture, conventions, layer specs (start here)
└── prd.md               # the single authoritative product read
```

**Stack:** Tauri 2.x + Rust; Solid + TypeScript + Vite; CodeMirror 6 editor;
libSQL index; Tantivy search. The non-Tauri crates stay buildable and testable
without the app harness.

The defining stance — *Markdown is truth, everything else is derived* — is what
makes the vault portable and the app crash-safe: delete the index, reopen the
vault, and it rebuilds. One caveat: a rename whose referrer rewrites are still
queued is not re-derivable, so that queue is journalled to disk separately.

---

## Getting started

### Installing

**There are no pre-built installers yet.** Building from source, below, is
currently the only way to run Cubical. Signed and notarized downloads for macOS,
Windows and Linux are being built in
[#97](https://github.com/TheVaus/Cubical/issues/97); this section becomes a
download table when they land.

### Prerequisites

- **Rust** (stable) — install via [rustup](https://rustup.rs).
- **Node.js** + npm — for the Vite/Solid frontend.
- **Tauri 2 system dependencies** for your OS (WebView runtime and build tools).
  Follow the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/).

### Run in development

```bash
# 1. Install frontend dependencies
cd ui && npm install && cd ..

# 2. Launch the app with hot-reloading frontend + Rust backend
cargo tauri dev
```

`cargo tauri dev` starts the Vite dev server (`http://localhost:5173`) and the
Tauri shell together. If you don't have the Tauri CLI, install it with
`cargo install tauri-cli` (or run via `cargo tauri` if already available).

### Build a release bundle

```bash
cargo tauri build
```

This builds the frontend (`npm run build`) and packages a native app bundle for
your platform under `target/`.

### Run the checks

All project gates run from one place:

```bash
scripts/check.sh
```

This runs `cargo fmt`, `cargo clippy`, the Rust test suite, the frontend
type-check (`tsc`), the frontend tests (`vitest`), the UI build, and the docs
consistency checker. Frontend-only and Rust-only loops:

```bash
cd ui && npm test          # vitest
cargo test --workspace     # Rust
```

---

## Documentation

- [`CLAUDE.md`](CLAUDE.md) — the session primer: identity, non-negotiables, and
  current state. Start here.
- [`docs/README.md`](docs/README.md) — the documentation index and doc map.
- [`prd.md`](prd.md) — the Master PRD: what Cubical is, who it's for, what exists
  today, and what ships next.

---

## License

Cubical is released under the [MIT License](LICENSE).
