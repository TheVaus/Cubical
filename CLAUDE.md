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

**No active feature branch — the design-system→component-library migration is COMPLETE and merged to `main` (2026-07-18; branch `feat/design-system-migration` fast-forwarded in and deleted).** `design-system/` is now the app's single source of truth for **tokens AND components** (`@ds` alias; `ui/` borrows every component that has a DS equivalent). Phases B (leaf primitives), C (C1 context menu→`Menu`, C2 delete-confirm→`Modal`, C3 tree-header→`IconButton`; overlay-fit audit), and D (`layout.css` gut — one dead rule, `.statusbar__spacer`, removed; **do NOT shrink `layout.css` further, the rest is live**) all done & live-verified under `cargo tauri dev`. The record + the DS self-containment rule, the Properties draft-guard invariant, and the deliberately-bespoke list live in [`docs/superpowers/2026-07-17-ds-migration-progress.md`](docs/superpowers/2026-07-17-ds-migration-progress.md). **Remaining is not migration debt:** a low-value deferred inline tail (external-edit banner buttons, OmniBar input) → issue #34, and net-new DS primitives (`Select`/`Popover`/`Link`/`DatePicker`/two-pane modal/richer palette) needed before the deliberately-bespoke surfaces could migrate → parked issue #35.

**On `main` (unpushed local trunk):** all Layer-4 feature work merged — recent-vaults store (the first global, non-vault state; app-shell-owned, pattern for future machine-local state), small-wins UI batch, configurable shortcuts, folder rename, raw-source coloring, minimap, create files/folders, property-ref interpolation, configurable status bar, rename durability journal, Core Plugins + portable `.cubical/config.toml`, **and the design-system→component-library migration (2026-07-18)**. Each is owned by its `docs/superpowers/specs|plans/*` pair. Typed properties (inline `# type:`) merged but **defaulted off** — slated for a vault-level type registry (`docs/architecture/planned.md` §14; issue #19). The **`l4` close-tag is the only structural open gate** — operator smoke, recipe `layer-4-spec.md` §9.5–9.6. Nothing user-requested is open; deferred-complex (untouched): dataview f(x) graphs, calendar, terminal, tabs (#20), other-file-type viewers; DS-migration follow-ups parked in #34 (inline tail) / #35 (net-new DS primitives). **Open bug:** intermittent `[[wikilink]]` non-render in Live Preview (raw mode fine, no pattern yet). **2 Dependabot alerts remain, blocked upstream:** `lru` #3 (low, tantivy 0.22), `glib` #1 (medium, Linux-GTK-only).

**Tests:** 728 vitest + 562 Rust. Gates: `scripts/check.sh` (tsc, vitest, build, cargo fmt/clippy/test, docs) — run it, not the pieces. CI runs it on every PR/push to `main`; Rust pinned via `rust-toolchain.toml`; Dependabot + SHA-pinned actions; deferred backlog + perf debt (#14–#17, milestone `v1.0`) live in GitHub Issues. How it fits: `docs/conventions.md` → Continuous integration. Layer status/tags/dates: `docs/build-order.md`. **Known flake:** `cubical-core`'s `watcher::…dropping_handle_stops_event_delivery_within_100ms` fails under full-workspace load, passes in isolation — not a regression.

**Tauri dev gotcha:** a hot-reloaded frontend running against a stale Rust binary produces convincing phantom bugs (cost a full debugging cycle). When a Tauri-layer bug appears, **force a full recompile/restart of `npm run tauri dev` before investigating**. Note the plain `vite` preview has **no Tauri backend** at all — vault-gated UI can't render there.
