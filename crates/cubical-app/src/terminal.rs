mod reap;
mod registry;
mod session;
mod spawn;

pub use registry::TerminalRegistry;

use base64::Engine as _;
use cubical_engine::state::AppState;
use registry::Entry;
use spawn::OpenSpec;
use tauri::ipc::Channel;

#[derive(Clone, serde::Serialize)]
pub struct TerminalChunk {
    pub base64: String,
}

impl TerminalChunk {
    fn from_bytes(bytes: &[u8]) -> Self {
        Self {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }
    }

    #[cfg(test)]
    fn decode(&self) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(&self.base64)
            .unwrap_or_default()
    }
}

#[derive(serde::Serialize)]
pub struct TerminalOpenResponse {
    pub terminal_id: String,
}

#[tauri::command]
pub async fn terminal_open(
    state: tauri::State<'_, AppState>,
    registry: tauri::State<'_, TerminalRegistry>,
    vault_id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<TerminalChunk>,
) -> Result<TerminalOpenResponse, String> {
    let info = cubical_engine::commands::vault::get_vault_info(
        state.inner(),
        cubical_engine::api::types::GetVaultInfoRequest {
            vault_id: vault_id.clone(),
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    let spec = OpenSpec::shell(info.path, cols, rows);
    let sink = Box::new(move |chunk| on_output.send(chunk).is_ok());
    let terminal_id = registry.open(&vault_id, spec, sink)?;
    Ok(TerminalOpenResponse { terminal_id })
}

#[tauri::command]
pub async fn terminal_write(
    registry: tauri::State<'_, TerminalRegistry>,
    terminal_id: String,
    data: String,
) -> Result<(), String> {
    registry.write(&terminal_id, data.as_bytes())
}

#[tauri::command]
pub async fn terminal_resize(
    registry: tauri::State<'_, TerminalRegistry>,
    terminal_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    registry.resize(&terminal_id, cols, rows)
}

#[tauri::command]
pub async fn terminal_close(
    registry: tauri::State<'_, TerminalRegistry>,
    terminal_id: String,
) -> Result<(), String> {
    reap(registry.take(&terminal_id).into_iter().collect()).await;
    Ok(())
}

pub async fn reap_vault(registry: &TerminalRegistry, vault_id: &str) {
    reap(registry.drain_vault(vault_id)).await;
}

pub async fn reap_all(registry: &TerminalRegistry) {
    reap(registry.drain_all()).await;
}

pub fn reap_all_blocking(registry: &TerminalRegistry) {
    drop(registry.drain_all());
}

async fn reap(entries: Vec<Entry>) {
    if entries.is_empty() {
        return;
    }
    if tokio::task::spawn_blocking(move || drop(entries))
        .await
        .is_err()
    {
        tracing::error!("terminal reaping task panicked");
    }
}
