-- Layer 3 block references. See docs/architecture/document-model.md §5.3
-- and docs/layer-3-spec.md §2.7.
--
-- `blocks`: one row per `^block-id` token found in a file's source.
-- `position_hint` is the byte offset of the start of the line carrying
-- the id (for ordering / locating); `last_modified` is a unix seconds
-- stamp written at refresh time. `(file_path, block_id)` is unique per
-- the per-file scope rule.
--
-- `block_refs`: one row per RESOLVED block-anchored wiki-link
-- (`[[target#^id]]`). Derived from the `links` table during scan Pass 2
-- and on watcher edits. A ref is "broken" when no `blocks` row matches
-- (target_file_path, target_block_id) — computed at query time, not
-- stored.
--
-- ON DELETE CASCADE on the source/owning file path means a future
-- `DELETE FROM files` (pending-rewrites territory, Session J) cleans up.

CREATE TABLE blocks (
    file_path     TEXT NOT NULL,
    block_id      TEXT NOT NULL,
    position_hint INTEGER NOT NULL,
    last_modified INTEGER NOT NULL,
    PRIMARY KEY (file_path, block_id),
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE TABLE block_refs (
    source_file_path TEXT NOT NULL,
    target_file_path TEXT NOT NULL,
    target_block_id  TEXT NOT NULL,
    FOREIGN KEY (source_file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX idx_blocks_lookup ON blocks(file_path, block_id);
CREATE INDEX idx_block_refs_source ON block_refs(source_file_path);
CREATE INDEX idx_block_refs_target ON block_refs(target_file_path, target_block_id);
