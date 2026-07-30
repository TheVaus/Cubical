use std::sync::Arc;

use cubical_app::run_console_line;
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

#[tokio::test]
async fn new_note_creates_the_file_on_disk() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "new note --at Smoke.md").await;
    assert_eq!(result.code, 0);
    assert!(tmp.path().join("Smoke.md").exists());
}

#[tokio::test]
async fn console_and_cli_pipelines_agree_on_list() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("A.md"), "# A").unwrap();
    std::fs::write(tmp.path().join("B.md"), "# B").unwrap();
    let (state, vid) = open(tmp.path()).await;

    let console_result = run_console_line(&state, &NoopEventSink, &vid, "list").await;

    let cli = Cli::try_parse_from(["cubical", "list"]).unwrap();
    let cmd = to_command(cli.cmd, tmp.path(), None).unwrap();
    let outcome = cubical_ipc::dispatch(&vid, cmd, &state, &NoopEventSink)
        .await
        .unwrap();
    let (mut out, mut err) = (Vec::new(), Vec::new());
    render_to(&outcome, false, &mut out, &mut err);
    let cli_stdout = String::from_utf8(out).unwrap();

    assert_eq!(console_result.stdout, cli_stdout);
    assert!(console_result.stdout.contains("A.md") && console_result.stdout.contains("B.md"));
}

#[tokio::test]
async fn reject_vault_flag_long_form() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "--vault X list").await;
    assert_eq!(result.code, 2);
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn reject_vault_flag_equals_form() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "--vault=X list").await;
    assert_eq!(result.code, 2);
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn reject_write_needs_body() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("A.md"), "old").unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "write A.md").await;
    assert_eq!(result.code, 1);
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn reject_empty_line() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "").await;
    assert_eq!(result.code, 2);
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn reject_whitespace_only_line() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "   ").await;
    assert_eq!(result.code, 2);
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn reject_unknown_subcommand_captures_clap_output() {
    let tmp = tempfile::tempdir().unwrap();
    let (state, vid) = open(tmp.path()).await;
    let result = run_console_line(&state, &NoopEventSink, &vid, "bogus").await;
    assert_eq!(result.code, 2);
    assert!(result.stdout.is_empty());
    assert!(!result.stderr.is_empty());
}

#[tokio::test]
async fn leading_cubical_token_is_stripped() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("A.md"), "# A").unwrap();
    let (state, vid) = open(tmp.path()).await;

    let with_prefix = run_console_line(&state, &NoopEventSink, &vid, "cubical list").await;
    let without_prefix = run_console_line(&state, &NoopEventSink, &vid, "list").await;

    assert_eq!(with_prefix.code, without_prefix.code);
    assert_eq!(with_prefix.stdout, without_prefix.stdout);
    assert_eq!(with_prefix.stderr, without_prefix.stderr);
}
