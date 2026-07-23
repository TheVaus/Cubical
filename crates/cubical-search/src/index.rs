use crate::doc::IndexDoc;
use crate::error::SearchError;
use crate::schema::{build_schema, register_tokenizers, Fields};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tantivy::collector::DocSetCollector;
use tantivy::query::AllQuery;
use tantivy::schema::{Schema, TantivyDocument, Value};
use tantivy::{doc, Index, IndexReader, IndexWriter, ReloadPolicy, Term};

pub const SCHEMA_VERSION: u32 = 2;

const SCHEMA_JSON: &str = "schema.json";

#[derive(Debug, Serialize, Deserialize)]
struct SchemaStamp {
    version: u32,
}

pub struct SearchIndex {
    dir: PathBuf,
    fields: Fields,
    schema: Schema,
    index: Index,
    writer: Mutex<IndexWriter>,
    reader: IndexReader,
    commit_count: AtomicU64,
}

impl SearchIndex {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self, SearchError> {
        let dir = dir.as_ref().to_path_buf();
        std::fs::create_dir_all(&dir)?;

        let stamp_path = dir.join(SCHEMA_JSON);
        let needs_wipe = match std::fs::read_to_string(&stamp_path) {
            Ok(s) => match serde_json::from_str::<SchemaStamp>(&s) {
                Ok(stamp) => stamp.version != SCHEMA_VERSION,
                Err(_) => true,
            },
            Err(_) => true,
        };
        if needs_wipe && dir.exists() {
            for entry in std::fs::read_dir(&dir)? {
                let path = entry?.path();
                if path.is_dir() {
                    std::fs::remove_dir_all(&path)?;
                } else {
                    std::fs::remove_file(&path)?;
                }
            }
        }

        let (schema, fields) = build_schema();
        let mmap =
            tantivy::directory::MmapDirectory::open(&dir).map_err(tantivy::TantivyError::from)?;
        let index = Index::open_or_create(mmap, schema.clone())?;
        register_tokenizers(index.tokenizers());

        let writer = index.writer(50_000_000)?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()?;

        std::fs::write(
            &stamp_path,
            serde_json::to_string(&SchemaStamp {
                version: SCHEMA_VERSION,
            })?,
        )?;

        Ok(Self {
            dir,
            fields,
            schema,
            index,
            writer: Mutex::new(writer),
            reader,
            commit_count: AtomicU64::new(0),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    pub fn fields(&self) -> Fields {
        self.fields
    }

    pub fn upsert(&self, d: &IndexDoc) -> Result<(), SearchError> {
        let writer = self
            .writer
            .lock()
            .map_err(|_| SearchError::WriterPoisoned)?;
        let term = Term::from_field_text(self.fields.path, &d.path);
        writer.delete_term(term);
        let f = self.fields;
        let mut doc = doc!(
            f.path => d.path.clone(),
            f.title => d.title.clone(),
            f.headings => d.headings.clone(),
            f.body => d.body.clone(),
            f.code => d.code.clone(),
            f.frontmatter => d.frontmatter.clone(),
            f.mtime_secs => d.mtime_secs,
            f.size_bytes => d.size_bytes,
        );
        for t in &d.tags {
            doc.add_text(f.tags, t);
        }
        writer.add_document(doc)?;
        Ok(())
    }

    pub fn delete_path(&self, path: &str) -> Result<(), SearchError> {
        let writer = self
            .writer
            .lock()
            .map_err(|_| SearchError::WriterPoisoned)?;
        let term = Term::from_field_text(self.fields.path, path);
        writer.delete_term(term);
        Ok(())
    }

    pub fn retain_paths(&self, keep: &HashSet<String>) -> Result<usize, SearchError> {
        let searcher = self.reader.searcher();
        let addrs = searcher.search(&AllQuery, &DocSetCollector)?;
        let writer = self
            .writer
            .lock()
            .map_err(|_| SearchError::WriterPoisoned)?;
        let mut removed = 0;
        for addr in addrs {
            let doc: TantivyDocument = searcher.doc(addr)?;
            if let Some(path) = doc.get_first(self.fields.path).and_then(|v| v.as_str()) {
                if !keep.contains(path) {
                    writer.delete_term(Term::from_field_text(self.fields.path, path));
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }

    pub fn commit(&self) -> Result<(), SearchError> {
        {
            let mut writer = self
                .writer
                .lock()
                .map_err(|_| SearchError::WriterPoisoned)?;
            writer.commit()?;
        }
        self.reader.reload()?;
        self.commit_count.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn commit_count(&self) -> u64 {
        self.commit_count.load(Ordering::Relaxed)
    }

    pub fn doc_count(&self) -> Result<u64, SearchError> {
        Ok(self.reader.searcher().num_docs())
    }

    pub fn segment_count(&self) -> u64 {
        self.reader.searcher().segment_readers().len() as u64
    }

    pub fn delete_all(&self) -> Result<(), SearchError> {
        let writer = self
            .writer
            .lock()
            .map_err(|_| SearchError::WriterPoisoned)?;
        writer.delete_all_documents()?;
        Ok(())
    }

    pub(crate) fn reader_clone(&self) -> IndexReader {
        self.reader.clone()
    }

    pub(crate) fn index(&self) -> &Index {
        &self.index
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn doc_fixture(path: &str, body: &str, tags: &[&str]) -> IndexDoc {
        IndexDoc {
            path: path.to_string(),
            title: format!("Title of {path}"),
            headings: String::new(),
            body: body.to_string(),
            code: String::new(),
            tags: tags.iter().map(|s| (*s).to_string()).collect(),
            frontmatter: String::new(),
            mtime_secs: 0,
            size_bytes: 0,
        }
    }

    #[test]
    fn open_creates_dir_and_stamp() {
        let tmp = TempDir::new().unwrap();
        let _idx = SearchIndex::open(tmp.path()).unwrap();
        assert!(tmp.path().join("schema.json").exists());
    }

    #[test]
    fn upsert_then_doc_count_is_one() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "hello world", &["foo"]))
            .unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 1);
    }

    #[test]
    fn upsert_same_path_replaces() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "v1", &[])).unwrap();
        idx.upsert(&doc_fixture("a.md", "v2", &[])).unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 1);
    }

    #[test]
    fn delete_path_removes_doc() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "hello", &[])).unwrap();
        idx.commit().unwrap();
        idx.delete_path("a.md").unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0);
    }

    #[test]
    fn schema_version_mismatch_wipes() {
        let tmp = TempDir::new().unwrap();
        {
            let idx = SearchIndex::open(tmp.path()).unwrap();
            idx.upsert(&doc_fixture("a.md", "hello", &[])).unwrap();
            idx.commit().unwrap();
        }
        std::fs::write(tmp.path().join("schema.json"), r#"{"version": 999}"#).unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        assert_eq!(
            idx.doc_count().unwrap(),
            0,
            "old data should have been wiped"
        );
    }

    #[test]
    fn missing_stamp_wipes_and_re_creates() {
        let tmp = TempDir::new().unwrap();
        {
            let idx = SearchIndex::open(tmp.path()).unwrap();
            idx.upsert(&doc_fixture("a.md", "hello", &[])).unwrap();
            idx.commit().unwrap();
        }
        std::fs::remove_file(tmp.path().join("schema.json")).unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0);
    }

    #[test]
    fn delete_all_clears_doc_count_after_commit() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        idx.upsert(&doc_fixture("a.md", "alpha body", &["foo"]))
            .unwrap();
        idx.upsert(&doc_fixture("b.md", "beta body", &["bar"]))
            .unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 2);
        idx.delete_all().unwrap();
        idx.commit().unwrap();
        assert_eq!(idx.doc_count().unwrap(), 0);
    }

    #[test]
    fn segment_count_is_zero_until_commit_then_at_least_one() {
        let tmp = TempDir::new().unwrap();
        let idx = SearchIndex::open(tmp.path()).unwrap();
        assert_eq!(idx.segment_count(), 0);
        idx.upsert(&doc_fixture("a.md", "x", &[])).unwrap();
        idx.commit().unwrap();
        assert!(idx.segment_count() >= 1);
    }
}
