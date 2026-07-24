# CLI frontend — Phase 2 handoff (2026-07-24)

> **CONSUMED — Phase 2 is built and merged to `main` (merge `a0c9f46`). This document is
> kept as a record of what was handed off; do not act on it.** What actually shipped is
> owned by [`specs/2026-07-24-cli-attach-phase2-design.md`](specs/2026-07-24-cli-attach-phase2-design.md).
> The live handoff is [`2026-07-24-cli-phase3-handoff.md`](2026-07-24-cli-phase3-handoff.md).

Making the `cubical` CLI a **live** second frontend on the *running app's* backend,
instead of a standalone one-shot. This is the payoff of the whole design: the app
window and the terminal become two windows onto one backend — no collision, always
up to date.

**Read first:** the design spec
[`specs/2026-07-24-cli-frontend-design.md`](specs/2026-07-24-cli-frontend-design.md)
(esp. "Phases 2 & 3") and the durable rationale in
[`../implementation/engine-ipc.md`](../implementation/engine-ipc.md) →
"Cross-process vault ownership lock". Auto-memory: `project_cli_frontend`.

---

## Status: Phase 1 DONE & merged to local `main` (gate-green, UNPUSHED)

Phase 1 shipped a write-capable standalone CLI + the cross-process ownership lock.
`main` is a few commits ahead of `origin/main` — **push is the user's call**
(`git push origin main`). Nothing is on a branch; start Phase 2 from a fresh branch
off `main` (`feat/cli-attach` or similar — the user works in the main checkout with
branches, never worktrees).

**The invariant Phase 1 established:** *one backend owns a vault at a time; frontends
attach.* Enforced by an OS advisory lock in `cubical-engine::vault_lock`, taken inside
`open_vault` before `Vault::open`. Chosen architecture is **Option A** (the running
app hosts the backend; CLI attaches when it's up, runs standalone when it's down) —
*not* a standalone daemon.

## What Phase 1 left in place — the seams you plug into

Everything below was built deliberately as a Phase-2 attach point:

1. **`socket_path` already threads through the lock, hardcoded to `None`.**
   - `CubicalError::VaultLocked { pid, socket_path }` — the error `open_vault` returns
     on contention (`crates/cubical-engine/src/error.rs`).
   - `vault_lock::LockPayload.socket_path` + `LockOwner.socket_path`
     (`crates/cubical-engine/src/vault_lock.rs`). `write_payload` currently writes
     `socket_path: None` (vault_lock.rs:82). **Phase 2 makes the app write its socket
     path here so a contending CLI can read it back.**
2. **The CLI's decline branch is the attach point.**
   `crates/cubical-cli/src/main.rs:95` — `Err(CubicalError::VaultLocked { pid, .. }) =>`
   prints "Live routing arrives in Phase 2" and exits 2. **Phase 2 flips this: if
   `socket_path` is `Some`, connect and route the command through it instead of
   declining.**
3. **The lock is taken in the engine, so the GUI already participates.**
   `open_vault` at `crates/cubical-engine/src/commands/vault.rs:60` acquires;
   `close_vault`/process-exit releases. The app taking the lock is exactly what lets
   the CLI find it. The app does NOT yet advertise a socket (there is none) — that's
   the new work.

## What Phase 2 must build

### a) App-side socket server (the backend endpoint)
A Unix-domain-socket listener in `cubical-app` that accepts a framed command, runs it
against the app's **managed** `AppState` with a **`TauriEventSink`**, and returns the
response. Because it uses the same `AppState` + real event sink, executing a command
over the socket updates the live UI identically to a click.

- App wiring today: `crates/cubical-app/src/lib.rs:44` `pub fn run()`,
  `:51` `.manage(AppState::new())`, `:52` `.invoke_handler(generate_handler![…])`,
  and per-command `TauriEventSink::new(app.clone())` (e.g. `:113`, `:365`…). The socket
  server wants a **`.setup(|app| …)`** hook that spawns a tokio task holding the
  `AppHandle` (for `state()` + a `TauriEventSink`) and the socket path.
- **Strong recommendation: factor a shared dispatch layer.** The Tauri commands in
  `lib.rs` are thin wrappers over `cubical_engine::commands::*`. The socket handler is
  the same mapping keyed by a wire enum. Extract one
  `dispatch(cmd, &AppState, &dyn EventSink) -> Response` used by *both* the socket
  server and (ideally) the Tauri commands, so they can never drift. The CLI's
  `dispatch` in `main.rs` is the shape to mirror.

### b) Advertise the socket in the lock payload
When the app opens a vault, its lock payload must carry the server's socket path.
Cleanest seam: add `advertise_socket: Option<String>` to `OpenVaultRequest`, flow it
into `vault_lock::acquire` → `write_payload`. The **app** passes `Some(path)`; the
**CLI** passes `None` (it's a client, never a server). Keeps the engine generic — it's
just a string. (Alternative: a `VaultLockGuard::advertise_socket(&self, path)` that
rewrites the payload post-acquire; the request-field approach is simpler.)

### c) CLI attach path
In `main.rs run()`: on `VaultLocked { socket_path: Some(path), .. }`, open the socket,
send the parsed command, print the response, exit with the server's status. On
`socket_path: None` (a non-server owner — shouldn't happen in Phase 2, but be
defensive), keep today's decline. This also makes **reads** work while the app is open
(Phase 1 declines even reads, because a standalone `open_vault` would run a
second index-writing scan; over the socket there's no second engine).

### Design decisions to settle in brainstorming (don't skip the process)
- **Wire protocol / framing:** length-prefixed JSON is the low-ceremony default (serde
  is everywhere already). Define a `Request`/`Response` enum in a shared module
  (engine or a new tiny `cubical-ipc` crate?) so CLI and app share the types.
- **One socket per app, or per vault?** Per-app is simpler (one listener; the request
  names the vault). The lock payload is per-vault but can advertise the same app-global
  socket path.
- **Socket location & cleanup:** OS runtime dir (same place as the lockfile; reuse
  `CUBICAL_RUNTIME_DIR`). Stale-socket handling on app crash (bind fails → unlink →
  rebind).
- **Windows:** `fs4` locking is cross-platform, but Unix-domain sockets differ on
  Windows (named pipes, or `interprocess` crate). Desktop-v1 is Mac/Linux-first; decide
  whether to abstract now or defer Windows.
- **Concurrency/auth:** the socket is a same-user local endpoint; keep it simple, but
  decide serialization (the engine already serializes via `AppState`'s locks).

## Testing approach
- **Engine/app:** a socket round-trip test — start the server against a temp vault,
  connect, send `create_file`, assert the file exists and the response is right.
- **CLI attach:** an integration test where the *test process* stands up a minimal
  socket server advertising itself in the lock payload (reuse `vault_lock`), then runs
  the `cubical` binary and asserts it routed through the socket (e.g. a sentinel the
  fake server writes) rather than declining. This mirrors the Phase-1
  `declines_with_exit_code_2…` test in `crates/cubical-cli/tests/cli.rs`, which is the
  template.
- Full gate: `scripts/check.sh` (run it, not the pieces).

## Gotchas (bitten in Phase 1 — save yourself the time)
- **Tantivy in-process teardown.** Two engines in one process on the same vault fight
  over tantivy's *own* index lockfile (`LockBusy`) even after `close_vault`, because
  the search writer doesn't drop synchronously. This is why the Phase-1 `open_vault`
  release test asserts at the **`vault_lock` layer**, not via a full reopen
  (`vault.rs` ~:2010). In real cross-process use it's a non-issue (tantivy's lock
  releases on process exit). Keep socket tests cross-process or lock-layer.
- **`CUBICAL_RUNTIME_DIR`** overrides the lock/socket dir — set it in every test for
  hermeticity. In-process env-touching tests must serialize on
  `vault_lock::RUNTIME_ENV_GUARD` (std Mutex) — see the `#[allow(clippy::await_holding_lock)]`
  on the Phase-1 integration test.
- **The lockfile is unlocked-but-not-deleted on release** (deletion races with
  waiters). The next acquirer truncates + rewrites. Don't "fix" this by unlinking.
- **Tauri stale-build phantom bugs.** A hot-reloaded frontend on a stale Rust binary
  fakes real bugs — force a full `npm run tauri dev` recompile before debugging the
  Tauri layer. Auto-memory `project_tauri_stale_build_gotcha`. Live-drive setup:
  `project_tauri_live_verify_setup`.
- **Known flake** (not yours): `cubical-core`'s
  `dropping_handle_stops_event_delivery_within_100ms` fails under full-workspace load,
  passes in isolation.

## Phase 3 (after Phase 2)
An in-app terminal panel running the same `cubical` binary against the socket. It's
nearly free once Phase 2 exists, and subsumes the long-deferred "terminal" backlog item
(`project_requested_ui_backlog` / issue #20 neighborhood).
