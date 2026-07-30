use std::path::Path;
use std::process::{Command, Output};

use tempfile::{tempdir, TempDir};

static ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
fn write_to_a_nonexistent_vault_fails_without_waiting_on_stdin() {
    use std::process::Stdio;

    let missing = tempdir().unwrap().path().join("definitely-not-here");
    let mut child = Command::new(env!("CARGO_BIN_EXE_cubical"))
        .arg("--vault")
        .arg(&missing)
        .args(["write", "x.md"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn cubical");

    // Deliberately hold the stdin pipe open and write nothing: a to_command
    // (guarded by needs_body) that read to EOF unconditionally would block here forever.
    let _held_open = child.stdin.take().expect("stdin pipe");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            panic!("cubical blocked on stdin instead of rejecting the vault path");
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    };

    assert!(!status.success(), "a missing vault must be an error");
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
    let _env = ENV_GUARD.lock().unwrap();
    let h = Harness::new();
    // Hold the ownership lock from the test process (same runtime dir as the child),
    // simulating the app owning the vault.
    std::env::set_var("CUBICAL_RUNTIME_DIR", &h.runtime_path);
    let canonical = std::fs::canonicalize(h.vault_path()).unwrap();
    let _guard = match cubical_engine::vault_lock::acquire(&canonical, None).unwrap() {
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

#[cfg(unix)]
#[test]
fn attaches_over_the_socket_when_the_app_owns_the_vault() {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;

    let _env = ENV_GUARD.lock().unwrap();
    let h = Harness::new();
    std::env::set_var("CUBICAL_RUNTIME_DIR", &h.runtime_path);
    let canonical = std::fs::canonicalize(h.vault_path()).unwrap();
    let sock = h.runtime_path.join("cubical-fake.sock");

    // Hold the lock AND advertise the fake socket, exactly as the running app would.
    let _guard = match cubical_engine::vault_lock::acquire(
        &canonical,
        Some(sock.to_string_lossy().as_ref()),
    )
    .unwrap()
    {
        cubical_engine::vault_lock::Acquire::Acquired(g) => g,
        cubical_engine::vault_lock::Acquire::Held(_) => panic!("test should own the lock"),
    };
    std::env::remove_var("CUBICAL_RUNTIME_DIR");

    let listener = UnixListener::bind(&sock).unwrap();
    listener.set_nonblocking(true).unwrap();
    // Fake server: read the framed Request, reply with a sentinel Files outcome.
    let server = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "the CLI never connected to the advertised socket — \
                         it is no longer taking the attach branch"
                    );
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => panic!("accept failed: {e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        let mut len = [0u8; 4];
        stream.read_exact(&mut len).unwrap();
        let n = u32::from_be_bytes(len) as usize;
        let mut buf = vec![0u8; n];
        stream.read_exact(&mut buf).unwrap();
        let _req: cubical_ipc::Request = serde_json::from_slice(&buf).unwrap();
        let resp = cubical_ipc::Response::Ok(cubical_ipc::Outcome::Files(vec![
            "SENTINEL-ROUTED.md".to_string(),
        ]));
        let bytes = serde_json::to_vec(&resp).unwrap();
        stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .unwrap();
        stream.write_all(&bytes).unwrap();
        stream.flush().unwrap();
    });

    let out = h.run(&["list"]);
    server.join().unwrap();

    assert_eq!(
        out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        String::from_utf8_lossy(&out.stdout).contains("SENTINEL-ROUTED.md"),
        "expected the command to route through the socket; stdout: {}",
        String::from_utf8_lossy(&out.stdout),
    );
}
