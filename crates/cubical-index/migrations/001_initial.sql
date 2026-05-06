-- Layer 0 initial schema. See docs/layer-0-spec.md §7.
--
-- This migration creates the four bedrock tables:
--   - schema_version : linear migration version tracker
--   - files          : tracked vault files, identified by relative path
--   - config         : vault-scoped key/value app config (unused in L0)
--   - audit_log      : ring-buffered diagnostic log
--
-- Tables reserved for later layers (frontmatter, wiki_links, block_refs,
-- blocks, tags, pending_rewrites, tantivy_meta, crdt_*, time_machine_*,
-- embeddings) are intentionally NOT created here.

-- Schema versioning. version = 1 in Layer 0.
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY
);
INSERT INTO schema_version (version) VALUES (1);

-- The vault's tracked files. Identified by path in L0; gains a nullable
-- `cubical_id` column at L7 when frontmatter UUIDs are introduced.
CREATE TABLE files (
    path          TEXT PRIMARY KEY,           -- relative to vault root
    type_id       TEXT NOT NULL,              -- file-type handler id
    size_bytes    INTEGER NOT NULL,
    mtime_unix    INTEGER NOT NULL,           -- last modification time
    content_hash  TEXT NOT NULL,              -- SHA-256 hex; used for change detection
    inode         INTEGER,                    -- nullable; used for rename heuristics on close-time scans
    last_seen     INTEGER NOT NULL,           -- unix ts of last vault scan that saw this
    created_at    INTEGER NOT NULL,           -- unix ts of first scan
    updated_at    INTEGER NOT NULL            -- unix ts of last metadata update
);
CREATE INDEX idx_files_type  ON files(type_id);
CREATE INDEX idx_files_inode ON files(inode);

-- App-level config (vault-scoped). Used for things like "last opened tab",
-- "user-set asset folder if ever made configurable", etc. Layer 0 leaves empty.
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Audit log of significant Cubical operations. Useful for debugging.
-- Auto-pruned to 10000 most recent rows.
CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    level     TEXT NOT NULL,                  -- 'info' | 'warn' | 'error'
    category  TEXT NOT NULL,                  -- 'scan' | 'watcher' | 'uuid' | 'ipc' | ...
    message   TEXT NOT NULL,
    detail    TEXT                            -- optional JSON blob
);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
