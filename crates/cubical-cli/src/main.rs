use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use cubical_engine::api::types::{
    CloseVaultRequest, CreateFileAtPathRequest, CreateFileRequest, CreateFolderRequest,
    DeletePathRequest, GetBacklinksRequest, GetSettingRequest, GetVaultInfoRequest,
    ListFilesRequest, OpenVaultRequest, RenameFileRequest, RenameFolderRequest, ResolveLinkRequest,
    ScanStatus, SetSettingRequest, UndoRenameRequest, WriteFileTextRequest,
};
use cubical_engine::commands::{backlinks, links, rename, vault};
use cubical_engine::error::CubicalError;
use cubical_engine::events::{EventSink, NoopEventSink};
use cubical_engine::state::AppState;

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

async fn run(cli: Cli) -> i32 {
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
        Err(CubicalError::VaultLocked { pid, .. }) => {
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
        Ok(()) => {
            dispatch(
                &state,
                sink.as_ref(),
                &vault_id,
                &cli.vault,
                cli.json,
                cli.cmd,
            )
            .await
        }
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
        Ok(code) => code,
        Err(e) => {
            eprintln!("error: {e:#}");
            1
        }
    }
}

async fn dispatch(
    state: &AppState,
    sink: &dyn EventSink,
    vault_id: &str,
    vault_root: &Path,
    json: bool,
    cmd: Cmd,
) -> Result<i32> {
    let vid = vault_id.to_string();
    match cmd {
        Cmd::List => {
            let resp = vault::list_files(
                state,
                ListFilesRequest {
                    vault_id: vid,
                    limit: None,
                    offset: None,
                },
            )
            .await
            .context("listing files")?;
            let markdown: Vec<_> = resp
                .files
                .into_iter()
                .filter(|f| f.type_id == "markdown")
                .collect();
            if json {
                print_json(&markdown)?;
            } else {
                for f in &markdown {
                    println!("{}", f.path);
                }
            }
            Ok(0)
        }
        Cmd::Resolve { target } => {
            let resp = links::resolve_link(
                state,
                ResolveLinkRequest {
                    vault_id: vid,
                    target_raw: target.clone(),
                    source_path: None,
                },
            )
            .await
            .context("resolving link")?;
            match &resp.target_path {
                Some(path) => {
                    if json {
                        print_json(&resp)?;
                    } else {
                        println!("{path}");
                    }
                    Ok(0)
                }
                None => {
                    eprintln!("unresolved: {target}");
                    Ok(1)
                }
            }
        }
        Cmd::Backlinks { path } => {
            let resp = backlinks::get_backlinks(
                state,
                GetBacklinksRequest {
                    vault_id: vid,
                    path: path.clone(),
                },
            )
            .await
            .with_context(|| format!("listing backlinks for {path}"))?;
            if json {
                print_json(&resp)?;
            } else {
                for b in &resp.backlinks {
                    println!("{}", b.source_path);
                }
            }
            Ok(0)
        }
        Cmd::New(NewWhat::Note { at, parent }) => {
            let path = match at {
                Some(path) => {
                    vault::create_file_at_path(
                        state,
                        CreateFileAtPathRequest {
                            vault_id: vid,
                            path,
                        },
                    )
                    .await
                    .context("creating note")?
                    .path
                }
                None => {
                    vault::create_file(
                        state,
                        CreateFileRequest {
                            vault_id: vid,
                            parent_dir: parent.unwrap_or_default(),
                        },
                    )
                    .await
                    .context("creating note")?
                    .path
                }
            };
            report_path(json, &path);
            Ok(0)
        }
        Cmd::New(NewWhat::Folder { parent }) => {
            let resp = vault::create_folder(
                state,
                CreateFolderRequest {
                    vault_id: vid,
                    parent_dir: parent.unwrap_or_default(),
                },
            )
            .await
            .context("creating folder")?;
            report_path(json, &resp.path);
            Ok(0)
        }
        Cmd::Write { path } => {
            let mut body = String::new();
            std::io::stdin()
                .read_to_string(&mut body)
                .context("reading body from stdin")?;
            let resp = vault::write_file_text(
                state,
                WriteFileTextRequest {
                    vault_id: vid,
                    path: path.clone(),
                    content: body,
                    expected_seen_hash: None,
                },
            )
            .await
            .with_context(|| format!("writing {path}"))?;
            if json {
                print_json(&resp)?;
            } else {
                println!("wrote {path}");
            }
            Ok(0)
        }
        Cmd::Rename { from, to } => {
            let is_dir = vault_root.join(&from).is_dir();
            if is_dir {
                let resp = rename::rename_folder(
                    state,
                    sink,
                    RenameFolderRequest {
                        vault_id: vid,
                        from_path: from.clone(),
                        to_path: to.clone(),
                    },
                )
                .await
                .with_context(|| format!("renaming folder {from} -> {to}"))?;
                report_rename(json, &to, resp.pending_count);
            } else {
                let resp = rename::rename_file(
                    state,
                    sink,
                    RenameFileRequest {
                        vault_id: vid,
                        from_path: from.clone(),
                        to_path: to.clone(),
                    },
                )
                .await
                .with_context(|| format!("renaming {from} -> {to}"))?;
                report_rename(json, &to, resp.pending_count);
            }
            Ok(0)
        }
        Cmd::Rm { path } => {
            vault::delete_path(
                state,
                DeletePathRequest {
                    vault_id: vid,
                    path: path.clone(),
                },
            )
            .await
            .with_context(|| format!("deleting {path}"))?;
            if !json {
                println!("trashed {path}");
            }
            Ok(0)
        }
        Cmd::Set { key, value } => {
            let parsed = serde_json::from_str::<serde_json::Value>(&value)
                .unwrap_or_else(|_| serde_json::Value::String(value.clone()));
            vault::set_setting(
                state,
                SetSettingRequest {
                    vault_id: vid,
                    key: key.clone(),
                    value: parsed,
                },
            )
            .await
            .with_context(|| format!("setting {key}"))?;
            if !json {
                println!("set {key}");
            }
            Ok(0)
        }
        Cmd::Get { key } => {
            let resp = vault::get_setting(
                state,
                GetSettingRequest {
                    vault_id: vid,
                    key: key.clone(),
                },
            )
            .await
            .with_context(|| format!("getting {key}"))?;
            match resp.value {
                Some(value) => {
                    println!("{}", serde_json::to_string(&value)?);
                    Ok(0)
                }
                None => {
                    eprintln!("unset: {key}");
                    Ok(1)
                }
            }
        }
        Cmd::UndoRename { op_id } => {
            let resp = rename::undo_rename(
                state,
                sink,
                UndoRenameRequest {
                    vault_id: vid,
                    rename_op_id: op_id,
                },
            )
            .await
            .with_context(|| format!("undoing rename op {op_id}"))?;
            if json {
                print_json(&resp)?;
            } else {
                println!("undid rename op {op_id} (removed {} rows)", resp.removed);
            }
            Ok(0)
        }
    }
}

fn report_path(json: bool, path: &str) {
    if json {
        println!("{}", serde_json::json!({ "path": path }));
    } else {
        println!("{path}");
    }
}

fn report_rename(json: bool, to: &str, pending_count: i64) {
    if json {
        println!(
            "{}",
            serde_json::json!({ "path": to, "pending_count": pending_count })
        );
    } else {
        println!("renamed -> {to}");
    }
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
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
