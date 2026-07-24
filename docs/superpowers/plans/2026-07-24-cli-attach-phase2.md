# CLI Frontend Phase 2 — Live Attach — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `cubical` CLI attach to the running app's backend over a per-app Unix socket, so a terminal command executes against the app's live in-process engine (updating the UI) instead of declining.

**Architecture:** A new `cubical-ipc` crate owns the wire boundary — a `Command`/`Outcome`/`Response` protocol, a single `dispatch()` (lifted from the CLI), a `render()` that prints and returns an exit code, and a `#[cfg(unix)]` length-prefixed-JSON transport. Three callers share this: the CLI running locally when the app is closed, the CLI sending over the socket when the app is open, and the app's socket server running the same `dispatch` against its managed `AppState` + `TauriEventSink`. The app advertises its socket path in the vault ownership lock via a new `open_vault` parameter.

**Tech Stack:** Rust, tokio (Unix-domain sockets + async framing), serde/serde_json, clap, fs4 (existing lock), Tauri v2 (app-side server task).

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-07-24-cli-attach-phase2-design.md` — this plan implements it. Predecessor: `2026-07-24-cli-frontend-design.md` (Phase 1).
- **One backend owns a vault; frontends attach.** Never create a second writer against a vault the app owns.
- **No new vault features, no REPL, no Windows socket backend** — Unix-domain sockets only, behind `#[cfg(unix)]`; Windows falls back to the Phase-1 decline.
- **Engine stays wire-free:** wire types (`Command`/`Outcome`/`Response`) live in `cubical-ipc`, never in `cubical-engine`. `Outcome` carries owned primitives, not engine response structs.
- **No explanatory comments in source** (project rule) — rationale goes in `docs/`. A one-line doc is the most allowed.
- **Full gate:** `scripts/check.sh` (tsc, vitest, build, cargo fmt/clippy/test, docs). Run it, not the pieces. Known non-blocking flake: `cubical-core` `dropping_handle_stops_event_delivery_within_100ms` under full load.
- **Tests set `CUBICAL_RUNTIME_DIR`** for hermeticity; in-process env-touching tests serialize on a shared `std::sync::Mutex` guard (Rust runs a crate's tests concurrently in one process, so unguarded `set_var`/`remove_var` races). Engine tests use `vault_lock::RUNTIME_ENV_GUARD`; `cubical-ipc` unit tests use a crate-local `RUNTIME_ENV_GUARD` (added in Task 1); the `cubical-ipc` integration test uses a file-local guard. Async tests that hold the guard across `.await` carry `#[allow(clippy::await_holding_lock)]` (mirrors the Phase-1 engine integration test).
- **Branch:** `feat/cli-attach` (already created off `main`; single checkout, no worktrees). Commit after each task.
- `--json` output shape is defined by `Outcome` (intentional, documented change from Phase-1's raw-struct dump). Human **success** output is unchanged; error text loses Phase-1's `anyhow` context (`error: writing X.md: <cause>` → `error: <cause>`).

---

## File Structure

- **Create** `crates/cubical-ipc/Cargo.toml` — new crate manifest.
- **Create** `crates/cubical-ipc/src/lib.rs` — module wiring + re-exports.
- **Create** `crates/cubical-ipc/src/protocol.rs` — `Command`, `Request`, `Outcome`, `Response`.
- **Create** `crates/cubical-ipc/src/dispatch.rs` — `dispatch()` (command → engine fn → `Outcome`).
- **Create** `crates/cubical-ipc/src/render.rs` — `render(&Outcome, json) -> i32`.
- **Create** `crates/cubical-ipc/src/transport.rs` — framing, `client::send`, `handle_connection`, `app_socket_path` (`#[cfg(unix)]`; Windows stubs).
- **Create** `crates/cubical-ipc/tests/socket.rs` — cross-task socket round-trip.
- **Modify** `crates/cubical-engine/src/vault_lock.rs` — `acquire`/`write_payload` take a socket path.
- **Modify** `crates/cubical-engine/src/commands/vault.rs` — `open_vault` gains `advertise_socket` param; add `pub resolve_open_vault_id`.
- **Modify** `crates/cubical-cli/Cargo.toml` — depend on `cubical-ipc`.
- **Modify** `crates/cubical-cli/src/main.rs` — build `Command`, dispatch locally via ipc, attach on `VaultLocked`.
- **Modify** `crates/cubical-cli/tests/cli.rs` — attach integration test + Phase-1 caller fix.
- **Modify** `crates/cubical-app/Cargo.toml` — depend on `cubical-ipc`.
- **Modify** `crates/cubical-app/src/lib.rs` — `.setup()` socket server task; `open_vault` command advertises its socket path.
- **Modify** `docs/implementation/engine-ipc.md` — socket boundary rationale.

---

## Task 1: Scaffold `cubical-ipc` crate + wire protocol

**Files:**
- Create: `crates/cubical-ipc/Cargo.toml`
- Create: `crates/cubical-ipc/src/lib.rs`
- Create: `crates/cubical-ipc/src/protocol.rs`

**Interfaces:**
- Produces: `cubical_ipc::{Command, Request, Outcome, Response}` (all `serde` + `Debug, Clone, PartialEq`).

- [ ] **Step 1: Create the crate manifest**

`crates/cubical-ipc/Cargo.toml`:

```toml
[package]
name = "cubical-ipc"
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true
authors.workspace = true
description = "Wire protocol + shared dispatch between the Cubical app backend and the cubical CLI frontend."

[dependencies]
cubical-engine = { path = "../cubical-engine" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true, features = ["net", "io-util", "rt", "macros"] }

[dev-dependencies]
tempfile = "3"
tokio = { workspace = true, features = ["net", "io-util", "rt-multi-thread", "macros", "time"] }
```

- [ ] **Step 2: Write the protocol types**

`crates/cubical-ipc/src/protocol.rs`:

```rust
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Command {
    List,
    Resolve { target: String },
    Backlinks { path: String },
    NewNote { at: Option<String>, parent: Option<String> },
    NewFolder { parent: Option<String> },
    Write { path: String, content: String },
    RenameFile { from: String, to: String },
    RenameFolder { from: String, to: String },
    Rm { path: String },
    Set { key: String, value: serde_json::Value },
    Get { key: String },
    UndoRename { op_id: i64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub vault_path: PathBuf,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Outcome {
    Files(Vec<String>),
    Resolved { target: String, path: Option<String> },
    Backlinks(Vec<String>),
    Created(String),
    Wrote(String),
    Renamed { to: String, pending_count: i64 },
    Trashed(String),
    SettingSet(String),
    SettingGet { key: String, value: Option<serde_json::Value> },
    UndoRename { op_id: i64, removed: u64, pending_count: i64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Response {
    Ok(Outcome),
    Err(String),
}
```

- [ ] **Step 3: Write the lib.rs wiring + a round-trip test**

`crates/cubical-ipc/src/lib.rs`:

```rust
#![forbid(unsafe_code)]

mod protocol;

pub use protocol::{Command, Outcome, Request, Response};

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn request_round_trips_through_json() {
        let req = Request {
            vault_path: std::path::PathBuf::from("/vaults/alpha"),
            command: Command::Write {
                path: "notes/A.md".into(),
                content: "hello".into(),
            },
        };
        let bytes = serde_json::to_vec(&req).unwrap();
        let back: Request = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn response_round_trips_through_json() {
        let resp = Response::Ok(Outcome::Renamed {
            to: "notes/B.md".into(),
            pending_count: 3,
        });
        let bytes = serde_json::to_vec(&resp).unwrap();
        let back: Response = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(resp, back);
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p cubical-ipc`
Expected: PASS (2 tests). The crate is auto-discovered by the workspace `members = ["crates/*"]`.

- [ ] **Step 5: Commit**

```bash
git add crates/cubical-ipc/Cargo.toml crates/cubical-ipc/src/lib.rs crates/cubical-ipc/src/protocol.rs Cargo.lock
git commit -m "feat(ipc): scaffold cubical-ipc crate + wire protocol types"
```

---

## Task 2: `dispatch()` + `render()`

Lift the CLI's command execution into `cubical-ipc` as a data-returning `dispatch`, and add a shared `render`. `dispatch` takes an already-resolved `vault_id` and an `EventSink` — the caller decides `NoopEventSink` (CLI-local) vs `TauriEventSink` (app).

**Files:**
- Create: `crates/cubical-ipc/src/dispatch.rs`
- Create: `crates/cubical-ipc/src/render.rs`
- Modify: `crates/cubical-ipc/src/lib.rs`

**Interfaces:**
- Consumes: `cubical_engine::state::AppState`, `cubical_engine::events::EventSink`, `cubical_engine::commands::{vault, links, backlinks, rename}`, `cubical_engine::api::types::*`, `cubical_engine::error::CubicalError`.
- Produces:
  - `pub async fn dispatch(vault_id: &str, command: Command, state: &AppState, sink: &dyn EventSink) -> Result<Outcome, CubicalError>`
  - `pub fn render(outcome: &Outcome, json: bool) -> i32`

- [ ] **Step 1: Write the failing dispatch test**

`crates/cubical-ipc/src/dispatch.rs` (test module first — the impl follows in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use cubical_engine::api::types::{GetVaultInfoRequest, OpenVaultRequest, ScanStatus};
    use cubical_engine::commands::vault;
    use cubical_engine::events::NoopEventSink;
    use cubical_engine::state::AppState;
    use std::sync::Arc;

    async fn open_temp(dir: &std::path::Path) -> (AppState, String) {
        let state = AppState::new();
        let opened = vault::open_vault(
            &state,
            Arc::new(NoopEventSink),
            OpenVaultRequest { path: dir.to_path_buf() },
            None,
        )
        .await
        .unwrap();
        loop {
            let info = vault::get_vault_info(
                &state,
                GetVaultInfoRequest { vault_id: opened.vault_id.clone() },
            )
            .await
            .unwrap();
            if matches!(info.scan_status, ScanStatus::Complete) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        (state, opened.vault_id)
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_new_note_creates_a_file() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt"));
        let (state, vault_id) = open_temp(dir.path()).await;

        let outcome = dispatch(
            &vault_id,
            Command::NewNote { at: Some("Daily.md".into()), parent: None },
            &state,
            &NoopEventSink,
        )
        .await
        .unwrap();

        match outcome {
            Outcome::Created(path) => assert_eq!(path, "Daily.md"),
            other => panic!("expected Created, got {other:?}"),
        }
        assert!(dir.path().join("Daily.md").exists());
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn dispatch_write_replaces_body() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt2"));
        std::fs::write(dir.path().join("N.md"), "old").unwrap();
        let (state, vault_id) = open_temp(dir.path()).await;

        let outcome = dispatch(
            &vault_id,
            Command::Write { path: "N.md".into(), content: "new body".into() },
            &state,
            &NoopEventSink,
        )
        .await
        .unwrap();

        assert_eq!(outcome, Outcome::Wrote("N.md".into()));
        assert_eq!(std::fs::read_to_string(dir.path().join("N.md")).unwrap(), "new body");
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p cubical-ipc dispatch_new_note_creates_a_file`
Expected: FAIL — `dispatch` not found (compile error).

- [ ] **Step 3: Write the dispatch implementation**

Prepend to `crates/cubical-ipc/src/dispatch.rs`:

```rust
use cubical_engine::api::types::{
    CreateFileAtPathRequest, CreateFileRequest, CreateFolderRequest, DeletePathRequest,
    GetBacklinksRequest, GetSettingRequest, ListFilesRequest, RenameFileRequest,
    RenameFolderRequest, ResolveLinkRequest, SetSettingRequest, UndoRenameRequest,
    WriteFileTextRequest,
};
use cubical_engine::commands::{backlinks, links, rename, vault};
use cubical_engine::error::CubicalError;
use cubical_engine::events::EventSink;
use cubical_engine::state::AppState;

use crate::protocol::{Command, Outcome};

pub async fn dispatch(
    vault_id: &str,
    command: Command,
    state: &AppState,
    sink: &dyn EventSink,
) -> Result<Outcome, CubicalError> {
    let vid = vault_id.to_string();
    match command {
        Command::List => {
            let resp = vault::list_files(
                state,
                ListFilesRequest { vault_id: vid, limit: None, offset: None },
            )
            .await?;
            let files = resp
                .files
                .into_iter()
                .filter(|f| f.type_id == "markdown")
                .map(|f| f.path)
                .collect();
            Ok(Outcome::Files(files))
        }
        Command::Resolve { target } => {
            let resp = links::resolve_link(
                state,
                ResolveLinkRequest { vault_id: vid, target_raw: target.clone(), source_path: None },
            )
            .await?;
            Ok(Outcome::Resolved { target, path: resp.target_path })
        }
        Command::Backlinks { path } => {
            let resp = backlinks::get_backlinks(
                state,
                GetBacklinksRequest { vault_id: vid, path },
            )
            .await?;
            Ok(Outcome::Backlinks(
                resp.backlinks.into_iter().map(|b| b.source_path).collect(),
            ))
        }
        Command::NewNote { at, parent } => {
            let path = match at {
                Some(path) => {
                    vault::create_file_at_path(
                        state,
                        CreateFileAtPathRequest { vault_id: vid, path },
                    )
                    .await?
                    .path
                }
                None => {
                    vault::create_file(
                        state,
                        CreateFileRequest { vault_id: vid, parent_dir: parent.unwrap_or_default() },
                    )
                    .await?
                    .path
                }
            };
            Ok(Outcome::Created(path))
        }
        Command::NewFolder { parent } => {
            let resp = vault::create_folder(
                state,
                CreateFolderRequest { vault_id: vid, parent_dir: parent.unwrap_or_default() },
            )
            .await?;
            Ok(Outcome::Created(resp.path))
        }
        Command::Write { path, content } => {
            vault::write_file_text(
                state,
                WriteFileTextRequest {
                    vault_id: vid,
                    path: path.clone(),
                    content,
                    expected_seen_hash: None,
                },
            )
            .await?;
            Ok(Outcome::Wrote(path))
        }
        Command::RenameFile { from, to } => {
            let resp = rename::rename_file(
                state,
                sink,
                RenameFileRequest { vault_id: vid, from_path: from, to_path: to.clone() },
            )
            .await?;
            Ok(Outcome::Renamed { to, pending_count: resp.pending_count })
        }
        Command::RenameFolder { from, to } => {
            let resp = rename::rename_folder(
                state,
                sink,
                RenameFolderRequest { vault_id: vid, from_path: from, to_path: to.clone() },
            )
            .await?;
            Ok(Outcome::Renamed { to, pending_count: resp.pending_count })
        }
        Command::Rm { path } => {
            vault::delete_path(state, DeletePathRequest { vault_id: vid, path: path.clone() })
                .await?;
            Ok(Outcome::Trashed(path))
        }
        Command::Set { key, value } => {
            vault::set_setting(
                state,
                SetSettingRequest { vault_id: vid, key: key.clone(), value },
            )
            .await?;
            Ok(Outcome::SettingSet(key))
        }
        Command::Get { key } => {
            let resp = vault::get_setting(
                state,
                GetSettingRequest { vault_id: vid, key: key.clone() },
            )
            .await?;
            Ok(Outcome::SettingGet { key, value: resp.value })
        }
        Command::UndoRename { op_id } => {
            let resp = rename::undo_rename(
                state,
                sink,
                UndoRenameRequest { vault_id: vid, rename_op_id: op_id },
            )
            .await?;
            Ok(Outcome::UndoRename { op_id, removed: resp.removed, pending_count: resp.pending_count })
        }
    }
}
```

- [ ] **Step 4: Run the dispatch tests to verify they pass**

Run: `cargo test -p cubical-ipc dispatch_`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing render test**

`crates/cubical-ipc/src/render.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Outcome;

    #[test]
    fn resolved_none_exits_one() {
        let code = render(&Outcome::Resolved { target: "X".into(), path: None }, false);
        assert_eq!(code, 1);
    }

    #[test]
    fn resolved_some_exits_zero() {
        let code = render(
            &Outcome::Resolved { target: "X".into(), path: Some("X.md".into()) },
            false,
        );
        assert_eq!(code, 0);
    }

    #[test]
    fn setting_get_unset_exits_one() {
        let code = render(&Outcome::SettingGet { key: "k".into(), value: None }, false);
        assert_eq!(code, 1);
    }

    #[test]
    fn created_exits_zero() {
        assert_eq!(render(&Outcome::Created("A.md".into()), false), 0);
        assert_eq!(render(&Outcome::Created("A.md".into()), true), 0);
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cargo test -p cubical-ipc -- render`
Expected: FAIL — `render` not found.

- [ ] **Step 7: Write the render implementation**

Prepend to `crates/cubical-ipc/src/render.rs`:

```rust
use crate::protocol::Outcome;

pub fn render(outcome: &Outcome, json: bool) -> i32 {
    match outcome {
        Outcome::Files(paths) => {
            if json {
                println!("{}", serde_json::to_string_pretty(paths).unwrap_or_default());
            } else {
                for p in paths {
                    println!("{p}");
                }
            }
            0
        }
        Outcome::Resolved { target, path } => match path {
            Some(p) => {
                if json {
                    println!("{}", serde_json::json!({ "target_path": p }));
                } else {
                    println!("{p}");
                }
                0
            }
            None => {
                eprintln!("unresolved: {target}");
                1
            }
        },
        Outcome::Backlinks(sources) => {
            if json {
                println!("{}", serde_json::to_string_pretty(sources).unwrap_or_default());
            } else {
                for s in sources {
                    println!("{s}");
                }
            }
            0
        }
        Outcome::Created(path) => {
            if json {
                println!("{}", serde_json::json!({ "path": path }));
            } else {
                println!("{path}");
            }
            0
        }
        Outcome::Wrote(path) => {
            if json {
                println!("{}", serde_json::json!({ "path": path }));
            } else {
                println!("wrote {path}");
            }
            0
        }
        Outcome::Renamed { to, pending_count } => {
            if json {
                println!("{}", serde_json::json!({ "path": to, "pending_count": pending_count }));
            } else {
                println!("renamed -> {to}");
            }
            0
        }
        Outcome::Trashed(path) => {
            if !json {
                println!("trashed {path}");
            }
            0
        }
        Outcome::SettingSet(key) => {
            if !json {
                println!("set {key}");
            }
            0
        }
        Outcome::SettingGet { key, value } => match value {
            Some(v) => {
                println!("{}", serde_json::to_string(v).unwrap_or_default());
                0
            }
            None => {
                eprintln!("unset: {key}");
                1
            }
        },
        Outcome::UndoRename { op_id, removed, pending_count } => {
            if json {
                println!(
                    "{}",
                    serde_json::json!({ "removed": removed, "pending_count": pending_count })
                );
            } else {
                println!("undid rename op {op_id} (removed {removed} rows)");
            }
            0
        }
    }
}
```

- [ ] **Step 8: Wire the new modules into lib.rs (and add the env-test guard)**

Edit `crates/cubical-ipc/src/lib.rs` — add below `mod protocol;`:

```rust
mod dispatch;
mod render;

pub use dispatch::dispatch;
pub use render::render;

#[cfg(test)]
pub(crate) static RUNTIME_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());
```

The guard is introduced here (not earlier) because this is the first task with a test that consumes it — a `#[cfg(test)]` static with no consumer trips `dead_code` under the workspace's `-D warnings` clippy gate.

- [ ] **Step 9: Run all ipc tests**

Run: `cargo test -p cubical-ipc`
Expected: PASS (protocol 2 + dispatch 2 + render 4 = 8).

- [ ] **Step 10: Commit**

```bash
git add crates/cubical-ipc/src/
git commit -m "feat(ipc): shared dispatch() + render() over the wire protocol"
```

---

## Task 3: Transport — framing, client, `app_socket_path` (`#[cfg(unix)]`)

Length-prefixed JSON framing (generic over async read/write so it's testable with `tokio::io::duplex`), a Unix-socket client, and the per-app socket path helper. `handle_connection` (server side) comes in Task 5 once the engine resolver exists.

**Files:**
- Create: `crates/cubical-ipc/src/transport.rs`
- Modify: `crates/cubical-ipc/src/lib.rs`

**Interfaces:**
- Produces:
  - `pub async fn write_msg<W, T>(w: &mut W, msg: &T) -> std::io::Result<()>` where `W: AsyncWrite + Unpin`, `T: Serialize`
  - `pub async fn read_msg<R, T>(r: &mut R) -> std::io::Result<T>` where `R: AsyncRead + Unpin`, `T: DeserializeOwned`
  - `pub fn app_socket_path(pid: u32) -> std::path::PathBuf`
  - `#[cfg(unix)] pub async fn client_send(socket_path: &Path, req: &Request) -> std::io::Result<Response>`
  - `#[cfg(not(unix))] pub async fn client_send(...) -> std::io::Result<Response>` (errors)

- [ ] **Step 1: Write the failing framing test**

`crates/cubical-ipc/src/transport.rs` (test module first):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Command, Request};

    #[tokio::test]
    async fn frame_round_trips_over_a_duplex() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let req = Request {
            vault_path: std::path::PathBuf::from("/v"),
            command: Command::List,
        };
        let sent = req.clone();
        let writer = tokio::spawn(async move {
            write_msg(&mut a, &sent).await.unwrap();
        });
        let got: Request = read_msg(&mut b).await.unwrap();
        writer.await.unwrap();
        assert_eq!(got, req);
    }

    #[test]
    fn app_socket_path_lands_in_runtime_dir_and_names_the_pid() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", "/tmp/cubical-ipc-test-rt");
        let p = app_socket_path(4242);
        assert!(p.starts_with("/tmp/cubical-ipc-test-rt"));
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "cubical-4242.sock");
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }
}
```

Note: the `app_socket_path` test touches `CUBICAL_RUNTIME_DIR` and asserts on it, so it locks `crate::RUNTIME_ENV_GUARD` (shared with the Task-2 dispatch tests in the same test binary) to serialize against them. The `frame_round_trips` test touches no env and needs no guard.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p cubical-ipc -- transport`
Expected: FAIL — `write_msg`/`read_msg`/`app_socket_path` not found.

- [ ] **Step 3: Write the transport implementation**

Prepend to `crates/cubical-ipc/src/transport.rs`:

```rust
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::protocol::{Request, Response};

const MAX_FRAME: u32 = 64 * 1024 * 1024;

pub async fn write_msg<W, T>(w: &mut W, msg: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    let len = u32::try_from(bytes.len())
        .map_err(|_| std::io::Error::other("frame too large"))?;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_msg<R, T>(r: &mut R) -> std::io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(std::io::Error::other("frame exceeds maximum size"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(std::io::Error::other)
}

pub fn app_socket_path(pid: u32) -> PathBuf {
    runtime_dir().join(format!("cubical-{pid}.sock"))
}

fn runtime_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CUBICAL_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    dirs::runtime_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("cubical")
        .join("locks")
}

#[cfg(unix)]
pub async fn client_send(socket_path: &Path, req: &Request) -> std::io::Result<Response> {
    use tokio::net::UnixStream;
    let mut stream = UnixStream::connect(socket_path).await?;
    write_msg(&mut stream, req).await?;
    read_msg(&mut stream).await
}

#[cfg(not(unix))]
pub async fn client_send(_socket_path: &Path, _req: &Request) -> std::io::Result<Response> {
    Err(std::io::Error::other("socket attach is not supported on this platform"))
}
```

`cubical-ipc` calls `cubical_engine::vault_lock::runtime_dir` (made `pub`) rather than keeping its own copy — the two must resolve identically or the CLI attaches to a path nobody bound, and only a shared definition makes the compiler enforce that. No `dirs` dependency on `cubical-ipc`.

- [ ] **Step 4: Wire transport into lib.rs**

Edit `crates/cubical-ipc/src/lib.rs`:

```rust
mod transport;

pub use transport::{app_socket_path, client_send, read_msg, write_msg};
```

- [ ] **Step 5: Run to verify pass**

Run: `cargo test -p cubical-ipc -- transport`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-ipc/src/transport.rs crates/cubical-ipc/src/lib.rs crates/cubical-ipc/Cargo.toml Cargo.lock
git commit -m "feat(ipc): length-prefixed framing, unix client, app_socket_path"
```

---

## Task 4: Lock advertisement + open-vault resolver (engine)

Make the ownership lock carry a socket path, thread it through `open_vault` as a parameter, and expose a public path→vault_id resolver for the socket server.

**Files:**
- Modify: `crates/cubical-engine/src/vault_lock.rs`
- Modify: `crates/cubical-engine/src/commands/vault.rs`
- Modify: `crates/cubical-cli/src/main.rs` (caller: pass `None`)
- Modify: `crates/cubical-app/src/lib.rs` (caller: pass `None` for now — Task 7 sets `Some`)

**Interfaces:**
- Changes: `vault_lock::acquire(canonical_vault_path: &Path, socket_path: Option<&str>) -> io::Result<Acquire>`
- Changes: `commands::vault::open_vault(state, app, req, advertise_socket: Option<String>)`
- Produces: `pub async fn commands::vault::resolve_open_vault_id(state: &AppState, incoming_canonical: &Path) -> Option<String>`

- [ ] **Step 1: Update the vault_lock tests to the new signature (failing)**

In `crates/cubical-engine/src/vault_lock.rs`, add a new test and update the socket assertion. Add to the `tests` module:

```rust
    #[test]
    fn acquire_advertises_the_socket_path() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Path::new("/vaults/epsilon");
        let _held = match acquire_in(dir.path(), vault, Some("/run/cubical-1.sock")).unwrap() {
            Acquire::Acquired(g) => g,
            Acquire::Held(_) => panic!("first acquire should succeed"),
        };
        match acquire_in(dir.path(), vault, None).unwrap() {
            Acquire::Acquired(_) => panic!("still held"),
            Acquire::Held(owner) => {
                assert_eq!(owner.socket_path.as_deref(), Some("/run/cubical-1.sock"));
            }
        }
    }
```

Update every existing `acquire_in(dir.path(), vault)` call in the test module to `acquire_in(dir.path(), vault, None)` (5 call sites: `acquire_on_a_free_path_succeeds`, `a_second_acquire_reports_the_current_owner`, `releasing_the_guard_allows_reacquire`, `distinct_vault_paths_are_independent`, `the_lock_file_lands_in_the_given_dir`).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p cubical-engine vault_lock`
Expected: FAIL — `acquire_in` takes 2 args, not 3.

- [ ] **Step 3: Thread the socket path through `acquire`/`write_payload`**

In `crates/cubical-engine/src/vault_lock.rs`:

```rust
pub fn acquire(canonical_vault_path: &Path, socket_path: Option<&str>) -> io::Result<Acquire> {
    acquire_in(&runtime_dir(), canonical_vault_path, socket_path)
}

pub(crate) fn acquire_in(
    dir: &Path,
    canonical_vault_path: &Path,
    socket_path: Option<&str>,
) -> io::Result<Acquire> {
    use fs4::FileExt;

    std::fs::create_dir_all(dir)?;
    let lock_path = dir.join(lock_filename(canonical_vault_path));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)?;

    match file.try_lock_exclusive() {
        Ok(()) => {
            write_payload(&file, canonical_vault_path, socket_path)?;
            Ok(Acquire::Acquired(VaultLockGuard { file, lock_path }))
        }
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
            let owner = read_owner(&lock_path).unwrap_or(LockOwner { pid: 0, socket_path: None });
            Ok(Acquire::Held(owner))
        }
        Err(e) => Err(e),
    }
}

fn write_payload(
    file: &File,
    canonical_vault_path: &Path,
    socket_path: Option<&str>,
) -> io::Result<()> {
    use std::io::{Seek, SeekFrom, Write};

    let payload = LockPayload {
        pid: std::process::id(),
        path: canonical_vault_path.to_string_lossy().into_owned(),
        socket_path: socket_path.map(|s| s.to_string()),
    };
    let bytes = serde_json::to_vec(&payload).map_err(io::Error::other)?;
    file.set_len(0)?;
    (&*file).seek(SeekFrom::Start(0))?;
    (&*file).write_all(&bytes)?;
    (&*file).flush()?;
    Ok(())
}
```

- [ ] **Step 4: Run vault_lock tests**

Run: `cargo test -p cubical-engine vault_lock`
Expected: PASS (7 tests: 6 existing + 1 new).

- [ ] **Step 5: Add the `advertise_socket` param + resolver to `open_vault` (failing build)**

In `crates/cubical-engine/src/commands/vault.rs`, change the signature and the `acquire` call:

```rust
pub async fn open_vault(
    state: &AppState,
    app: std::sync::Arc<dyn EventSink>,
    req: OpenVaultRequest,
    advertise_socket: Option<String>,
) -> Result<OpenVaultResponse, CubicalError> {
```

and:

```rust
    let lock_key = canonical.unwrap_or_else(|| req.path.clone());
    let lock_guard = match crate::vault_lock::acquire(&lock_key, advertise_socket.as_deref())
        .map_err(|e| CubicalError::Io(format!("acquiring vault lock: {e}")))?
    {
```

Add the public resolver near `find_open_vault_by_canonical_path`:

```rust
pub async fn resolve_open_vault_id(
    state: &AppState,
    incoming_canonical: &std::path::Path,
) -> Option<String> {
    let guard = state.vaults().read().await;
    find_open_vault_by_canonical_path(&guard, incoming_canonical).map(|(id, _)| id)
}
```

- [ ] **Step 6: Fix the two production callers**

`crates/cubical-cli/src/main.rs` — the `vault::open_vault(...)` call in `run()`: add a fourth argument `None`:

```rust
    let opened = match vault::open_vault(
        &state,
        Arc::clone(&sink),
        OpenVaultRequest { path: cli.vault.clone() },
        None,
    )
    .await
```

`crates/cubical-app/src/lib.rs` — the `commands::vault::open_vault(...)` call in the `open_vault` Tauri command: add `None` as the fourth argument (Task 7 replaces it with `Some(path)`).

Also fix the two in-crate test callers in `crates/cubical-engine/src/commands/vault.rs` (the `let opened = open_vault(...)` and `let err = open_vault(...)` sites the grep found) by appending `, None`.

**And fix the `cubical-ipc` test caller:** `crates/cubical-ipc/src/dispatch.rs`'s `open_temp` test helper calls `vault::open_vault(...)` with three arguments (correct before this task) — append `, None` as the fourth. Adding the parameter is a breaking signature change, so sweep for **every** caller before building: `rg -n "open_vault\s*\(" crates --glob '*.rs'`. Expect call sites in `cubical-cli/src/main.rs`, `cubical-app/src/lib.rs`, `cubical-engine/src/commands/vault.rs` (2 tests), and `cubical-ipc/src/dispatch.rs` (1 test helper).

- [ ] **Step 7: Add a resolver test**

Add to the tests in `crates/cubical-engine/src/commands/vault.rs` (mirror an existing open_vault test's setup):

```rust
    #[tokio::test]
    async fn resolve_open_vault_id_finds_the_open_vault() {
        let _guard = crate::vault_lock::RUNTIME_ENV_GUARD.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", dir.path().join("rt"));
        let state = AppState::new();
        let opened = open_vault(
            &state,
            std::sync::Arc::new(crate::events::NoopEventSink),
            OpenVaultRequest { path: dir.path().to_path_buf() },
            None,
        )
        .await
        .unwrap();
        let canonical = std::fs::canonicalize(dir.path()).unwrap();
        let found = resolve_open_vault_id(&state, &canonical).await;
        assert_eq!(found.as_deref(), Some(opened.vault_id.as_str()));
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }
```

(If the existing open_vault tests use a different `AppState`/import path, match theirs — check the top of the `tests` module for imports and the `RUNTIME_ENV_GUARD` usage pattern already established for Phase-1's lock integration test.)

- [ ] **Step 8: Run engine tests**

Run: `cargo test -p cubical-engine`
Expected: PASS (all, including the new resolver test). If the known watcher flake trips, re-run that test in isolation.

- [ ] **Step 9: Commit**

```bash
git add crates/cubical-engine/src/vault_lock.rs crates/cubical-engine/src/commands/vault.rs crates/cubical-cli/src/main.rs crates/cubical-app/src/lib.rs
git commit -m "feat(engine): advertise socket path in the lock; add open-vault resolver"
```

---

## Task 5: `handle_connection` + cross-task socket round-trip

Add the server-side per-connection handler to `cubical-ipc` (it uses the Task-4 resolver + Task-2 dispatch), and prove a real socket round-trip end to end.

**Files:**
- Modify: `crates/cubical-ipc/src/transport.rs`
- Modify: `crates/cubical-ipc/src/lib.rs`
- Create: `crates/cubical-ipc/tests/socket.rs`

**Interfaces:**
- Produces: `#[cfg(unix)] pub async fn handle_connection(stream: tokio::net::UnixStream, state: &AppState, sink: &dyn EventSink) -> std::io::Result<()>`

- [ ] **Step 1: Write the failing round-trip test**

`crates/cubical-ipc/tests/socket.rs`:

```rust
#![cfg(unix)]

use std::sync::Arc;

use cubical_engine::api::types::{GetVaultInfoRequest, OpenVaultRequest, ScanStatus};
use cubical_engine::commands::vault;
use cubical_engine::events::NoopEventSink;
use cubical_engine::state::AppState;
use cubical_ipc::{client_send, handle_connection, Command, Request, Response};
use tokio::net::UnixListener;

static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

async fn open_scanned(dir: &std::path::Path) -> (AppState, String) {
    let state = AppState::new();
    let opened = vault::open_vault(
        &state,
        Arc::new(NoopEventSink),
        OpenVaultRequest { path: dir.to_path_buf() },
        None,
    )
    .await
    .unwrap();
    loop {
        let info = vault::get_vault_info(
            &state,
            GetVaultInfoRequest { vault_id: opened.vault_id.clone() },
        )
        .await
        .unwrap();
        if matches!(info.scan_status, ScanStatus::Complete) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    (state, opened.vault_id)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn socket_new_note_creates_a_file_via_dispatch() {
    let _env = ENV_GUARD.lock().unwrap();
    let rt = tempfile::tempdir().unwrap();
    std::env::set_var("CUBICAL_RUNTIME_DIR", rt.path());
    let vault_dir = tempfile::tempdir().unwrap();
    let (state, _vault_id) = open_scanned(vault_dir.path()).await;

    let sock = rt.path().join("test.sock");
    let listener = UnixListener::bind(&sock).unwrap();

    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        handle_connection(stream, &state, &NoopEventSink).await.unwrap();
    });

    let canonical = std::fs::canonicalize(vault_dir.path()).unwrap();
    let resp = client_send(
        &sock,
        &Request {
            vault_path: canonical,
            command: Command::NewNote { at: Some("FromSocket.md".into()), parent: None },
        },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert_eq!(resp, Response::Ok(cubical_ipc::Outcome::Created("FromSocket.md".into())));
    assert!(vault_dir.path().join("FromSocket.md").exists());
    std::env::remove_var("CUBICAL_RUNTIME_DIR");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn socket_unknown_vault_returns_err() {
    let _env = ENV_GUARD.lock().unwrap();
    let rt = tempfile::tempdir().unwrap();
    std::env::set_var("CUBICAL_RUNTIME_DIR", rt.path());
    let state = AppState::new();

    let sock = rt.path().join("test2.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        handle_connection(stream, &state, &NoopEventSink).await.unwrap();
    });

    let resp = client_send(
        &sock,
        &Request { vault_path: "/nope".into(), command: Command::List },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert!(matches!(resp, Response::Err(_)));
    std::env::remove_var("CUBICAL_RUNTIME_DIR");
}
```

Note: `cubical_ipc::Outcome` must be public — confirm `pub use protocol::{..., Outcome, ...}` from Task 1 covers it (it does).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p cubical-ipc --test socket`
Expected: FAIL — `handle_connection` not found.

- [ ] **Step 3: Implement `handle_connection`**

Append to `crates/cubical-ipc/src/transport.rs`:

```rust
#[cfg(unix)]
pub async fn handle_connection(
    mut stream: tokio::net::UnixStream,
    state: &cubical_engine::state::AppState,
    sink: &dyn cubical_engine::events::EventSink,
) -> std::io::Result<()> {
    let req: Request = read_msg(&mut stream).await?;
    let canonical = std::fs::canonicalize(&req.vault_path).unwrap_or(req.vault_path.clone());
    let response = match cubical_engine::commands::vault::resolve_open_vault_id(state, &canonical)
        .await
    {
        Some(vault_id) => match crate::dispatch::dispatch(&vault_id, req.command, state, sink).await
        {
            Ok(outcome) => Response::Ok(outcome),
            Err(e) => Response::Err(e.to_string()),
        },
        None => Response::Err("vault not open".to_string()),
    };
    write_msg(&mut stream, &response).await
}
```

- [ ] **Step 4: Export it**

Edit `crates/cubical-ipc/src/lib.rs` — extend the transport re-export:

```rust
#[cfg(unix)]
pub use transport::handle_connection;
```

- [ ] **Step 5: Run the socket tests**

Run: `cargo test -p cubical-ipc --test socket`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-ipc/src/transport.rs crates/cubical-ipc/src/lib.rs crates/cubical-ipc/tests/socket.rs
git commit -m "feat(ipc): server-side handle_connection + socket round-trip tests"
```

---

## Task 6: CLI — build `Command`, dispatch locally, attach on `VaultLocked`

Rewrite `cubical-cli` to build a `Command`, run it through `cubical_ipc::dispatch` locally when the app is closed, and route it over the socket when the app owns the vault. Delete the CLI's now-duplicated inline dispatch.

**Files:**
- Modify: `crates/cubical-cli/Cargo.toml`
- Modify: `crates/cubical-cli/src/main.rs`
- Modify: `crates/cubical-cli/tests/cli.rs`

**Interfaces:**
- Consumes: `cubical_ipc::{Command, Request, Response, Outcome, dispatch, render, client_send}`.

- [ ] **Step 1: Add the ipc dependency**

`crates/cubical-cli/Cargo.toml` `[dependencies]`:

```toml
cubical-ipc = { path = "../cubical-ipc" }
```

- [ ] **Step 2: Write the attach integration test (failing)**

Add to `crates/cubical-cli/tests/cli.rs`. This mirrors `declines_with_exit_code_2_when_the_vault_is_locked`, but the test process **advertises a socket** and stands up a fake server that returns a sentinel:

```rust
#[test]
fn attaches_over_the_socket_when_the_app_owns_the_vault() {
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    let h = Harness::new();
    std::env::set_var("CUBICAL_RUNTIME_DIR", &h.runtime_path);
    let canonical = std::fs::canonicalize(h.vault_path()).unwrap();
    let sock = h.runtime_path.join("cubical-fake.sock");

    // Hold the lock AND advertise the fake socket, exactly as the running app would.
    let _guard = match cubical_engine::vault_lock::acquire(
        &canonical,
        Some(sock.to_string_lossy().as_ref()),
    )
    .unwrap()
    {
        cubical_engine::vault_lock::Acquire::Acquired(g) => g,
        cubical_engine::vault_lock::Acquire::Held(_) => panic!("test should own the lock"),
    };
    std::env::remove_var("CUBICAL_RUNTIME_DIR");

    let listener = UnixListener::bind(&sock).unwrap();
    // Fake server: read the framed Request, reply with a sentinel Files outcome.
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut len = [0u8; 4];
        stream.read_exact(&mut len).unwrap();
        let n = u32::from_be_bytes(len) as usize;
        let mut buf = vec![0u8; n];
        stream.read_exact(&mut buf).unwrap();
        let _req: cubical_ipc::Request = serde_json::from_slice(&buf).unwrap();
        let resp = cubical_ipc::Response::Ok(cubical_ipc::Outcome::Files(vec![
            "SENTINEL-ROUTED.md".to_string(),
        ]));
        let bytes = serde_json::to_vec(&resp).unwrap();
        stream.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();
        stream.write_all(&bytes).unwrap();
        stream.flush().unwrap();
    });

    let out = h.run(&["list"]);
    server.join().unwrap();

    assert_eq!(out.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&out.stderr));
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("SENTINEL-ROUTED.md"),
        "expected the command to route through the socket; stdout: {}",
        String::from_utf8_lossy(&out.stdout),
    );
}
```

Add `cubical-ipc = { path = "../cubical-ipc" }` to `crates/cubical-cli/Cargo.toml` `[dev-dependencies]` as well (the test names it).

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p cubical-cli --test cli attaches_over_the_socket`
Expected: FAIL — the CLI still declines with exit 2 (Phase-1 behavior), so stdout lacks the sentinel and the code is 2.

- [ ] **Step 4: Rewrite `main.rs` to build a Command and route it**

Replace the body of `crates/cubical-cli/src/main.rs` from the `use` block down. Keep the `Cli`/`Cmd`/`NewWhat` clap structs and `wait_for_scan` exactly as they are; replace `run`, `dispatch`, and the `report_*`/`print_json` helpers with:

```rust
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use cubical_engine::api::types::{
    CloseVaultRequest, GetVaultInfoRequest, OpenVaultRequest, ScanStatus,
};
use cubical_engine::commands::vault;
use cubical_engine::error::CubicalError;
use cubical_engine::events::{EventSink, NoopEventSink};
use cubical_engine::state::AppState;
use cubical_ipc::{Command as WireCommand, Request, Response};

// ... keep the existing #[derive(Parser)] Cli, #[derive(Subcommand)] Cmd, NewWhat ...

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    std::process::exit(run(cli).await);
}

fn build_command(cmd: Cmd, vault_root: &Path) -> Result<WireCommand> {
    Ok(match cmd {
        Cmd::List => WireCommand::List,
        Cmd::Resolve { target } => WireCommand::Resolve { target },
        Cmd::Backlinks { path } => WireCommand::Backlinks { path },
        Cmd::New(NewWhat::Note { at, parent }) => WireCommand::NewNote { at, parent },
        Cmd::New(NewWhat::Folder { parent }) => WireCommand::NewFolder { parent },
        Cmd::Write { path } => {
            let mut content = String::new();
            std::io::stdin()
                .read_to_string(&mut content)
                .context("reading body from stdin")?;
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

async fn run(cli: Cli) -> i32 {
    let command = match build_command(cli.cmd, &cli.vault) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e:#}");
            return 1;
        }
    };

    let state = AppState::new();
    let sink: Arc<dyn EventSink> = Arc::new(NoopEventSink);

    let opened = match vault::open_vault(
        &state,
        Arc::clone(&sink),
        OpenVaultRequest { path: cli.vault.clone() },
        None,
    )
    .await
    {
        Ok(opened) => opened,
        Err(CubicalError::VaultLocked { pid, socket_path: Some(path) }) => {
            return attach(&cli.vault, command, &path, cli.json).await;
        }
        Err(CubicalError::VaultLocked { pid, socket_path: None }) => {
            eprintln!("Cubical has this vault open (pid {pid}). Live routing arrives in Phase 2.");
            return 2;
        }
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };

    let vault_id = opened.vault_id;
    let outcome = match wait_for_scan(&state, &vault_id).await {
        Ok(()) => cubical_ipc::dispatch(&vault_id, command, &state, sink.as_ref())
            .await
            .map_err(anyhow::Error::from),
        Err(e) => Err(e),
    };

    let _ = vault::close_vault(
        &state,
        sink.as_ref(),
        CloseVaultRequest { vault_id: vault_id.clone() },
    )
    .await;

    match outcome {
        Ok(outcome) => cubical_ipc::render(&outcome, cli.json),
        Err(e) => {
            eprintln!("error: {e:#}");
            1
        }
    }
}

async fn attach(vault_root: &Path, command: WireCommand, socket_path: &str, json: bool) -> i32 {
    let canonical = std::fs::canonicalize(vault_root).unwrap_or_else(|_| vault_root.to_path_buf());
    let req = Request { vault_path: canonical, command };
    match cubical_ipc::client_send(Path::new(socket_path), &req).await {
        Ok(Response::Ok(outcome)) => cubical_ipc::render(&outcome, json),
        Ok(Response::Err(msg)) => {
            eprintln!("error: {msg}");
            1
        }
        Err(e) => {
            eprintln!("error: could not reach the running Cubical app: {e}");
            1
        }
    }
}
```

Note: `pid` in the `Some(path)` arm is unused — name it `pid: _` to avoid a warning, or drop the binding: `VaultLocked { socket_path: Some(path), .. }`. Delete the old `dispatch`, `report_path`, `report_rename`, `print_json` functions entirely (now in `cubical-ipc`). Keep `wait_for_scan` and its `GetVaultInfoRequest`/`ScanStatus` imports.

- [ ] **Step 5: Run the full CLI test suite**

Run: `cargo test -p cubical-cli`
Expected: PASS — all Phase-1 tests still green (they run against a free vault, so `dispatch` local path), the exit-2 decline test still green (owner advertises no socket → `socket_path: None`), and the new attach test green.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-cli/Cargo.toml crates/cubical-cli/src/main.rs crates/cubical-cli/tests/cli.rs Cargo.lock
git commit -m "feat(cli): route commands through cubical-ipc; attach over the socket when the app owns the vault"
```

---

## Task 7: App — socket server task + advertise socket path

Wire the app to run the socket server and advertise its socket path when opening a vault.

**Files:**
- Modify: `crates/cubical-app/Cargo.toml`
- Modify: `crates/cubical-app/src/lib.rs`

**Interfaces:**
- Consumes: `cubical_ipc::{app_socket_path, handle_connection}`, `tauri::async_runtime`, `tauri::Manager`, `crate::tauri_sink::TauriEventSink`.

- [ ] **Step 1: Add the ipc dependency**

`crates/cubical-app/Cargo.toml` `[dependencies]`:

```toml
cubical-ipc = { path = "../cubical-ipc" }
```

- [ ] **Step 2: Advertise the socket path in the `open_vault` command**

In `crates/cubical-app/src/lib.rs`, the `open_vault` Tauri command currently passes `None`. Replace with the app's socket path:

```rust
    let resp = commands::vault::open_vault(
        state.inner(),
        std::sync::Arc::new(crate::tauri_sink::TauriEventSink::new(app.clone())),
        req,
        Some(
            cubical_ipc::app_socket_path(std::process::id())
                .to_string_lossy()
                .into_owned(),
        ),
    )
    .await?;
```

- [ ] **Step 3: Spawn the socket server in `.setup()`**

In `run()`, add a `.setup(...)` call to the builder chain (before `.run(...)`). The server binds the app's socket, unlinks any stale file first, and handles connections **sequentially** (mutations are serialized by `AppState`; a one-shot CLI is low-volume):

```rust
        .setup(|app| {
            #[cfg(unix)]
            {
                use tauri::Manager;
                let handle = app.handle().clone();
                let sock = cubical_ipc::app_socket_path(std::process::id());
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = serve_socket(handle, sock).await {
                        tracing::warn!("cubical-ipc socket server stopped: {e}");
                    }
                });
            }
            Ok(())
        })
```

Add the `serve_socket` helper to `lib.rs`:

```rust
#[cfg(unix)]
async fn serve_socket(app: tauri::AppHandle, sock: std::path::PathBuf) -> std::io::Result<()> {
    use tauri::Manager;

    let _ = std::fs::remove_file(&sock);
    if let Some(parent) = sock.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = tokio::net::UnixListener::bind(&sock)?;
    tracing::info!("cubical-ipc socket listening at {}", sock.display());
    loop {
        let (stream, _) = listener.accept().await?;
        let state = app.state::<AppState>();
        let sink = crate::tauri_sink::TauriEventSink::new(app.clone());
        if let Err(e) = cubical_ipc::handle_connection(stream, state.inner(), &sink).await {
            tracing::warn!("cubical-ipc connection error: {e}");
        }
    }
}
```

Note: the runtime dir for `app_socket_path` must match the lock's — both use `CUBICAL_RUNTIME_DIR` or the same default (`<runtime>/cubical/locks`). They do, by construction (Task 3's `runtime_dir` mirrors `vault_lock::runtime_dir`).

- [ ] **Step 4: Build the app crate**

Run: `cargo build -p cubical-app`
Expected: compiles. (The app has no unit tests for this; it's exercised by the manual smoke below and the CLI attach test at the protocol level.)

- [ ] **Step 5: Manual smoke (documented, best-effort)**

If a dev environment is available: `npm run tauri dev` (force a full recompile — stale-binary gotcha), open a vault, then from a terminal in the vault dir run `cubical list` and `echo "hi" | cubical write Smoke.md`. Expected: the commands succeed (exit 0) and the app UI reflects `Smoke.md` live (watcher echo suppressed via the shared `flush_own_writes` path). If no GUI environment is available, note that in the task closeout and rely on the automated socket round-trip (Task 5) + CLI attach (Task 6) tests, which exercise the same `handle_connection` + protocol.

- [ ] **Step 6: Commit**

```bash
git add crates/cubical-app/Cargo.toml crates/cubical-app/src/lib.rs Cargo.lock
git commit -m "feat(app): host the cubical-ipc socket server; advertise its path on open_vault"
```

---

## Task 8: Docs + full gate

**Files:**
- Modify: `docs/implementation/engine-ipc.md`
- Modify: `docs/superpowers/specs/2026-07-24-cli-attach-phase2-design.md` ("What was built")

- [ ] **Step 1: Extend the engine-ipc rationale**

In `docs/implementation/engine-ipc.md`, under "Cross-process vault ownership lock", add a subsection describing the now-realized socket boundary: the app hosts a `#[cfg(unix)]` Unix-domain-socket server (`cubical-app` `.setup()` → sequential accept loop) over the shared `cubical_ipc::handle_connection`; the wire protocol (`Command`/`Outcome`/`Response`, length-prefixed JSON) and the single `dispatch()` live in `cubical-ipc`, shared by the CLI-local path, the socket server, and the CLI client; the app advertises its per-pid socket path in the lock payload via the `open_vault` `advertise_socket` parameter; the CLI's `VaultLocked` branch attaches when `socket_path` is `Some`, else declines (exit 2). Note `--json` output is `Outcome`-defined. Keep it terse — one owner per fact; link, don't restate the spec.

- [ ] **Step 2: Fill in the spec's "What was built (Phase 2)"**

Replace the placeholder with a terse record of the crate, the shared dispatch/render/protocol, the socket transport, the lock advertisement, the app server, and the test counts (fill actual numbers after Step 3).

- [ ] **Step 3: Run the full gate**

Run: `scripts/check.sh`
Expected: green (tsc, vitest, build, cargo fmt/clippy/test, docs). If the `cubical-core` watcher flake trips, re-run it in isolation to confirm it is the known flake, not a regression.

- [ ] **Step 4: Commit**

```bash
git add docs/implementation/engine-ipc.md docs/superpowers/specs/2026-07-24-cli-attach-phase2-design.md
git commit -m "docs(cli): record Phase 2 live-attach (socket boundary realized)"
```

- [ ] **Step 5: Session closeout**

Rewrite the `CLAUDE.md` Project state block (Phase 2 done; Phase 3 the remaining deferred item) and update the `project_cli_frontend` memory. Report final test counts and gate status.

---

## Self-Review (completed during planning)

- **Spec coverage:** architecture (Tasks 1–2), server + advertisement (Tasks 4,5,7), CLI attach (Task 6), transport/framing/Windows stub (Task 3), error handling (render + attach branches, Task 6; `Response::Err` in Task 5), testing (unit in 1–2, transport in 3, socket round-trip in 5, CLI attach in 6), docs (Task 8). No gaps.
- **Placeholder scan:** every code/test step carries real code; the only "fill in later" is the spec's "What was built" (by design, filled in Task 8 Step 2) and actual test counts (Task 8).
- **Type consistency:** `dispatch(vault_id, command, state, sink)`, `render(&Outcome, json) -> i32`, `acquire(path, Option<&str>)`, `open_vault(state, app, req, Option<String>)`, `resolve_open_vault(state, &Path) -> Option<(String, ScanStatus)>`, `handle_connection(UnixStream, &AppState, &dyn EventSink)`, `client_send(&Path, &Request) -> Response`, `app_socket_path(u32)` — used consistently across tasks. `Command`/`Outcome`/`Response` variant names match between protocol, dispatch, render, and the CLI/tests.
- **Known nuance:** `--json` shape is now `Outcome`-defined (documented, no external consumers). Human success output unchanged; error text drops Phase-1's `anyhow` context.
