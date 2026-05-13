//! `cubical-app` — the Tauri shell.
//!
//! Owns the Lane 1 ↔ Lane 2 IPC boundary. Pulls in every workspace crate and
//! exposes Tauri commands per `docs/layer-0-spec.md` §8.
//!
//! ## Module layout
//!
//! - [`commands`] — pure async command handlers; no Tauri imports.
//! - [`api`] — IPC request/response types; no Tauri imports.
//! - [`state`] — `AppState` definition; no Tauri imports.
//! - [`events`] — Tauri event names, payload types, and emit helpers.
//!   This is the only Tauri-coupled module outside `lib.rs` itself.
//!
//! ## Pattern
//!
//! `#[tauri::command]`-decorated functions in this file are **thin shims**
//! that pull state via `tauri::State<'_, AppState>` and forward to a pure
//! handler in [`commands`]. Pure handlers are unit-testable without a Tauri
//! test harness, and migration off Tauri (if ever needed) means rewriting
//! only the shims. See `docs/migration-touchpoints.md`.
//!
//! In L0 the shell is intentionally empty — it opens a window, wires logging,
//! and proves the dev loop. Commands land in subsequent L0 sessions.

#![forbid(unsafe_code)]

pub mod api;
pub mod commands;
pub mod error;
pub mod events;
pub mod state;

use api::types::{
    CancelVaultScanRequest, CloseVaultRequest, GetCanonicalAstRequest, GetCanonicalAstResponse,
    GetFrontmatterRequest, GetFrontmatterResponse, GetVaultInfoRequest, GetVaultInfoResponse,
    ListFilesRequest, ListFilesResponse, OpenVaultRequest, OpenVaultResponse, ReadFileTextRequest,
    ReadFileTextResponse,
};
use error::CubicalError;
use state::AppState;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

/// Initialize structured logging for the Rust side.
///
/// Called from `main` (desktop entry point) and from any future mobile entry
/// points. Output goes to stderr in dev builds; release builds will eventually
/// rotate into `<vault>/.cubical/cubical.log` (post-L0 work).
fn init_logging() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())
        .init();
}

/// Build and run the Tauri application.
///
/// Mobile entry points should also call this. Currently desktop-only.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    tracing::info!("Cubical starting (Layer 0 bedrock)");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_vault,
            cancel_vault_scan,
            get_vault_info,
            list_files,
            get_frontmatter,
            read_file_text,
            get_canonical_ast,
            close_vault,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ---------------------------------------------------------------------------
// Tauri command shims — three lines each, forwarding to pure handlers in
// `commands::vault`. The shims are the only `#[tauri::command]`-decorated
// functions in the crate; everything below them is Tauri-free.
// ---------------------------------------------------------------------------

/// Tauri shim — see [`commands::vault::open_vault`].
#[tauri::command]
async fn open_vault(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    commands::vault::open_vault(state.inner(), &app, req).await
}

/// Tauri shim — see [`commands::vault::cancel_vault_scan`].
#[tauri::command]
async fn cancel_vault_scan(
    state: tauri::State<'_, AppState>,
    req: CancelVaultScanRequest,
) -> Result<(), CubicalError> {
    commands::vault::cancel_vault_scan(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::get_vault_info`].
#[tauri::command]
async fn get_vault_info(
    state: tauri::State<'_, AppState>,
    req: GetVaultInfoRequest,
) -> Result<GetVaultInfoResponse, CubicalError> {
    commands::vault::get_vault_info(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::list_files`].
#[tauri::command]
async fn list_files(
    state: tauri::State<'_, AppState>,
    req: ListFilesRequest,
) -> Result<ListFilesResponse, CubicalError> {
    commands::vault::list_files(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::get_frontmatter`].
#[tauri::command]
async fn get_frontmatter(
    state: tauri::State<'_, AppState>,
    req: GetFrontmatterRequest,
) -> Result<GetFrontmatterResponse, CubicalError> {
    commands::vault::get_frontmatter(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::read_file_text`].
#[tauri::command]
async fn read_file_text(
    state: tauri::State<'_, AppState>,
    req: ReadFileTextRequest,
) -> Result<ReadFileTextResponse, CubicalError> {
    commands::vault::read_file_text(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::get_canonical_ast`].
#[tauri::command]
async fn get_canonical_ast(
    state: tauri::State<'_, AppState>,
    req: GetCanonicalAstRequest,
) -> Result<GetCanonicalAstResponse, CubicalError> {
    commands::vault::get_canonical_ast(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::close_vault`].
#[tauri::command]
async fn close_vault(
    state: tauri::State<'_, AppState>,
    req: CloseVaultRequest,
) -> Result<(), CubicalError> {
    commands::vault::close_vault(state.inner(), req).await
}
