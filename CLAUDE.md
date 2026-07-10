# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. Tauri + Rust + Solid/TS. Plain `.md` files are the absolute source of truth. No Electron, no Node, no cloud.

This is the session primer. Read it before any work. It auto-loads every session and carries only the load-bearing rules, session protocol, and current state — for everything else (the full doc map, repo layout, architecture, conventions, build order) start at the index: [`docs/README.md`](docs/README.md). If a decision here conflicts with what a session participant says, raise the conflict — don't silently override it.

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
- Most user-facing features are composable on/off blocks, not a monolith: the substrate (vault, AST, index, IPC) is always-on; a feature toggles without touching the `.md` source of truth. Design every feature to switch off cleanly. Scope + mechanism: [`foundation.md`](docs/architecture/foundation.md) §1 (commitment 4).

For non-features explicitly cut from scope, see [`docs/architecture/constraints.md`](docs/architecture/constraints.md).

---

## Code quality

- Code must be maintainable and production-ready — no shortcuts that defer cleanup to the next session.
- Follow SRP: each module, function, and component owns one concern. Split when a unit starts serving two masters.
- Respect logical boundaries — don't reach across layers or domains; route through the established IPC/API surface.

---

## Session protocol

**Loading:** Auto-loaded every session. Start at the index [`docs/README.md`](docs/README.md) for the doc map. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file; if editing code, `docs/conventions.md`; if touching IPC / Tauri, `docs/migration-touchpoints.md`; if editing docs, follow **Doc discipline** in the index.

**Right-size the process:** ceremony scales with the task — a trivial fix just ships; a standard feature gets one working doc; only layer/architectural work gets the full brainstorm→spec→plan→closeout. Details + the smoke rules in `docs/conventions.md` → Sessions.

**During work:** Don't live-update the layer spec. Capture what landed once, tersely, at session end — in the layer spec's "What was built" plus the Project state block below.

**At session end:** Rewrite the Project state block below — never append, rewrite. Keep it to three short blocks (current branch / `main` / tests), each a few lines. It carries *current focus + pointers*, not detail: blow-by-blow lives in the layer specs and `docs/superpowers/` handoffs. If a paragraph is restating a spec, cut it to a link.

---

## Project state

**Latest on `main` (16 commits, unpushed):** **Recent-vaults store**, merged 2026-07-09 — Cubical's **first global, non-vault state**. A machine-local `recent_vaults.json` in the OS app-config dir (`app.path().app_config_dir()`, e.g. `~/Library/Application Support/dev.cubical.app/`), owned by **`cubical-app`** (the Tauri shell) — deliberately *not* `cubical-engine`, which stays vault-focused. Cap 10, LRU, atomic temp+rename, best-effort everywhere (missing/corrupt file → empty list; a write failure can never fail an open). Recording folds into the `open_vault` shim on `Ok` only, so the frontend never calls an "add" command. Two IPC commands (`list_recent_vaults` stamps a live `exists` per entry; `remove_recent_vault`). Frontend: `openVaultByPath` extracted from `handleOpen` (shared by dialog / recent-click / launch auto-open), a shared `RecentVaultList` (switch · greyed-missing · × prune), launch **auto-open of the last vault** (top entry iff `exists`; never cascades to an older one), and recents on the empty-vault landing. Spec+plan `docs/superpowers/specs|plans/2026-07-09-recent-vaults-store*`. Built via subagent-driven-development (4 tasks, clean reviews, final review "ready to merge"). Two follow-up UX fixes: a `booting` signal suppresses the landing flash during launch auto-open, and the switcher now shows a "Switch to" section with an explicit empty state (its list excludes the current vault, so with one recent it used to collapse to a lone OS-picker button). **Note:** adding a *new* vault still necessarily goes through the OS folder dialog — the app can only list vaults it has seen.

Prior `main` head: **Small-wins UI batch** (#3/#4/#5/#7/#8), merged 2026-07-09, all frontend — muted file-type extension labels (#5); three new bindable commands (#7): follow-wikilink `Alt-Enter`, toggle-sidebar `Mod-Shift-l`, new-note `Mod-n`; editor back/forward navigation (#4): pure `navHistory.ts` reducer + topbar ‹ › buttons + `nav.back`/`nav.forward` (`Mod-Alt-←/→`), session-scoped, pushes in the shared `handleSelectFile` choke point; in-app vault-switcher popup (#3, shipped memory-less — the store above now fills its `recentVaults` seam); Settings→Shortcuts help popover (#8) + friendly special-key labels (`formatChordForDisplay` maps Enter/arrows). Obsidian-matched key defaults throughout. Spec+plan `docs/superpowers/specs|plans/2026-07-08-small-wins-ui-batch*`.

Prior `main` head: **Dependabot security sweep** (already on `origin/main`) — libsql `default-features=false, features=["core"]` (drops the remote/replication/tls stack a no-cloud vault never uses), tauri→2.11.1, vite 5→7 / vitest 2→3; **2 alerts remain, blocked upstream**: `lru` #3 (low, tantivy 0.22) and `glib` #1 (medium, Linux-GTK-only, tauri gtk 0.18). Before that: **configurable shortcuts** (`docs/superpowers/…/2026-07-05-configurable-shortcuts*`) + folder rename.

**On `main`:** all recent feature work merged — **raw-source coloring** (`editor.colorize_raw_source`, default off), configurable shortcuts, folder rename, minimap (`editor.minimap_enabled`, default off), create files + folders, property-ref interpolation (default-on), configurable status bar, Live Preview touch-reveal, rename durability journal + deleted-file pruning + rename-coalescing, Core Plugins + portable `.cubical/config.toml` settings, all Layer 4. Typed properties (inline `# type:`) merged but **defaulted off** — slated for a vault-level type registry (`docs/architecture/planned.md` §14; issue #19). The **`l4` close-tag is the only structural open gate** — operator smoke, recipe `layer-4-spec.md` §9.5–9.6. **User-requested backlog:** small-wins batch (#3/#4/#5/#7/#8) **done**, and its recent-vaults follow-on **done** (see latest-on-main). Nothing user-requested remains open. Deferred-complex (untouched): dataview f(x) graphs, calendar, terminal, tabs (#20), other-file-type viewers (png/svg/pdf/txt). **Open bug:** intermittent `[[wikilink]]` non-render in Live Preview (raw mode fine, no pattern yet). Deferred (GitHub Issues): per-occurrence search (#21).

**Dev infrastructure:** CI runs `scripts/check.sh` on every PR/push to `main` (`.github/workflows/ci.yml`); Rust pinned via `rust-toolchain.toml`; Dependabot watches cargo/npm/actions + security alerts on; actions SHA-pinned. Deferred/parked backlog + perf debt now tracked as GitHub Issues (perf #14–#17, milestone `v1.0`). How it all fits: `docs/conventions.md` → Continuous integration.

**Tests:** 728 vitest + 562 Rust (7 new `recent_vaults` unit tests). Gates: `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) — all green at merge (rust fmt + workspace clippy + tests, tsc, vitest, build). Layer status/tags/dates: `docs/build-order.md`.

**Tauri dev gotcha:** a hot-reloaded frontend running against a stale Rust binary produces convincing phantom bugs (cost a full debugging cycle this session). When a Tauri-layer bug appears, **force a full recompile/restart of `npm run tauri dev` before investigating**.
