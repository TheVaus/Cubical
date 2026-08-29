#![forbid(unsafe_code)]

pub mod file_type;
pub mod vault;

pub use file_type::{
    sha256_bytes_hex, BinaryHandler, FileTypeError, FileTypeHandler, FileTypeRegistry,
    MarkdownHandler,
};
pub use vault::{
    atomic_write, parse_off_executor, refresh_block_refs_for_file, refresh_blocks,
    refresh_frontmatter, refresh_frontmatter_with_doc, refresh_links, refresh_links_with_doc,
    refresh_tags, refresh_tags_with_doc, scan, start_watcher, ScanOutcome, ScanProgress,
    VanishedFile, Vault, VaultError, WatchEvent, WatcherHandle,
};
