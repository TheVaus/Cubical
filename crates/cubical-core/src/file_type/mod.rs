//! Polymorphic file-type registry.
//!
//! A [`FileTypeHandler`] claims a class of files (markdown, binary,
//! eventually Canvas) and exposes the small set of behaviours Cubical needs to
//! operate on them generically: classification, content hashing, and export
//! sanitization. The [`FileTypeRegistry`] queries handlers in registration
//! order and the first one whose [`FileTypeHandler::matches`] returns `true`
//! claims the file.
//!
//! Layer 0's trait is intentionally narrow — identity logic (frontmatter UUID
//! read/write) joins the trait at L7 alongside "enable sync" onboarding. See
//! `docs/layer-0-spec.md` §5.

mod binary;
mod markdown;

pub use binary::BinaryHandler;
pub use markdown::MarkdownHandler;

use std::fmt::Write as _;
use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};

/// Errors produced by [`FileTypeHandler`] implementations.
///
/// Kept separate from `CubicalError` so the registry can live behind a stable
/// abstraction boundary; the app crate converts to `CubicalError::FileType` at
/// the IPC edge.
#[derive(Debug, thiserror::Error)]
pub enum FileTypeError {
    /// I/O error reading or hashing a file.
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Polymorphic handler for a class of files.
///
/// Handlers are queried in registration order by [`FileTypeRegistry`]; the
/// first handler whose [`Self::matches`] returns `true` claims the file. The
/// catch-all [`BinaryHandler`] must therefore be registered last.
///
/// Implementations must be `Send + Sync` so the registry can be shared across
/// the Tokio runtime.
pub trait FileTypeHandler: Send + Sync {
    /// Stable identifier for this handler — persisted in the `files.type_id`
    /// column. Examples: `"markdown"`, `"binary"`, future `"canvas"`. Renaming
    /// a `type_id` is a breaking schema change.
    fn type_id(&self) -> &'static str;

    /// Whether this handler claims the file based on path/extension/sniff.
    ///
    /// Layer 0 dispatches purely on extension; richer sniffing (magic bytes,
    /// MIME) can be layered on without changing the trait surface.
    fn matches(&self, path: &Path) -> bool;

    /// Compute a content hash for change detection.
    ///
    /// L0 implementations stream the file contents through SHA-256. Other
    /// implementations may choose any stable hash; the value is opaque to the
    /// rest of the system but must be deterministic for identical bytes.
    fn content_hash(&self, path: &Path) -> Result<String, FileTypeError>;

    /// Strip Cubical-specific metadata from a content buffer for export.
    ///
    /// In L0 every handler returns the buffer unchanged. At L7 the markdown
    /// handler will remove the `cubical_id` frontmatter key here.
    fn sanitize_for_export(&self, content: &[u8]) -> Result<Vec<u8>, FileTypeError>;
}

/// Ordered set of [`FileTypeHandler`]s used to classify files.
///
/// The registry never panics on an unknown extension because the default
/// configuration includes [`BinaryHandler`] as a catch-all. Custom registries
/// (tests, headless tooling) may omit the catch-all and accept that
/// [`Self::handler_for`] can return `None`.
pub struct FileTypeRegistry {
    handlers: Vec<Box<dyn FileTypeHandler>>,
}

impl FileTypeRegistry {
    /// Creates an empty registry. Most callers want [`Self::default`] for the
    /// L0 built-ins.
    #[must_use]
    pub fn new() -> Self {
        Self {
            handlers: Vec::new(),
        }
    }

    /// Appends `handler` to the registry. Order is significant — it determines
    /// match priority.
    pub fn register(&mut self, handler: Box<dyn FileTypeHandler>) {
        self.handlers.push(handler);
    }

    /// Returns the first handler whose [`FileTypeHandler::matches`] is true
    /// for `path`, or `None` if no handler claims the file.
    #[must_use]
    pub fn handler_for(&self, path: &Path) -> Option<&dyn FileTypeHandler> {
        self.handlers
            .iter()
            .find(|h| h.matches(path))
            .map(AsRef::as_ref)
    }

    /// Number of registered handlers.
    #[must_use]
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    /// Whether the registry contains no handlers.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

impl Default for FileTypeRegistry {
    /// Default L0 registry: [`MarkdownHandler`] first, [`BinaryHandler`] as the
    /// catch-all. Reflects the entire L0 file-type taxonomy.
    fn default() -> Self {
        let mut registry = Self::new();
        registry.register(Box::new(MarkdownHandler));
        registry.register(Box::new(BinaryHandler));
        registry
    }
}

/// Streaming SHA-256 of `path`'s contents, returned as lowercase hex.
///
/// Reads in 64 KiB chunks so files larger than RAM hash without buffering the
/// whole body. Shared by every L0 handler since they all hash raw bytes.
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
        // Writing to a String is infallible; the result is discarded only to
        // satisfy the unused-must-use lint.
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
        // BinaryHandler matches markdown too — registry ordering, not
        // `matches`, decides priority.
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
        // Known SHA-256 of "hello world".
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
        // Known SHA-256 of zero-length input.
        assert_eq!(
            hex,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    }

    #[test]
    fn content_hash_handles_files_larger_than_buffer() {
        // Exercises the streaming loop: 256 KiB is four full 64 KiB reads.
        let dir = tempdir().unwrap();
        let path = dir.path().join("big.bin");
        let payload = vec![0xABu8; 256 * 1024];
        std::fs::write(&path, &payload).unwrap();
        let h = BinaryHandler;
        let a = h.content_hash(&path).unwrap();
        let b = h.content_hash(&path).unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 64); // SHA-256 hex length
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
