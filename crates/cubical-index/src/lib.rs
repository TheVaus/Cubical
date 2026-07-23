#![forbid(unsafe_code)]

mod blocks;
mod error;
mod folders;
mod links;
mod migrations;
mod pending;
mod runner;
mod tags;

pub use blocks::{
    block_exists, blocks_for_file, broken_block_refs, replace_block_refs_for_file,
    replace_blocks_for_file, BlockRefRow, BlockRow, BrokenBlockRef,
};
pub use error::IndexError;
pub use folders::{delete_folder, list_folders, sweep_stale_folders, upsert_folder};
pub use links::{
    backlinks_for, files_for_link_query, links_from, links_to, replace_links_for_file, BacklinkRow,
    LinkRow,
};
pub use migrations::{Migration, MIGRATIONS};
pub use pending::{
    delete_pending_for_target, delete_rename_op, enqueue_pending, list_recent_rename_ops,
    pending_count_breakdown, pending_count_for_target, pending_count_total, pending_for_target,
    pending_targets, NewPendingRewrite, PendingRewriteRow, RenameOpRow, RewriteKind,
};
pub use runner::{open_index, IndexConn};
pub use tags::{
    all_tag_paths, files_for_tag_prefix, replace_tags_for_file, tag_paths_for_prefix,
    tags_for_file, TagRow, TagSource,
};
