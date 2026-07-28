use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};

use cubical_engine::api::types::{
    CloseVaultRequest, GetVaultInfoRequest, OpenVaultRequest, ScanStatus,
};
use cubical_engine::commands::vault;
use cubical_engine::error::CubicalError;
use cubical_engine::events::{EventSink, NoopEventSink};
use cubical_engine::state::AppState;
use cubical_ipc::parse::{needs_body, to_command, Cli, Parser};
use cubical_ipc::{Command as WireCommand, Request, Response};

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    std::process::exit(run(cli).await);
}

async fn run(cli: Cli) -> i32 {
    if !cli.vault.is_dir() {
        eprintln!(
            "error: {} is not a directory, so it cannot be a vault",
            cli.vault.display(),
        );
        return 1;
    }

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
        Err(cubical_ipc::TransportError::Io(e)) => {
            eprintln!("error: could not reach the running Cubical app: {e}");
            1
        }
        Err(cubical_ipc::TransportError::Protocol(msg)) => {
            eprintln!("error: the running Cubical app sent an unreadable response: {msg}");
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
