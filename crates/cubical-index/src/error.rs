use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("io error opening index database at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("libsql error: {0}")]
    LibSql(#[from] libsql::Error),

    #[error(
        "on-disk schema version {0} is newer than this build supports; \
         upgrade Cubical to open this vault"
    )]
    SchemaTooNew(u32),

    #[error("unknown enum value {value:?} in {table}.{column}")]
    UnknownEnum {
        table: &'static str,
        column: &'static str,
        value: String,
    },
}

const SQLITE_CORRUPT: i32 = 11;
const SQLITE_NOTADB: i32 = 26;

impl IndexError {
    #[must_use]
    pub fn is_unusable_database(&self) -> bool {
        match self {
            IndexError::LibSql(libsql::Error::SqliteFailure(code, _)) => {
                matches!(*code & 0xff, SQLITE_CORRUPT | SQLITE_NOTADB)
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corrupt_and_not_a_database_are_unusable() {
        assert!(IndexError::LibSql(libsql::Error::SqliteFailure(
            SQLITE_NOTADB,
            "file is not a database".into()
        ))
        .is_unusable_database());
        assert!(IndexError::LibSql(libsql::Error::SqliteFailure(
            SQLITE_CORRUPT,
            "database disk image is malformed".into()
        ))
        .is_unusable_database());
    }

    #[test]
    fn extended_result_codes_keep_their_primary_meaning() {
        let corrupt_vtab = SQLITE_CORRUPT | (1 << 8);
        assert!(
            IndexError::LibSql(libsql::Error::SqliteFailure(corrupt_vtab, String::new()))
                .is_unusable_database()
        );
    }

    #[test]
    fn schema_too_new_is_never_unusable() {
        assert!(!IndexError::SchemaTooNew(99).is_unusable_database());
    }

    #[test]
    fn cannot_open_and_busy_are_not_unusable() {
        for code in [1, 5, 14] {
            assert!(
                !IndexError::LibSql(libsql::Error::SqliteFailure(code, String::new()))
                    .is_unusable_database(),
                "sqlite code {code} must not be treated as corruption"
            );
        }
        assert!(
            !IndexError::LibSql(libsql::Error::ConnectionFailed("nope".into()))
                .is_unusable_database()
        );
        assert!(!IndexError::Io {
            path: std::path::PathBuf::from("index.db"),
            source: std::io::Error::other("boom"),
        }
        .is_unusable_database());
    }
}
