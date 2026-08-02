> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# CLI Frontend Phase 2 — Live Attach — Design

**Date:** 2026-07-24
**Status:** Approved for build (self-reviewed; pending user spec review).
**Branch:** `feat/cli-attach` (off `main`; single checkout, no worktrees).
**Predecessor:** [`2026-07-24-cli-frontend-design.md`](2026-07-24-cli-frontend-design.md) (Phase 1 — the ownership lock + standalone CLI). Handoff: [`../2026-07-24-cli-frontend-phase2-handoff.md`](../2026-07-24-cli-frontend-phase2-handoff.md).

## Goal

Make the `cubical` CLI a **live** second frontend on the *running app's* backend instead of a standalone one-shot. When the app owns a vault, the CLI attaches over a local socket and routes its command through the app's in-process engine — so a terminal `cubical` command updates the live UI identically to a click, reads work while the app is open, and there is never a second writer. When the app is closed, the CLI runs standalone exactly as in Phase 1.

This completes the invariant Phase 1 established: **one backend owns a vault at a time; every frontend attaches to it.** It does **not** add or change any user-facing vault feature — it only changes *who executes* a CLI command when the app is up.

## Non-goals (hold the line on scope)

- No REPL / persistent CLI session — still one command per invocation (deferred to a later phase).
- No new vault commands beyond Phase 1's verb set.
- No refactor of the ~40 hand-written Tauri GUI commands — they remain the GUI's own path. Only the CLI's command surface is unified.
- No Windows socket backend — Unix-domain sockets only, behind `#[cfg(unix)]`; Windows falls back to the Phase-1 decline (see §7).
- Phase 3 (in-app terminal panel) stays deferred; this phase makes it nearly free.

## Architecture

Three callers, **one dispatch**:

1. **CLI, app closed** — acquire the vault lock, run the command against a one-shot engine with a `NoopEventSink` (Phase-1 behavior).
2. **CLI, app open** — serialize the command, send it over the app's socket, print the response.
3. **App socket server** — deserialize the command, run it against the app's managed `AppState` with a `TauriEventSink`.

Callers 1 and 3 execute the **same** `dispatch(...)` function; caller 2 produces the same `Command` value that caller 1 would run locally. Zero drift by construction: there is exactly one place that maps a command to engine calls, and one place that renders the result.

### New crate: `cubical-ipc`

A tiny workspace crate that owns the wire boundary. Depends on `cubical-engine`; both `cubical-cli` and `cubical-app` depend on it. The engine stays free of wire-serialization concerns.

Contents:

- **`Command`** — a `serde` enum, one variant per CLI verb:
  `List`, `Resolve { target }`, `Backlinks { path }`, `NewNote { at, parent }`,
  `NewFolder { parent }`, `Write { path, content }`, `RenameFile { from, to }`,
  `RenameFolder { from, to }`, `Rm { path }`, `Set { key, value }`, `Get { key }`,
  `UndoRename { op_id }`.
  - `Write.content` carries the stdin body — the CLI reads stdin client-side, so stdin never crosses the socket as a stream.
  - Rename is split into `RenameFile`/`RenameFolder`: the CLI does the `is_dir` detection client-side (it has FS access to the vault in both modes) and emits the matching variant, which maps 1:1 to the two engine fns. Keeps `dispatch` from needing a vault-root lookup.
- **`Request { vault_path: PathBuf, command: Command }`** — `vault_path` is the **canonicalized** vault path; the server resolves it to an open `vault_id`.
- **`Outcome`** — a `serde` enum, one variant per command carrying exactly what the CLI prints (created path, rename `pending_count`, file list, `Resolve` `Option<String>`, backlinks list, `Get` `Option<Value>`, `UndoRename` `removed` count, write confirmation, etc.).
- **`Response`** — `enum Response { Ok(Outcome), Err(String) }`; dispatch errors travel as `Err(message)` data rather than a dropped connection. (Built as a dedicated enum rather than the originally-sketched `Result<Outcome, String>` alias: it tags cleanly on the wire and reads unambiguously at the CLI match site.)
- **`dispatch(vault_id: &str, command: Command, state: &AppState, sink: &dyn EventSink) -> Result<Outcome, CubicalError>`** — the single command→engine-fn mapping. This *is* today's `cubical-cli/src/main.rs` `dispatch`, lifted out and made to return data instead of printing.
- **`render(outcome: &Outcome, json: bool) -> i32`** — prints human-readable or `--json` output to stdout/stderr and returns the process exit code, owning the existing "unresolved/unset → exit 1" cases (`Resolve` None, `Get` None). Both the local and socket paths call `render` identically.
- **Transport** (`#[cfg(unix)]`), see §4.
- **`app_socket_path(pid: u32) -> PathBuf`** — the canonical per-app socket location (runtime dir, `cubical-<pid>.sock`), used by both the server bind and the app's open-vault wiring so they never disagree.

## Data flow

**App closed (standalone, unchanged from Phase 1):**
`cubical <cmd>` → canonicalize `--vault` → `open_vault` acquires the lock (advertising `None`) → `wait_for_scan` → build `Command` (read stdin for `write`) → `dispatch(vault_id, cmd, &state, &NoopEventSink)` → `render(outcome, json)` → `close_vault` (flushes referrer rewrites) → exit.

**App open (attach):**
`cubical <cmd>` → canonicalize `--vault` → `open_vault` → `Err(VaultLocked { socket_path: Some(path), .. })` → build `Request { vault_path, command }` (read stdin for `write`) → `ipc::client::send(path, request)` → **[app]** accept → resolve `vault_path` → `vault_id` → `dispatch(vault_id, cmd, &state, &TauriEventSink)` → engine fn runs, `TauriEventSink` fires and the app's file watcher picks up the FS change (UI updates live) → `Outcome` → framed `Response` → **[CLI]** `render(outcome, json)` → exit with that code.

## App-side socket server & advertisement

- **Server task:** a `.setup(|app| …)` hook in `cubical-app` spawns a task (via `tauri::async_runtime::spawn`) that binds `app_socket_path(pid)` (**unlink-before-bind** to clear a stale same-pid leftover) and accepts connections. Connections are handled **sequentially** in that one task (not one task per connection: `handle_connection` borrows `&AppState`/`&dyn EventSink`, so spawning would demand `'static`, and mutations are already serialized by `AppState`'s own locks). Per connection:
  1. read a framed `Request`;
  2. resolve `request.vault_path` → `(vault_id, scan_status)` via a new public engine resolver (see below); if not open → `Response::Err("vault not open")`, if not yet `Complete` → `Response::Err("vault is still scanning")`;
  3. `dispatch(vault_id, request.command, app.state::<AppState>(), &TauriEventSink::new(app.clone()))`;
  4. map `Result<Outcome, CubicalError>` → `Response` and write it framed.
  A panicking or erroring handler never brings down the app; the worst case is one `Response::Err`.
- **Path→vault resolver:** `find_open_vault_by_canonical_path` is currently private. Add a thin `pub async fn resolve_open_vault(state: &AppState, canonical: &Path) -> Option<(String, ScanStatus)>` in `commands::vault` wrapping it, rather than leaking the private helper. It must surface the scan status, not just the id: the attach path has no `wait_for_scan`, and dispatching against a partial index gives `list` partial results and `rename` an incomplete referrer set.
- **Socket advertisement:** add an `advertise_socket: Option<String>` **parameter** to `commands::vault::open_vault` (not a field on `OpenVaultRequest`, which is the frontend→app `Deserialize` contract and must not carry app-internal wiring). Thread it into `vault_lock::acquire(canonical, socket_path)` → `write_payload`, replacing the hardcoded `socket_path: None`. The **app** passes `Some(app_socket_path(pid).to_string_lossy())`; the **CLI** and engine tests pass `None`. Four call sites total.
- **One socket per app.** The per-pid filename avoids collisions between two app instances (which own different vaults / different locks). Every vault the app opens advertises the *same* socket path; the `Request` names the vault, so one listener serves all open vaults.

## Concurrency & safety

- The engine already serializes mutations through `AppState`'s locks. Socket connections, the GUI, and (when closed) the one-shot CLI all funnel through the same `AppState` — no new locking is introduced.
- Attach uses the app's `AppState` + a real `TauriEventSink` (rather than a second engine) so the app's index, rename journal and audit log stay authoritative and the rename/flush/audit events reach the UI. The editor picks up a socket `write` through the **file watcher**, not through `flush_own_writes` — `write_file_text` does not populate that gate (only the rename referrer-rewrite flush does), and suppressing the echo would leave the GUI unaware of the write.
- The socket is a same-user, local-only endpoint (Unix-domain socket in the user's runtime dir). Filesystem permissions are the only auth layer, so they are asserted rather than assumed: `0o700` on the runtime dir, `0o600` on the socket after bind (the `temp_dir()` fallback can be world-writable). Consistent with the local-first, single-user desktop model.
- Both sides read under a deadline (`cubical_ipc::IO_TIMEOUT`, 10s): the accept loop is sequential, so an idle connected peer would otherwise wedge every later `cubical` invocation. A transient `accept` error backs off and retries, and a panicking handler is caught, so neither ends the server for the app's lifetime.

## Wire protocol & transport (`#[cfg(unix)]`)

- **Framing:** length-prefixed JSON — a `u32` big-endian length followed by the `serde_json` bytes, for both `Request` and `Response`. One request / one response per connection, then close (no multiplexing — the CLI is one-shot).
- **Client:** `client::send(socket_path: &Path, req: &Request) -> io::Result<Response>` — connect a `UnixStream`, write the framed request, read the framed response.
- **Server helpers:** shared `read_frame`/`write_frame` (or typed `read_request`/`write_response`) in `cubical-ipc`; the ~20-line accept loop lives app-side because it needs the `AppHandle`.
- **Windows:** `#[cfg(not(unix))]` stubs — `client::send` and the server bind return an error; the app simply never spawns the server, and the CLI hits `socket_path: None` (or a connect error) and falls back to the Phase-1 decline. The platform seam is confined to the transport module.

## CLI attach path

In `run()`, the `Err(CubicalError::VaultLocked { .. })` arm becomes:

- **`socket_path: Some(path)`** → build `Request { vault_path: canonicalize(--vault), command }` (reading stdin for `write`), `ipc::client::send(&path, &req)`:
  - `Ok(Response::Ok(outcome))` → `render(&outcome, json)`, exit with its code.
  - `Ok(Response::Err(msg))` → `eprintln!("error: {msg}")`, exit 1.
  - `Err(io)` (connect refused / socket missing — the app closed between our lock read and connect) → `eprintln!("error: …")`, exit 1. **No retry** (stdin is already consumed for `write` and isn't seekable; the race is rare and re-running succeeds against the now-free lock).
- **`socket_path: None`** → keep the Phase-1 decline (exit 2). Defensive: shouldn't occur when the app is the owner in Phase 2.

Reads (`list`, `resolve`, `backlinks`, `get`) now succeed while the app is open, because they route over the socket instead of trying a second index-writing `open_vault`.

## Error handling summary

| Situation | Behavior |
|---|---|
| App closed, command ok | Phase-1 standalone, exit 0 |
| App closed, command error | `close_vault` then exit 1 (Phase 1) |
| App open, command ok | Dispatched live over socket, `render` exit code |
| App open, dispatch error | `Response::Err` → exit 1 |
| App open, vault mid-close / not resolvable | `Response::Err("vault not open")` → exit 1 |
| App open, vault still scanning | `Response::Err("vault is still scanning")` → exit 1 (the local path's `wait_for_scan` equivalent — a partial index would give `list` partial results and `rename` an incomplete referrer set) |
| App open, `cubical set …` | Dispatched live; the UI reflects it immediately. There is no watcher to ride on (`.cubical/` is excluded, and workspace keys go to libsql), so `dispatch`'s `Set` arm emits `vault:setting-changed` and the frontend re-hydrates. Emitted from `dispatch`, not `set_setting`, so the GUI's own writes don't echo back. *(Closed 2026-07-24; was the one attached command with no live UI effect.)* |
| App open, peer idle / app wedged | Client read times out after `IO_TIMEOUT` → clear error, exit 1 |
| App open, connect fails (app just closed) | Clear error, exit 1 (no retry) |
| Lock held but `socket_path: None` | Phase-1 decline, exit 2 |
| Windows | No server; decline / connect-error path |

## Testing

- **`cubical-ipc` unit:** framing round-trip (`write_frame` → `read_frame` for a `Request` and a `Response`); `dispatch` against a temp-vault `AppState` for `NewNote` and `Write` (assert FS effect + returned `Outcome`); `render` exit codes for `Resolve(None)` / `Get(None)`.
- **Socket round-trip (cross-task, one engine):** a server task binds a temp socket (via `CUBICAL_RUNTIME_DIR`) and runs real `dispatch` against a temp-vault `AppState`; `client::send` a `NewNote` then a `Write`; assert the FS effect and the `Response`.
- **CLI attach integration (cross-process; mirrors Phase-1 `declines_with_exit_code_2`):** the test process calls `vault_lock::acquire(&canonical, Some(&sock))` to hold the lock *and* advertise, binds a **fake** server on `sock` that returns a sentinel `Outcome` (no real engine → no tantivy teardown concern), sets `CUBICAL_RUNTIME_DIR`, runs the `cubical` binary, and asserts it routed through the socket (sentinel in stdout) rather than declining with exit 2. A companion `write`-over-socket case asserts stdin reached the fake server.
- **Regression:** the Phase-1 exit-2 test still passes when the owner advertises no socket (`acquire(&canonical, None)`).
- Full gate: `scripts/check.sh` (run it, not the pieces). Watch for the known `cubical-core` watcher flake under full load (not a regression).

### Gotchas carried from Phase 1

- Keep socket tests **cross-process or single-engine** — two real engines in one process fight over tantivy's own index lockfile even after `close_vault`. The fake-server attach test sidesteps this (no engine in the holder).
- Always set `CUBICAL_RUNTIME_DIR` for hermeticity; in-process env-touching tests serialize on `vault_lock::RUNTIME_ENV_GUARD`.
- The lockfile is unlocked-but-not-deleted on release; the next acquirer truncates + rewrites. Socket-path advertisement rides in that same rewrite — don't unlink the lockfile.
- Tauri stale-build phantom bugs: force a full `npm run tauri dev` recompile before debugging the app-side server.

## Docs

- **Durable rationale:** extend `docs/implementation/engine-ipc.md` → "Cross-process vault ownership lock" with the now-realized socket boundary (server in `cubical-app`, `dispatch`/wire types in `cubical-ipc`, advertisement via the `open_vault` param, `#[cfg(unix)]` seam).
- **"What was built (Phase 2)"** recorded in this spec at close; `CLAUDE.md` Project state and the `project_cli_frontend` memory rewritten.

## What was built (Phase 2)

- **New crate `cubical-ipc`** — `protocol.rs` (`Command`/`Request`/`Outcome`/
  `Response`, `Outcome` carrying owned primitives rather than engine response
  structs), `dispatch.rs` (the single command→engine-fn mapping, lifted out
  of the CLI), `render.rs` (all printing + exit codes), `transport.rs`
  (length-prefixed JSON framing, `client_send`, `handle_connection`,
  `app_socket_path`; `#[cfg(unix)]` with a `#[cfg(not(unix))]` error stub).
  12 tests: 2 protocol round-trip, 2 dispatch, 4 render, 2 transport, 2 socket
  round-trip (real `UnixListener` + real `dispatch`).
- **Engine:** `vault_lock::acquire`/`acquire_in`/`write_payload` take
  `socket_path: Option<&str>`; `commands::vault::open_vault` gained a 4th
  `advertise_socket: Option<String>` **parameter** (not an `OpenVaultRequest`
  field — that type is the frontend→app `Deserialize` contract). New public
  `resolve_open_vault(state, canonical_path) -> Option<(String, ScanStatus)>`
  wraps the existing private lookup — it returns the scan status too, so the
  socket path can gate on `Complete` the way the local path's
  `wait_for_scan` does. `vault_lock::runtime_dir` is `pub` so `cubical-ipc`
  shares one definition instead of a copy. 1 new `vault_lock` advertisement
  test, 2 resolver tests.
- **App:** `open_vault` advertises `Some(app_socket_path(pid))`; a `.setup()`
  hook spawns `serve_socket`, a sequential accept loop over
  `cubical_ipc::handle_connection` — one task, not one-per-connection, since
  `handle_connection` borrows `&AppState` and mutations are already
  serialized by `AppState`'s own locks. Each connection gets a fresh
  `TauriEventSink`, so the app's index/journal stay authoritative and the
  rename/flush/audit events reach the UI; a socket `write` reaches the editor
  via the **file watcher** (`write_file_text` does not populate
  `flush_own_writes`). `open_vault` advertises a socket path only when the
  `.setup()` bind actually succeeded, so a failed bind degrades to the
  Phase-1 decline instead of stranding every later CLI call on a dead path.
  The accept loop survives transient errors (backoff + retry) and catches a
  panicking handler; the socket is unlinked on `RunEvent::Exit`.
- **CLI:** builds the wire `Command` before opening the vault (stdin is
  consumed once and isn't seekable). `VaultLocked { socket_path: Some(path) }`
  → attach over the socket; `None` → the Phase-1 decline (exit 2), unchanged.
  No retry on connect failure. Reads (`list`/`resolve`/`backlinks`/`get`) now
  work while the app is open. 1 attach test (real binary vs. a fake server)
  + 2 end-to-end tests (real binary + real engine + real socket, asserting
  the FS effect and a piped stdin write).
- **`--json` output is now `Outcome`-defined** (an intentional, documented
  change from Phase 1's raw-engine-struct dump). **Success** output on stdout
  is byte-identical to Phase 1. Error text is not: Phase 1 wrapped engine
  calls in `anyhow` context, so a failure printed e.g.
  `error: writing X.md: <cause>`; the shared `dispatch` prints
  `error: <cause>`. Accepted — the cause is unchanged and the context added
  nothing the command line didn't already say.
- 17 new tests total across `cubical-ipc`, `cubical-engine`, and
  `cubical-cli`.

**Not built:** interactive Tauri GUI smoke-verification of the live socket
path (non-interactive session — covered instead by the cross-process fake-
server and real-engine-over-socket tests above). Phase 3 (in-app terminal
panel) remains deferred; this phase makes it nearly free, per the Architecture
section above.
