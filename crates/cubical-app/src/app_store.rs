use std::path::Path;

use serde::Serialize;

pub fn write_json<T: Serialize + ?Sized>(store: &Path, value: &T) {
    if let Err(e) = try_write_json(store, value) {
        tracing::warn!("could not save {}: {e}", store.display());
    }
}

fn try_write_json<T: Serialize + ?Sized>(store: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = store.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    cubical_core::atomic_write(store, &json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_parent_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("nested").join("state.json");
        write_json(&store, &vec!["a", "b"]);
        let back: Vec<String> = serde_json::from_slice(&std::fs::read(&store).unwrap()).unwrap();
        assert_eq!(back, vec!["a", "b"]);
        let names: Vec<_> = std::fs::read_dir(store.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("state.json")]);
    }
}
