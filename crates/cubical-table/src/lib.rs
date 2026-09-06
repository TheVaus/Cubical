#![forbid(unsafe_code)]

mod cache;
mod delimited;
mod error;
mod excel;
mod table;

use std::path::Path;

pub use cache::TableCache;
pub use error::TableError;
pub use table::{Cell, Table};

const COMMA: u8 = b',';
const TAB: u8 = b'\t';

enum Format {
    Delimited(u8),
    Excel,
}

impl Format {
    fn of(extension: &str) -> Option<Format> {
        match normalize(extension).as_str() {
            "csv" => Some(Format::Delimited(COMMA)),
            "tsv" => Some(Format::Delimited(TAB)),
            "xlsx" | "xlsm" => Some(Format::Excel),
            _ => None,
        }
    }
}

fn normalize(extension: &str) -> String {
    extension
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase()
}

pub fn supports_extension(extension: &str) -> bool {
    Format::of(extension).is_some()
}

pub fn load(path: &Path, sheet: Option<&str>) -> Result<Table, TableError> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    match Format::of(extension) {
        Some(Format::Delimited(delimiter)) => delimited::decode(&std::fs::read(path)?, delimiter),
        Some(Format::Excel) => excel::decode(path, sheet),
        None => Err(TableError::UnsupportedFormat {
            extension: normalize(extension),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn temp() -> TempDir {
        match TempDir::new() {
            Ok(dir) => dir,
            Err(err) => panic!("tempdir failed: {err}"),
        }
    }

    #[test]
    fn supported_extensions_are_case_insensitive_and_dot_tolerant() {
        for ext in ["csv", "CSV", ".csv", "tsv", "xlsx", "XLSX", ".xlsm"] {
            assert!(supports_extension(ext), "{ext} should be supported");
        }
        for ext in ["", "md", "numbers", "xls", "ods", "csv.gz"] {
            assert!(!supports_extension(ext), "{ext} should not be supported");
        }
    }

    #[test]
    fn a_csv_loads_from_disk() {
        let dir = temp();
        let path = dir.path().join("data.CSV");
        match fs::write(&path, "name,qty\nAlpha,2\n") {
            Ok(()) => (),
            Err(err) => panic!("write failed: {err}"),
        }
        let table = match load(&path, None) {
            Ok(table) => table,
            Err(err) => panic!("load failed: {err}"),
        };
        assert_eq!(table.columns, vec!["name", "qty"]);
        assert_eq!(table.get(0, "qty").and_then(|c| c.num), Some(2.0));
    }

    #[test]
    fn a_sheet_name_is_ignored_for_delimited_files() {
        let dir = temp();
        let path = dir.path().join("data.tsv");
        match fs::write(&path, "a\tb\n1\t2\n") {
            Ok(()) => (),
            Err(err) => panic!("write failed: {err}"),
        }
        let named = match load(&path, Some("whatever")) {
            Ok(table) => table,
            Err(err) => panic!("load failed: {err}"),
        };
        let bare = match load(&path, None) {
            Ok(table) => table,
            Err(err) => panic!("load failed: {err}"),
        };
        assert_eq!(named, bare);
    }

    #[test]
    fn an_unsupported_extension_names_itself() {
        let dir = temp();
        let path = dir.path().join("data.Numbers");
        let err = match load(&path, None) {
            Err(err) => err,
            Ok(_) => panic!("expected an unsupported-format error"),
        };
        assert_eq!(
            err.to_string(),
            "unsupported table format \"numbers\"; expected .csv, .tsv, .xlsx or .xlsm"
        );
    }

    #[test]
    fn a_missing_csv_is_an_io_error() {
        let dir = temp();
        let err = match load(&dir.path().join("nope.csv"), None) {
            Err(err) => err,
            Ok(_) => panic!("expected an io error"),
        };
        assert!(matches!(err, TableError::Io(_)), "{err:?}");
    }
}
