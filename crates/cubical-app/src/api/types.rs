//! Request and response types for IPC commands.
//!
//! Plain `serde` structs — no Tauri imports, no Tauri-specific decorators.
//! These cross the Lane 1 ↔ Lane 2 boundary and survive a future shell
//! migration unchanged.
//!
//! L0 ships this as a stub. Real types land alongside their commands in
//! subsequent L0 sessions per `docs/layer-0-spec.md` §8.

// L0+ will define: OpenVaultRequest, OpenVaultResponse, GetVaultInfoRequest,
// GetVaultInfoResponse, ListFilesRequest, ListFilesResponse, FileEntry,
// CloseVaultRequest, CancelVaultScanRequest, etc.
