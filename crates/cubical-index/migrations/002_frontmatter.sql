-- Layer 1 frontmatter table. See docs/layer-0-spec.md §7 ("frontmatter
-- (parsed YAML keys for Dataview-style queries) — Layer 1") and
-- docs/architecture/document-model.md §5.1.
--
-- Holds the parsed frontmatter of every tracked file as (key, value)
-- pairs. `value` is JSON-encoded so the column shape is stable
-- regardless of whether the source YAML key was a scalar, list, or
-- nested mapping. Dataview-style queries arrive at L4; this table is
-- the substrate.
--
-- ON DELETE CASCADE means a future `DELETE FROM files WHERE path = ?`
-- (which L0 does NOT do — see §6 of spec, behavior deferred to L3
-- pending-rewrites work) will clean up its frontmatter rows
-- automatically.

CREATE TABLE frontmatter (
    file_path  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    PRIMARY KEY (file_path, key),
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);
CREATE INDEX idx_frontmatter_key ON frontmatter(key);
