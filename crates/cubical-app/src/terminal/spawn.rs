use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use portable_pty::CommandBuilder;

pub const DEFAULT_GRACE: Duration = Duration::from_millis(1500);
pub const FALLBACK_SHELL: &str = "/bin/sh";
pub const VAULT_ENV: &str = "CUBICAL_VAULT";

#[derive(Debug)]
pub struct OpenSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub vault_root: PathBuf,
    pub cols: u16,
    pub rows: u16,
    pub grace: Duration,
}

impl OpenSpec {
    pub fn shell(vault_root: PathBuf, cols: u16, rows: u16) -> Self {
        Self {
            program: shell_program(),
            args: Vec::new(),
            vault_root,
            cols,
            rows,
            grace: DEFAULT_GRACE,
        }
    }
}

pub fn shell_from(var: Option<&str>) -> PathBuf {
    match var {
        Some(s) if !s.trim().is_empty() => PathBuf::from(s),
        _ => PathBuf::from(FALLBACK_SHELL),
    }
}

pub fn shell_program() -> PathBuf {
    shell_from(std::env::var("SHELL").ok().as_deref())
}

pub fn app_bin_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
}

pub fn prepend_path(dir: &Path, existing: Option<&str>) -> OsString {
    let dir = dir.to_string_lossy().into_owned();
    match existing {
        Some(path) if !path.is_empty() => {
            if std::env::split_paths(path).any(|p| p.to_string_lossy() == dir) {
                OsString::from(path)
            } else {
                OsString::from(format!("{dir}{}{path}", path_separator()))
            }
        }
        _ => OsString::from(dir),
    }
}

fn path_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

pub fn build_command(spec: &OpenSpec) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&spec.program);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    cmd.cwd(&spec.vault_root);
    cmd.env(VAULT_ENV, spec.vault_root.as_os_str());
    if let Some(dir) = app_bin_dir() {
        let existing = cmd
            .get_env("PATH")
            .map(|p| p.to_string_lossy().into_owned());
        cmd.env("PATH", prepend_path(&dir, existing.as_deref()));
    }
    cmd
}
