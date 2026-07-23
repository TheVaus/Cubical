use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Command {
    List,
    Resolve {
        target: String,
    },
    Backlinks {
        path: String,
    },
    NewNote {
        at: Option<String>,
        parent: Option<String>,
    },
    NewFolder {
        parent: Option<String>,
    },
    Write {
        path: String,
        content: String,
    },
    RenameFile {
        from: String,
        to: String,
    },
    RenameFolder {
        from: String,
        to: String,
    },
    Rm {
        path: String,
    },
    Set {
        key: String,
        value: serde_json::Value,
    },
    Get {
        key: String,
    },
    UndoRename {
        op_id: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Request {
    pub vault_path: PathBuf,
    pub command: Command,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Outcome {
    Files(Vec<String>),
    Resolved {
        target: String,
        path: Option<String>,
    },
    Backlinks(Vec<String>),
    Created(String),
    Wrote(String),
    Renamed {
        to: String,
        pending_count: i64,
    },
    Trashed(String),
    SettingSet(String),
    SettingGet {
        key: String,
        value: Option<serde_json::Value>,
    },
    UndoRename {
        op_id: i64,
        removed: u64,
        pending_count: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Response {
    Ok(Outcome),
    Err(String),
}
