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

For non-features explicitly cut from scope, see [`docs/architecture/constraints.md`](docs/architecture/constraints.md).

---

## Session protocol

**Loading:** Auto-loaded every session. Start at the index [`docs/README.md`](docs/README.md) for the doc map. If the task touches design, load `docs/architecture/README.md` and the relevant sub-file; if editing code, `docs/conventions.md`; if touching IPC / Tauri, `docs/migration-touchpoints.md`; if editing docs, follow **Doc discipline** in the index.

**Right-size the process:** ceremony scales with the task — a trivial fix just ships; a standard feature gets one working doc; only layer/architectural work gets the full brainstorm→spec→plan→closeout. Details + the smoke rules in `docs/conventions.md` → Sessions.

**During work:** Don't live-update the layer spec. Capture what landed once, tersely, at session end — in the layer spec's "What was built" plus the Project state block below.

**At session end:** Rewrite the Project state block below — never append, rewrite. Keep it to three short blocks (current branch / `main` / tests), each a few lines. It carries *current focus + pointers*, not detail: blow-by-blow lives in the layer specs and `docs/superpowers/` handoffs. If a paragraph is restating a spec, cut it to a link.

---

## Project state

**Now — `feat/typed-properties` (2026-06-17).** Typed properties via inline
YAML `type:` comments + a curated date-format table; pure
`ui/src/properties/{typeComments,inferType}.ts` (+tests). Spec/plan:
`docs/superpowers/{specs,plans}/2026-06-17-typed-properties-inline-comments*`.

**On `main`:** Core Plugins + portable `.cubical/config.toml` settings
(2026-06-16); all Layer 4 sub-layers merged (`l4a`–`l4d`). The **`l4`
close-tag is the only open gate** — blocks on one interactive `cargo tauri
dev` operator smoke (L4-D widget render, indexing banner, R6/R10,
keyboard-nav focus ring); recipe in `layer-4-spec.md` §9.5–9.6. Deferred to
their own sessions: tabs/multi-document (single→multi-buffer fork; handoff
`docs/superpowers/2026-06-12-ui-rework-progress.md`) and per-occurrence
search snippet cards.

**Tests:** 500 vitest + 519 Rust on `main`. Gates: run `scripts/check.sh`
(cargo fmt/clippy/test, tsc, vitest, build, docs check). Layer
status/tags/dates: `docs/build-order.md`.
