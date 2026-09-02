use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use crate::error::TableError;
use crate::table::Table;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    mtime: SystemTime,
    len: u64,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    path: PathBuf,
    sheet: Option<String>,
}

struct Entry {
    stamp: Stamp,
    table: Arc<Table>,
    bytes: usize,
    used: u64,
}

#[derive(Default)]
struct State {
    entries: HashMap<Key, Entry>,
    bytes: usize,
    clock: u64,
}

pub struct TableCache {
    byte_ceiling: usize,
    state: Mutex<State>,
}

impl TableCache {
    pub fn new(byte_ceiling: usize) -> Self {
        TableCache {
            byte_ceiling,
            state: Mutex::new(State::default()),
        }
    }

    pub fn load(&self, path: &Path, sheet: Option<&str>) -> Result<Arc<Table>, TableError> {
        let key = Key {
            path: path.canonicalize()?,
            sheet: sheet.map(str::to_string),
        };
        let before = stamp(&key.path)?;
        if let Some(hit) = self.hit(&key, before) {
            return Ok(hit);
        }

        let table = Arc::new(crate::load(&key.path, sheet)?);
        match stamp(&key.path) {
            Ok(after) if after == before => self.store(key, before, Arc::clone(&table)),
            _ => self.forget(&key),
        }
        Ok(table)
    }

    pub fn invalidate(&self, path: &Path) {
        let canonical = path.canonicalize().ok();
        let mut state = self.guard();
        let doomed: Vec<Key> = state
            .entries
            .keys()
            .filter(|k| k.path.as_path() == path || canonical.as_deref() == Some(k.path.as_path()))
            .cloned()
            .collect();
        for key in doomed {
            drop_entry(&mut state, &key);
        }
    }

    fn guard(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn hit(&self, key: &Key, stamp: Stamp) -> Option<Arc<Table>> {
        let mut state = self.guard();
        state.clock += 1;
        let clock = state.clock;
        let entry = state.entries.get_mut(key)?;
        if entry.stamp != stamp {
            return None;
        }
        entry.used = clock;
        Some(Arc::clone(&entry.table))
    }

    fn forget(&self, key: &Key) {
        let mut state = self.guard();
        drop_entry(&mut state, key);
    }

    fn store(&self, key: Key, stamp: Stamp, table: Arc<Table>) {
        let bytes = table.estimated_bytes();
        let mut state = self.guard();
        drop_entry(&mut state, &key);
        if bytes > self.byte_ceiling {
            return;
        }
        state.clock += 1;
        let used = state.clock;
        state.entries.insert(
            key,
            Entry {
                stamp,
                table,
                bytes,
                used,
            },
        );
        state.bytes += bytes;
        while state.bytes > self.byte_ceiling {
            let oldest = state
                .entries
                .iter()
                .min_by_key(|(_, e)| e.used)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(key) => drop_entry(&mut state, &key),
                None => break,
            }
        }
    }
}

fn drop_entry(state: &mut State, key: &Key) {
    if let Some(entry) = state.entries.remove(key) {
        state.bytes = state.bytes.saturating_sub(entry.bytes);
    }
}

fn stamp(path: &Path) -> Result<Stamp, TableError> {
    let meta = path.metadata()?;
    Ok(Stamp {
        mtime: meta.modified()?,
        len: meta.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::fs::FileTimes;
    use std::time::Duration;
    use tempfile::TempDir;

    const HEADER: &str = "name,qty\n";

    fn write(path: &Path, body: &str) {
        match fs::write(path, body) {
            Ok(()) => (),
            Err(err) => panic!("write failed: {err}"),
        }
    }

    fn mtime(path: &Path) -> SystemTime {
        match path.metadata().and_then(|m| m.modified()) {
            Ok(t) => t,
            Err(err) => panic!("stat failed: {err}"),
        }
    }

    fn set_mtime(path: &Path, when: SystemTime) {
        let file = match fs::File::options().write(true).open(path) {
            Ok(file) => file,
            Err(err) => panic!("open failed: {err}"),
        };
        match file.set_times(FileTimes::new().set_modified(when)) {
            Ok(()) => (),
            Err(err) => panic!("set_times failed: {err}"),
        }
    }

    fn rewrite_in_place(path: &Path, body: &str) {
        let before = mtime(path);
        let len = match path.metadata() {
            Ok(meta) => meta.len(),
            Err(err) => panic!("stat failed: {err}"),
        };
        write(path, body);
        assert_eq!(
            match path.metadata() {
                Ok(meta) => meta.len(),
                Err(err) => panic!("stat failed: {err}"),
            },
            len,
            "rewrite_in_place must not change the file size"
        );
        set_mtime(path, before);
    }

    fn first_cell(table: &Table) -> &str {
        match table.rows.first().and_then(|row| row.first()) {
            Some(cell) => cell.text.as_str(),
            None => panic!("expected at least one row"),
        }
    }

    fn load(cache: &TableCache, path: &Path) -> Arc<Table> {
        match cache.load(path, None) {
            Ok(table) => table,
            Err(err) => panic!("load failed: {err}"),
        }
    }

    fn fixture(dir: &TempDir, name: &str, body: &str) -> PathBuf {
        let path = dir.path().join(name);
        write(&path, body);
        path
    }

    fn temp() -> TempDir {
        match TempDir::new() {
            Ok(dir) => dir,
            Err(err) => panic!("tempdir failed: {err}"),
        }
    }

    #[test]
    fn a_repeat_load_shares_one_decode() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(1 << 20);
        let first = load(&cache, &path);
        let second = load(&cache, &path);
        assert!(Arc::ptr_eq(&first, &second));
    }

    #[test]
    fn an_unchanged_stat_serves_the_cached_table() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(1 << 20);
        assert_eq!(first_cell(&load(&cache, &path)), "Alpha");
        rewrite_in_place(&path, &format!("{HEADER}Bravo,1\n"));
        assert_eq!(first_cell(&load(&cache, &path)), "Alpha");
    }

    #[test]
    fn a_changed_mtime_re_decodes() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(1 << 20);
        assert_eq!(first_cell(&load(&cache, &path)), "Alpha");
        let later = mtime(&path) + Duration::from_secs(5);
        write(&path, &format!("{HEADER}Bravo,1\n"));
        set_mtime(&path, later);
        assert_eq!(first_cell(&load(&cache, &path)), "Bravo");
    }

    #[test]
    fn a_changed_size_re_decodes() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(1 << 20);
        assert_eq!(load(&cache, &path).rows.len(), 1);
        let before = mtime(&path);
        write(&path, &format!("{HEADER}Alpha,1\nBravo,2\n"));
        set_mtime(&path, before);
        assert_eq!(load(&cache, &path).rows.len(), 2);
    }

    #[test]
    fn invalidate_forces_a_re_decode() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(1 << 20);
        assert_eq!(first_cell(&load(&cache, &path)), "Alpha");
        rewrite_in_place(&path, &format!("{HEADER}Bravo,1\n"));
        cache.invalidate(&path);
        assert_eq!(first_cell(&load(&cache, &path)), "Bravo");
    }

    #[test]
    fn invalidating_one_path_leaves_the_others_cached() {
        let dir = temp();
        let one = fixture(&dir, "one.csv", &format!("{HEADER}Alpha,1\n"));
        let two = fixture(&dir, "two.csv", &format!("{HEADER}Carla,1\n"));
        let cache = TableCache::new(1 << 20);
        let kept = load(&cache, &two);
        load(&cache, &one);
        cache.invalidate(&one);
        assert!(Arc::ptr_eq(&kept, &load(&cache, &two)));
    }

    #[test]
    fn a_table_over_the_ceiling_is_returned_but_not_retained() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(0);
        assert_eq!(first_cell(&load(&cache, &path)), "Alpha");
        rewrite_in_place(&path, &format!("{HEADER}Bravo,1\n"));
        assert_eq!(first_cell(&load(&cache, &path)), "Bravo");
    }

    #[test]
    fn the_least_recently_used_table_is_evicted_past_the_ceiling() {
        let dir = temp();
        let one = fixture(&dir, "one.csv", &format!("{HEADER}Alpha,1\n"));
        let two = fixture(&dir, "two.csv", &format!("{HEADER}Carla,1\n"));
        let ceiling = load(&TableCache::new(1 << 20), &one).estimated_bytes() * 3 / 2;
        let cache = TableCache::new(ceiling);
        load(&cache, &one);
        load(&cache, &two);
        rewrite_in_place(&one, &format!("{HEADER}Bravo,1\n"));
        rewrite_in_place(&two, &format!("{HEADER}Delta,1\n"));
        assert_eq!(first_cell(&load(&cache, &two)), "Carla");
        assert_eq!(first_cell(&load(&cache, &one)), "Bravo");
    }

    #[test]
    fn a_missing_file_is_an_io_error() {
        let dir = temp();
        let err = match TableCache::new(1 << 20).load(&dir.path().join("nope.csv"), None) {
            Err(err) => err,
            Ok(_) => panic!("expected an io error"),
        };
        assert!(matches!(err, TableError::Io(_)), "{err:?}");
    }

    #[test]
    fn sheets_are_cached_separately() {
        let dir = temp();
        let path = fixture(&dir, "t.csv", &format!("{HEADER}Alpha,1\n"));
        let cache = TableCache::new(1 << 20);
        let bare = load(&cache, &path);
        let named = match cache.load(&path, Some("Q1")) {
            Ok(table) => table,
            Err(err) => panic!("load failed: {err}"),
        };
        assert!(!Arc::ptr_eq(&bare, &named));
        assert_eq!(*bare, *named);
    }

    #[test]
    fn the_cache_is_shareable_across_threads() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<TableCache>();
    }
}
