#![forbid(unsafe_code)]

mod recent_vaults;
mod tauri_sink;

use cubical_engine::api::types::{
    BlockIdAutocompleteRequest, BlockIdAutocompleteResponse, CancelVaultScanRequest,
    CloseVaultRequest, CreateBlockRefRequest, CreateBlockRefResponse, CreateFileAtPathRequest,
    CreateFileAtPathResponse, CreateFileRequest, CreateFileResponse, CreateFolderRequest,
    CreateFolderResponse, DataviewQueryRequest, DataviewResult, DeletePathRequest,
    FlushPendingRewritesForTargetRequest, FlushPendingRewritesRequest,
    FlushPendingRewritesResponse, GetBacklinksRequest, GetBacklinksResponse,
    GetBrokenBlockRefsRequest, GetBrokenBlockRefsResponse, GetCanonicalAstRequest,
    GetCanonicalAstResponse, GetEmbedRequest, GetEmbedResponse, GetFrontmatterRequest,
    GetFrontmatterResponse, GetPendingRewritesBreakdownRequest,
    GetPendingRewritesBreakdownResponse, GetPendingRewritesCountRequest,
    GetPendingRewritesCountResponse, GetPropertyRequest, GetPropertyResponse, GetSettingRequest,
    GetSettingResponse, GetVaultInfoRequest, GetVaultInfoResponse, LinkAutocompleteRequest,
    LinkAutocompleteResponse, ListFilesRequest, ListFilesResponse, ListRecentRenameOpsRequest,
    ListRecentRenameOpsResponse, ListTagsRequest, ListTagsResponse, OpenVaultRequest,
    OpenVaultResponse, QueryTagPageRequest, QueryTagPageResponse, ReadFileTextRequest,
    ReadFileTextResponse, ReloadSettingsRequest, ReloadSettingsResponse, RenameBlockIdRequest,
    RenameBlockIdResponse, RenameFileRequest, RenameFileResponse, RenameFolderRequest,
    RenameFolderResponse, RenameTagRequest, RenameTagResponse, ResolveLinkRequest,
    ResolveLinkResponse, SearchHealthDto, SearchIndexStatusDto, SearchRequest, SearchResponse,
    SearchVaultRequest, SetSettingRequest, SetSettingResponse, TagAutocompleteRequest,
    TagAutocompleteResponse, UndoRenameRequest, UndoRenameResponse, WriteFileTextRequest,
    WriteFileTextResponse,
};
use cubical_engine::commands;
use cubical_engine::error::CubicalError;
use cubical_engine::state::AppState;
use tauri::Manager;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

fn init_logging() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer())
        .init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    tracing::info!("Cubical starting (Layer 0 bedrock)");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .setup(|_app| {
            #[cfg(unix)]
            {
                let handle = _app.handle().clone();
                let sock = cubical_ipc::app_socket_path(std::process::id());
                match bind_socket(&sock) {
                    Ok(listener) => {
                        let _ = BOUND_SOCKET.set(sock.clone());
                        tracing::info!("cubical-ipc socket listening at {}", sock.display());
                        tauri::async_runtime::spawn(async move {
                            serve_socket(handle, listener).await;
                        });
                    }
                    Err(e) => {
                        tracing::warn!(
                            "cubical-ipc socket unavailable at {}: {e} — the CLI will not attach",
                            sock.display()
                        );
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_vault,
            list_recent_vaults,
            remove_recent_vault,
            cancel_vault_scan,
            get_vault_info,
            list_files,
            create_file,
            create_file_at_path,
            create_folder,
            delete_path,
            get_frontmatter,
            read_file_text,
            write_file_text,
            get_setting,
            set_setting,
            get_canonical_ast,
            resolve_link,
            get_embed,
            get_property,
            get_unlinked_mentions,
            link_mention,
            get_backlinks,
            query_tag_page,
            link_autocomplete,
            tag_autocomplete,
            list_tags,
            block_id_autocomplete,
            create_block_ref,
            get_broken_block_refs,
            rename_file,
            rename_folder,
            rename_tag,
            rename_block_id,
            flush_pending_rewrites,
            flush_pending_rewrites_for_target,
            get_pending_rewrites_count,
            get_pending_rewrites_breakdown,
            list_recent_rename_ops,
            undo_rename,
            search,
            search_index_status,
            search_rebuild_index,
            search_get_health,
            dataview_query,
            reload_settings,
            close_vault,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(unix)]
            if matches!(_event, tauri::RunEvent::Exit) {
                remove_bound_socket();
            }
        });
}

#[cfg(unix)]
static BOUND_SOCKET: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

#[cfg(unix)]
fn advertised_socket_path() -> Option<String> {
    BOUND_SOCKET.get().map(|p| p.to_string_lossy().into_owned())
}

#[cfg(not(unix))]
fn advertised_socket_path() -> Option<String> {
    None
}

#[cfg(unix)]
fn remove_bound_socket() {
    if let Some(sock) = BOUND_SOCKET.get() {
        if let Err(e) = std::fs::remove_file(sock) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!("could not remove {}: {e}", sock.display());
            }
        }
    }
}

#[cfg(unix)]
fn bind_socket(sock: &std::path::Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;

    if let Some(parent) = sock.parent() {
        std::fs::create_dir_all(parent)?;
        if let Err(e) = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)) {
            tracing::warn!("could not restrict {}: {e}", parent.display());
        }
    }
    if let Err(e) = std::fs::remove_file(sock) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("could not clear stale socket {}: {e}", sock.display());
        }
    }
    let listener = std::os::unix::net::UnixListener::bind(sock)?;
    std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

#[cfg(unix)]
const ACCEPT_ERROR_BACKOFF: std::time::Duration = std::time::Duration::from_millis(100);

#[cfg(unix)]
async fn serve_socket(app: tauri::AppHandle, listener: std::os::unix::net::UnixListener) {
    use tauri::Manager;

    let listener = match tokio::net::UnixListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("cubical-ipc socket could not join the runtime: {e}");
            return;
        }
    };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                tracing::warn!("cubical-ipc accept failed: {e}");
                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                continue;
            }
        };
        let state = app.state::<AppState>();
        let sink = crate::tauri_sink::TauriEventSink::new(app.clone());
        let served = std::panic::AssertUnwindSafe(cubical_ipc::handle_connection(
            stream,
            state.inner(),
            &sink,
        ));
        match futures_util::FutureExt::catch_unwind(served).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("cubical-ipc connection error: {e}"),
            Err(_) => tracing::error!("cubical-ipc connection handler panicked"),
        }
    }
}

#[tauri::command]
async fn open_vault(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    let vault_path = req.path.to_string_lossy().to_string();
    let resp = commands::vault::open_vault(
        state.inner(),
        std::sync::Arc::new(crate::tauri_sink::TauriEventSink::new(app.clone())),
        req,
        advertised_socket_path(),
    )
    .await?;
    if let Some(store) = recent_vaults_store(&app) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        recent_vaults::record(&store, &vault_path, now);
    }
    Ok(resp)
}

fn recent_vaults_store(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("recent_vaults.json"))
}

#[tauri::command]
fn list_recent_vaults(app: tauri::AppHandle) -> recent_vaults::ListRecentVaultsResponse {
    let vaults = recent_vaults_store(&app)
        .map(|p| recent_vaults::list_with_existence(&p))
        .unwrap_or_default();
    recent_vaults::ListRecentVaultsResponse { vaults }
}

#[tauri::command]
fn remove_recent_vault(app: tauri::AppHandle, req: recent_vaults::RemoveRecentVaultRequest) {
    if let Some(p) = recent_vaults_store(&app) {
        recent_vaults::remove(&p, &req.path);
    }
}

#[tauri::command]
async fn cancel_vault_scan(
    state: tauri::State<'_, AppState>,
    req: CancelVaultScanRequest,
) -> Result<(), CubicalError> {
    commands::vault::cancel_vault_scan(state.inner(), req).await
}

#[tauri::command]
async fn get_vault_info(
    state: tauri::State<'_, AppState>,
    req: GetVaultInfoRequest,
) -> Result<GetVaultInfoResponse, CubicalError> {
    commands::vault::get_vault_info(state.inner(), req).await
}

#[tauri::command]
async fn list_files(
    state: tauri::State<'_, AppState>,
    req: ListFilesRequest,
) -> Result<ListFilesResponse, CubicalError> {
    commands::vault::list_files(state.inner(), req).await
}

#[tauri::command]
async fn create_file(
    state: tauri::State<'_, AppState>,
    req: CreateFileRequest,
) -> Result<CreateFileResponse, CubicalError> {
    commands::vault::create_file(state.inner(), req).await
}

#[tauri::command]
async fn create_file_at_path(
    state: tauri::State<'_, AppState>,
    req: CreateFileAtPathRequest,
) -> Result<CreateFileAtPathResponse, CubicalError> {
    commands::vault::create_file_at_path(state.inner(), req).await
}

#[tauri::command]
async fn create_folder(
    state: tauri::State<'_, AppState>,
    req: CreateFolderRequest,
) -> Result<CreateFolderResponse, CubicalError> {
    commands::vault::create_folder(state.inner(), req).await
}

#[tauri::command]
async fn delete_path(
    state: tauri::State<'_, AppState>,
    req: DeletePathRequest,
) -> Result<(), CubicalError> {
    commands::vault::delete_path(state.inner(), req).await
}

#[tauri::command]
async fn get_frontmatter(
    state: tauri::State<'_, AppState>,
    req: GetFrontmatterRequest,
) -> Result<GetFrontmatterResponse, CubicalError> {
    commands::vault::get_frontmatter(state.inner(), req).await
}

#[tauri::command]
async fn read_file_text(
    state: tauri::State<'_, AppState>,
    req: ReadFileTextRequest,
) -> Result<ReadFileTextResponse, CubicalError> {
    commands::vault::read_file_text(state.inner(), req).await
}

#[tauri::command]
async fn write_file_text(
    state: tauri::State<'_, AppState>,
    req: WriteFileTextRequest,
) -> Result<WriteFileTextResponse, CubicalError> {
    commands::vault::write_file_text(state.inner(), req).await
}

#[tauri::command]
async fn get_setting(
    state: tauri::State<'_, AppState>,
    req: GetSettingRequest,
) -> Result<GetSettingResponse, CubicalError> {
    commands::vault::get_setting(state.inner(), req).await
}

#[tauri::command]
async fn set_setting(
    state: tauri::State<'_, AppState>,
    req: SetSettingRequest,
) -> Result<SetSettingResponse, CubicalError> {
    commands::vault::set_setting(state.inner(), req).await
}

#[tauri::command]
async fn get_canonical_ast(
    state: tauri::State<'_, AppState>,
    req: GetCanonicalAstRequest,
) -> Result<GetCanonicalAstResponse, CubicalError> {
    commands::vault::get_canonical_ast(state.inner(), req).await
}

#[tauri::command]
async fn resolve_link(
    state: tauri::State<'_, AppState>,
    req: ResolveLinkRequest,
) -> Result<ResolveLinkResponse, CubicalError> {
    commands::links::resolve_link(state.inner(), req).await
}

#[tauri::command]
async fn get_embed(
    state: tauri::State<'_, AppState>,
    req: GetEmbedRequest,
) -> Result<GetEmbedResponse, CubicalError> {
    commands::embeds::get_embed(state.inner(), req).await
}

#[tauri::command]
async fn get_property(
    state: tauri::State<'_, AppState>,
    req: GetPropertyRequest,
) -> Result<GetPropertyResponse, CubicalError> {
    commands::property_ref::get_property(state.inner(), req).await
}

#[tauri::command]
async fn get_unlinked_mentions(
    state: tauri::State<'_, AppState>,
    req: cubical_engine::api::types::GetUnlinkedMentionsRequest,
) -> Result<cubical_engine::api::types::GetUnlinkedMentionsResponse, CubicalError> {
    commands::mentions::get_unlinked_mentions(state.inner(), req).await
}

#[tauri::command]
async fn link_mention(
    state: tauri::State<'_, AppState>,
    req: cubical_engine::api::types::LinkMentionRequest,
) -> Result<cubical_engine::api::types::LinkMentionResponse, CubicalError> {
    commands::mentions::link_mention(state.inner(), req).await
}

#[tauri::command]
async fn get_backlinks(
    state: tauri::State<'_, AppState>,
    req: GetBacklinksRequest,
) -> Result<GetBacklinksResponse, CubicalError> {
    commands::backlinks::get_backlinks(state.inner(), req).await
}

#[tauri::command]
async fn query_tag_page(
    state: tauri::State<'_, AppState>,
    req: QueryTagPageRequest,
) -> Result<QueryTagPageResponse, CubicalError> {
    commands::tags::query_tag_page(state.inner(), req).await
}

#[tauri::command]
async fn link_autocomplete(
    state: tauri::State<'_, AppState>,
    req: LinkAutocompleteRequest,
) -> Result<LinkAutocompleteResponse, CubicalError> {
    commands::autocomplete::link_autocomplete(state.inner(), req).await
}

#[tauri::command]
async fn tag_autocomplete(
    state: tauri::State<'_, AppState>,
    req: TagAutocompleteRequest,
) -> Result<TagAutocompleteResponse, CubicalError> {
    commands::autocomplete::tag_autocomplete(state.inner(), req).await
}

#[tauri::command]
async fn list_tags(
    state: tauri::State<'_, AppState>,
    req: ListTagsRequest,
) -> Result<ListTagsResponse, CubicalError> {
    commands::autocomplete::list_tags(state.inner(), req).await
}

#[tauri::command]
async fn block_id_autocomplete(
    state: tauri::State<'_, AppState>,
    req: BlockIdAutocompleteRequest,
) -> Result<BlockIdAutocompleteResponse, CubicalError> {
    commands::autocomplete::block_id_autocomplete(state.inner(), req).await
}

#[tauri::command]
async fn create_block_ref(
    state: tauri::State<'_, AppState>,
    req: CreateBlockRefRequest,
) -> Result<CreateBlockRefResponse, CubicalError> {
    commands::blocks::create_block_ref(state.inner(), req).await
}

#[tauri::command]
async fn get_broken_block_refs(
    state: tauri::State<'_, AppState>,
    req: GetBrokenBlockRefsRequest,
) -> Result<GetBrokenBlockRefsResponse, CubicalError> {
    commands::blocks::get_broken_block_refs(state.inner(), req).await
}

#[tauri::command]
async fn rename_file(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameFileRequest,
) -> Result<RenameFileResponse, CubicalError> {
    commands::rename::rename_file(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn rename_folder(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameFolderRequest,
) -> Result<RenameFolderResponse, CubicalError> {
    commands::rename::rename_folder(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn rename_tag(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameTagRequest,
) -> Result<RenameTagResponse, CubicalError> {
    commands::rename::rename_tag(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn rename_block_id(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: RenameBlockIdRequest,
) -> Result<RenameBlockIdResponse, CubicalError> {
    commands::rename::rename_block_id(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn flush_pending_rewrites(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: FlushPendingRewritesRequest,
) -> Result<FlushPendingRewritesResponse, CubicalError> {
    commands::rename::flush_pending_rewrites(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn flush_pending_rewrites_for_target(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: FlushPendingRewritesForTargetRequest,
) -> Result<FlushPendingRewritesResponse, CubicalError> {
    commands::rename::flush_pending_rewrites_for_target(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn get_pending_rewrites_count(
    state: tauri::State<'_, AppState>,
    req: GetPendingRewritesCountRequest,
) -> Result<GetPendingRewritesCountResponse, CubicalError> {
    commands::rename::get_pending_rewrites_count(state.inner(), req).await
}

#[tauri::command]
async fn get_pending_rewrites_breakdown(
    state: tauri::State<'_, AppState>,
    req: GetPendingRewritesBreakdownRequest,
) -> Result<GetPendingRewritesBreakdownResponse, CubicalError> {
    commands::rename::get_pending_rewrites_breakdown(state.inner(), req).await
}

#[tauri::command]
async fn list_recent_rename_ops(
    state: tauri::State<'_, AppState>,
    req: ListRecentRenameOpsRequest,
) -> Result<ListRecentRenameOpsResponse, CubicalError> {
    commands::rename::list_recent_rename_ops(state.inner(), req).await
}

#[tauri::command]
async fn undo_rename(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: UndoRenameRequest,
) -> Result<UndoRenameResponse, CubicalError> {
    commands::rename::undo_rename(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}

#[tauri::command]
async fn search(
    state: tauri::State<'_, AppState>,
    req: SearchRequest,
) -> Result<SearchResponse, CubicalError> {
    commands::search::search(state.inner(), req).await
}

#[tauri::command]
async fn search_index_status(
    state: tauri::State<'_, AppState>,
    req: SearchVaultRequest,
) -> Result<SearchIndexStatusDto, CubicalError> {
    commands::search::search_index_status(state.inner(), req).await
}

#[tauri::command]
async fn search_rebuild_index(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: SearchVaultRequest,
) -> Result<(), CubicalError> {
    commands::search::search_rebuild_index(
        state.inner(),
        std::sync::Arc::new(crate::tauri_sink::TauriEventSink::new(app)),
        req,
    )
    .await
}

#[tauri::command]
async fn search_get_health(
    state: tauri::State<'_, AppState>,
    req: SearchVaultRequest,
) -> Result<SearchHealthDto, CubicalError> {
    commands::search::search_get_health(state.inner(), req).await
}

#[tauri::command]
async fn dataview_query(
    state: tauri::State<'_, AppState>,
    req: DataviewQueryRequest,
) -> Result<DataviewResult, CubicalError> {
    commands::dataview::dataview_query(state.inner(), req).await
}

#[tauri::command]
async fn reload_settings(
    state: tauri::State<'_, AppState>,
    req: ReloadSettingsRequest,
) -> Result<ReloadSettingsResponse, CubicalError> {
    commands::vault::reload_settings(state.inner(), req).await
}

#[tauri::command]
async fn close_vault(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    req: CloseVaultRequest,
) -> Result<(), CubicalError> {
    commands::vault::close_vault(
        state.inner(),
        &crate::tauri_sink::TauriEventSink::new(app),
        req,
    )
    .await
}
