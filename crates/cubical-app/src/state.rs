//! Application state container.
//!
//! `AppState` is plain Rust — no Tauri imports. Tauri stores it via
//! `app.manage(state)`; pure command handlers in `crate::commands` take
//! `&AppState`. The Tauri shim in `lib.rs` is the only place that knows
//! how state is wrapped (`tauri::State<'_, AppState>`).
//!
//! See `docs/migration-touchpoints.md` for the rationale.

/// Top-level application state.
///
/// L0 ships this as essentially empty — vaults, event handles, and other
/// state members land in subsequent L0 sessions as the commands come online.
#[derive(Default)]
pub struct AppState {
    // L0+ will add: vaults: RwLock<HashMap<VaultId, Vault>>, event handles, etc.
}

impl AppState {
    /// Create a fresh `AppState`. Called once at app startup.
    pub fn new() -> Self {
        Self::default()
    }
}
