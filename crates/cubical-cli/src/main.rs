//! `cubical` — a terminal frontend over [`cubical_engine`].
//!
//! Proof that the engine is genuinely frontend-agnostic: this binary links
//! `cubical-engine` with **no Tauri dependency**, builds an [`AppState`],
//! opens a vault, and drives the exact same command handlers the GUI uses —
//! supplying its own [`EventSink`] (a no-op) instead of a `TauriEventSink`.
//!
//! Standalone one-shot: open the vault, run the initial scan to completion,
//! answer the query, exit. (The GUI-vs-CLI concurrency story — forwarding to
//! a running instance — is a later step; see the engine/transport decoupling
//! plan.)

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

use cubical_engine::api::types::{
    GetBacklinksRequest, GetVaultInfoRequest, ListFilesRequest, OpenVaultRequest,
    ResolveLinkRequest, ScanStatus,
};
use cubical_engine::commands::{backlinks, links, vault};
use cubical_engine::events::{EventSink, NoopEventSink};
use cubical_engine::state::AppState;

#[derive(Parser)]
#[command(name = "cubical", about = "Query a Cubical vault from the terminal.")]
struct Cli {
    /// Path to the vault directory.
    #[arg(long, short, global = true, default_value = ".")]
    vault: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List the vault's markdown files (vault-relative paths).
    List,
    /// Resolve a wiki-link target to a file path. Exits non-zero if
    /// unresolved (missing or ambiguous).
    Resolve {
        /// The target as written inside `[[…]]`, e.g. `Daily` or `notes/Daily`.
        target: String,
    },
    /// List the notes that link to a given note (vault-relative path).
    Backlinks {
        /// Vault-relative path of the target note, e.g. `notes/Daily.md`.
        path: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let state = AppState::new();
    let sink: Arc<dyn EventSink> = Arc::new(NoopEventSink);

    let opened = vault::open_vault(
        &state,
        Arc::clone(&sink),
        OpenVaultRequest {
            path: cli.vault.clone(),
        },
    )
    .await
    .with_context(|| format!("opening vault at {}", cli.vault.display()))?;
    let vault_id = opened.vault_id;

    wait_for_scan(&state, &vault_id).await?;

    match cli.cmd {
        Cmd::List => {
            let resp = vault::list_files(
                &state,
                ListFilesRequest {
                    vault_id,
                    limit: None,
                    offset: None,
                },
            )
            .await
            .context("listing files")?;
            for f in resp.files.iter().filter(|f| f.type_id == "markdown") {
                println!("{}", f.path);
            }
        }
        Cmd::Resolve { target } => {
            let resp = links::resolve_link(
                &state,
                ResolveLinkRequest {
                    vault_id,
                    target_raw: target.clone(),
                    source_path: None,
                },
            )
            .await
            .context("resolving link")?;
            match resp.target_path {
                Some(path) => println!("{path}"),
                None => {
                    eprintln!("unresolved: {target}");
                    std::process::exit(1);
                }
            }
        }
        Cmd::Backlinks { path } => {
            let resp = backlinks::get_backlinks(
                &state,
                GetBacklinksRequest {
                    vault_id,
                    path: path.clone(),
                },
            )
            .await
            .with_context(|| format!("listing backlinks for {path}"))?;
            for b in resp.backlinks {
                println!("{}", b.source_path);
            }
        }
    }

    Ok(())
}

/// Poll the vault's scan status until the initial scan finishes. The
/// engine runs the scan as a background task; a one-shot CLI query needs
/// the index fully populated before it reads.
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
