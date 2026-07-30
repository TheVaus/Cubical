# CLI frontend Phase 3 — in-app command console — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cubical command console — a tab in the center workspace with an input line and a scrollback log — that runs the same verbs as the `cubical` binary against the already-open vault, in-process.

**Architecture:** The console becomes the **fourth caller of the one `dispatch`** (after CLI-local, the socket server, and the CLI client). Everything on the wire boundary that both the CLI and the console need moves into `cubical-ipc`: the clap parser (`parse.rs`) and a sink-based renderer (`render_to`). A new Tauri command `console_exec` tokenizes a line, parses it with the shared clap types, dispatches through the app's own `TauriEventSink`, and renders into buffers. The frontend is a plugin-gated `console` tab kind rendered in the center workspace; scrollback and history are ephemeral session state.

**Tech Stack:** Rust (clap 4 derive, tokio, Tauri v2, `shell-words`), Solid/TypeScript (vitest), the existing `cubical-ipc` / `cubical-engine` / `cubical-app` crates and the `ui/src/tabs` model.

**Owning spec:** [`docs/superpowers/specs/2026-07-25-cli-console-phase3-design.md`](../specs/2026-07-25-cli-console-phase3-design.md). Durable rationale lands in [`docs/implementation/engine-ipc.md`](../../implementation/engine-ipc.md) and [`docs/implementation/frontend.md`](../../implementation/frontend.md) → Console.

## Global Constraints

- **One `dispatch`, one `render`/`render_to`, one `parse`.** The console must not duplicate parsing or output formatting. Any drift between the console and the CLI is a bug the parity test (Task 3) exists to catch.
- **`clap = { version = "4", features = ["derive"] }`** moves from `cubical-cli`'s manifest to `cubical-ipc`'s; both dependents use it. Not feature-gated.
- **One new dependency, Rust build-time only:** `shell-words` (MIT/Apache-2.0, no transitive deps). No new JS runtime dependency. No `xterm.js`, no PTY, no shell process.
- **The console rejects `write` and `--vault`** (see Task 3). No confirmation prompts (`rm`/`rename` run directly, matching CLI).
- **Composability (CLAUDE.md non-negotiable):** the console is a core plugin, `settingKey: "plugins.console_enabled"`, `defaultEnabled: false`. Switching it off while a console tab is open closes that tab.
- **No explanatory comments in source** (CLAUDE.md → Comments). Rationale goes in `docs/implementation/`.
- **Gate is `scripts/check.sh` run whole**, never piped to `tail` (masks the exit code — redirect to a file and check `$?`). `cubical-core`'s `dropping_handle_stops_event_delivery_within_100ms` is a known flake under full-workspace load; re-run it alone to confirm, don't "fix" it.
- **Tests that mutate `CUBICAL_RUNTIME_DIR` must serialize on a mutex** (`vault_lock::RUNTIME_ENV_GUARD` / crate-local guard); unguarded `set_var` races manifest as a *hang*. Not expected to bite here (no test in this plan sets that var) but noted.

---

## File Structure

**Rust — moved/changed:**
- `crates/cubical-ipc/src/parse.rs` — **new.** Owns `Cli`, `Cmd`, `NewWhat`, `needs_body`, `to_command`. The text→`Command` boundary, mirroring `render`'s `Command`→text boundary.
- `crates/cubical-ipc/src/render.rs` — add `render_to` (sink-based); `render` becomes a two-line wrapper.
- `crates/cubical-ipc/src/lib.rs` — export `parse` items and `render_to`.
- `crates/cubical-ipc/Cargo.toml` — gains `clap` (from cubical-cli).
- `crates/cubical-cli/src/main.rs` — drops `Cli`/`Cmd`/`NewWhat`/`build_command`; imports them from `cubical_ipc::parse`; reads stdin itself and passes the body in.
- `crates/cubical-cli/Cargo.toml` — loses `clap` (now transitive via cubical-ipc's re-export).
- `crates/cubical-app/src/lib.rs` — new `console_exec` command + registration.
- `crates/cubical-app/Cargo.toml` — gains `shell-words`.

**Frontend — new:**
- `ui/src/console/history.ts` — command-history ring (pure).
- `ui/src/console/scrollback.ts` — scrollback entry model + 500-cap (pure).
- `ui/src/console/ConsolePanel.tsx` — the panel (input line + scrollback log).
- `ui/src/console/*.test.ts(x)` — units for each.

**Frontend — changed:**
- `ui/src/api/ipc.ts` — `consoleExec` wrapper, `ConsoleResult`, `plugins.console_enabled` in the `Setting` union.
- `ui/src/settings/corePlugins.ts` — a `console` entry in `CORE_PLUGINS`.
- `ui/src/tabs/tabModel.ts` — `{ kind: "console" }` in `TabView`; `tabId` handles it.
- `ui/src/core/commands.ts` — `view.openConsole` in `COMMAND_DEFAULTS`.
- `ui/src/core/commands.test.ts` — assert the new default.
- `ui/src/App.tsx` — register the `view.openConsole` command; render `ConsolePanel` in the center workspace; close the console tab when the plugin is disabled; keep console ids out of the editor keep-alive pool; drop console tabs from persisted sessions.
- `ui/src/styles/layout.css` — console-tab body styling only (adds; shrinks nothing).

---

## Task 1: Move the clap parser into `cubical-ipc` (`parse.rs`)

Extract the parser so both the CLI and the console share one text→`Command` boundary. The stdin read stays in the CLI; `to_command` takes an optional body.

**Files:**
- Create: `crates/cubical-ipc/src/parse.rs`
- Modify: `crates/cubical-ipc/src/lib.rs` (add `mod parse;` + re-exports)
- Modify: `crates/cubical-ipc/Cargo.toml` (add `clap`)
- Modify: `crates/cubical-cli/src/main.rs` (delete moved code, import, read stdin, call `to_command`)
- Modify: `crates/cubical-cli/Cargo.toml` (remove `clap`)
- Test: inline `#[cfg(test)]` in `crates/cubical-ipc/src/parse.rs`

**Interfaces:**
- Produces (used by Task 3 and by the CLI):
  ```rust
  // crates/cubical-ipc/src/parse.rs
  #[derive(clap::Parser)]
  #[command(name = "cubical", about = "Drive a Cubical vault from the terminal.")]
  pub struct Cli {
      #[arg(long, global = true, default_value = ".", help = "Path to the vault directory.")]
      pub vault: std::path::PathBuf,
      #[arg(long, global = true, help = "Emit the raw engine response as JSON.")]
      pub json: bool,
      #[command(subcommand)]
      pub cmd: Cmd,
  }
  #[derive(clap::Subcommand)]
  pub enum Cmd { /* List, Resolve, Backlinks, New(NewWhat), Write, Rename, Rm, Set, Get, UndoRename */ }
  #[derive(clap::Subcommand)]
  pub enum NewWhat { /* Note{at,parent}, Folder{parent} */ }

  pub fn needs_body(cmd: &Cmd) -> bool;                 // true for Cmd::Write
  pub fn to_command(cmd: Cmd, vault_root: &std::path::Path, body: Option<String>)
      -> anyhow::Result<crate::Command>;
  ```
- Consumes: `crate::Command` (already in `cubical-ipc`), `anyhow`.

- [ ] **Step 1: Add `clap` to `cubical-ipc`, remove from `cubical-cli`**

In `crates/cubical-ipc/Cargo.toml` under `[dependencies]` add (copy the exact version line from `cubical-cli/Cargo.toml`):
```toml
clap = { version = "4", features = ["derive"] }
```
Remove that same line from `crates/cubical-cli/Cargo.toml`. `cubical-cli` already depends on `cubical-ipc`, so the derive macros resolve through it via the re-exported types.

- [ ] **Step 2: Write `parse.rs` with the moved types and the two functions**

```rust
use std::path::Path;

use anyhow::Result;
use clap::{Parser, Subcommand};

use crate::Command as WireCommand;

#[derive(Parser)]
#[command(name = "cubical", about = "Drive a Cubical vault from the terminal.")]
pub struct Cli {
    #[arg(long, global = true, default_value = ".", help = "Path to the vault directory.")]
    pub vault: std::path::PathBuf,
    #[arg(long, global = true, help = "Emit the raw engine response as JSON.")]
    pub json: bool,
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand)]
pub enum Cmd {
    #[command(about = "List the vault's markdown files (vault-relative paths).")]
    List,
    #[command(about = "Resolve a wiki-link target to a file path. Exits non-zero if unresolved.")]
    Resolve { target: String },
    #[command(about = "List the notes that link to a given note (vault-relative path).")]
    Backlinks { path: String },
    #[command(subcommand, about = "Create a new note or folder.")]
    New(NewWhat),
    #[command(about = "Replace a markdown file's body with text read from stdin.")]
    Write { path: String },
    #[command(about = "Rename a file or folder, rewriting referring links.")]
    Rename { from: String, to: String },
    #[command(about = "Move a file or folder to the OS trash.")]
    Rm { path: String },
    #[command(about = "Set a vault setting. VALUE is parsed as JSON, else stored as a string.")]
    Set { key: String, value: String },
    #[command(about = "Print a vault setting's value.")]
    Get { key: String },
    #[command(name = "undo-rename", about = "Undo a rename operation by its op id.")]
    UndoRename { op_id: i64 },
}

#[derive(Subcommand)]
pub enum NewWhat {
    #[command(about = "Create a markdown note.")]
    Note {
        #[arg(long, help = "Exact vault-relative path, e.g. notes/Daily.md.")]
        at: Option<String>,
        #[arg(long = "in", help = "Parent directory for an auto-named note.")]
        parent: Option<String>,
    },
    #[command(about = "Create a folder.")]
    Folder {
        #[arg(long = "in", help = "Parent directory for an auto-named folder.")]
        parent: Option<String>,
    },
}

pub fn needs_body(cmd: &Cmd) -> bool {
    matches!(cmd, Cmd::Write { .. })
}

pub fn to_command(cmd: Cmd, vault_root: &Path, body: Option<String>) -> Result<WireCommand> {
    Ok(match cmd {
        Cmd::List => WireCommand::List,
        Cmd::Resolve { target } => WireCommand::Resolve { target },
        Cmd::Backlinks { path } => WireCommand::Backlinks { path },
        Cmd::New(NewWhat::Note { at, parent }) => WireCommand::NewNote { at, parent },
        Cmd::New(NewWhat::Folder { parent }) => WireCommand::NewFolder { parent },
        Cmd::Write { path } => {
            let content =
                body.ok_or_else(|| anyhow::anyhow!("write requires a body on stdin"))?;
            WireCommand::Write { path, content }
        }
        Cmd::Rename { from, to } => {
            if vault_root.join(&from).is_dir() {
                WireCommand::RenameFolder { from, to }
            } else {
                WireCommand::RenameFile { from, to }
            }
        }
        Cmd::Rm { path } => WireCommand::Rm { path },
        Cmd::Set { key, value } => {
            let parsed = serde_json::from_str::<serde_json::Value>(&value)
                .unwrap_or(serde_json::Value::String(value));
            WireCommand::Set { key, value: parsed }
        }
        Cmd::Get { key } => WireCommand::Get { key },
        Cmd::UndoRename { op_id } => WireCommand::UndoRename { op_id },
    })
}
```

- [ ] **Step 3: Export from `lib.rs`**

In `crates/cubical-ipc/src/lib.rs`, add `mod parse;` beside the other `mod` lines and add a re-export:
```rust
pub mod parse;
```
(A `pub mod` keeps the `cubical_ipc::parse::{Cli, Cmd, needs_body, to_command}` paths the spec names.)

- [ ] **Step 4: Rewrite `cubical-cli/src/main.rs` to use the shared parser**

Delete the local `Cli`, `Cmd`, `NewWhat`, and `build_command`. Change imports and `run`:
```rust
use cubical_ipc::parse::{needs_body, to_command, Cli, Cmd};
// ... keep the other imports; drop `use clap::{Parser, Subcommand};` except `use clap::Parser;`
```
In `main`, `Cli::parse()` still works (derive comes via the re-exported type). Replace the `build_command` call in `run` with:
```rust
let body = if needs_body(&cli.cmd) {
    let mut content = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut content) {
        eprintln!("error: reading body from stdin: {e}");
        return 1;
    }
    Some(content)
} else {
    None
};
let command = match to_command(cli.cmd, &cli.vault, body) {
    Ok(c) => c,
    Err(e) => {
        eprintln!("error: {e:#}");
        return 1;
    }
};
```
Keep everything else in `run`/`attach`/`wait_for_scan` unchanged. (`std::io::Read` and `anyhow::Context` stay imported; `Context` is still used by `wait_for_scan`.)

- [ ] **Step 5: Write `parse.rs` unit tests**

Append to `parse.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("cubical").chain(args.iter().copied())).unwrap()
    }

    #[test]
    fn list_parses_to_list_command() {
        let cli = parse(&["list"]);
        assert!(matches!(to_command(cli.cmd, Path::new("/v"), None).unwrap(), WireCommand::List));
    }

    #[test]
    fn new_note_at_maps_fields() {
        let cli = parse(&["new", "note", "--at", "A.md"]);
        match to_command(cli.cmd, Path::new("/v"), None).unwrap() {
            WireCommand::NewNote { at, parent } => {
                assert_eq!(at.as_deref(), Some("A.md"));
                assert!(parent.is_none());
            }
            other => panic!("wrong command: {other:?}"),
        }
    }

    #[test]
    fn write_needs_body_and_errors_without_one() {
        let cli = parse(&["write", "A.md"]);
        assert!(needs_body(&cli.cmd));
        assert!(to_command(cli.cmd, Path::new("/v"), None).is_err());
    }

    #[test]
    fn write_with_body_carries_content() {
        let cli = parse(&["write", "A.md"]);
        match to_command(cli.cmd, Path::new("/v"), Some("hi".into())).unwrap() {
            WireCommand::Write { path, content } => {
                assert_eq!(path, "A.md");
                assert_eq!(content, "hi");
            }
            other => panic!("wrong command: {other:?}"),
        }
    }

    #[test]
    fn set_parses_json_value_else_string() {
        let cli = parse(&["set", "a.b", "true"]);
        match to_command(cli.cmd, Path::new("/v"), None).unwrap() {
            WireCommand::Set { value, .. } => assert_eq!(value, serde_json::Value::Bool(true)),
            other => panic!("wrong command: {other:?}"),
        }
        let cli = parse(&["set", "a.b", "plain"]);
        match to_command(cli.cmd, Path::new("/v"), None).unwrap() {
            WireCommand::Set { value, .. } => {
                assert_eq!(value, serde_json::Value::String("plain".into()));
            }
            other => panic!("wrong command: {other:?}"),
        }
    }

    #[test]
    fn unknown_verb_is_a_clap_error() {
        let err = Cli::try_parse_from(["cubical", "bogus"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
    }
}
```
(`WireCommand` must be `Debug`; it already is in `protocol.rs`. If `Debug` is missing, that is a one-line derive add on `Command` — do it in this step.)

- [ ] **Step 6: Run the tests**

Run: `cargo test -p cubical-ipc parse`
Expected: PASS. Then `cargo build -p cubical-cli` — Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-ipc/src/parse.rs crates/cubical-ipc/src/lib.rs \
        crates/cubical-ipc/Cargo.toml crates/cubical-cli/src/main.rs \
        crates/cubical-cli/Cargo.toml Cargo.lock
git commit -m "refactor(ipc): move clap parser into cubical-ipc::parse"
```

---

## Task 2: Make `render` sink-based (`render_to`)

So the console can capture stdout/stderr into buffers instead of the process's streams.

**Files:**
- Modify: `crates/cubical-ipc/src/render.rs`
- Modify: `crates/cubical-ipc/src/lib.rs` (export `render_to`)
- Test: inline `#[cfg(test)]` in `render.rs`

**Interfaces:**
- Produces (used by Task 3):
  ```rust
  pub fn render_to(outcome: &Outcome, json: bool, out: &mut dyn std::io::Write, err: &mut dyn std::io::Write) -> i32;
  pub fn render(outcome: &Outcome, json: bool) -> i32; // unchanged signature; now wraps render_to
  ```

- [ ] **Step 1: Rewrite `render.rs` body as `render_to`**

Add `use std::io::Write;` at the top. Rename the existing `pub fn render` to `pub fn render_to(outcome: &Outcome, json: bool, out: &mut dyn Write, err: &mut dyn Write) -> i32`, and mechanically convert every `println!("...")` to `let _ = writeln!(out, "...");` and every `eprintln!("...")` to `let _ = writeln!(err, "...");`. The `serde_json` interpolation stays identical. Example for the first arm:
```rust
Outcome::Files(paths) => {
    if json {
        let _ = writeln!(out, "{}", serde_json::to_string_pretty(paths).unwrap_or_default());
    } else {
        for p in paths {
            let _ = writeln!(out, "{p}");
        }
    }
    0
}
```
Apply the same to every arm (`Resolved`, `Backlinks`, `Created`, `Wrote`, `Renamed`, `Trashed`, `SettingSet`, `SettingGet`, `UndoRename`), preserving each arm's exit code exactly.

- [ ] **Step 2: Add the `render` wrapper**

```rust
pub fn render(outcome: &Outcome, json: bool) -> i32 {
    let mut out = std::io::stdout();
    let mut err = std::io::stderr();
    render_to(outcome, json, &mut out, &mut err)
}
```

- [ ] **Step 3: Export `render_to` from `lib.rs`**

```rust
pub use render::{render, render_to};
```

- [ ] **Step 4: Add `render_to` buffer tests**

Add to the existing `#[cfg(test)] mod tests` in `render.rs`:
```rust
fn run(outcome: &Outcome, json: bool) -> (String, String, i32) {
    let mut out = Vec::new();
    let mut err = Vec::new();
    let code = render_to(outcome, json, &mut out, &mut err);
    (String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap(), code)
}

#[test]
fn files_plain_lists_one_per_line() {
    let (out, err, code) = run(&Outcome::Files(vec!["a.md".into(), "b.md".into()]), false);
    assert_eq!(out, "a.md\nb.md\n");
    assert_eq!(err, "");
    assert_eq!(code, 0);
}

#[test]
fn resolved_none_writes_to_err_code_one() {
    let (out, err, code) = run(&Outcome::Resolved { target: "X".into(), path: None }, false);
    assert_eq!(out, "");
    assert_eq!(err, "unresolved: X\n");
    assert_eq!(code, 1);
}

#[test]
fn created_json_emits_object() {
    let (out, _err, code) = run(&Outcome::Created("A.md".into()), true);
    assert_eq!(out.trim(), r#"{"path":"A.md"}"#);
    assert_eq!(code, 0);
}
```

- [ ] **Step 5: Run the tests**

Run: `cargo test -p cubical-ipc render`
Expected: PASS (existing exit-code tests still pass because they call `render`, which now delegates).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-ipc/src/render.rs crates/cubical-ipc/src/lib.rs
git commit -m "refactor(ipc): sink-based render_to, render wraps it"
```

---

## Task 3: `console_exec` Tauri command

The fourth caller of `dispatch`. Tokenizes a line, reuses `parse` + `to_command`, dispatches through the app's `TauriEventSink`, renders into buffers.

**Files:**
- Modify: `crates/cubical-app/src/lib.rs` (new command + registration)
- Modify: `crates/cubical-app/Cargo.toml` (add `shell-words`)
- Test: `crates/cubical-app/tests/console_exec.rs` — **new**, no fakes

**Interfaces:**
- Consumes: `cubical_ipc::parse::{Cli, needs_body, to_command}`, `cubical_ipc::{dispatch, render_to}`, `cubical_engine::commands::vault::get_vault_info`, `crate::tauri_sink::TauriEventSink`.
- Produces (used by the frontend, Task 6):
  ```rust
  #[derive(serde::Deserialize)]
  struct ConsoleExecRequest { vault_id: String, line: String }
  #[derive(serde::Serialize)]
  struct ConsoleResult { stdout: String, stderr: String, code: i32 }
  #[tauri::command] async fn console_exec(state, app, req: ConsoleExecRequest) -> Result<ConsoleResult, String>
  ```

- [ ] **Step 1: Add `shell-words` to `cubical-app`**

In `crates/cubical-app/Cargo.toml` under `[dependencies]`:
```toml
shell-words = "1"
```

- [ ] **Step 2: Write the `console_exec` command in `crates/cubical-app/src/lib.rs`**

Add near the other `#[tauri::command]` fns. Imports at call sites use full paths to avoid touching the header `use` block:
```rust
#[derive(serde::Deserialize)]
struct ConsoleExecRequest {
    vault_id: String,
    line: String,
}

#[derive(serde::Serialize)]
struct ConsoleResult {
    stdout: String,
    stderr: String,
    code: i32,
}

#[tauri::command]
async fn console_exec(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: ConsoleExecRequest,
) -> Result<ConsoleResult, String> {
    use cubical_engine::api::types::GetVaultInfoRequest;
    use cubical_ipc::parse::{needs_body, to_command, Cli};

    let tokens = match shell_words::split(&req.line) {
        Ok(t) => t,
        Err(e) => {
            return Ok(ConsoleResult {
                stdout: String::new(),
                stderr: format!("error: unbalanced quotes: {e}"),
                code: 2,
            })
        }
    };
    let mut tokens: Vec<String> = tokens;
    if tokens.first().map(String::as_str) == Some("cubical") {
        tokens.remove(0);
    }
    if tokens.is_empty() {
        return Ok(ConsoleResult {
            stdout: String::new(),
            stderr: "the console runs cubical verbs; write and --vault are unavailable here"
                .to_string(),
            code: 2,
        });
    }
    if tokens
        .iter()
        .any(|t| t == "--vault" || t.starts_with("--vault="))
    {
        return Ok(ConsoleResult {
            stdout: String::new(),
            stderr: "error: --vault is not available in the console (bound to the open vault)"
                .to_string(),
            code: 2,
        });
    }

    let cli = match Cli::try_parse_from(std::iter::once("cubical".to_string()).chain(tokens)) {
        Ok(cli) => cli,
        Err(e) => {
            let code = e.exit_code();
            return Ok(ConsoleResult {
                stdout: String::new(),
                stderr: e.render().to_string(),
                code,
            });
        }
    };

    if needs_body(&cli.cmd) {
        return Ok(ConsoleResult {
            stdout: String::new(),
            stderr: "write is not available in the console — use the editor, or pipe from a terminal"
                .to_string(),
            code: 1,
        });
    }

    let info = cubical_engine::commands::vault::get_vault_info(
        state.inner(),
        GetVaultInfoRequest { vault_id: req.vault_id.clone() },
    )
    .await
    .map_err(|e| e.to_string())?;
    let vault_root = info.path;

    let command = to_command(cli.cmd, &vault_root, None).map_err(|e| format!("{e:#}"))?;

    let sink = crate::tauri_sink::TauriEventSink::new(app);
    let outcome = cubical_ipc::dispatch(&req.vault_id, command, state.inner(), &sink).await;

    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = match &outcome {
        Ok(o) => cubical_ipc::render_to(o, cli.json, &mut out, &mut err),
        Err(e) => {
            let _ = std::io::Write::write_all(&mut err, format!("error: {e}\n").as_bytes());
            1
        }
    };
    Ok(ConsoleResult {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        code,
    })
}
```

- [ ] **Step 3: Register the command**

In the `tauri::generate_handler![ ... ]` list add `console_exec,` beside `close_vault,`.

- [ ] **Step 4: Build**

Run: `cargo build -p cubical-app`
Expected: builds clean. (If `dispatch` requires `Command: Debug` or a missing bound surfaces, resolve it here.)

- [ ] **Step 5: Write the no-fakes integration + parity tests**

Create `crates/cubical-app/tests/console_exec.rs`. The command is not `pub`, so the test drives the **same pipeline** the command runs (tokenize→parse→`to_command`→`dispatch`→`render_to`) against a real engine and vault. The parity test asserts the console pipeline's stdout equals the CLI pipeline's (`to_command`→`dispatch`→`render_to`) for the same argv on the same single engine — one engine, no index-lock conflict (Phase-2 lesson).
```rust
use std::sync::Arc;

use cubical_engine::events::NoopEventSink;
use cubical_engine::state::AppState;
use cubical_ipc::parse::{to_command, Cli};
use cubical_ipc::render_to;

async fn open(root: &std::path::Path) -> (AppState, String) {
    use cubical_engine::api::types::{OpenVaultRequest, ScanStatus, GetVaultInfoRequest};
    use cubical_engine::commands::vault;
    let state = AppState::new();
    let sink: Arc<dyn cubical_engine::events::EventSink> = Arc::new(NoopEventSink);
    let opened = vault::open_vault(&state, Arc::clone(&sink),
        OpenVaultRequest { path: root.to_path_buf() }, None).await.unwrap();
    loop {
        let info = vault::get_vault_info(&state,
            GetVaultInfoRequest { vault_id: opened.vault_id.clone() }).await.unwrap();
        if matches!(info.scan_status, ScanStatus::Complete) { break; }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    (state, opened.vault_id)
}

// Runs the console-side pipeline; returns (stdout, code).
async fn console_run(state: &AppState, vault_id: &str, root: &std::path::Path, line: &str) -> (String, i32) {
    let sink = NoopEventSink;
    let tokens: Vec<String> = shell_words::split(line).unwrap();
    let cli = Cli::try_parse_from(std::iter::once("cubical".to_string()).chain(tokens)).unwrap();
    let cmd = to_command(cli.cmd, root, None).unwrap();
    let outcome = cubical_ipc::dispatch(vault_id, cmd, state, &sink).await.unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = render_to(&outcome, cli.json, &mut out, &mut err);
    let _ = err;
    (String::from_utf8(out).unwrap(), code)
}

#[tokio::test]
async fn new_note_creates_the_file_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let (_out, code) = console_run(&state, &vid, tmp.path(), "new note --at Smoke.md").await;
    assert_eq!(code, 0);
    assert!(tmp.path().join("Smoke.md").exists());
}

#[tokio::test]
async fn console_and_cli_pipelines_agree_on_list() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("A.md"), "# A").unwrap();
    std::fs::write(tmp.path().join("B.md"), "# B").unwrap();
    let (state, vid) = open(tmp.path()).await;
    // Console path.
    let (console_out, _) = console_run(&state, &vid, tmp.path(), "list").await;
    // CLI path: build the same Command directly and render to a buffer.
    let sink = NoopEventSink;
    let cli = Cli::try_parse_from(["cubical", "list"]).unwrap();
    let cmd = to_command(cli.cmd, tmp.path(), None).unwrap();
    let outcome = cubical_ipc::dispatch(&vid, cmd, &state, &sink).await.unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    render_to(&outcome, false, &mut out, &mut err);
    assert_eq!(console_out, String::from_utf8(out).unwrap());
    assert!(console_out.contains("A.md") && console_out.contains("B.md"));
}
```
Add `tempfile` and `shell-words` to `crates/cubical-app`'s `[dev-dependencies]` if not present (`tempfile` is used elsewhere in the workspace — copy its version).

- [ ] **Step 6: Run the tests**

Run: `cargo test -p cubical-app --test console_exec`
Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/cubical-app/src/lib.rs crates/cubical-app/Cargo.toml \
        crates/cubical-app/tests/console_exec.rs Cargo.lock
git commit -m "feat(console): console_exec Tauri command dispatches cubical verbs in-process"
```

---

## Task 4: Command-history ring (`history.ts`)

Pure ↑/↓ history navigation. No framework, fully unit-tested.

**Files:**
- Create: `ui/src/console/history.ts`
- Test: `ui/src/console/history.test.ts`

**Interfaces:**
- Produces (used by Task 7):
  ```ts
  export interface History { entries: string[]; cursor: number } // cursor === entries.length means "at draft"
  export const emptyHistory: History;
  export function push(h: History, line: string): History;   // ignores empty/dup-of-last; resets cursor to end
  export function up(h: History): { history: History; value: string | null };
  export function down(h: History): { history: History; value: string | null };
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { emptyHistory, push, up, down } from "./history";

describe("history", () => {
  it("push ignores blanks and consecutive duplicates", () => {
    let h = push(emptyHistory, "list");
    h = push(h, "");
    h = push(h, "list");
    expect(h.entries).toEqual(["list"]);
  });

  it("up walks backwards, down walks forwards to the draft", () => {
    let h = push(push(emptyHistory, "a"), "b");
    const u1 = up(h); expect(u1.value).toBe("b"); h = u1.history;
    const u2 = up(h); expect(u2.value).toBe("a"); h = u2.history;
    const u3 = up(h); expect(u3.value).toBe("a"); h = u3.history; // clamps
    const d1 = down(h); expect(d1.value).toBe("b"); h = d1.history;
    const d2 = down(h); expect(d2.value).toBe(null); h = d2.history; // back to draft
  });

  it("up on empty history yields null", () => {
    expect(up(emptyHistory).value).toBe(null);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run ui/src/console/history.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `history.ts`**

```ts
export interface History {
  entries: string[];
  cursor: number;
}

export const emptyHistory: History = { entries: [], cursor: 0 };

export function push(h: History, line: string): History {
  const trimmed = line.trim();
  if (trimmed === "" || h.entries[h.entries.length - 1] === trimmed) {
    return { entries: h.entries, cursor: h.entries.length };
  }
  const entries = [...h.entries, trimmed];
  return { entries, cursor: entries.length };
}

export function up(h: History): { history: History; value: string | null } {
  if (h.entries.length === 0) return { history: h, value: null };
  const cursor = Math.max(0, h.cursor - 1);
  return { history: { ...h, cursor }, value: h.entries[cursor] ?? null };
}

export function down(h: History): { history: History; value: string | null } {
  if (h.cursor >= h.entries.length) return { history: h, value: null };
  const cursor = h.cursor + 1;
  const value = cursor >= h.entries.length ? null : (h.entries[cursor] ?? null);
  return { history: { ...h, cursor }, value };
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run ui/src/console/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/console/history.ts ui/src/console/history.test.ts
git commit -m "feat(console): command-history ring"
```

---

## Task 5: Scrollback model (`scrollback.ts`)

Pure entry model with a 500-entry cap.

**Files:**
- Create: `ui/src/console/scrollback.ts`
- Test: `ui/src/console/scrollback.test.ts`

**Interfaces:**
- Produces (used by Task 7):
  ```ts
  export type EntryKind = "input" | "stdout" | "stderr";
  export interface Entry { kind: EntryKind; text: string }
  export const MAX_ENTRIES = 500;
  export function append(entries: Entry[], next: Entry[]): Entry[]; // concat + cap to last MAX_ENTRIES
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { append, MAX_ENTRIES, type Entry } from "./scrollback";

const e = (text: string): Entry => ({ kind: "stdout", text });

describe("scrollback", () => {
  it("appends in order", () => {
    expect(append([e("a")], [e("b"), e("c")]).map((x) => x.text)).toEqual(["a", "b", "c"]);
  });

  it("caps to the last MAX_ENTRIES", () => {
    const many: Entry[] = Array.from({ length: MAX_ENTRIES + 10 }, (_, i) => e(String(i)));
    const out = append([], many);
    expect(out.length).toBe(MAX_ENTRIES);
    expect(out[0]!.text).toBe("10");
    expect(out[out.length - 1]!.text).toBe(String(MAX_ENTRIES + 9));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run ui/src/console/scrollback.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `scrollback.ts`**

```ts
export type EntryKind = "input" | "stdout" | "stderr";

export interface Entry {
  kind: EntryKind;
  text: string;
}

export const MAX_ENTRIES = 500;

export function append(entries: Entry[], next: Entry[]): Entry[] {
  const combined = [...entries, ...next];
  return combined.length > MAX_ENTRIES ? combined.slice(combined.length - MAX_ENTRIES) : combined;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run ui/src/console/scrollback.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/console/scrollback.ts ui/src/console/scrollback.test.ts
git commit -m "feat(console): scrollback entry model with 500-entry cap"
```

---

## Task 6: IPC wrapper, `Setting` key, and core-plugin entry

The single IPC chokepoint plus the composability wiring. No behavior yet — this is the glue Tasks 7 and 8 consume.

**Files:**
- Modify: `ui/src/api/ipc.ts` (add `ConsoleResult`, `consoleExec`, `plugins.console_enabled` in `Setting`)
- Modify: `ui/src/settings/corePlugins.ts` (add the `console` entry)

**Interfaces:**
- Produces (used by Tasks 7 and 8):
  ```ts
  export interface ConsoleResult { stdout: string; stderr: string; code: number }
  export function consoleExec(vaultId: string, line: string): Promise<ConsoleResult>;
  // Setting union gains: { key: "plugins.console_enabled"; value: boolean }
  // CORE_PLUGINS gains a { id: "console", settingKey: "plugins.console_enabled", defaultEnabled: false } entry
  ```

- [ ] **Step 1: Add the `Setting` key**

In `ui/src/api/ipc.ts`, in the `Setting` union beside `plugins.property_refs_enabled`:
```ts
  | { key: "plugins.console_enabled"; value: boolean }
```

- [ ] **Step 2: Add `ConsoleResult` and `consoleExec`**

Near the other command wrappers in `ipc.ts`:
```ts
export interface ConsoleResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function consoleExec(vaultId: string, line: string): Promise<ConsoleResult> {
  return invoke<ConsoleResult>("console_exec", {
    req: { vault_id: vaultId, line },
  });
}
```

- [ ] **Step 3: Add the core-plugin entry**

In `ui/src/settings/corePlugins.ts`, append to `CORE_PLUGINS`:
```ts
  {
    id: "console",
    name: "Command console",
    description: "Run cubical commands against the open vault in a tab.",
    settingKey: "plugins.console_enabled",
    defaultEnabled: false,
  },
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p ui/tsconfig.json`
Expected: no errors. (`settingKey` must be a `BooleanSettingKey`; the Step-1 addition makes `plugins.console_enabled` a boolean key, so it satisfies the type.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/ipc.ts ui/src/settings/corePlugins.ts
git commit -m "feat(console): consoleExec IPC wrapper + console core-plugin entry"
```

---

## Task 7: `ConsolePanel` component

The panel: a scrollback log above an input line. Enter runs `consoleExec`; ↑/↓ walk history; the input is disabled while a command is in flight.

**Files:**
- Create: `ui/src/console/ConsolePanel.tsx`
- Test: `ui/src/console/ConsolePanel.test.tsx`
- Modify: `ui/src/styles/layout.css` (console body styling — additive)

**Interfaces:**
- Consumes: `consoleExec`, `ConsoleResult` (Task 6); `emptyHistory`, `push`, `up`, `down` (Task 4); `append`, `Entry` (Task 5).
- Produces (used by Task 8):
  ```tsx
  export function ConsolePanel(props: { vaultId: string }): JSXElement;
  ```

- [ ] **Step 1: Write the failing render/behavior test**

Uses `@solidjs/testing-library` (already a dev dep — the tabs suite uses it). Mock the IPC wrapper.
```tsx
import { render, fireEvent } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api/ipc", () => ({
  consoleExec: vi.fn(async () => ({ stdout: "A.md\nB.md\n", stderr: "", code: 0 })),
}));

import { ConsolePanel } from "./ConsolePanel";
import { consoleExec } from "../api/ipc";

describe("ConsolePanel", () => {
  it("runs a line and renders stdout in the scrollback", async () => {
    const { getByLabelText, findByText } = render(() => <ConsolePanel vaultId="v1" />);
    const input = getByLabelText("Console input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "list" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(consoleExec).toHaveBeenCalledWith("v1", "list");
    await findByText("A.md");
    await findByText("B.md");
    expect(input.value).toBe(""); // cleared after submit
  });

  it("recalls the previous command with ArrowUp", async () => {
    const { getByLabelText, findByText } = render(() => <ConsolePanel vaultId="v1" />);
    const input = getByLabelText("Console input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "list" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await findByText("A.md");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("list");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run ui/src/console/ConsolePanel.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `ConsolePanel.tsx`**

```tsx
import { For, createSignal, type JSXElement } from "solid-js";

import { consoleExec } from "../api/ipc";
import { emptyHistory, push, up, down, type History } from "./history";
import { append, type Entry } from "./scrollback";

export function ConsolePanel(props: { vaultId: string }): JSXElement {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let history: History = emptyHistory;

  const run = async () => {
    const line = value();
    if (line.trim() === "" || busy()) return;
    history = push(history, line);
    setEntries((e) => append(e, [{ kind: "input", text: line }]));
    setValue("");
    setBusy(true);
    try {
      const res = await consoleExec(props.vaultId, line);
      const next: Entry[] = [];
      if (res.stdout !== "") next.push({ kind: "stdout", text: res.stdout.replace(/\n$/, "") });
      if (res.stderr !== "") next.push({ kind: "stderr", text: res.stderr.replace(/\n$/, "") });
      if (next.length > 0) setEntries((e) => append(e, next));
    } catch (err) {
      setEntries((e) => append(e, [{ kind: "stderr", text: String(err) }]));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void run();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const r = up(history);
      history = r.history;
      if (r.value !== null) setValue(r.value);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const r = down(history);
      history = r.history;
      setValue(r.value ?? "");
    }
  };

  return (
    <div class="console">
      <div class="console__scrollback">
        <For each={entries()}>
          {(entry) => (
            <div class={`console__entry console__entry--${entry.kind}`}>
              {entry.kind === "input" ? `› ${entry.text}` : entry.text}
            </div>
          )}
        </For>
      </div>
      <input
        class="console__input"
        aria-label="Console input"
        spellcheck={false}
        autocomplete="off"
        placeholder="Type a cubical command, e.g. list"
        value={value()}
        disabled={busy()}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
```

- [ ] **Step 4: Add console styling to `layout.css`**

Append (additive — do not touch existing rules):
```css
.console {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-sm);
}
.console__scrollback {
  flex: 1;
  overflow-y: auto;
  white-space: pre-wrap;
  padding: var(--space-3);
}
.console__entry--input { color: var(--c-fg-primary); font-weight: 600; }
.console__entry--stdout { color: var(--c-fg-secondary, var(--c-fg-primary)); }
.console__entry--stderr { color: var(--c-danger, var(--c-warning, var(--c-accent))); }
.console__input {
  border: none;
  border-top: 1px solid var(--c-border-subtle);
  background: var(--c-bg-secondary);
  color: var(--c-fg-primary);
  font: inherit;
  padding: var(--space-2) var(--space-3);
  outline: none;
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run ui/src/console/ConsolePanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/console/ConsolePanel.tsx ui/src/console/ConsolePanel.test.tsx ui/src/styles/layout.css
git commit -m "feat(console): ConsolePanel component"
```

---

## Task 8: Wire the console into the tab model, commands, and workspace

Add the `console` view kind, the open command + shortcut (plugin-gated), render `ConsolePanel` in the center workspace, keep console ids out of the editor pool, drop console tabs from persistence, and close the console tab when the plugin is disabled.

**Files:**
- Modify: `ui/src/tabs/tabModel.ts` (add the `console` kind + `tabId`)
- Modify: `ui/src/tabs/tabModel.test.ts` (console-kind unit)
- Modify: `ui/src/core/commands.ts` (add `view.openConsole` default)
- Modify: `ui/src/core/commands.test.ts` (assert the default)
- Modify: `ui/src/App.tsx` (command registration, render, keep-alive filter, persistence filter, plugin-off close)

**Interfaces:**
- Consumes: `ConsolePanel` (Task 7); `corePluginEnabled`, `CORE_PLUGINS` (Task 6); `openTab`, `closeTab`, `TabView` (tabModel).
- Produces: a `{ kind: "console" }` tab with the constant id `"console"` (singleton).

- [ ] **Step 1: Write the failing tabModel test**

Add to `ui/src/tabs/tabModel.test.ts`:
```ts
it("console tabs share one constant id (singleton)", () => {
  const a = openTab(emptyTabs, { kind: "console" });
  const b = openTab(a, { kind: "console" });
  expect(b.tabs.length).toBe(1);
  expect(b.activeId).toBe("console");
});
```
(Ensure `openTab` and `emptyTabs` are imported in the test file — they are, in the existing suite.)

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run ui/src/tabs/tabModel.test.ts`
Expected: FAIL (type error / `console` not assignable).

- [ ] **Step 3: Extend `TabView` and `tabId`**

In `ui/src/tabs/tabModel.ts`:
```ts
export type TabView =
  | { kind: "file"; path: string }
  | { kind: "tag"; tagPath: string }
  | { kind: "console" };
```
Rewrite `tabId` as a switch so it stays exhaustive:
```ts
export function tabId(view: TabView): string {
  switch (view.kind) {
    case "file":
      return `file:${view.path}`;
    case "tag":
      return `tag:${view.tagPath}`;
    case "console":
      return "console";
  }
}
```
`remapTabPaths` already only rewrites `view.kind === "file"`, so console tabs pass through untouched — no change needed there.

- [ ] **Step 4: Run the tabModel test to see it pass**

Run: `npx vitest run ui/src/tabs/tabModel.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `view.openConsole` command default**

In `ui/src/core/commands.ts`, append to `COMMAND_DEFAULTS`:
```ts
  {
    id: "view.openConsole",
    title: "Open command console",
    scope: "global",
    defaultKey: "Mod-Shift-c",
  },
```
In `ui/src/core/commands.test.ts`, add to the assertions that check the global defaults:
```ts
expect.objectContaining({ id: "view.openConsole", scope: "global", defaultKey: "Mod-Shift-c" }),
```
(Match the surrounding assertion style at lines ~352–358; add `"view.openConsole"` to any `for (const id of [...])` list that iterates the global command ids if the test uses one.)

- [ ] **Step 6: Register the command in `App.tsx`**

In the `globalCommands` object (near `view.closeTab`, ~line 1393), add:
```ts
      "view.openConsole": {
        id: "view.openConsole",
        title: "Open command console",
        when: () =>
          vaultId() !== null &&
          corePluginEnabled(
            corePlugins(),
            CORE_PLUGINS.find((p) => p.id === "console")!,
          ),
        run: () => setTabs((s) => openTab(s, { kind: "console" })),
      },
```

- [ ] **Step 7: Render `ConsolePanel` in the center workspace**

Add the import at the top of `App.tsx`:
```ts
import { ConsolePanel } from "./console/ConsolePanel";
```
Wrap the existing center-workspace block (the `<Show when={view().kind === "file"} fallback={<TagPage .../>}>` at ~line 2080) in a console branch. Replace the opening of that block with:
```tsx
<Show
  when={view().kind === "console"}
  fallback={
    <Show
      when={view().kind === "file"}
      fallback={
        <TagPage
          vaultId={vaultId()}
          tagPath={(view() as { kind: "tag"; tagPath: string }).tagPath}
          refreshSignal={tagRefreshTick()}
          onSelectFile={(path) => void handleNavigateWikilink(path, null)}
          onBack={handleExitTagView}
        />
      }
    >
      {/* existing file-branch contents unchanged */}
    </Show>
  }
>
  <ConsolePanel vaultId={vaultId()!} />
</Show>
```
Concretely: move the current `<Show when={view().kind === "file"} fallback={TagPage}>…</Show>` verbatim into the `fallback` of a new outer `<Show when={view().kind === "console"}>`, whose children are `<ConsolePanel vaultId={vaultId()!} />`. Nothing inside the file branch changes.

- [ ] **Step 8: Keep console ids out of the editor keep-alive pool**

At the `<For each={live()}>` that renders editors (~line 2207), filter to file-backed ids:
```tsx
<For each={live().filter((id) => pathForId(id) !== null)}>
```
(`pathForId` returns non-null only for file tabs, so console and tag ids no longer spawn hidden editors.)

- [ ] **Step 9: Drop console tabs from persisted sessions**

In `toDto` (~line 496), skip console tabs so they are neither serialized nor restored (scrollback is ephemeral — a restored empty console adds nothing):
```ts
  const toDto = (s: TabSet): TabSessionDto => ({
    active_id: s.activeId,
    tabs: s.tabs
      .filter((t) => t.view.kind !== "console")
      .map((t) => ({
        id: t.id,
        kind: t.view.kind,
        path: t.view.kind === "file" ? t.view.path : null,
        tag_path: t.view.kind === "tag" ? t.view.tagPath : null,
      })),
  });
```
(`fromDto` already ignores any `kind` that is neither `file`-with-path nor `tag`-with-tag_path, so no change is needed there, but the filter keeps the saved file clean and avoids a dangling `active_id`.)

- [ ] **Step 10: Close the console tab when the plugin is disabled**

Add a `createEffect` beside the other settings-reactive effects in `App.tsx`:
```ts
  createEffect(() => {
    const enabled = corePluginEnabled(
      corePlugins(),
      CORE_PLUGINS.find((p) => p.id === "console")!,
    );
    if (!enabled) {
      setTabs((s) =>
        s.tabs.some((t) => t.view.kind === "console") ? closeTab(s, "console") : s,
      );
    }
  });
```
(Ensure `closeTab` is imported from the tab model — it is already imported alongside `openTab`.)

- [ ] **Step 11: Typecheck and run the frontend gate**

Run: `npx tsc --noEmit -p ui/tsconfig.json`
Then: `npx vitest run ui/src/tabs ui/src/core ui/src/console`
Expected: no type errors; all suites PASS.

- [ ] **Step 12: Commit**

```bash
git add ui/src/tabs/tabModel.ts ui/src/tabs/tabModel.test.ts \
        ui/src/core/commands.ts ui/src/core/commands.test.ts ui/src/App.tsx
git commit -m "feat(console): console tab kind, open command, workspace wiring"
```

---

## Task 9: Documentation + full gate + GUI smoke

**Files:**
- Modify: `docs/implementation/engine-ipc.md` (the `parse`/`render_to` split and the fourth caller)
- Modify: `docs/implementation/frontend.md` (a Console section)
- Modify: `docs/superpowers/specs/2026-07-25-cli-console-phase3-design.md` (status → built; "What was built" note)

- [ ] **Step 1: Record rationale in `engine-ipc.md`**

Under the existing "Socket boundary" material, add a short subsection: `cubical-ipc` now owns the text boundary in both directions — `render`/`render_to` (`Outcome`→text) and `parse` (`Cli`/`Cmd`→`Command`). The console is the **fourth caller of the one `dispatch`**, in-process via `TauriEventSink`, so it needs no socket, no binary, and works on Windows. It rejects `write` (no stdin) and `--vault` (bound to the open vault). No explanatory comments in code — this doc is the record.

- [ ] **Step 2: Record the frontend model in `frontend.md`**

Add a "Console" section: the console is a `{ kind: "console" }` tab (singleton id `"console"`), plugin-gated on `plugins.console_enabled` (`defaultEnabled: false`); scrollback (500-cap) and history are ephemeral signals, not persisted (dropped from `toDto`); disabling the plugin closes the tab; console ids are excluded from the editor keep-alive pool.

- [ ] **Step 3: Update the spec status**

Change the spec header `Status:` to `built 2026-07-28` and add a terse "What was built" note pointing at this plan.

- [ ] **Step 4: Run the full gate**

Run (never piped to `tail`):
```bash
./scripts/check.sh > /tmp/check.log 2>&1; echo "exit=$?"
```
Expected: `exit=0`. If `cubical-core`'s `dropping_handle_stops_event_delivery_within_100ms` is the only failure, re-run it alone (`cargo test -p cubical-core dropping_handle_stops_event_delivery_within_100ms`) to confirm it's the known flake.

- [ ] **Step 5: Tauri GUI smoke (best-effort, honest reporting)**

Force a full recompile first (stale-build gotcha): `npm run tauri dev` from a clean build. Open a vault, enable the Command console plugin in Settings, trigger `Mod-Shift-c`, run `list` and `new note --at Smoke.md`, and confirm the note appears in the tree (proves the `TauriEventSink` live-refresh path). If the environment is non-interactive and the GUI can't be driven, record that the console is covered end-to-end by the Task-3 no-fakes tests and that the ~Tauri-glue smoke is inspection-only — mirroring the Phase-2 caveat. Do not claim the smoke passed if it wasn't run.

- [ ] **Step 6: Commit**

```bash
git add docs/implementation/engine-ipc.md docs/implementation/frontend.md \
        docs/superpowers/specs/2026-07-25-cli-console-phase3-design.md
git commit -m "docs(console): record the parse/render_to split and console tab model"
```

---

## Self-Review

**Spec coverage:**
- §1a parser move → Task 1. §1b `render_to` → Task 2. §1c `console_exec` (all 8 steps: tokenize, strip `cubical`, reject `--vault`, parse+capture clap, reject body verbs, `to_command`, dispatch via `TauriEventSink`, `render_to`) → Task 3 Step 2. `shell-words` dep → Task 3 Step 1.
- §2 frontend units (`history.ts`, `scrollback.ts`) → Tasks 4, 5. `ConsolePanel` → Task 7. `consoleExec` chokepoint in `ipc.ts` → Task 6. Tab-model `console` kind + open command + shortcut + gating → Task 8. `layout.css` additive → Task 7 Step 4. `CORE_PLUGINS` entry (`defaultEnabled: false`) → Task 6. Plugin-off closes the tab → Task 8 Step 10. `Setting` union one-line add → Task 6 Step 1. Scrollback/history not persisted → Task 8 Step 9.
- §3 rejects `write` (Task 3 body-verb reject) and `--vault` (Task 3 token reject); no confirmation prompts (dispatch runs `rm`/`rename` directly — inherited, nothing added).
- §4 clap errors + `--help` captured with code 2 → Task 3 Step 2 (`e.exit_code()` / `e.render()`); the console's own restriction line is surfaced on empty/`--vault`/body-verb rejection; dispatch errors → `error: <msg>` code 1; no-vault handled by the `vaultId()!` gate at render; in-flight input disabled → Task 7 `busy()`.
- §5 tests: parity (Task 3 `console_and_cli_pipelines_agree_on_list`), `parse` units (Task 1), `render_to` units (Task 2), no-fakes integration (Task 3 `new_note_creates_the_file_on_disk`), vitest `history`/`scrollback`/`ConsolePanel` (Tasks 4, 5, 7).
- §6 out-of-scope items (PTY, ANSI, arbitrary programs, streaming, cancellation, tab completion, persisted scrollback, binary bundling, splits) — none introduced.

**Placeholder scan:** every code step carries real code; no "TBD"/"handle edge cases"/"similar to Task N".

**Type consistency:** `to_command(cmd, vault_root, body)` and `needs_body(&cmd)` identical across Tasks 1 and 3. `render_to(outcome, json, out, err)` identical across Tasks 2 and 3. `ConsoleResult { stdout, stderr, code }` matches between Rust (Task 3) and TS (`ConsoleResult` Task 6). `consoleExec(vaultId, line)` matches between Task 6 (def) and Task 7 (call, and the test's mock). `{ kind: "console" }` and id `"console"` consistent across Tasks 7 (`ConsolePanel` opened via) and 8 (`tabId`, `openTab`, `closeTab("console")`). `plugins.console_enabled` consistent across Task 6 (`Setting`, `CORE_PLUGINS.settingKey`) and Task 8 (gating lookups by `id: "console"`).
