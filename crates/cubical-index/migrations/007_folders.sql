-- Folder tracking — lets empty directories appear in the file tree.
--
-- The file tree is otherwise derived from `files` paths, so a directory
-- with no files in it has no representation. This table records every
-- directory in the vault (vault-relative path, no leading/trailing
-- slash; the vault root is NOT stored). It is derived, rebuildable state:
-- the on-disk directory is the source of truth, re-discovered by every
-- scan. `last_seen` carries the staleness sweep (a folder deleted while
-- the app wasn't watching is dropped on the next scan), mirroring the
-- `files` table's own sweep.
--
-- No FK: folders are a flat path list, not a parent of `files` rows.

CREATE TABLE folders (
    path        TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    last_seen   INTEGER NOT NULL
);
