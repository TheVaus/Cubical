// Terminal frontend over cubical-engine with no Tauri dep — proves the engine is frontend-agnostic.

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
    #[arg(
        long,
        short,
        global = true,
        default_value = ".",
        help = "Path to the vault directory."
    )]
    vault: PathBuf,
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    #[command(about = "List the vault's markdown files (vault-relative paths).")]
    List,
    #[command(about = "Resolve a wiki-link target to a file path. Exits non-zero if unresolved.")]
    Resolve {
        #[arg(help = "The target as written inside [[…]], e.g. `Daily` or `notes/Daily`.")]
        target: String,
    },
    #[command(about = "List the notes that link to a given note (vault-relative path).")]
    Backlinks {
        #[arg(help = "Vault-relative path of the target note, e.g. `notes/Daily.md`.")]
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
