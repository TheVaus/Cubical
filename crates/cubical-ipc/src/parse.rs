use std::path::Path;

use anyhow::Result;
use clap::Subcommand;

use crate::Command as WireCommand;

pub use clap::Parser;

#[derive(Debug, Parser)]
#[command(name = "cubical", about = "Drive a Cubical vault from the terminal.")]
pub struct Cli {
    #[arg(
        long,
        global = true,
        default_value = ".",
        help = "Path to the vault directory."
    )]
    pub vault: std::path::PathBuf,
    #[arg(long, global = true, help = "Emit the raw engine response as JSON.")]
    pub json: bool,
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Debug, Subcommand)]
pub enum Cmd {
    #[command(about = "List the vault's markdown files (vault-relative paths).")]
    List,
    #[command(about = "Resolve a wiki-link target to a file path. Exits non-zero if unresolved.")]
    Resolve { target: String },
    #[command(about = "List the notes that link to a given note (vault-relative path).")]
    Backlinks { path: String },
    #[command(subcommand, about = "Create a new note or folder.")]
    New(NewWhat),
    #[command(about = "Replace a markdown file's body with text read from stdin.")]
    Write { path: String },
    #[command(about = "Rename a file or folder, rewriting referring links.")]
    Rename { from: String, to: String },
    #[command(about = "Move a file or folder to the OS trash.")]
    Rm { path: String },
    #[command(about = "Set a vault setting. VALUE is parsed as JSON, else stored as a string.")]
    Set { key: String, value: String },
    #[command(about = "Print a vault setting's value.")]
    Get { key: String },
    #[command(name = "undo-rename", about = "Undo a rename operation by its op id.")]
    UndoRename { op_id: i64 },
}

#[derive(Debug, Subcommand)]
pub enum NewWhat {
    #[command(about = "Create a markdown note.")]
    Note {
        #[arg(long, help = "Exact vault-relative path, e.g. notes/Daily.md.")]
        at: Option<String>,
        #[arg(long = "in", help = "Parent directory for an auto-named note.")]
        parent: Option<String>,
    },
    #[command(about = "Create a folder.")]
    Folder {
        #[arg(long = "in", help = "Parent directory for an auto-named folder.")]
        parent: Option<String>,
    },
}

pub fn needs_body(cmd: &Cmd) -> bool {
    matches!(cmd, Cmd::Write { .. })
}

pub fn to_command(cmd: Cmd, vault_root: &Path, body: Option<String>) -> Result<WireCommand> {
    Ok(match cmd {
        Cmd::List => WireCommand::List,
        Cmd::Resolve { target } => WireCommand::Resolve { target },
        Cmd::Backlinks { path } => WireCommand::Backlinks { path },
        Cmd::New(NewWhat::Note { at, parent }) => WireCommand::NewNote { at, parent },
        Cmd::New(NewWhat::Folder { parent }) => WireCommand::NewFolder { parent },
        Cmd::Write { path } => {
            let content = body.ok_or_else(|| anyhow::anyhow!("write requires a body on stdin"))?;
            WireCommand::Write { path, content }
        }
        Cmd::Rename { from, to } => {
            if vault_root.join(&from).is_dir() {
                WireCommand::RenameFolder { from, to }
            } else {
                WireCommand::RenameFile { from, to }
            }
        }
        Cmd::Rm { path } => WireCommand::Rm { path },
        Cmd::Set { key, value } => {
            let parsed = serde_json::from_str::<serde_json::Value>(&value)
                .unwrap_or(serde_json::Value::String(value));
            WireCommand::Set { key, value: parsed }
        }
        Cmd::Get { key } => WireCommand::Get { key },
        Cmd::UndoRename { op_id } => WireCommand::UndoRename { op_id },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("cubical").chain(args.iter().copied())).unwrap()
    }

    #[test]
    fn list_parses_to_list_command() {
        let cli = parse(&["list"]);
        assert!(matches!(
            to_command(cli.cmd, Path::new("/v"), None).unwrap(),
            WireCommand::List
        ));
    }

    #[test]
    fn new_note_at_maps_fields() {
        let cli = parse(&["new", "note", "--at", "A.md"]);
        match to_command(cli.cmd, Path::new("/v"), None).unwrap() {
            WireCommand::NewNote { at, parent } => {
                assert_eq!(at.as_deref(), Some("A.md"));
                assert!(parent.is_none());
            }
            other => panic!("wrong command: {other:?}"),
        }
    }

    #[test]
    fn write_needs_body_and_errors_without_one() {
        let cli = parse(&["write", "A.md"]);
        assert!(needs_body(&cli.cmd));
        assert!(to_command(cli.cmd, Path::new("/v"), None).is_err());
    }

    #[test]
    fn write_with_body_carries_content() {
        let cli = parse(&["write", "A.md"]);
        match to_command(cli.cmd, Path::new("/v"), Some("hi".into())).unwrap() {
            WireCommand::Write { path, content } => {
                assert_eq!(path, "A.md");
                assert_eq!(content, "hi");
            }
            other => panic!("wrong command: {other:?}"),
        }
    }

    #[test]
    fn set_parses_json_value_else_string() {
        let cli = parse(&["set", "a.b", "true"]);
        match to_command(cli.cmd, Path::new("/v"), None).unwrap() {
            WireCommand::Set { value, .. } => assert_eq!(value, serde_json::Value::Bool(true)),
            other => panic!("wrong command: {other:?}"),
        }
        let cli = parse(&["set", "a.b", "plain"]);
        match to_command(cli.cmd, Path::new("/v"), None).unwrap() {
            WireCommand::Set { value, .. } => {
                assert_eq!(value, serde_json::Value::String("plain".into()));
            }
            other => panic!("wrong command: {other:?}"),
        }
    }

    #[test]
    fn unknown_verb_is_a_clap_error() {
        let err = Cli::try_parse_from(["cubical", "bogus"]).unwrap_err();
        assert_eq!(err.exit_code(), 2);
    }
}
