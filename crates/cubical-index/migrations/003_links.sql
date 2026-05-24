-- Layer 3 wiki-link index. See docs/architecture/document-model.md §5.2
-- ("Resolution is via libSQL's link index, keyed by `file_path` pre-L7")
-- and docs/layer-3-spec.md §2.1.
--
-- One row per wiki-link occurrence. `target_path` is NULL when the link
-- could not be resolved at extraction time; the row is kept so the
-- backlinks UI can surface unresolved links and so re-resolution after
-- a rename can fill it in. `position` is the byte offset of the link's
-- opener in the source file, used for ordering and for context snippets.
--
-- ON DELETE CASCADE on `source_path` means a future `DELETE FROM files`
-- (pending-rewrites territory, Session J) cleans up its link rows.

CREATE TABLE links (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    source_path   TEXT NOT NULL,
    target_raw    TEXT NOT NULL,
    target_path   TEXT,
    anchor_kind   TEXT,
    anchor_value  TEXT,
    display_text  TEXT,
    is_embed      INTEGER NOT NULL DEFAULT 0,
    position      INTEGER NOT NULL,
    FOREIGN KEY (source_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX idx_links_source ON links(source_path);
CREATE INDEX idx_links_target ON links(target_path);
