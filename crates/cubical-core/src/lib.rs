#![forbid(unsafe_code)]

pub mod file_type;
pub mod vault;

pub use file_type::{
    sha256_bytes_hex, BinaryHandler, FileTypeError, FileTypeHandler, FileTypeRegistry,
    MarkdownHandler,
};
pub use vault::{
    atomic_write, refresh_block_refs_for_file, refresh_blocks, refresh_frontmatter, refresh_links,
    refresh_tags, scan, start_watcher, ScanProgress, Vault, VaultError, WatchEvent, WatcherHandle,
};
