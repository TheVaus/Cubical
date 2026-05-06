//! [`MarkdownHandler`] — claims `.md` and `.markdown`.

use std::path::Path;

use super::{sha256_file_hex, FileTypeError, FileTypeHandler};

/// Handler for plain markdown notes (`.md` / `.markdown`).
///
/// Layer 0 only classifies files and computes a SHA-256 content hash for
/// change detection. [`FileTypeHandler::sanitize_for_export`] is a
/// pass-through; the `cubical_id` frontmatter strip lands at L7 alongside
/// frontmatter UUIDs.
pub struct MarkdownHandler;

impl FileTypeHandler for MarkdownHandler {
    fn type_id(&self) -> &'static str {
        "markdown"
    }

    fn matches(&self, path: &Path) -> bool {
        path.extension()
            .and_then(|s| s.to_str())
            .is_some_and(|ext| {
                ext.eq_ignore_ascii_case("md") || ext.eq_ignore_ascii_case("markdown")
            })
    }

    fn content_hash(&self, path: &Path) -> Result<String, FileTypeError> {
        sha256_file_hex(path)
    }

    fn sanitize_for_export(&self, content: &[u8]) -> Result<Vec<u8>, FileTypeError> {
        Ok(content.to_vec())
    }
}
