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

**Current branch `feat/colorize-raw-source`:** **raw-source coloring** for the editor. Design spec committed (`docs/superpowers/specs/2026-06-28-colorize-raw-source-design.md`); implementation committed (`colorSource.ts` + `.test.ts`, Editor/cm-theme/minimap integration; plus overscroll + scroll-away editor fixes), branch synced to `main` and CI-green on draft PR #27 — not yet merged. Nothing else is off `main`.

**On `main`:** all recent feature work merged — **minimap** (read-only `@chenglou/pretext` canvas strip, gated `editor.minimap_enabled`, default off), create files + folders, property-ref interpolation (default-on), configurable status bar, Live Preview touch-reveal, rename durability journal + deleted-file pruning + rename-coalescing, Core Plugins + portable `.cubical/config.toml` settings, all Layer 4. Typed properties (inline `# type:`) merged but **defaulted off** — slated for a vault-level type registry (`docs/architecture/planned.md` §14; issue #19). The **`l4` close-tag is the only structural open gate** — operator smoke, recipe `layer-4-spec.md` §9.5–9.6. Deferred (GitHub Issues): tabs/multi-document (#20), per-occurrence search (#21).

**Dev infrastructure:** CI runs `scripts/check.sh` on every PR/push to `main` (`.github/workflows/ci.yml`); Rust pinned via `rust-toolchain.toml`; Dependabot watches cargo/npm/actions + security alerts on; actions SHA-pinned. Deferred/parked backlog + perf debt now tracked as GitHub Issues (perf #14–#17, milestone `v1.0`). How it all fits: `docs/conventions.md` → Continuous integration.

**Tests:** 660 vitest + 555 Rust. Gates: `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) — all green. Layer status/tags/dates: `docs/build-order.md`.
