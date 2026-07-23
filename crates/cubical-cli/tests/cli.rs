use std::path::Path;
use std::process::{Command, Output};

use tempfile::{tempdir, TempDir};

struct Harness {
    _runtime: TempDir,
    vault: TempDir,
    runtime_path: std::path::PathBuf,
}

impl Harness {
    fn new() -> Self {
        let runtime = tempdir().unwrap();
        let runtime_path = runtime.path().to_path_buf();
        Self {
            _runtime: runtime,
            vault: tempdir().unwrap(),
            runtime_path,
        }
    }

    fn vault_path(&self) -> &Path {
        self.vault.path()
    }

    fn run(&self, args: &[&str]) -> Output {
        self.run_with_stdin(args, "")
    }

    fn run_with_stdin(&self, args: &[&str], stdin: &str) -> Output {
        use std::io::Write;
        use std::process::Stdio;

        let mut child = Command::new(env!("CARGO_BIN_EXE_cubical"))
            .env("CUBICAL_RUNTIME_DIR", &self.runtime_path)
            .arg("--vault")
            .arg(self.vault_path())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn cubical");
        child
            .stdin
            .take()
            .unwrap()
            .write_all(stdin.as_bytes())
            .unwrap();
        child.wait_with_output().expect("wait cubical")
    }

    fn read(&self, rel: &str) -> String {
        std::fs::read_to_string(self.vault_path().join(rel)).unwrap()
    }
}

fn assert_ok(out: &Output) {
    assert!(
        out.status.success(),
        "expected success, got {:?}\nstdout: {}\nstderr: {}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr),
    );
}

#[test]
fn new_note_creates_a_markdown_file() {
    let h = Harness::new();
    let out = h.run(&["new", "note", "--at", "Daily.md"]);
    assert_ok(&out);
    assert!(h.vault_path().join("Daily.md").is_file());
}

#[test]
fn new_folder_creates_a_directory() {
    let h = Harness::new();
    let out = h.run(&["new", "folder", "--in", ""]);
    assert_ok(&out);
    // The first auto-named folder is "Untitled Folder".
    assert!(h.vault_path().join("Untitled Folder").is_dir());
}

#[test]
fn write_sets_the_file_body_from_stdin() {
    let h = Harness::new();
    assert_ok(&h.run(&["new", "note", "--at", "Note.md"]));
    assert_ok(&h.run_with_stdin(&["write", "Note.md"], "hello world\n"));
    assert!(h.read("Note.md").contains("hello world"));
}

#[test]
fn rename_rewrites_a_referrer_link() {
    let h = Harness::new();
    assert_ok(&h.run(&["new", "note", "--at", "Target.md"]));
    assert_ok(&h.run(&["new", "note", "--at", "Source.md"]));
    assert_ok(&h.run_with_stdin(&["write", "Source.md"], "see [[Target]]\n"));

    assert_ok(&h.run(&["rename", "Target.md", "Renamed.md"]));

    assert!(h.vault_path().join("Renamed.md").is_file());
    let source = h.read("Source.md");
    assert!(
        source.contains("[[Renamed]]"),
        "referrer link should have been rewritten by the close-flush, got: {source}"
    );
}

#[test]
fn rm_moves_a_file_out_of_the_vault() {
    let h = Harness::new();
    assert_ok(&h.run(&["new", "note", "--at", "Trash.md"]));
    assert_ok(&h.run(&["rm", "Trash.md"]));
    assert!(!h.vault_path().join("Trash.md").exists());
}

#[test]
fn set_then_get_round_trips_a_setting() {
    let h = Harness::new();
    assert_ok(&h.run(&["set", "appearance.theme_mode", "dark"]));
    let out = h.run(&["get", "appearance.theme_mode"]);
    assert_ok(&out);
    assert!(String::from_utf8_lossy(&out.stdout).contains("dark"));
}

#[test]
fn declines_with_exit_code_2_when_the_vault_is_locked() {
    let h = Harness::new();
    // Hold the ownership lock from the test process (same runtime dir as the child),
    // simulating the app owning the vault.
    std::env::set_var("CUBICAL_RUNTIME_DIR", &h.runtime_path);
    let canonical = std::fs::canonicalize(h.vault_path()).unwrap();
    let _guard = match cubical_engine::vault_lock::acquire(&canonical).unwrap() {
        cubical_engine::vault_lock::Acquire::Acquired(g) => g,
        cubical_engine::vault_lock::Acquire::Held(_) => panic!("test should own the lock first"),
    };
    std::env::remove_var("CUBICAL_RUNTIME_DIR");

    let out = h.run(&["list"]);
    assert_eq!(
        out.status.code(),
        Some(2),
        "a locked vault must exit 2; stderr: {}",
        String::from_utf8_lossy(&out.stderr),
    );
}
