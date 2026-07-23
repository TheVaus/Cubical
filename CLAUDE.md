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
- **Don't write comments — write docs.** No explanatory comments in source, doc-comments (`///`, `//!`, JSDoc) included; a brief one-liner is the most that's allowed. Rationale, invariants and "why it's like this" belong in [`docs/implementation/`](docs/implementation/) (one file per domain), or in `architecture/` when the decision is locked. When a change needs explaining, update the owning doc in the same commit — never leave the explanation in the code. Full rule + the functional pragmas that must never be stripped: [`docs/conventions.md`](docs/conventions.md) → Comments.

---

## Session protocol

**Loading:** Auto-loaded every session. Start at the index [`docs/README.md`](docs/README.md) for the doc map. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file; if editing code, `docs/conventions.md`; if touching IPC / Tauri, `docs/migration-touchpoints.md`; if editing docs, follow **Doc discipline** in the index.

**Right-size the process:** ceremony scales with the task — a trivial fix just ships; a standard feature gets one working doc; only layer/architectural work gets the full brainstorm→spec→plan→closeout. Details + the smoke rules in `docs/conventions.md` → Sessions.

**During work:** Don't live-update the layer spec. Capture what landed once, tersely, at session end — in the layer spec's "What was built" plus the Project state block below.

**At session end:** Rewrite the Project state block below — never append, rewrite. Keep it to three short blocks (current branch / `main` / tests), each a few lines. It carries *current focus + pointers*, not detail: blow-by-blow lives in the layer specs and `docs/superpowers/` handoffs. If a paragraph is restating a spec, cut it to a link.

---

## Project state

**CLI-frontend Phase 1 COMPLETE & merged to local `main` (2026-07-24, gate-green; branch `feat/cli-frontend` fast-forwarded in and deleted). `main` is a few commits ahead of `origin/main` — NOT yet pushed.** A write-capable `cubical` terminal frontend over the existing engine command fns (`new note|folder`, `write` via stdin, `rename` file/folder auto-detect, `rm`, `set`/`get`, `undo-rename` + the prior reads; `--json` global), plus a new **`cubical-engine::vault_lock`** cross-process ownership lock. Invariant driving the whole design: **one backend owns a vault at a time; frontends attach.** `open_vault` takes an OS advisory lock (`fs4`; lockfile in the OS runtime dir, keyed by a SHA-256 of the canonical vault path — **never in `.cubical/`**; `CUBICAL_RUNTIME_DIR` overrides) *before* `Vault::open` and returns `VaultLocked{pid,socket_path}` on contention; `close_vault`/process-exit releases it. The CLI declines with **exit 2** when the app owns the vault. Lifecycle: open→scan→dispatch→**close (flushes referrer rewrites, so a one-shot rename never strands links)**. Owned by [`docs/superpowers/specs/2026-07-24-cli-frontend-design.md`](docs/superpowers/specs/2026-07-24-cli-frontend-design.md); rationale in [`docs/implementation/engine-ipc.md`](docs/implementation/engine-ipc.md) → "Cross-process vault ownership lock". **Chosen approach = Option A (app-hosts-backend), built in phases. Deferred to focused next sessions: Phase 2** app-side Unix-socket server + CLI attach (flips the CLI's decline branch → *attach* over `socket_path`, giving live "same backend, both frontends"); **Phase 3** in-app terminal panel (subsumes the deferred "terminal" backlog item). **Next-session handoff (seams, design decisions, gotchas): [`docs/superpowers/2026-07-24-cli-frontend-phase2-handoff.md`](docs/superpowers/2026-07-24-cli-frontend-phase2-handoff.md).**

**DS→component-library migration + icon system: COMPLETE & on `main`** (2026-07-18/19) — full record in memory + [`docs/superpowers/2026-07-17-ds-migration-progress.md`](docs/superpowers/2026-07-17-ds-migration-progress.md). Load-bearing carry-overs: **do NOT shrink `layout.css` further (the rest is live)**; issue #35 net-new DS primitives are **6 of 7 done**, only the richer ranked `CommandPalette` (OmniBar) remains; deferred inline tail → issue #34.

**On `main` (synced with `origin/main`):** all Layer-4 feature work merged — recent-vaults store (the first global, non-vault state; app-shell-owned, pattern for future machine-local state), small-wins UI batch, configurable shortcuts, folder rename, raw-source coloring, minimap, create files/folders, property-ref interpolation, configurable status bar, rename durability journal, Core Plugins + portable `.cubical/config.toml`, **and the design-system→component-library migration (2026-07-18)**. Each is owned by its `docs/superpowers/specs|plans/*` pair. Typed properties (inline `# type:`) merged but **defaulted off** — slated for a vault-level type registry (`docs/architecture/planned.md` §14; issue #19). The **`l4` close-tag is the only structural open gate** — operator smoke, recipe `layer-4-spec.md` §9.5–9.6. Nothing user-requested is open; deferred-complex (untouched): dataview f(x) graphs, calendar, terminal, tabs (#20), other-file-type viewers; DS-migration follow-ups parked in #34 (inline tail) / #35 (net-new DS primitives). **Open bug:** intermittent `[[wikilink]]` non-render in Live Preview (raw mode fine, no pattern yet). **2 Dependabot alerts remain, blocked upstream:** `lru` #3 (low, tantivy 0.22), `glib` #1 (medium, Linux-GTK-only).

**Tests:** 771 vitest + 576 Rust (incl. the `feat/cli-frontend` branch's 14 new: 6 `vault_lock` + 1 `open_vault` lock integration + 7 `cubical-cli` binary integration). Gates: `scripts/check.sh` (tsc, vitest, build, cargo fmt/clippy/test, docs) — run it, not the pieces. CI runs it on every PR/push to `main`; Rust pinned via `rust-toolchain.toml`; Dependabot + SHA-pinned actions; deferred backlog + perf debt (#14–#17, milestone `v1.0`) live in GitHub Issues. How it fits: `docs/conventions.md` → Continuous integration. Layer status/tags/dates: `docs/build-order.md`. **Known flake:** `cubical-core`'s `watcher::…dropping_handle_stops_event_delivery_within_100ms` fails under full-workspace load, passes in isolation — not a regression.

**Tauri dev gotcha:** a hot-reloaded frontend running against a stale Rust binary produces convincing phantom bugs (cost a full debugging cycle). When a Tauri-layer bug appears, **force a full recompile/restart of `npm run tauri dev` before investigating**. Note the plain `vite` preview has **no Tauri backend** at all — vault-gated UI can't render there.
