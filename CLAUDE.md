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

**Core Plugins + TOML settings file — landed on `main` (2026-06-16).**
Per-vault settings moved out of the libSQL `config` table into a portable
`.cubical/config.toml` (TOML, durable source of truth; `ui.*` workspace
state stays DB-backed). New pure `cubical-core` `vault::settings` (map⇄TOML,
atomic load/save, `is_workspace_key`); `OpenVault` in-memory map + open-time
hydration; `get/set_setting` routed (settings→file, `ui.*`→DB, save off the
async executor via `spawn_blocking`); `reload_settings` IPC; `vault.md`
amended (config = durable, not rebuildable cache). Frontend: `corePlugins`
registry (`ui/src/settings/corePlugins.ts`) + a Settings → Plugins → Core
Plugins tab toggling `plugins.dataview_enabled`, live-gating the editor's
dataview runner (off ⇒ raw ```query). Six gates green. Also on this branch:
the **L4-D operator-smoke bug fixes** (dataview link-nav via capture-phase
mousedown, count-click→reveal via `posAtDOM`, stale-while-revalidate
flicker). **Residual: live Tauri-GUI operator smoke** (toggle on/off,
eyeball `config.toml`) — code/test-verified, GUI not driven. Spec+plan:
`docs/superpowers/{specs,plans}/2026-06-15-core-plugins-dataview-toggle*`.

**Layer 4 — Search.** L4-A/B/C + search-fuzzy + **L4-D** all CLOSED and
merged to `main` (tags `l4a`, `l4a-fix`/`.1`, `l4b`, `l4c`, `l4a-fix.2`,
`l4d`). **L4-D — Dataview-style libSQL queries (closed 2026-06-15, tag
`l4d`):** new `cubical-query` crate (parser → planner → executor;
`json_extract`-normalized SQL over the `frontmatter`/`tags`/`files`
tables), one vault-keyed `dataview_query` IPC, and a live ```` ```query ````
editor block widget (pure renderer + runner cache). Branch reconciled with
the meanwhile-landed UI rework (clean merge), six gates green. **One
outstanding residual: the live *visual* operator smoke** — the CM widget's
on-screen render / link-nav / cursor-reveal needs `cargo tauri dev` (the
`dataview_query` IPC is Tauri-runtime-only; data path + mount wiring are
otherwise fully code/test-verified). Recipe in layer-4-spec §9.5.

**L4 layer-close — merged to `main` (2026-06-15, §9.6); only the `l4`
tag remains.** Done: §5 deviations **promoted** to `docs/architecture/concurrency.md`
§6.2 (vault_id keying, three-value search state cell, prose `STORED`);
search-row **keyboard nav chip** (`task_bd4e47f4`) shipped (pure
`ui/src/sidebar/searchNav.ts`, roving tabindex over file groups); the
carried smoke recorded at **best-available** fidelity — SCHEMA_VERSION
wipe and `open_vault` re-open `LockBusy` are **already covered by
automated tests**, and L4-A recipes 1–11 map to named backend tests
(R6 phrase+negation / R10 fan-out stay GUI-smoke). **Deferred** (own
session): per-occurrence snippet cards (`task_b5f2f1ef`) — backend
Tantivy fragment surgery, non-blocking. **Sole remaining `l4` gate:**
the operator GUI smoke (`cargo tauri dev`) — L4-D widget render,
indexing banner, ~2-3× index-disk eyeball, R6/R10, the new keyboard-nav
focus ring. After that pass, `git tag l4`.

**UI rework — incrementally landed on `main` 2026-06-12** (work continued
on branch `feat/ui-rework`, now merged). A layered Obsidian-style shell: full-width top/status bars, fixed editor +
floating slide-to-collapse sidebars (collapsing never reflows the
editor), folder tree, editable filename-title (= rename, **no `# H1`
injected**), settings modal, vault switcher, color-theory pass. Done:
shell + title + status bar + settings + vault switcher + folder tree +
search-results-over-tree layer + polish. **Only remaining: tabs /
multi-document** — the single→multi-buffer architecture fork (autosave/
conflict/`seenHash` all assume one open buffer); a standalone effort, not
started.
New: `ui/src/styles/layout.css`, `ui/src/sidebar/fileTree.ts` (+test).
Full handoff: `docs/superpowers/2026-06-12-ui-rework-progress.md`; design
mockup: `docs/superpowers/mockups/ui-rework.html`.

Tests: **500 vitest + 519 Rust** on `main`. Since the l4-close baseline
(484 + 507): the L4-D operator-smoke bug fixes added vitest
(`dataviewMousedown` +11, renderer/runner contract updates); the
core-plugins/settings build added 3 vitest (`corePlugins`) + 12 Rust
(`vault::settings` module, app integration, `reload_settings`). Gates:
`cargo test --workspace`, `cargo
clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all
--check`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`. Tags: l0
(05-13) l1 (05-09) l2 (05-22) l3 (06-01) l4a (06-03) l4a-fix/.1 (06-06)
l4b/l4c/l4a-fix.2 (06-08) l4d (06-15).
