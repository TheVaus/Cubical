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
        OpenVaultRequest {
            path: dir.to_path_buf(),
        },
        None,
    )
    .await
    .unwrap();
    loop {
        let info = vault::get_vault_info(
            &state,
            GetVaultInfoRequest {
                vault_id: opened.vault_id.clone(),
            },
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
        handle_connection(stream, &state, &NoopEventSink)
            .await
            .unwrap();
    });

    let canonical = std::fs::canonicalize(vault_dir.path()).unwrap();
    let resp = client_send(
        &sock,
        &Request {
            vault_path: canonical,
            command: Command::NewNote {
                at: Some("FromSocket.md".into()),
                parent: None,
            },
        },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert_eq!(
        resp,
        Response::Ok(cubical_ipc::Outcome::Created("FromSocket.md".into()))
    );
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
        handle_connection(stream, &state, &NoopEventSink)
            .await
            .unwrap();
    });

    let resp = client_send(
        &sock,
        &Request {
            vault_path: "/nope".into(),
            command: Command::List,
        },
    )
    .await
    .unwrap();

    server.await.unwrap();
    assert!(matches!(resp, Response::Err(_)));
    std::env::remove_var("CUBICAL_RUNTIME_DIR");
}
