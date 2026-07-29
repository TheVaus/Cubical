use std::sync::Arc;

use cubical_engine::events::NoopEventSink;
use cubical_engine::state::AppState;
use cubical_ipc::parse::{to_command, Cli, Parser};
use cubical_ipc::render_to;

async fn open(root: &std::path::Path) -> (AppState, String) {
    use cubical_engine::api::types::{GetVaultInfoRequest, OpenVaultRequest, ScanStatus};
    use cubical_engine::commands::vault;
    let state = AppState::new();
    let sink: Arc<dyn cubical_engine::events::EventSink> = Arc::new(NoopEventSink);
    let opened = vault::open_vault(
        &state,
        Arc::clone(&sink),
        OpenVaultRequest {
            path: root.to_path_buf(),
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
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    (state, opened.vault_id)
}

async fn console_run(
    state: &AppState,
    vault_id: &str,
    root: &std::path::Path,
    line: &str,
) -> (String, i32) {
    let sink = NoopEventSink;
    let tokens: Vec<String> = shell_words::split(line).unwrap();
    let cli = Cli::try_parse_from(std::iter::once("cubical".to_string()).chain(tokens)).unwrap();
    let cmd = to_command(cli.cmd, root, None).unwrap();
    let outcome = cubical_ipc::dispatch(vault_id, cmd, state, &sink)
        .await
        .unwrap();
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
    let (console_out, _) = console_run(&state, &vid, tmp.path(), "list").await;
    let sink = NoopEventSink;
    let cli = Cli::try_parse_from(["cubical", "list"]).unwrap();
    let cmd = to_command(cli.cmd, tmp.path(), None).unwrap();
    let outcome = cubical_ipc::dispatch(&vid, cmd, &state, &sink)
        .await
        .unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    render_to(&outcome, false, &mut out, &mut err);
    assert_eq!(console_out, String::from_utf8(out).unwrap());
    assert!(console_out.contains("A.md") && console_out.contains("B.md"));
}
