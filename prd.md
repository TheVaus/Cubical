# Cubical — Master PRD

> A single authoritative read on Cubical: what it is, who it's for, why it's
> built this way, what exists today, and what ships next. This is a **synthesis**
> of the canonical docs (`CLAUDE.md`, `docs/architecture/`, `docs/build-order.md`,
> the layer specs); where it disagrees with them, **they win** — owning docs are
> linked inline. Layers 0–4 are built & merged; Layer 5 (the v1.0 cut) is in
> progress. Canonical status, tags and dates →
> [`build-order.md`](docs/build-order.md).

**Contents:** [1 Summary](#1-summary) · [2 Problem](#2-problem--users) ·
[3 Principles](#3-principles-non-negotiables) · [4 Mental model](#4-how-it-works--mental-model) ·
[5 Architecture](#5-architecture) · [6 What exists today](#6-what-exists-today) ·
[7 v1.0 / Layer 5](#7-road-to-v10--layer-5) · [8 Post-v1.0](#8-post-v10-roadmap) ·
[9 Out of scope](#9-out-of-scope) · [10 Quality & gates](#10-quality--gates) ·
[11 Open questions](#11-open-questions--debt) · [12 Glossary](#12-glossary)

---

## 1. Summary

**Cubical is a blazing-fast, strictly local-first Personal Knowledge Management
(PKM) app.** Point it at a folder of plain `.md` files (a "vault") and get a fast
editor, a knowledge graph (links, backlinks, tags, embeds), and full-text +
structured search. The defining stance: **your Markdown files are the absolute
source of truth** — search indexes, the link graph, and caches are *derived state*
that can be deleted and rebuilt without losing a byte (the one exception being a
rename's queued referrer rewrites, which are journalled separately). No Electron,
no Node.js runtime in the shipped app, no required cloud account.

- **Platform (v1):** desktop only (macOS/Windows/Linux), via Tauri.
- **Stack:** Tauri 2.x + Rust; Solid + TypeScript + Vite; CodeMirror 6 editor;
  libSQL index; Tantivy search.
- **Positioning:** Obsidian-class local Markdown PKM — but with performance,
  sandboxing, and no-lock-in treated as architectural non-negotiables, not
  features.

> Owners: identity → [`CLAUDE.md`](CLAUDE.md); stack → [`foundation.md`](docs/architecture/foundation.md).

---

## 2. Problem & users

Cubical answers three predictable failures of knowledge tools:

1. **Lock-in** (proprietary formats / inaccessible cloud DBs) → content is *only*
   plain Markdown; the vault works with the app uninstalled and the company gone.
2. **Sluggishness at scale** → performance is a *feature*, measured at keystroke,
   scroll, and search; the bar is "imperceptible." Heavy work runs in Rust, off
   the UI thread.
3. **Fragility / broken trust** (tools that mangle files or lose external edits) →
   files survive external edits/renames while the app is closed; no app
   identifiers are written into `.md` files before sync onboarding (Layer 7).

**Target users:** power note-takers who own their data and think in Markdown,
wiki-links, and tags (researchers, writers, engineers, students); local-first
believers (privacy, offline, portability); eventually developers extending via a
sandboxed plugin ecosystem. **Not v1:** mobile-first users, centralized-cloud
teams, and users wanting cross-app import baked into core (left to plugins).

> Owner: [`foundation.md`](docs/architecture/foundation.md) §1.

---

## 3. Principles (non-negotiables)

Load-bearing decisions; changing one is an architecture event, not a code change.

1. **Plain `.md` is the absolute source of truth** — derived state (index,
   caches) is rebuildable from it, with one exception: the pending-rewrites
   queue, which is why a durable rename journal exists. User config
   (`config.toml`, `themes/`) is neither derived nor rebuildable.
2. **The vault is 100% portable** — no external service needed to open it; you
   can zip it and send it.
3. **Performance is measured, not asserted** — a cold scan-and-index of a
   10,000-note vault stays under 13 s, a 1,000-note vault under 1.5 s.
4. **No Electron, no Node runtime, no centralized cloud DB** for core storage
   **in the shipped product** — Node is build-time tooling (Vite, npm) only.
5. **Files survive external edits** in vim/Finder/Dropbox while the app is closed.
6. **No file-identity UUIDs in any `.md` before Layer 7** — the vault is yours
   byte-for-byte until sync onboarding.
7. **Third-party plugins are sandboxed** — the ABI is WASI/WASM; JavaScript is a
   *source language* (compiled to WASM via Javy/QuickJS), never an unsandboxed
   runtime. First-party features may use native capabilities, but a **gateway**
   — one handing an unsandboxed capability to arbitrary external code, as the
   embedded terminal does — must be opt-in/default-off, unable to compromise
   vault integrity when abused, and auditable.
8. **Desktop only for v1** — mobile deferred, but architecture must not preclude it.
9. **Most features are composable on/off blocks** — most, not all. A small
   always-on substrate (vault, AST, index, IPC) underpins toggleable blocks that
   switch off cleanly without touching `.md`. Blocks form a dependency graph
   (backlinks need the link index, etc.).

> Owner: [`CLAUDE.md`](CLAUDE.md); composability → [`foundation.md`](docs/architecture/foundation.md) §1.

---

## 4. How it works — mental model

### 4.1 The vault

A user-chosen directory; Cubical doesn't own the location.

```
<vault>/
├── any/folders/you/want/   # your .md notes, organized however you like
├── .assets/                # binary assets, deduped per-vault by SHA-256 hash
└── .cubical/               # the ONLY state Cubical owns inside the vault
    ├── index.db            # libSQL: metadata, links, tags  (rebuildable cache)
    ├── config.toml         # durable per-vault settings  (source of truth, NOT rebuildable)
    ├── themes/             # user CSS themes  (L5+)
    └── recovery/           # pre-merge safety snapshots  (L7+)
```

`.cubical/` holds two kinds of state: **durable config** (`config.toml` — theme,
editor defaults, enabled core plugins; resets to defaults if deleted; travels
with the vault) and **rebuildable cache** (`index.db`, search, recovery — delete
it, reopen, and the vault is fully functional again, just without history).
Assets dedupe **per-vault only** (cross-vault/global folders are rejected — they
break portability).

> Owner: [`vault.md`](docs/architecture/vault.md) §3, §9.

### 4.2 File identity (changes once, deliberately)

- **Layers 0–6 (v1.0): path-based.** No UUIDs in user files. Renames detected via
  the watcher and reconciled through the **Pending Rewrites Cache**; closed-app
  renames fall back to inode + content-hash heuristics.
- **Layer 7 (sync): frontmatter UUIDs.** On sync opt-in, Cubical mints
  `cubical_id: <uuid>` into each file's YAML — the single batch-write moment in a
  vault's life, framed as "enabling sync" (OS mtime captured and restored around
  the write).

**Export sanitization:** before any export (PDF/HTML/copy-as-Markdown) the
`cubical_id` is stripped from the in-memory buffer; pre-L7 there's nothing to
strip (identity function).

> Owner: [`vault.md`](docs/architecture/vault.md) §4.

### 4.3 Canonical AST

A single normalized Markdown AST (`cubical-ast` crate). Editor Lezer trees are
normalized into it on the Rust side, and **every non-editor system** (indexer,
link resolver, backlinks, exporter, future plugin host) consumes it — killing the
"different parsers see different documents" bug class. A **cross-language parity
contract** keeps the Rust parser and the editor's Lezer grammar in lockstep. The
editor's Live Preview rendering is a sanctioned exception (reads Lezer directly
for byte-precise marker hide/reveal). The AST is intentionally **slim** — only the
Markdown subset Cubical produces; no math/mermaid/callouts/footnotes in v1.

> Owner: [`document-model.md`](docs/architecture/document-model.md) §5.5.

### 4.4 Knowledge graph

- **Wiki-links:** `[[target]]`, `[[target|display]]`, `[[target#heading]]`,
  `[[target#^block-id]]`. Resolved via libSQL link index; resolution order is
  locked (exact path → unique basename → unique suffix; ambiguity → unresolved but
  still surfaced in UI).
- **Embeds:** `![[target]]` inlines a note/section/block; recursive but bounded
  (default max depth 4).
- **Block references:** `^block-id` on a paragraph/list item, **lazily** created
  only when first referenced (never bulk-stamped).
- **Tags:** `#tag` inline or `tags: [...]` frontmatter, one index; nested via `/`;
  case-insensitive match, case-preserving display; parent prefix-matches
  descendants.
- **Virtual tag pages:** auto-generated from a libSQL query, not real `.md`.
- **Backlinks & unlinked mentions** in the right sidebar.

### 4.5 Pending Rewrites Cache

Renaming a heavily-linked file/tag could trigger hundreds of synchronous writes.
Instead the rename is **instant for the user** and disk rewrites are **deferred**:
enqueued in libSQL (grouped per rename op); **reads materialize** (every read
applies pending rewrites in order, so UI/index/export always see correct content);
flushed on a timer (default 5 min), on app close, when one file's count > 50, or on
user command. Status bar shows the unflushed count; undo is instant within the
window.

> Owner: [`document-model.md`](docs/architecture/document-model.md) §5.2–5.7.

---

## 5. Architecture

### 5.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Shell / backend | **Tauri 2.x + Rust** | No Electron/Node runtime ships (Node is build-time only); strict IPC allowlist; heavy work in Rust |
| Frontend | **Solid + TS + Vite** | Fine-grained reactivity; clean interop with DOM-owning libs |
| Editor | **CodeMirror 6 + Lezer** | Input/IME/a11y + incremental Markdown parsing for Live Preview |
| Measurement / virtualization | **Pretext** | Height/layout for the editor scroller & large lists |
| Canonical AST | **`cubical-ast`** | One document interpretation across the system |
| Metadata & index | **libSQL** (`.cubical/index.db`) | Embedded SQLite fork; native vector + future network mode |
| Full-text search | **Tantivy** | Rust-native BM25, stemming, typo tolerance; indexes the AST |
| CRDT (L7) | **Loro** | Native movable trees; behind a `CrdtBackend` trait |
| Graph render (L9) | **WebGPU** | 60fps on 100k-node graphs |

Local AI is **out of core scope** — delegated to plugins (libSQL vector storage is
available to them). > Owner: [`foundation.md`](docs/architecture/foundation.md) §2.

### 5.2 Crates

`cubical-core` (vault, watcher, file-type registry, frontmatter I/O) ·
`cubical-ast` (canonical AST, no Tauri deps) · `cubical-index` (libSQL schema &
queries) · `cubical-search` (Tantivy, L4) · `cubical-sync` (`CrdtBackend` +
Loro, L7) · `cubical-app` (Tauri app). All non-app crates stay buildable/testable
without the Tauri harness. `ui/` is the Solid frontend. > Owner: [`docs/README.md`](docs/README.md).

### 5.3 Concurrency — three lanes

Crossing a lane is an explicit, designed event. **Lane 1 (webview):** CodeMirror,
Pretext, Solid, DOM, input — owns in-memory state for focused notes only.
**Lane 2 (Rust async / Tokio):** all disk & DB work — indexing, libSQL, file I/O,
AST normalization, pending-rewrites flush, export, CRDT merges (L7).
**Lane 3 (Web Workers):** reserved for WASM plugins (L6). *(Future Lane 4: headless
Wasmtime host, same WASI ABI, only if needed.)*

**IPC:** Tauri commands are the Lane 1↔2 boundary — **coarse-grained**, with
**typed request/response structs**, every per-vault command carrying an explicit
`vault_id` (nothing implicitly scoped to a "current" vault). Streaming (search-as-
you-type) uses Tauri events. > Owner: [`concurrency.md`](docs/architecture/concurrency.md) §6.

### 5.4 UI

Left panel (universal "+", virtualized file explorer, persistent search) ·
central workspace (tab bar + split-pane, unified Live Preview editor) · right
sidebar (backlinks + unlinked mentions) · status bar (indexer progress, vault
health, pending-rewrites count, sync state post-L7). Global triggers: `Cmd/Ctrl+K`
Omni-Bar, `[[` link autocomplete, `#` tag autocomplete, drag-and-drop assets.
**Live Preview is the only normal mode** (cursor line shows raw, others render); a
Raw Source toggle exists. **Multi-vault:** one vault per window, multiple windows;
cross-vault search/tabs/palette out of scope. **Theming:** one CSS-variable token
surface (`tokens.css`, lint-enforced, no hardcoded colors elsewhere); built-in
Light/Dark; user themes from `.cubical/themes/`; the CM6 theme is generated from
the same tokens; live `data-theme` switch with no reload. > Owner: [`ui.md`](docs/architecture/ui.md) §11–12.

---

## 6. What exists today

Built in **layers**, each a shippable increment. **v1.0 cuts at the end of Layer
5.** Layers 0–4 built & merged; L5 in progress. > Canonical status/tags/dates →
[`build-order.md`](docs/build-order.md); per-layer detail → `docs/layer-N-spec.md`.

| Layer | Status | Delivered |
|---|---|---|
| **0 Bedrock** | ✅ closed | Tauri scaffold, libSQL + migration system, debounced file watcher, vault validation + scan-on-open, file-type registry, frontmatter I/O, atomic writes, typed Tauri command surface, token scaffold. **No UUID injection.** |
| **1 Document Model** | ✅ closed | Canonical AST (`cubical-ast`), Lezer grammar, `get_canonical_ast` IPC, frontmatter→libSQL, TS normalizer, cross-language parity harness. |
| **2 Editing** *(first demo-able)* | ✅ closed | Writable editor + debounced autosave, Live Preview decorations, Raw Source toggle, Properties UI (inline frontmatter editor), Light/Dark themes + CM6 theme generator, vault-local settings (`config.toml`), external-edit conflict policy + watcher feedback-loop suppression. |
| **3 Knowledge Graph** | ✅ closed | Wiki-link parsing + index, link rendering + click-to-navigate, backlinks panel + right sidebar, tags (inline/frontmatter, nested), virtual tag pages, link + tag autocomplete, lazy block references + `^id` gestures, bounded embeds, unlinked mentions, rename → Pending Rewrites Cache. |
| **4 Search** | ✅ merged (`l4` close-tag pending operator smoke) | Tantivy full-text (BM25, stemming, typo tolerance; prose fields stored for correct highlights), persistent left-panel results UI, `Cmd/Ctrl+K` Omni-Bar, Dataview-style structured libSQL queries. Index lives under `.cubical/search/` with a schema-version stamp (mismatch → wipe & rebuild); never touches `.md`. |

**Also merged / in flight (per `CLAUDE.md` Project state):** create files + folders
(migration 007, `create_file`/`create_folder` IPCs, tree-header buttons);
**property-reference interpolation** (shipped, default-on `plugins.property_refs_enabled`)
— inline read-only display of a frontmatter scalar, `[[Gandalf.age]]` (cross-file)
and `[[.age]]` (self), raw scalar, no dependency on typed properties; configurable
status bar (awaiting smoke); **typed properties** (inline `# type:` comments) merged
to `main` but **defaulted off** — the inline-comment storage puts app metadata in
`.md` against the non-negotiables, so it's parked pending a vault-level type
registry. > Owner: [`planned.md`](docs/architecture/planned.md) §14.

---

## 7. Road to v1.0 — Layer 5

**Daily-Driver Polish** = the public v1.0 cut; four **independent** surfaces shipped
incrementally. > Owner: [`2026-06-25-layer-5-...-design.md`](docs/superpowers/specs/2026-06-25-layer-5-daily-driver-polish-design.md).

1. **Theme picker** (Settings ▸ Appearance) — two orthogonal axes: **mode**
   (`light|dark|system`, default `system`) and **theme/skin** (`default|<user>`,
   default `default`). A Rust IPC scans `.cubical/themes/*.css`; selecting a skin
   injects a managed `<style>` after `tokens.css`. *Load-bearing:* after either
   axis changes, re-read computed tokens and regenerate the CM6 theme so the
   editor never desyncs. *Out:* font overrides, High-Contrast, plugin themes (L6).
2. **Export** — `export.copyMarkdown` copies the active note's *materialized*
   content (pending rewrites applied) via the existing read path, plus a reserved
   **sanitize seam** (identity pre-L7; strips `cubical_id` at L7). No standalone
   sanitize module built now. *Out:* HTML/PDF, selection-scoped copy.
3. **Keyboard shortcuts — command/keymap registry** (the one new substrate, in
   `core/`). A command `{id, title, run(), when?()}` + bindings mapping a key to a
   command id within a scope (`global|editor`). The CM6 keymap is generated from
   editor-scope bindings (one source of truth); a dev-time test forbids duplicate
   keys per scope. *Landed:* registry types + binding table, key-chord matching,
   `when()`-guarded resolver, and **user-remappable bindings** (per-vault
   `shortcuts.overrides`) — the last of these shipped 2026-07-06, beyond the
   original v1 scope. *Out:* command palette, `?` cheat-sheet.
4. **Perf pass** — fix the four still-open anti-patterns: N+1 in vault scan,
   full-tree decoration walk, row-at-a-time INSERTs, sequential async. *Bar:* a
   scan benchmark harness now exists and performance is held to a measured
   number — see [`foundation.md`](docs/architecture/foundation.md) §1
   (commitment 2). > Owner: [`anti-patterns-2026-06-01.md`](docs/anti-patterns-2026-06-01.md).

**Cut bar — L5 done when:** mode×skin switch live with CM6 in sync; registry owns
app-level shortcuts (scattered handlers consolidated); Copy-as-Markdown works with
the sanitize seam reserved; all four anti-patterns removed; all gates green
(`scripts/check.sh`); docs updated (build-order row + tag, architecture where
behavior changed, a `layer-5-spec.md` record).

---

## 8. Post-v1.0 roadmap

Order is deliberate. > Owner: [`build-order.md`](docs/build-order.md); [`planned.md`](docs/architecture/planned.md).

- **L6 Plugins** *(before sync — the ABI is a one-way door once third parties
  depend on it).* WASI/WASM host, manifest, Web Worker runtime, Javy/QuickJS
  toolchain, plugin themes, ABI deprecation framework. ABI is integer-versioned
  (runtime `N` accepts `N`, `N-1`, `N-2`). Rust native; AssemblyScript/Zig/Go/C via
  WASI; **JS/TS first-class** via Javy/QuickJS (~2–5× overhead, invisible for typical
  plugins) — the ecosystem unlock. Permissions are granular, explicit, per-plugin
  (network off by default, no escalation, revocable); plugins read files through the
  Cubical capability (materialized content), not raw WASI fs.
- **L7 Sync.** Loro CRDT; `cubical_id` UUIDs minted at onboarding; WebRTC P2P;
  optional E2EE relay (holds encrypted blobs only). Per-note op logs in libSQL,
  bounded by snapshot + compaction; two-tier asset pipeline.
- **L8 Time Machine** *(post-v1.0).* Snapshots at **sync-clean state** (zero pending
  ops + zero unsaved buffers), content-addressed; version-history + restore + 3-way
  merge UI. (Pre-L7, `.cubical/recovery/` is the simpler safety substrate.)
- **L9 Graph View** *(post-v1.0).* WebGPU knowledge graph, 60fps at 100k nodes.
- **L10 Long tail** *(post-v1.0).* Canvas, mobile, etc.

---

## 9. Out of scope

Deliberate "no," not "later": centralized cloud DB for core storage; cross-vault /
global asset dedup; proprietary content formats (**Markdown only**); required user
accounts; JS runtimes bypassing the WASM sandbox; cross-app importers (Obsidian/
Logseq/Notion — left to community plugins); local AI/RAG/embeddings as a **core**
feature (plugin concern; libSQL vectors exposed to plugins); telemetry shipping
content/filenames/structure off-device (opt-in crash/usage stats may be separate).

**Retired ideas** (don't re-litigate): EOF HTML-comment UUIDs (→ frontmatter UUIDs
at L7); 4-tier external-edit recovery waterfall (→ `.cubical/recovery/`);
`.cubical/quarantine/` (→ file-type registry covers it). > Owner: [`constraints.md`](docs/architecture/constraints.md).

---

## 10. Quality & gates

- **Quality:** production-ready; SRP (one concern per unit); respect layer
  boundaries (route through the IPC/API surface).
- **Rust:** edition 2021; `cargo fmt` + `clippy -D warnings` clean; no
  `unwrap()`/`expect()` outside tests/`main`; `thiserror` (libs) / `anyhow` (app).
- **TypeScript:** strict, no `any`, Prettier + ESLint, Solid idioms.
- **Tauri commands:** coarse-grained, verb-noun, typed structs.
- **Tests (current gate):** core/ast/index unit-tested; app crate
  integration-tested against a temp vault; UI vitest since L3. Counts are a
  query, not a documented fact — run `scripts/check.sh`.
- **Gate:** `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) — all
  green.
- **Doc discipline:** every fact has one owner; others link, never restate
  (enforced by `scripts/check_docs.py`).
- **Smoke:** interactive `cargo tauri dev` for any rendered/interactive change; a
  recorded operator runbook gates each layer tag at close.

> Owner: [`conventions.md`](docs/conventions.md); doc rules → [`docs/README.md`](docs/README.md).

---

## 11. Open questions & debt

**Deferred to their go-live layer:** CRDT op-log compaction params (L7); encryption
at rest for `index.db`/`recovery/` (reserved, must not be precluded); i18n (string
layer reserved, translations post-v1.0); license / business model (MIT placeholder,
revisited before the L5 beta cut); `index.db` backup/corruption-recovery story;
sync network details (NAT/STUN/TURN, relay, keys) at L7.

**Parked:** typed properties — shipped but defaulted off; awaits a vault-level type
registry in `.cubical/` before promotion (inline-comment storage violates the
"no app metadata in `.md`" rule).

**Known perf debt** (non-blocking): the four anti-patterns (addressed in the L5
perf pass); beyond them, indexing-scale strategy and Pretext virtualization remain
future work. > Owner: [`planned.md`](docs/architecture/planned.md) §14; [`build-order.md`](docs/build-order.md).

---

## 12. Glossary

**Vault** — the user-chosen Markdown directory Cubical operates on. **`.cubical/`**
— the only Cubical-owned state inside a vault (durable config + rebuildable cache).
**Canonical AST** — the single normalized syntax tree all non-editor systems
consume (`cubical-ast`). **Live Preview** — the default mode where rendered Markdown
and raw source coexist. **Pending Rewrites Cache** — deferred-write mechanism making
renames instant while coalescing file rewrites. **Block reference** — a `^block-id`
on a paragraph, lazily created on first reference. **Omni-Bar** — the `Cmd/Ctrl+K`
quick-nav + command palette. **Dataview-style query** — structured query over
frontmatter via libSQL. **Lanes 1/2/3** — webview / Rust async / Web Worker plugins.
**Layer** — a shippable build increment (0–10); v1.0 cuts at end of L5. **Core
plugin** — a built-in toggleable feature block (seed of the full plugin ABI), gated
via `config.toml` `plugins.*`. **`cubical_id`** — per-file frontmatter UUID minted
only at L7 sync onboarding.

---

*Synthesis maintained for orientation; for any binding decision, consult the owning
doc linked inline.*
