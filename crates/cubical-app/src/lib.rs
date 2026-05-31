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
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse, CancelVaultScanRequest,
    CloseVaultRequest, CreateBlockRefRequest, CreateBlockRefResponse, GetBacklinksRequest,
    GetBacklinksResponse, GetBrokenBlockRefsRequest, GetBrokenBlockRefsResponse,
    GetCanonicalAstRequest, GetCanonicalAstResponse, GetEmbedRequest, GetEmbedResponse,
    GetFrontmatterRequest, GetFrontmatterResponse, GetSettingRequest, GetSettingResponse,
    GetVaultInfoRequest, GetVaultInfoResponse, LinkAutocompleteRequest, LinkAutocompleteResponse,
    ListFilesRequest, ListFilesResponse, OpenVaultRequest, OpenVaultResponse, QueryTagPageRequest,
    QueryTagPageResponse, ReadFileTextRequest, ReadFileTextResponse, ResolveLinkRequest,
    ResolveLinkResponse, SetSettingRequest, SetSettingResponse, TagAutocompleteRequest,
    TagAutocompleteResponse, WriteFileTextRequest, WriteFileTextResponse,
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
            write_file_text,
            get_setting,
            set_setting,
            get_canonical_ast,
            resolve_link,
            get_embed,
            get_unlinked_mentions,
            link_mention,
            get_backlinks,
            query_tag_page,
            link_autocomplete,
            tag_autocomplete,
            block_id_autocomplete,
            create_block_ref,
            get_broken_block_refs,
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

/// Tauri shim — see [`commands::vault::write_file_text`].
#[tauri::command]
async fn write_file_text(
    state: tauri::State<'_, AppState>,
    req: WriteFileTextRequest,
) -> Result<WriteFileTextResponse, CubicalError> {
    commands::vault::write_file_text(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::get_setting`].
#[tauri::command]
async fn get_setting(
    state: tauri::State<'_, AppState>,
    req: GetSettingRequest,
) -> Result<GetSettingResponse, CubicalError> {
    commands::vault::get_setting(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::set_setting`].
#[tauri::command]
async fn set_setting(
    state: tauri::State<'_, AppState>,
    req: SetSettingRequest,
) -> Result<SetSettingResponse, CubicalError> {
    commands::vault::set_setting(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::get_canonical_ast`].
#[tauri::command]
async fn get_canonical_ast(
    state: tauri::State<'_, AppState>,
    req: GetCanonicalAstRequest,
) -> Result<GetCanonicalAstResponse, CubicalError> {
    commands::vault::get_canonical_ast(state.inner(), req).await
}

/// Tauri shim — see [`commands::links::resolve_link`].
#[tauri::command]
async fn resolve_link(
    state: tauri::State<'_, AppState>,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, CubicalError> {
    commands::links::resolve_link(state.inner(), req).await
}

/// Tauri shim — see [`commands::embeds::get_embed`].
#[tauri::command]
async fn get_embed(
    state: tauri::State<'_, AppState>,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, CubicalError> {
    commands::embeds::get_embed(state.inner(), req).await
}

/// Tauri shim — see [`commands::mentions::get_unlinked_mentions`].
#[tauri::command]
async fn get_unlinked_mentions(
    state: tauri::State<'_, AppState>,
    req: crate::api::types::GetUnlinkedMentionsRequest,
) -> Result<crate::api::types::GetUnlinkedMentionsResponse, CubicalError> {
    commands::mentions::get_unlinked_mentions(state.inner(), req).await
}

/// Tauri shim — see [`commands::mentions::link_mention`].
#[tauri::command]
async fn link_mention(
    state: tauri::State<'_, AppState>,
    req: crate::api::types::LinkMentionRequest,
) -> Result<crate::api::types::LinkMentionResponse, CubicalError> {
    commands::mentions::link_mention(state.inner(), req).await
}

/// Tauri shim — see [`commands::backlinks::get_backlinks`].
#[tauri::command]
async fn get_backlinks(
    state: tauri::State<'_, AppState>,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, CubicalError> {
    commands::backlinks::get_backlinks(state.inner(), req).await
}

/// Tauri shim — see [`commands::tags::query_tag_page`].
#[tauri::command]
async fn query_tag_page(
    state: tauri::State<'_, AppState>,
    req: QueryTagPageRequest,
) -> Result<QueryTagPageResponse, CubicalError> {
    commands::tags::query_tag_page(state.inner(), req).await
}

/// Tauri shim — see [`commands::autocomplete::link_autocomplete`].
#[tauri::command]
async fn link_autocomplete(
    state: tauri::State<'_, AppState>,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, CubicalError> {
    commands::autocomplete::link_autocomplete(state.inner(), req).await
}

/// Tauri shim — see [`commands::autocomplete::tag_autocomplete`].
#[tauri::command]
async fn tag_autocomplete(
    state: tauri::State<'_, AppState>,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, CubicalError> {
    commands::autocomplete::tag_autocomplete(state.inner(), req).await
}

/// Tauri shim — see [`commands::autocomplete::block_id_autocomplete`].
#[tauri::command]
async fn block_id_autocomplete(
    state: tauri::State<'_, AppState>,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, CubicalError> {
    commands::autocomplete::block_id_autocomplete(state.inner(), req).await
}

/// Tauri shim — see [`commands::blocks::create_block_ref`].
#[tauri::command]
async fn create_block_ref(
    state: tauri::State<'_, AppState>,
    req: CreateBlockRefRequest,
) -> Result<CreateBlockRefResponse, CubicalError> {
    commands::blocks::create_block_ref(state.inner(), req).await
}

/// Tauri shim — see [`commands::blocks::get_broken_block_refs`].
#[tauri::command]
async fn get_broken_block_refs(
    state: tauri::State<'_, AppState>,
    req: GetBrokenBlockRefsRequest,
) -> Result<GetBrokenBlockRefsResponse, CubicalError> {
    commands::blocks::get_broken_block_refs(state.inner(), req).await
}

/// Tauri shim — see [`commands::vault::close_vault`].
#[tauri::command]
async fn close_vault(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: CloseVaultRequest,
) -> Result<(), CubicalError> {
    commands::vault::close_vault(state.inner(), &app, req).await
}
