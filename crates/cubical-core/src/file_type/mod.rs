mod binary;
mod markdown;

pub use binary::BinaryHandler;
pub use markdown::MarkdownHandler;

use std::fmt::Write as _;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum FileTypeError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

pub trait FileTypeHandler: Send + Sync {
    fn type_id(&self) -> &'static str;

    fn matches(&self, path: &Path) -> bool;

    fn content_hash(&self, path: &Path) -> Result<String, FileTypeError>;

    fn sanitize_for_export(&self, content: &[u8]) -> Result<Vec<u8>, FileTypeError>;
}

pub struct FileTypeRegistry {
    handlers: Vec<Box<dyn FileTypeHandler>>,
}

impl FileTypeRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self {
            handlers: Vec::new(),
        }
    }

    pub fn register(&mut self, handler: Box<dyn FileTypeHandler>) {
        self.handlers.push(handler);
    }

    #[must_use]
    pub fn handler_for(&self, path: &Path) -> Option<&dyn FileTypeHandler> {
        self.handlers
            .iter()
            .find(|h| h.matches(path))
            .map(AsRef::as_ref)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

impl Default for FileTypeRegistry {
    fn default() -> Self {
        let mut registry = Self::new();
        registry.register(Box::new(MarkdownHandler));
        registry.register(Box::new(BinaryHandler));
        registry
    }
}

pub fn sha256_bytes_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        let _ = write!(hex, "{:02x}", byte);
    }
    hex
}

pub(crate) fn sha256_file_hex(path: &Path) -> Result<String, FileTypeError> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        let _ = write!(hex, "{:02x}", byte);
    }
    Ok(hex)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn markdown_handler_matches_md_and_markdown_case_insensitively() {
        let h = MarkdownHandler;
        assert!(h.matches(Path::new("a.md")));
        assert!(h.matches(Path::new("a.markdown")));
        assert!(h.matches(Path::new("/some/dir/Note.MD")));
        assert!(h.matches(Path::new("/some/dir/Note.Markdown")));
        assert!(!h.matches(Path::new("a.png")));
        assert!(!h.matches(Path::new("a.pdf")));
        assert!(!h.matches(Path::new("noext")));
        assert!(!h.matches(Path::new(".hidden")));
    }

    #[test]
    fn binary_handler_matches_everything() {
        let h = BinaryHandler;
        assert!(h.matches(Path::new("a.png")));
        assert!(h.matches(Path::new("a.pdf")));
        assert!(h.matches(Path::new("noext")));
        assert!(h.matches(Path::new("a.md")));
    }

    #[test]
    fn default_registry_routes_markdown_then_binary() {
        let registry = FileTypeRegistry::default();
        assert_eq!(registry.len(), 2);
        let cases: &[(&str, &str)] = &[
            ("note.md", "markdown"),
            ("note.markdown", "markdown"),
            ("nested/dir/Note.MD", "markdown"),
            ("image.png", "binary"),
            ("doc.pdf", "binary"),
            ("LICENSE", "binary"),
            ("archive.tar.gz", "binary"),
        ];
        for (path, expected) in cases {
            let got = registry
                .handler_for(Path::new(path))
                .map(FileTypeHandler::type_id);
            assert_eq!(got, Some(*expected), "dispatch for {path}");
        }
    }

    #[test]
    fn empty_registry_returns_none() {
        let registry = FileTypeRegistry::new();
        assert!(registry.is_empty());
        assert!(registry.handler_for(Path::new("anything.md")).is_none());
    }

    #[test]
    fn content_hash_is_deterministic_for_identical_bytes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"hello world").unwrap();
        f.sync_all().unwrap();
        drop(f);

        let h = MarkdownHandler;
        let first = h.content_hash(&path).unwrap();
        let second = h.content_hash(&path).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            first,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        );
    }

    #[test]
    fn content_hash_differs_for_different_bytes() {
        let dir = tempdir().unwrap();
        let p1 = dir.path().join("a.md");
        let p2 = dir.path().join("b.md");
        std::fs::write(&p1, b"alpha").unwrap();
        std::fs::write(&p2, b"beta").unwrap();
        let h = MarkdownHandler;
        assert_ne!(h.content_hash(&p1).unwrap(), h.content_hash(&p2).unwrap());
    }

    #[test]
    fn empty_file_hashes_without_panicking() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.bin");
        std::fs::File::create(&path).unwrap();
        let h = BinaryHandler;
        let hex = h.content_hash(&path).unwrap();
        assert_eq!(
            hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    }

    #[test]
    fn content_hash_handles_files_larger_than_buffer() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.bin");
        let payload = vec![0xABu8; 256 * 1024];
        std::fs::write(&path, &payload).unwrap();
        let h = BinaryHandler;
        let a = h.content_hash(&path).unwrap();
        let b = h.content_hash(&path).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn trait_object_dispatch_compiles_and_works() {
        let handlers: Vec<Box<dyn FileTypeHandler>> =
            vec![Box::new(MarkdownHandler), Box::new(BinaryHandler)];
        let chosen = handlers
            .iter()
            .find(|h| h.matches(Path::new("note.md")))
            .map(|h| h.type_id());
        assert_eq!(chosen, Some("markdown"));
        let chosen_binary = handlers
            .iter()
            .find(|h| h.matches(Path::new("photo.png")))
            .map(|h| h.type_id());
        assert_eq!(chosen_binary, Some("binary"));
    }

    #[test]
    fn sanitize_for_export_is_passthrough_in_l0() {
        let body: &[u8] = b"---\ntitle: hi\n---\n\nbody text\n";
        assert_eq!(
            MarkdownHandler.sanitize_for_export(body).unwrap(),
            body.to_vec(),
        );
        assert_eq!(
            BinaryHandler.sanitize_for_export(body).unwrap(),
            body.to_vec(),
        );
    }
}
