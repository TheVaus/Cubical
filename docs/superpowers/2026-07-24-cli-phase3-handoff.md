# CLI frontend — Phase 3 handoff (2026-07-24)

Phase 3 is the **in-app terminal panel**: a terminal inside the Cubical window running
the same `cubical` binary against the app's own socket. It subsumes the long-deferred
"terminal" backlog item. Phases 1 and 2 were built so that this phase is nearly free —
the backend work is done; what remains is a UI surface plus a PTY.

**Read first:** the Phase-2 design spec
[`specs/2026-07-24-cli-attach-phase2-design.md`](specs/2026-07-24-cli-attach-phase2-design.md)
and the durable rationale in [`../implementation/engine-ipc.md`](../implementation/engine-ipc.md)
→ "Cross-process vault ownership lock" / "Socket boundary". Auto-memory:
`project_cli_frontend`. The Phase-1 spec is
[`specs/2026-07-24-cli-frontend-design.md`](specs/2026-07-24-cli-frontend-design.md).

---

## Status: Phases 1 & 2 DONE, merged to local `main`

Merge commit `a0c9f46` (`--no-ff`); branch `feat/cli-attach` deleted. Full gate re-run
**on the merged result**: exit 0, **771 vitest + 629 Rust, 0 failures**.

**`main` is ~30 commits ahead of `origin/main` and UNPUSHED** (6 of those predate the
Phase-2 session). Pushing is the user's call — ask, don't assume.

The invariant is now fully realized: **one backend owns a vault at a time; frontends
attach.** With the app running, `cubical` executes against its live in-process engine
over a Unix socket; with the app closed it runs a standalone one-shot. Reads work either
way.

## What Phases 1–2 left in place — the seams Phase 3 plugs into

1. **The socket already exists and is already served.** `cubical-app`'s `.setup()` binds
   `cubical_ipc::app_socket_path(pid)` and runs a sequential accept loop over
   `cubical_ipc::handle_connection`. Phase 3 does **not** need new backend plumbing.
2. **The `cubical` binary already attaches.** On `VaultLocked { socket_path: Some(..) }`
   it connects and routes the command. A terminal panel that simply *runs `cubical`* in
   the app's own vault directory gets live behavior for free.
3. **`cubical-ipc` is the whole wire boundary** — `Command`/`Request`/`Outcome`/
   `Response`, the single `dispatch()`, the single `render()` (all printing + exit
   codes), framing, `client_send`, `handle_connection`, `app_socket_path`, `IO_TIMEOUT`
   (10s). Architecture to preserve: **one `dispatch`, three callers** (CLI-local,
   socket server, CLI client). Anything Phase 3 adds should become a *fourth caller of
   the same dispatch*, never a parallel implementation.

## What Phase 3 must build

A terminal panel in the app. The backend is done; this is mostly frontend + process
management:

- **A PTY host.** Tauri has no built-in terminal. Realistic options: the
  `portable-pty` crate (mature, cross-platform) driving a shell, or spawning `cubical`
  directly without a full shell. Decide whether the panel is a *general terminal* (full
  shell, user can run anything) or a *Cubical command console* (only `cubical` verbs).
  These are very different products — settle it in brainstorming.
- **A frontend terminal widget.** `xterm.js` is the obvious choice but is a new runtime
  dependency; check it against the no-Electron/no-Node non-negotiables (it's a browser
  lib, so it's fine, but it is a real dep). A DS-native minimal console is the
  alternative if the scope is "Cubical commands only".
- **Wiring the panel to the vault.** The panel should default its cwd to the open
  vault so bare `cubical <cmd>` resolves without `--vault`.
- **Composability.** Per the CLAUDE.md non-negotiable, this must be a toggleable
  feature block, not a monolith — it switches off cleanly without touching the `.md`
  source of truth.

### Design decisions to settle in brainstorming (don't skip the process)

- **General shell vs. Cubical-only console.** The biggest fork. A general shell is more
  useful and much larger surface (PTY, ANSI, resize, signals, security); a
  command console is small and safe.
- **Does the panel go through the socket at all?** If it shells out to `cubical`, it
  attaches over the socket like any terminal — clean, zero new backend. If it calls
  `dispatch` in-process instead, it skips a hop but becomes a fourth caller to keep in
  sync. Prefer shelling out unless there's a concrete reason not to.
- **Where the binary comes from.** A shipped app needs `cubical` on `PATH` or bundled
  alongside the app. Bundling is a packaging question that has not been touched.
- **Concurrency.** The app's accept loop is **sequential** today (fine for one-shot CLI
  calls). A terminal panel can hold longer-lived commands, so a slow command would block
  other socket clients. The Phase-2 final review recommended per-connection spawn +
  the existing read timeout as the shape that scales into Phase 3. Note the recorded
  rationale that spawning "would demand `'static`" is **not quite right** — `AppHandle`
  is `'static` and cloneable, so the borrow can be created inside the task. Re-evaluate
  rather than inheriting the constraint.

## Testing approach

- Follow the Phase-2 pattern: the valuable tests were the ones with **no fakes**.
  `crates/cubical-cli/tests/attach_e2e.rs` is the template — the test process plays
  "the app" (real `AppState`, real `open_vault` advertising a real socket, real accept
  loop via `tokio::join!`), and drives the **real `cubical` binary**. Only one engine
  exists, so there's no tantivy index-lock conflict.
- Full gate: `scripts/check.sh` (run it, not the pieces).

## Gotchas (paid for in Phases 1–2 — don't re-learn these)

- **`scripts/check.sh | tail` masks the exit code.** A piped gate reports `tail`'s
  status, not the gate's. Redirect to a file and check `$?` directly, or you will
  believe a red gate is green. This actually happened.
- **`cubical-core`'s `dropping_handle_stops_event_delivery_within_100ms` is a known
  timing flake** under full-workspace load; it passes in isolation. Confirm by re-running
  it alone. Don't "fix" it.
- **Tests that mutate `CUBICAL_RUNTIME_DIR` must serialize on a mutex guard.** Rust runs
  a crate's tests concurrently in one process. Unguarded `set_var`/`remove_var` races —
  in Phase 2 this manifested as a *hang*, not a failure. Engine uses
  `vault_lock::RUNTIME_ENV_GUARD`; `cubical-ipc` has a crate-local one; integration test
  files declare their own. Async tests holding it across `.await` need
  `#[allow(clippy::await_holding_lock)]`.
- **Tauri stale-build phantom bugs.** A hot-reloaded frontend on a stale Rust binary
  fakes real bugs — force a full `npm run tauri dev` recompile before debugging the Tauri
  layer. Auto-memory `project_tauri_stale_build_gotcha`. Live-drive setup:
  `project_tauri_live_verify_setup`.
- **`tokio::net::UnixListener::bind` panics outside a reactor.** Tauri's `.setup()` is
  not in one — Phase 2 had to bind with `std::os::unix::net::UnixListener` and convert
  via `from_std`.
- **Per-task review does not catch cross-task defects.** All eight Phase-2 tasks passed
  their own reviews clean; the final whole-branch review then found 8 Important issues
  that only existed *between* the pieces. Budget for the broad review.

## Known gaps and carry-overs (from the Phase-2 final review)

**Functional:**
- **`cubical set …` doesn't refresh the running UI.** `set_setting` emits no event and
  `.cubical/` is watcher-excluded, so a setting changed from the terminal is invisible
  until a reload. This is the one command where attach is *worse* than the old decline —
  it reports success while the UI diverges. Recorded in the Phase-2 spec. Fix by emitting
  an event the frontend already listens for.
- **The Tauri GUI smoke was never run** (non-interactive session). Everything below
  `.setup()` is covered by the end-to-end tests; the ~15 lines of Tauri glue are
  inspection-only. A one-minute manual check closes it: launch the app, open a vault,
  run `cubical --vault <that> new note --at Smoke.md`, watch it appear in the tree.
- **CLI error text lost Phase-1's `anyhow` context** (`error: writing X.md: <cause>` →
  `error: <cause>`). Deliberate — it's what makes local and attach output identical —
  and the parity claim was narrowed to *success* output. Restore the context in `render`
  if it's missed.

**Cosmetic / deferred (deliberately not fixed):**
- `cubical-ipc`'s transport collapses serde errors, oversized frames, and malformed JSON
  into `io::Error::other`, so the CLI reports "could not reach the running Cubical app"
  even for a malformed response from a reachable app. A small `TransportError` enum
  would make the message honest.
- `cubical write` reads stdin to EOF *before* validating the vault (required — stdin
  isn't seekable and the `Command` must exist before the lock check), so
  `cubical --vault /nonexistent write x.md` hangs at an interactive terminal instead of
  erroring. A `stat` on the vault dir before reading stdin would fix it.

**Unrelated, still open:** intermittent `[[wikilink]]` non-render in Live Preview (raw
mode fine, no pattern yet) — `project_wikilink_livepreview_render_bug`. Two Dependabot
alerts blocked upstream: `lru` #3 (tantivy 0.22), `glib` #1 (Linux-GTK-only). Issue #35's
last DS primitive (the ranked `CommandPalette`/OmniBar) is the only net-new DS item left.

---

**Phase 3 is optional.** Nothing depends on it, and the CLI is fully usable from an
external terminal today. If the next session has higher-value work (the `cubical set`
event, the GUI smoke, pushing `main`), do that first.
