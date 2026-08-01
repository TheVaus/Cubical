use cubical_engine::error::CubicalError;
use cubical_engine::state::AppState;
use cubical_ipc::agent_instructions as core;

#[derive(serde::Deserialize)]
pub struct AgentInstructionsRequest {
    vault_id: String,
}

#[tauri::command]
pub async fn agent_instructions_status(
    state: tauri::State<'_, AppState>,
    req: AgentInstructionsRequest,
) -> Result<core::AgentInstructionsStatus, CubicalError> {
    core::status(state.inner(), &req.vault_id).await
}

#[tauri::command]
pub async fn agent_instructions_accept(
    state: tauri::State<'_, AppState>,
    req: AgentInstructionsRequest,
) -> Result<core::AgentInstructionsAccepted, CubicalError> {
    core::accept(state.inner(), &req.vault_id).await
}

#[tauri::command]
pub async fn agent_instructions_decline(
    state: tauri::State<'_, AppState>,
    req: AgentInstructionsRequest,
) -> Result<(), CubicalError> {
    core::decline(state.inner(), &req.vault_id).await
}
