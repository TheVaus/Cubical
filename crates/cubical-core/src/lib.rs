//! `cubical-core` — the load-bearing concrete.
//!
//! Vault management, the file watcher, the polymorphic file-type registry, and
//! frontmatter I/O live here. This crate has no Tauri dependency and must remain
//! testable in isolation: the eventual plugin SDK and any headless tooling will
//! consume it.
//!
//! See `docs/layer-0-spec.md` for the L0 surface.

#![forbid(unsafe_code)]
#![warn(missing_docs)]

pub mod file_type;
pub mod vault;

pub use file_type::{
    sha256_bytes_hex, BinaryHandler, FileTypeError, FileTypeHandler, FileTypeRegistry,
    MarkdownHandler,
};
pub use vault::{
    atomic_write, refresh_frontmatter, refresh_links, refresh_tags, scan, start_watcher,
    ScanProgress, Vault, VaultError, WatchEvent, WatcherHandle,
};
