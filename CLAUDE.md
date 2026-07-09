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

**Latest on `main` (8 commits, unpushed):** **Small-wins UI batch** (#3/#4/#5/#7/#8), merged 2026-07-09, all frontend, no Rust/IPC/persistence. — muted file-type extension labels in the sidebar tree (#5); three new bindable commands (#7): follow-wikilink `Alt-Enter`, toggle-sidebar `Mod-Shift-l`, new-note `Mod-n` — all reuse existing handlers, auto-appear in Settings→Shortcuts; editor back/forward navigation (#4): pure `navHistory.ts` reducer + topbar ‹ › buttons + `nav.back`/`nav.forward` (`Mod-Alt-←/→`), session-scoped (not persisted), pushes in the shared `handleSelectFile` choke point; minimal in-app vault-switcher popup (#3): wraps the existing open-vault flow in a backdrop-dismiss popover, **no persistence** — its `recentVaults` prop is a forward-compat seam for a deferred global recent-vaults store (that store is its own future session, an app-data-location architecture decision); Settings→Shortcuts help popover (#8) + friendly special-key labels (`formatChordForDisplay` now maps Enter/arrows). Obsidian-matched key defaults throughout. Spec+plan `docs/superpowers/specs|plans/2026-07-08-small-wins-ui-batch*`; GUI operator-smoke confirmed by user. Built via subagent-driven-development (5 tasks, one fix loop on #3's dismiss race, clean final review).

Prior `main` head: **Dependabot security sweep** (already on `origin/main`) — libsql `default-features=false, features=["core"]` (drops the remote/replication/tls stack a no-cloud vault never uses), tauri→2.11.1, vite 5→7 / vitest 2→3; **2 alerts remain, blocked upstream**: `lru` #3 (low, tantivy 0.22) and `glib` #1 (medium, Linux-GTK-only, tauri gtk 0.18). Before that: **configurable shortcuts** (`docs/superpowers/…/2026-07-05-configurable-shortcuts*`) + folder rename.

**On `main`:** all recent feature work merged — **raw-source coloring** (`editor.colorize_raw_source`, default off), configurable shortcuts, folder rename, minimap (`editor.minimap_enabled`, default off), create files + folders, property-ref interpolation (default-on), configurable status bar, Live Preview touch-reveal, rename durability journal + deleted-file pruning + rename-coalescing, Core Plugins + portable `.cubical/config.toml` settings, all Layer 4. Typed properties (inline `# type:`) merged but **defaulted off** — slated for a vault-level type registry (`docs/architecture/planned.md` §14; issue #19). The **`l4` close-tag is the only structural open gate** — operator smoke, recipe `layer-4-spec.md` §9.5–9.6. **User-requested backlog:** small-wins batch (#3/#4/#5/#7/#8) all **done** (see latest-on-main above); the vault-switcher shipped memory-less, so a **global recent-vaults store** (app-data-location decision) is the one remaining follow-on. Deferred-complex (untouched): dataview f(x) graphs, calendar, terminal, tabs (#20), other-file-type viewers (png/svg/pdf/txt). **Open bug:** intermittent `[[wikilink]]` non-render in Live Preview (raw mode fine, no pattern yet). Deferred (GitHub Issues): per-occurrence search (#21).

**Dev infrastructure:** CI runs `scripts/check.sh` on every PR/push to `main` (`.github/workflows/ci.yml`); Rust pinned via `rust-toolchain.toml`; Dependabot watches cargo/npm/actions + security alerts on; actions SHA-pinned. Deferred/parked backlog + perf debt now tracked as GitHub Issues (perf #14–#17, milestone `v1.0`). How it all fits: `docs/conventions.md` → Continuous integration.

**Tests:** 728 vitest + 555 Rust. Gates: `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) — frontend all green (tsc, vitest, build); Rust untouched this batch. Layer status/tags/dates: `docs/build-order.md`.
