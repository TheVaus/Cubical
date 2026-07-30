use cubical_engine::state::AppState;

#[derive(serde::Deserialize)]
pub struct ConsoleExecRequest {
    vault_id: String,
    line: String,
}

#[derive(Debug, serde::Serialize)]
pub struct ConsoleResult {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

pub async fn run_console_line(
    state: &AppState,
    sink: &dyn cubical_engine::events::EventSink,
    vault_id: &str,
    line: &str,
) -> ConsoleResult {
    use cubical_engine::api::types::GetVaultInfoRequest;
    use cubical_ipc::parse::{needs_body, to_command, Cli, Parser};

    let tokens = match shell_words::split(line) {
        Ok(t) => t,
        Err(e) => {
            return ConsoleResult {
                stdout: String::new(),
                stderr: format!("error: unbalanced quotes: {e}"),
                code: 2,
            }
        }
    };
    let mut tokens: Vec<String> = tokens;
    if tokens.first().map(String::as_str) == Some("cubical") {
        tokens.remove(0);
    }
    if tokens.is_empty() {
        return ConsoleResult {
            stdout: String::new(),
            stderr: "the console runs cubical verbs; write and --vault are unavailable here"
                .to_string(),
            code: 2,
        };
    }
    if tokens
        .iter()
        .any(|t| t == "--vault" || t.starts_with("--vault="))
    {
        return ConsoleResult {
            stdout: String::new(),
            stderr: "error: --vault is not available in the console (bound to the open vault)"
                .to_string(),
            code: 2,
        };
    }

    let cli = match Cli::try_parse_from(std::iter::once("cubical".to_string()).chain(tokens)) {
        Ok(cli) => cli,
        Err(e) => {
            let code = e.exit_code();
            let rendered = e.render().to_string();
            return if code == 0 {
                ConsoleResult {
                    stdout: rendered,
                    stderr: String::new(),
                    code,
                }
            } else {
                ConsoleResult {
                    stdout: String::new(),
                    stderr: rendered,
                    code,
                }
            };
        }
    };

    if needs_body(&cli.cmd) {
        return ConsoleResult {
            stdout: String::new(),
            stderr:
                "write is not available in the console — use the editor, or pipe from a terminal"
                    .to_string(),
            code: 1,
        };
    }

    let info = match cubical_engine::commands::vault::get_vault_info(
        state,
        GetVaultInfoRequest {
            vault_id: vault_id.to_string(),
        },
    )
    .await
    {
        Ok(info) => info,
        Err(e) => {
            return ConsoleResult {
                stdout: String::new(),
                stderr: format!("error: {e}"),
                code: 1,
            }
        }
    };
    let vault_root = info.path;

    let command = match to_command(cli.cmd, &vault_root, None) {
        Ok(command) => command,
        Err(e) => {
            return ConsoleResult {
                stdout: String::new(),
                stderr: format!("error: {e:#}"),
                code: 1,
            }
        }
    };

    let outcome = cubical_ipc::dispatch(vault_id, command, state, sink).await;

    let (mut out, mut err) = (Vec::new(), Vec::new());
    let code = match &outcome {
        Ok(o) => cubical_ipc::render_to(o, cli.json, &mut out, &mut err),
        Err(e) => {
            let _ = std::io::Write::write_all(&mut err, format!("error: {e}\n").as_bytes());
            1
        }
    };
    ConsoleResult {
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        code,
    }
}

#[tauri::command]
pub async fn console_exec(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: ConsoleExecRequest,
) -> Result<ConsoleResult, String> {
    let sink = crate::tauri_sink::TauriEventSink::new(app);
    Ok(run_console_line(state.inner(), &sink, &req.vault_id, &req.line).await)
}
