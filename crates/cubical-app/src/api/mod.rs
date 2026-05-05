//! IPC interface adapter — request/response types and error serialization.
//!
//! Types defined here cross the Lane 1 ↔ Lane 2 boundary. They are framework-free
//! (only `serde` derives, no Tauri-specific decorators) so the same struct
//! definitions survive a future shell migration.
//!
//! See `docs/migration-touchpoints.md` for the boundary inventory.

pub mod types;
