//! [`BinaryHandler`] — catch-all for non-markdown files.

use std::path::Path;

use super::{sha256_file_hex, FileTypeError, FileTypeHandler};

/// Catch-all handler for non-markdown files (images, PDFs, attachments, ...).
///
/// In Layer 0 the binary handler only records that a file exists and computes
/// a SHA-256 content hash. The deduplicated `.assets/<hash>` pipeline lands in
/// L1+ alongside the asset workflow.
///
/// Because [`FileTypeHandler::matches`] returns `true` unconditionally, this
/// handler must be registered last in any [`super::FileTypeRegistry`] —
/// otherwise it will shadow more specific handlers.
pub struct BinaryHandler;

impl FileTypeHandler for BinaryHandler {
    fn type_id(&self) -> &'static str {
        "binary"
    }

    fn matches(&self, _path: &Path) -> bool {
        true
    }

    fn content_hash(&self, path: &Path) -> Result<String, FileTypeError> {
        sha256_file_hex(path)
    }

    fn sanitize_for_export(&self, content: &[u8]) -> Result<Vec<u8>, FileTypeError> {
        Ok(content.to_vec())
    }
}
