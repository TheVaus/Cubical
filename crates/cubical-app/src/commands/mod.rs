//! Pure async command handlers — no Tauri imports.
//!
//! Each submodule defines handlers as plain async functions taking `&AppState`
//! and a typed request, returning `Result<Response, CubicalError>`. The Tauri
//! shims in `crate::lib` are 3-line forwarders that pull state via
//! `tauri::State` and call into these handlers.
//!
//! Pattern rationale:
//! - **Testability:** handlers are unit-testable without booting Tauri.
//! - **Migration:** if the shell is ever swapped, only the shims rewrite.
//!
//! See `docs/migration-touchpoints.md` and `docs/layer-0-spec.md` §8.

// L0 ships this as a stub. Real commands land in subsequent L0 sessions:
//   pub mod vault; // open_vault, get_vault_info, list_files, close_vault, cancel_vault_scan
