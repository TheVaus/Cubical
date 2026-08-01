# Cubical

A blazing-fast, strictly local-first Personal Knowledge Management application. Tauri + Rust + Solid/TS. Plain `.md` files are the absolute source of truth. No Electron, no Node runtime, no cloud in the shipped product.

This is the session primer. Read it before any work. It auto-loads every session and carries only the load-bearing rules, session protocol, and current state — for everything else (the full doc map, repo layout, architecture, conventions, build order) start at the index: [`docs/README.md`](docs/README.md). If a decision here conflicts with what a session participant says, raise the conflict — don't silently override it.

---

## Non-negotiables

These are load-bearing decisions. Not up for debate in a working session. Surface conflicts as architecture changes, not code changes.

- Plain `.md` files are the absolute source of truth. Derived state (libSQL, indexes, caches) is rebuildable from it — with **one exception**: the pending-rewrites queue is not, which is why the durable rename journal (`.cubical/renames.jsonl`) exists; wiping the index without replaying it strands referrer links. User config (`config.toml`, `themes/`) is neither derived nor rebuildable — [`vault.md`](docs/architecture/vault.md) §3.
- The vault is 100% portable and self-contained. No external services required to open a vault.
- Performance is a feature, not a polish item — measured, not asserted. A cold scan-and-index stays under **13 s** at 10,000 notes and **1.5 s** at 1,000. Ratchet down, never up. The bar, the method, the current medians and the harness are owned by [`foundation.md`](docs/architecture/foundation.md) §1 (commitment 2).
- No Electron, no Node.js runtime, no centralized cloud database for core storage **in the shipped product**. Node remains a build-time toolchain (Vite, npm) and always has been.
- Files must survive being edited or renamed by external tools (vim, Finder, Dropbox) while the app is closed.
- **Third-party** plugin code is sandboxed: the ABI is WASI/WASM, and JavaScript is a *source language* via Javy/QuickJS-WASM, never an unsandboxed runtime. First-party features may use native capabilities — but one whose *purpose* is handing an unsandboxed capability to arbitrary external code is a **gateway**, and must be all three of: opt-in and default-off · unable to compromise vault integrity when abused · auditable. The embedded terminal is such a gateway, and it shipped.
- Desktop only for v1. Mobile is deferred but the architecture must not preclude it.
- No file-identity UUIDs injected into any `.md` file before Layer 7. The vault is the user's vault, byte-for-byte, until sync onboarding.
- Most user-facing features are composable on/off blocks — **most, not all**. The substrate (vault, AST, index, IPC) is always-on bedrock, never a toggle. Blocks form a **dependency graph**, not free stacking: a block cannot be active while one it depends on is off (backlinks need the link index; embeds need link resolution). A toggle changes behaviour and derived state only, never the `.md` source of truth. Scope + mechanism: [`foundation.md`](docs/architecture/foundation.md) §1 (commitment 4).

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

**Orienting in the codebase — use graphify first, it is far cheaper than grepping.** A prebuilt knowledge graph of this repo lives in [`graphify-out/`](graphify-out/) (`graph.json`, `GRAPH_REPORT.md`, `graph.html`). Before fanning out reads or searches to answer "how does X work / what calls Y / where does Z live", run `graphify query "<question>"` from the repo root — it answers from the graph without opening files. Also `graphify path "A" "B"` (shortest path between two concepts) and `graphify explain "<node>"`. Rebuild after large changes with `graphify . --update`. `graphify-out/` is generated and untracked; do not hand-edit it. Full usage: `~/.claude/skills/graphify/SKILL.md`.

**Right-size the process:** ceremony scales with the task — a trivial fix just ships; a standard feature gets one working doc; only layer/architectural work gets the full brainstorm→spec→plan→closeout. Details + the smoke rules in `docs/conventions.md` → Sessions.

**During work:** Don't live-update the layer spec. Capture what landed once, tersely, at session end — in the layer spec's "What was built" plus the Project state block below.

**At session end:** Rewrite the Project state block below — never append, rewrite. Keep it to three short blocks (current branch / `main` / tests), each a few lines. It carries *current focus + pointers*, not detail: blow-by-blow lives in the layer specs and `docs/superpowers/` handoffs. If a paragraph is restating a spec, cut it to a link.

---

## Project state

**Convergence layer: MERGED to `main` 2026-07-30 (merge `fc7009e`).** External processes (a shell `mv`, Finder, vim, an AI CLI) can no longer silently break link integrity: the watcher's `Renamed` arm runs the full referrer rewrite via `adopt_external_rename` = `validate_adopted + commit_rename` (extracted from `rename_file`, performs **no** filesystem mutation — that invariant is what lets a move which already happened reuse it). Idempotent by construction, not bookkeeping: adopt only when `files` has a row at `from` and none at `to`. Two recovery mechanisms for renames the watcher fails to pair — durable index reverse-lookup by inode (rescues the **macOS dropped-source bug**: the first `mv` after watcher start arrives as a bare `Created`, source side dropped entirely, cause traced to `notify-debouncer-full`'s `push_rename_event`) and an ephemeral tombstone buffer (rescues split `Removed`+`Created`). Ambiguous inode/hash **refuses to pair** — a missed rename is recoverable, a wrong rewrite corrupts markdown. Residue surfaces in a new Integrity panel, repaired only on explicit per-candidate confirmation; no auto-fix path exists. Owned by [spec](docs/superpowers/specs/2026-07-30-vault-convergence-design.md) + [plan](docs/superpowers/plans/2026-07-30-vault-convergence.md). The console isolation it did ahead of the terminal (App.tsx: 8 sites → 1 wiring call) is what later made deleting the console a one-point change.

**Embedded terminal: MERGED to `main` 2026-08-01 (PR #48, merge `68941aa`).** Real PTY + xterm.js, non-singleton `{kind:"terminal"}` tabs, `cubical` on the child `PATH` so engine-routed ops are available but not mandatory (dev builds only — the bundling gap is issue #47), all behind `plugins.terminal_enabled` (**default off**). **Interception is impossible and not attempted** — see [`foundation.md`](docs/architecture/foundation.md) §2.1 (native-capability rule for gateway features: opt-in/default-off, cannot compromise integrity when abused, auditable) and §2.2 (convergence over interception). Owned by [spec](docs/superpowers/specs/2026-07-30-terminal-design.md) + [plan](docs/superpowers/plans/2026-07-30-terminal.md); the plan's STATUS block carries what landed, the defects fixed, and the follow-ups. **GUI-smoke verified by hand 2026-07-31 — the first Tauri smoke ever run here.** **The console is now DELETED** (2026-07-31, its own commit): `ui/src/console/` + `cubical-app/src/console.rs` + `console_exec.rs` gone, the `{kind:"console"}` tab variant and `view.openConsole` retired, `consoleExec`/`ConsoleResult`/`plugins.console_enabled` off the IPC surface. `dispatch` is back to three callers. A stale `plugins.console_enabled` in an existing vault is inert — settings are a free-form map, so no migration. Spec + plan kept as records, marked superseded.

**On `main` (synced with `origin/main`):** all Layer-4 feature work, tabs/multi-doc (issue #20, merge `6b2b37c`), the CLI's Phases 1–3 including the in-app command console (PR #45, merge `65ce97c`) — the console itself **since deleted**, Phases 1–2 untouched, and the DS→component-library migration + icon system. Each owned by its `docs/superpowers/specs|plans/*` pair. Typed properties merged but **defaulted off** (registry → issue #19). `l4` close-tag is the only structural open gate. Deferred-complex, untouched: dataview f(x) graphs, calendar, other-file-type viewers. DS follow-ups in #34 / #35 (6 of 7 primitives done; ranked `CommandPalette` remains). **Do NOT shrink `layout.css` further** — the rest is live. **Open bug:** intermittent `[[wikilink]]` non-render in Live Preview. **2 open Dependabot alerts**, both deferred with cause (2026-07-31 remediation pass cleared the other seven, incl. `seroval` #27 — the only one that ever sat on a runtime dep): `glib` #1 is pinned by tauri's gtk 0.18, still upstream-blocked and Linux-only; `lru` #3 is **not** upstream-blocked as long recorded — tantivy 0.26.1 wants the patched `lru ^0.16.3` — but the 0.22→0.26 jump is an API migration plus a `SCHEMA_VERSION` bump to force an index rebuild, so it is its own session (issue #50).

**Tests:** counts are a query, not a stored fact — run the gate: `scripts/check.sh` (**run the script, not the pieces**); CI runs it on every PR/push to `main`. **Known flake:** `cubical-core`'s `watcher::…dropping_handle_stops_event_delivery_within_100ms` fails under full-workspace load, passes in isolation — not a regression, and `set -e` makes it abort the gate before `cubical-engine` runs. The **Tauri GUI smoke remains unrun** (non-interactive sessions); standing in for it here are real-watcher end-to-end tests doing out-of-band `fs::rename` against a real engine and asserting on-disk effects.
