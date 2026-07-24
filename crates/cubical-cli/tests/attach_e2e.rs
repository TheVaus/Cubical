#![cfg(unix)]

use std::sync::Arc;

use cubical_engine::api::types::{GetVaultInfoRequest, OpenVaultRequest, ScanStatus};
use cubical_engine::commands::vault;
use cubical_engine::events::NoopEventSink;
use cubical_engine::state::AppState;
use cubical_ipc::handle_connection;
use tokio::io::AsyncWriteExt;
use tokio::net::UnixListener;
use tokio::process::Command;

static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

const SERVE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

async fn serve_one(listener: &UnixListener, state: &AppState) {
    let served = async {
        let (stream, _) = listener.accept().await.unwrap();
        handle_connection(stream, state, &NoopEventSink)
            .await
            .unwrap();
    };
    tokio::time::timeout(SERVE_TIMEOUT, served)
        .await
        .expect("the CLI never connected to the advertised socket — it is no longer attaching");
}

async fn open_advertised(
    vault_dir: &std::path::Path,
    sock: &std::path::Path,
) -> (AppState, String) {
    let state = AppState::new();
    let opened = vault::open_vault(
        &state,
        Arc::new(NoopEventSink),
        OpenVaultRequest {
            path: vault_dir.to_path_buf(),
        },
        Some(sock.to_string_lossy().into_owned()),
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
async fn cli_attach_creates_a_note_through_the_real_engine() {
    let _env = ENV_GUARD.lock().unwrap();
    let rt = tempfile::tempdir().unwrap();
    let runtime_path = rt.path().to_path_buf();
    std::env::set_var("CUBICAL_RUNTIME_DIR", &runtime_path);
    let vault_dir = tempfile::tempdir().unwrap();
    let sock = runtime_path.join("attach-e2e-new-note.sock");

    let (state, _vault_id) = open_advertised(vault_dir.path(), &sock).await;
    let listener = UnixListener::bind(&sock).unwrap();

    let server = serve_one(&listener, &state);
    let client = async {
        Command::new(env!("CARGO_BIN_EXE_cubical"))
            .env("CUBICAL_RUNTIME_DIR", &runtime_path)
            .arg("--vault")
            .arg(vault_dir.path())
            .args(["new", "note", "--at", "E2E.md"])
            .output()
            .await
            .unwrap()
    };
    let (_, out) = tokio::join!(server, client);

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("E2E.md"));
    assert!(
        vault_dir.path().join("E2E.md").exists(),
        "the real engine must have created the file"
    );
    std::env::remove_var("CUBICAL_RUNTIME_DIR");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn cli_attach_writes_stdin_body_through_the_real_engine() {
    let _env = ENV_GUARD.lock().unwrap();
    let rt = tempfile::tempdir().unwrap();
    let runtime_path = rt.path().to_path_buf();
    std::env::set_var("CUBICAL_RUNTIME_DIR", &runtime_path);
    let vault_dir = tempfile::tempdir().unwrap();
    std::fs::write(vault_dir.path().join("E2E.md"), "old body").unwrap();
    let sock = runtime_path.join("attach-e2e-write.sock");

    let (state, _vault_id) = open_advertised(vault_dir.path(), &sock).await;
    let listener = UnixListener::bind(&sock).unwrap();

    let body = "hello from the real engine over the socket\n";

    let server = serve_one(&listener, &state);
    let client = async {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cubical"))
            .env("CUBICAL_RUNTIME_DIR", &runtime_path)
            .arg("--vault")
            .arg(vault_dir.path())
            .args(["write", "E2E.md"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(body.as_bytes()).await.unwrap();
        drop(stdin);
        child.wait_with_output().await.unwrap()
    };
    let (_, out) = tokio::join!(server, client);

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(vault_dir.path().join("E2E.md")).unwrap(),
        body
    );
    std::env::remove_var("CUBICAL_RUNTIME_DIR");
}
