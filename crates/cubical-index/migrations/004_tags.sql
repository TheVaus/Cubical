-- Layer 3 tag index. See docs/architecture/document-model.md §5.6
-- ("tags table") and docs/layer-3-spec.md §2.4.
--
-- One row per (file, tag, source) triple. `source` distinguishes the
-- declaration site: `'inline'` for `#tag` tokens in the body,
-- `'frontmatter'` for entries in the YAML `tags:` list. Both sources
-- feed the same logical index so virtual tag pages (Session E) treat
-- them uniformly.
--
-- `tag_path` is stored with its case as written. Case-insensitive
-- matching is the query-layer's job (`WHERE LOWER(tag_path) = LOWER(?)`)
-- so we don't lose the user's preferred casing for display in tag
-- pages and autocomplete.
--
-- ON DELETE CASCADE on `file_path` means a future `DELETE FROM files`
-- (pending-rewrites territory, Session J) cleans up its tag rows.

CREATE TABLE tags (
    file_path TEXT NOT NULL,
    tag_path  TEXT NOT NULL,
    source    TEXT NOT NULL,
    PRIMARY KEY (file_path, tag_path, source),
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
);

CREATE INDEX idx_tags_path ON tags(tag_path);
