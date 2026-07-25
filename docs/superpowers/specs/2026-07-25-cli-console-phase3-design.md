# CLI frontend Phase 3 — in-app command console (design)

**Date:** 2026-07-25
**Status:** designed, **blocked on tabs** — see "Dependency" below
**Supersedes the Phase-3 framing in:** [`../2026-07-24-cli-phase3-handoff.md`](../2026-07-24-cli-phase3-handoff.md)
**Builds on:** [`2026-07-24-cli-frontend-design.md`](2026-07-24-cli-frontend-design.md) (Phase 1),
[`2026-07-24-cli-attach-phase2-design.md`](2026-07-24-cli-attach-phase2-design.md) (Phase 2)
**Durable rationale lands in:** [`../../implementation/engine-ipc.md`](../../implementation/engine-ipc.md)

---

## What this is

A **Cubical command console**: a collapsible bottom panel in the app window with an input
line and a scrollback log, running the same verbs as the `cubical` binary against the
already-open vault.

The Phase-3 handoff framed this as "an in-app terminal panel" and named the fork it left
open — *general shell vs. Cubical-only console*. This spec settles that fork on the
console. No PTY, no ANSI, no shell process, no `xterm.js`, and no requirement that the
`cubical` binary be on `PATH` or bundled with the app.

That last point is the decisive one. A general shell would reach Cubical by shelling out
to `cubical`, which attaches over the Unix socket — elegant, but it makes the panel depend
on an unsolved packaging problem and inherits Phase 2's `#[cfg(unix)]` restriction. The
console calls `dispatch` in-process instead, so it needs no binary and works on Windows,
where sockets are deliberately deferred.

## Dependency: this is blocked on tabs

The console is **a tab**, not a docked panel — it opens in the center workspace alongside
open notes and is closed like any other tab. Cubical has no tabs today (issue #20; the
`topbar__tabs` markup in `App.tsx` renders exactly one placeholder `tab--active` div), so
this spec cannot be implemented until that lands.

Sequencing, decided 2026-07-25:

- **Project A — tabs** (issue #20), tabs-only, no splits. Its own spec → plan → build.
- **Project B — this spec**, retargeted onto A's tab model.

§1 (the Rust half) is entirely tab-agnostic and unchanged by this. It is deliberately
**not** landed early: `render_to` with no second caller is speculative generality, and a
`console_exec` command with no UI to call it is dead code waiting on a dependency.

The accepted cost of tab-over-panel, with no splits: **the console cannot be visible at the
same time as a note.** Running `list` or `backlinks` while reading is exactly the use case
that loses. This was weighed and accepted; splits would restore it and are deferred with
the rest of issue #20.

## The invariant this must not break

**One `dispatch`, three callers** — CLI-local, the app's socket server, the CLI client.
The console becomes the **fourth caller of that same `dispatch`**, never a parallel
implementation. Everything in §1 exists to make a fourth caller possible without
duplicating parsing or output formatting.

---

## 1. Rust changes

### 1a. Move the clap parser into `cubical-ipc` (new `parse.rs`)

Today `Cli`, `Cmd`, `NewWhat`, and `build_command` live in `crates/cubical-cli/src/main.rs`
and cannot be reached by anything else. They move to `crates/cubical-ipc/src/parse.rs`.

The destination follows from symmetry. `render` (`Outcome` → text) already lives in
`cubical-ipc` precisely so that every frontend produces identical output. `parse` (text →
`Command`) is the same boundary in the other direction, and it exists for the same reason.
`cubical-ipc` owns the text boundary in both directions; `main.rs` shrinks to runtime,
attach, and scan-wait logic.

`clap = { version = "4", features = ["derive"] }` moves from `cubical-cli`'s manifest to
`cubical-ipc`'s. It is not feature-gated: both dependents need it.

**The stdin read does not move.** `build_command`'s `Cmd::Write` arm currently reads
`stdin` inline, which is a CLI-only concern. The split:

```rust
pub fn needs_body(cmd: &Cmd) -> bool;
pub fn to_command(cmd: Cmd, vault_root: &Path, body: Option<String>) -> Result<Command>;
```

`to_command` errors if `needs_body` was true and `body` is `None`. The CLI reads stdin and
passes `Some`; the console rejects the verb before calling (§3).

### 1b. Make `render` sink-based

```rust
pub fn render_to(outcome: &Outcome, json: bool, out: &mut dyn Write, err: &mut dyn Write) -> i32;
pub fn render(outcome: &Outcome, json: bool) -> i32;   // two-line wrapper over stdout/stderr
```

Every `println!`/`eprintln!` in `render.rs` becomes a `writeln!` to the corresponding sink.
The CLI keeps calling `render` and is otherwise untouched. The console passes two `Vec<u8>`
buffers and gets structured output back.

### 1c. New Tauri command `console_exec` (`cubical-app`)

```rust
#[tauri::command]
async fn console_exec(vault_id: String, line: String, ...) -> Result<ConsoleResult, String>

struct ConsoleResult { stdout: String, stderr: String, code: i32 }
```

Steps, in order:

1. **Tokenize** `line` with quote awareness.
2. **Strip an optional leading `cubical` token**, so both `list` and `cubical list` work.
3. **Reject `--vault`** at the token level — the console is bound to the open vault (§3).
4. **Parse** via `cubical_ipc::parse` — clap errors, including `--help`, are captured
   rather than printed (§4).
5. **Reject body-needing verbs** via `needs_body(&cmd)`, which is `write` today (§3).
   This is checked *after* parsing, not on the raw tokens, so the rule is expressed once
   in `parse.rs` and a future body-needing verb is rejected automatically.
6. **Build** the `Command` via `to_command(cmd, vault_root, None)`.
7. **Dispatch** through `cubical_ipc::dispatch(&vault_id, command, &state, sink)` using the
   app's own **`TauriEventSink`** (`crates/cubical-app/src/tauri_sink.rs`).
8. **Render** via `render_to` into two buffers → `ConsoleResult`.

Step 7 is what makes the panel feel native: because it uses the same sink as the socket
server, live-UI refresh (file tree via the watcher, settings via `vault:setting-changed`)
happens exactly as it does for an attached CLI call. No new event plumbing.

### New dependency

One: a quote-aware tokenizer for step 1. **`shell-words`** (~200 lines, no transitive
dependencies, MIT/Apache-2.0) over a hand-rolled parser. Recorded explicitly because
"no new runtime dependencies" was part of the console's case against the general-shell
fork — this is the one exception, and it is a build-time-only Rust crate, not a JS runtime
dependency.

---

## 2. Frontend and settings

| Unit | Owns |
|---|---|
| `ui/src/console/history.ts` | ↑/↓ command-history ring — pure, unit-tested |
| `ui/src/console/scrollback.ts` | entry model `{ kind: "input" \| "stdout" \| "stderr", text }` + 500-entry cap — pure, unit-tested |
| `ui/src/console/ConsolePanel.tsx` | the panel: scrollback log + input line |
| `ui/src/api/ipc.ts` | `consoleExec` — the single IPC chokepoint, per `docs/migration-touchpoints.md` |
| tab model (project A) | a `console` view kind, `view.openConsole` command and shortcut, gated on the core-plugin toggle |
| `ui/src/styles/layout.css` | console-tab body styling only — no new layout region |
| `ui/src/settings/corePlugins.ts` | a `console` entry in `CORE_PLUGINS` |

**Placement.** The console is a **view kind in project A's tab model**, rendered in the
center workspace where a note or tag page would be. It adds no layout region, no drag
handle, and no height state — the tab model owns all of that. This adds a little to
`layout.css` and shrinks none of it, so the standing "do not shrink `layout.css` further"
carry-over is unaffected.

**Composability.** Per the CLAUDE.md non-negotiable, the console is a core plugin, not a
monolith. `CORE_PLUGINS` gains:

```ts
{ id: "console", name: "Command console",
  description: "Run cubical commands against the open vault in a tab.",
  settingKey: "plugins.console_enabled", defaultEnabled: false }
```

`defaultEnabled: false`, unlike the two existing core plugins. The console is a power-user
surface that can rename and trash files, so it is opt-in; flipping the default later is a
one-line change if it earns its place.

When the plugin is switched off while a console tab is open, that tab closes — a composable
block must switch off cleanly.

**Settings storage needs no Rust change.** Settings are stored generically as TOML
key/value pairs; only the TS `Setting` union in `ui/src/api/ipc.ts` enumerates keys, so
this is a one-line addition there. `is_workspace_key` is `key.starts_with("ui.")`, so a
`plugins.*` key is vault-scoped and travels in the portable `.cubical/config.toml` —
correct for a core plugin.

**Scrollback and history are session state**, held in signals and discarded when the tab
closes or the vault changes. Not persisted.

---

## 3. Verbs the console rejects

**`write`.** `cubical write <path>` replaces a file body with text read from stdin, and a
console has no stdin. It errors with a single line: *"write is not available in the console
— use the editor, or pipe from a terminal."* Rejected rather than adapted: retyping a whole
file body into a one-line input is a worse interaction than the editor the app already has,
and adapting it would mean either a second input mode or widening the external CLI surface
as a side effect of a UI decision. The external `cubical write` is unchanged.

**`--vault`.** The console is bound to the vault the app has open. Passing `--vault` errors
rather than being silently ignored, so the user is never misled about which vault a command
touched.

**No confirmation prompts.** `rm` and `rename` run without a dialog, matching CLI behavior:
`rm` moves to the OS trash and `rename` is reversible via `undo-rename`. Both are
recoverable, so a modal would add friction without adding safety.

---

## 4. Error handling

- **clap errors and `--help`** are rendered into the scrollback as ordinary output with
  clap's exit code 2. `help`, `new --help`, and a typo'd flag therefore all produce useful
  in-panel text. This falls out of capturing clap's rendered message instead of letting it
  print — a free win, not extra work.

  Help text is clap's generated output, not hand-written console help, so it cannot drift
  from the actual verbs. The console prepends one line naming its own restrictions
  (`write` and `--vault` are unavailable here) since clap does not know about them.
- **Rejected input** (§3) → one `stderr`-kind entry.
- **Dispatch errors** → the identical `error: <msg>` line the CLI prints, code 1.
- **No vault open** → the panel renders inside the existing `vaultId()` gate in `App.tsx`,
  so it cannot exist without a vault.
- **In flight** → the input is disabled until the command returns. Commands are one-shot
  and fast; there is no cancellation and no streaming.

`stderr` entries are styled distinctly from `stdout` entries, and a non-zero exit code is
shown on the entry.

---

## 5. Testing

Phase 2's lesson was that the tests worth having had no fakes. Applied here:

- **Parity test (load-bearing).** The same argv driven through the CLI path and through
  `console_exec` must produce byte-identical stdout. This is the test that keeps the fourth
  caller from drifting away from the other three; if only one test from this spec survives,
  it should be this one.
- **`parse.rs` units** — argv → `Command` for every verb, the `needs_body` path, and clap
  error capture.
- **`render_to` units** — buffers match the bytes `render` prints today, for each `Outcome`
  variant in both `--json` and plain modes.
- **Integration, no fakes** — open a real vault, run `console_exec("new note --at Smoke.md")`,
  assert the file exists on disk.
- **Vitest** — `history.test.ts` and `scrollback.test.ts` (pure), plus a `ConsolePanel`
  render test.

Full gate is `scripts/check.sh`. Note the two standing gotchas: piping it to `tail` masks
its exit code, and `cubical-core`'s `dropping_handle_stops_event_delivery_within_100ms` is
a known flake under full-workspace load.

---

## 6. Out of scope

Not in this spec, and not implied by it: a PTY or any shell process; ANSI or curses
support; running arbitrary non-`cubical` programs; streaming or long-running commands;
command cancellation; tab completion; persisted scrollback or history across restarts;
bundling the `cubical` binary with the app; **splits** (a console tab and a note tab
visible at once) — deferred with the rest of issue #20.

The general-shell fork is not foreclosed — the console does not make it harder to add a
real terminal later — but nothing here is built speculatively to accommodate it.
