-- L3 Session J — Pending Rewrites Cache.
-- See docs/architecture/document-model.md §5.7 and docs/layer-3-spec.md §2.10.
--
-- One row per deferred per-file token rewrite, grouped by rename_op_id
-- so undo deletes exactly the rows a single rename enqueued.
-- No FK on target_file → files(path): a row targeting a since-deleted
-- file silently drops on flush rather than blocking the migration runner.

CREATE TABLE pending_rewrites (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    target_file     TEXT NOT NULL,
    rewrite_kind    TEXT NOT NULL,         -- 'wiki_link' | 'tag' | 'block_ref'
    old_token       TEXT NOT NULL,
    new_token       TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    rename_op_id    INTEGER NOT NULL
);
CREATE INDEX idx_pending_target ON pending_rewrites(target_file);
CREATE INDEX idx_pending_op     ON pending_rewrites(rename_op_id);
