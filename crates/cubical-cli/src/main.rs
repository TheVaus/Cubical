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

#[derive(Parser)]
#[command(name = "cubical", about = "Drive a Cubical vault from the terminal.")]
struct Cli {
    #[arg(
        long,
        global = true,
        default_value = ".",
        help = "Path to the vault directory."
    )]
    vault: PathBuf,
    #[arg(long, global = true, help = "Emit the raw engine response as JSON.")]
    json: bool,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
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
enum NewWhat {
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
        OpenVaultRequest {
            path: cli.vault.clone(),
        },
        None,
    )
    .await
    {
        Ok(opened) => opened,
        Err(CubicalError::VaultLocked {
            socket_path: Some(path),
            ..
        }) => {
            return attach(&cli.vault, command, &path, cli.json).await;
        }
        Err(CubicalError::VaultLocked {
            pid,
            socket_path: None,
        }) => {
            eprintln!(
                "Cubical has this vault open (pid {pid}) but is not accepting local connections."
            );
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
        CloseVaultRequest {
            vault_id: vault_id.clone(),
        },
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
    let req = Request {
        vault_path: canonical,
        command,
    };
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

async fn wait_for_scan(state: &AppState, vault_id: &str) -> Result<()> {
    loop {
        let info = vault::get_vault_info(
            state,
            GetVaultInfoRequest {
                vault_id: vault_id.to_string(),
            },
        )
        .await
        .context("polling scan status")?;
        match info.scan_status {
            ScanStatus::Complete => return Ok(()),
            ScanStatus::Cancelled => anyhow::bail!("vault scan was cancelled"),
            ScanStatus::InProgress => {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }
}
