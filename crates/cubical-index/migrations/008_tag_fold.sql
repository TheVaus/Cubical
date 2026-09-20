-- Layer 3 tag matching moves off SQL case folding. See
-- docs/architecture/document-model.md §5.6.
--
-- `tag_path` still stores the case the user wrote, for display. What a
-- query compares is `tag_fold`, written by `cubical_index::fold_name` —
-- the same fold the vault uses for note names. SQL `LOWER()` in libSQL
-- is ASCII-only, so `#CAFÉ` folded there stayed `cafÉ` and never matched
-- a `#café` query; it also defeated `idx_tags_path`, because a function
-- of the column cannot use an index on the column.
--
-- Existing rows land with the empty-string default. `tag_path` is never
-- empty, so an empty `tag_fold` marks a row the backfill in
-- `runner::backfill_tag_folds` has yet to rewrite.

ALTER TABLE tags ADD COLUMN tag_fold TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_tags_fold ON tags(tag_fold);
