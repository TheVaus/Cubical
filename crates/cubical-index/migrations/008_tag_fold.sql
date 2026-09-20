-- Layer 3 tag matching moves off SQL case folding. See
-- docs/architecture/document-model.md §5.6.
--
-- `tag_path` still stores the case the user wrote, for display. What a
-- query compares is `tag_fold`, written by `cubical_index::fold_name` --
-- the same fold the vault uses for note names, for the reason
-- docs/implementation/engine-ipc.md gives under "Case-insensitive means
-- one function, everywhere".
--
-- Matching by range (`tag_fold = ?` or `tag_fold >= ? AND tag_fold < ?`)
-- rather than by LIKE is what lets `idx_tags_fold` be read at all: a
-- BINARY index cannot serve a LIKE pattern, and a fold applied to the
-- column could not use an index either.
--
-- Existing rows land with the empty-string default. `tag_path` is never
-- empty, so an empty `tag_fold` marks a row the backfill in
-- `runner::backfill_tag_folds` has yet to rewrite.

ALTER TABLE tags ADD COLUMN tag_fold TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_tags_fold ON tags(tag_fold);
