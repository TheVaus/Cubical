use std::path::Path;

use super::{sha256_file_hex, FileTypeError, FileTypeHandler};

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
