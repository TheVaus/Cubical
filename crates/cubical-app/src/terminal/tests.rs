use std::path::PathBuf;
#[cfg(unix)]
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use super::registry::TerminalRegistry;
use super::spawn::{
    app_bin_dir, build_command, prepend_path, shell_from, FALLBACK_SHELL, VAULT_ENV,
};
use super::{TerminalChunk, TerminalExit};

#[cfg(unix)]
const SETTLE: Duration = Duration::from_secs(5);
const TEST_GRACE: Duration = Duration::from_millis(200);

fn spec(program: &str, args: &[&str], root: PathBuf) -> super::spawn::OpenSpec {
    super::spawn::OpenSpec {
        program: PathBuf::from(program),
        args: args.iter().map(|s| s.to_string()).collect(),
        vault_root: root,
        cols: 80,
        rows: 24,
        grace: TEST_GRACE,
    }
}

#[cfg(unix)]
fn sink() -> (super::session::ChunkSink, Receiver<TerminalChunk>) {
    let (tx, rx): (Sender<TerminalChunk>, Receiver<TerminalChunk>) = channel();
    (Box::new(move |chunk| tx.send(chunk).is_ok()), rx)
}

#[cfg(unix)]
fn collect_until<F>(rx: &Receiver<TerminalChunk>, mut done: F) -> (String, Option<TerminalExit>)
where
    F: FnMut(&str, Option<&TerminalExit>) -> bool,
{
    let deadline = Instant::now() + SETTLE;
    let mut text = String::new();
    let mut exit = None;
    while Instant::now() < deadline {
        let Ok(chunk) = rx.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        text.push_str(&String::from_utf8_lossy(&chunk.decode()));
        if let Some(e) = chunk.exit.clone() {
            exit = Some(e);
        }
        if done(&text, exit.as_ref()) {
            break;
        }
    }
    (text, exit)
}

#[cfg(unix)]
fn is_alive(pid: u32) -> bool {
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), None).is_ok()
}

#[cfg(unix)]
fn wait_until_gone(pid: u32) -> bool {
    let deadline = Instant::now() + SETTLE;
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    !is_alive(pid)
}

#[test]
fn chunk_survives_a_multi_byte_character_split_across_reads() {
    let snowman = "☃".as_bytes();
    let first = TerminalChunk::from_bytes(&snowman[..1]);
    let second = TerminalChunk::from_bytes(&snowman[1..]);

    let mut rejoined = first.decode();
    rejoined.extend(second.decode());

    assert_eq!(rejoined, snowman);
    assert!(first.exit.is_none());
}

#[test]
fn an_exit_chunk_carries_no_bytes() {
    let chunk = TerminalChunk::exited(TerminalExit {
        code: Some(3),
        signal: None,
    });

    assert_eq!(chunk.base64, "");
    assert_eq!(chunk.exit.unwrap().code, Some(3));
}

#[test]
fn a_normal_chunk_omits_the_exit_field_on_the_wire() {
    let wire = serde_json::to_string(&TerminalChunk::from_bytes(b"hi")).unwrap();

    assert!(!wire.contains("exit"), "unexpected exit field in {wire}");
}

#[test]
fn the_shell_falls_back_when_the_environment_is_unset_or_blank() {
    assert_eq!(shell_from(Some("/bin/zsh")), PathBuf::from("/bin/zsh"));
    assert_eq!(shell_from(None), PathBuf::from(FALLBACK_SHELL));
    assert_eq!(shell_from(Some("   ")), PathBuf::from(FALLBACK_SHELL));
}

#[test]
fn the_app_binary_dir_goes_to_the_front_of_path_exactly_once() {
    let dir = PathBuf::from("/opt/cubical/bin");

    let fresh = prepend_path(&dir, Some("/usr/bin:/bin"));
    assert_eq!(fresh, "/opt/cubical/bin:/usr/bin:/bin");

    let again = prepend_path(&dir, Some(fresh.to_str().unwrap()));
    assert_eq!(again, fresh);

    assert_eq!(prepend_path(&dir, None), "/opt/cubical/bin");
    assert_eq!(prepend_path(&dir, Some("")), "/opt/cubical/bin");
}

#[test]
fn the_child_environment_carries_the_vault_root_and_the_app_binary_dir() {
    let root = PathBuf::from("/tmp/some-vault");
    let cmd = build_command(&spec("/bin/sh", &[], root.clone()));

    assert_eq!(cmd.get_env(VAULT_ENV).unwrap(), root.as_os_str());

    let path = cmd
        .get_env("PATH")
        .map(|p| p.to_string_lossy().into_owned());
    match app_bin_dir() {
        Some(dir) => {
            let path = path.expect("PATH should be set when the binary dir resolves");
            assert!(
                path.starts_with(&dir.to_string_lossy().into_owned()),
                "{path} should start with {}",
                dir.display()
            );
        }
        None => assert!(path.is_none()),
    }
}

#[cfg(unix)]
#[test]
fn output_streams_and_the_registry_self_cleans_when_the_child_exits() {
    let registry = TerminalRegistry::default();
    let (sink, rx) = sink();
    let id = registry
        .open(
            "v1",
            spec("/bin/sh", &["-c", "printf hello-pty"], PathBuf::from("/")),
            sink,
        )
        .unwrap();

    let (text, exit) = collect_until(&rx, |_, exit| exit.is_some());

    assert!(text.contains("hello-pty"), "unexpected output: {text:?}");
    assert_eq!(exit.expect("an exit chunk").code, Some(0));

    let deadline = Instant::now() + SETTLE;
    while !registry.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        registry.is_empty(),
        "the session outlived its child: {} left",
        registry.len()
    );
    assert!(registry.process_id(&id).is_none());
}

#[cfg(unix)]
#[test]
fn a_failing_child_reports_its_exit_code() {
    let registry = TerminalRegistry::default();
    let (sink, rx) = sink();
    registry
        .open(
            "v1",
            spec("/bin/sh", &["-c", "exit 7"], PathBuf::from("/")),
            sink,
        )
        .unwrap();

    let (_, exit) = collect_until(&rx, |_, exit| exit.is_some());

    assert_eq!(exit.expect("an exit chunk").code, Some(7));
}

#[cfg(unix)]
#[test]
fn keystrokes_reach_the_child_and_its_answer_comes_back() {
    let registry = TerminalRegistry::default();
    let (sink, rx) = sink();
    let id = registry
        .open(
            "v1",
            spec(
                "/bin/sh",
                &["-c", "read line; printf 'got:%s' \"$line\""],
                PathBuf::from("/"),
            ),
            sink,
        )
        .unwrap();

    registry.write(&id, b"ping\n").unwrap();
    let (text, _) = collect_until(&rx, |text, _| text.contains("got:ping"));

    assert!(text.contains("got:ping"), "unexpected output: {text:?}");
}

#[cfg(unix)]
#[test]
fn resizing_reaches_the_pty_winsize() {
    let registry = TerminalRegistry::default();
    let (sink, _rx) = sink();
    let id = registry
        .open(
            "v1",
            spec("/bin/sh", &["-c", "sleep 30"], PathBuf::from("/")),
            sink,
        )
        .unwrap();

    registry.resize(&id, 120, 40).unwrap();
    assert_eq!(registry.winsize(&id).unwrap(), (120, 40));

    let entry = registry.take(&id).unwrap();
    drop(entry);
}

#[cfg(unix)]
#[test]
fn closing_a_tab_leaves_no_orphan_process() {
    let registry = TerminalRegistry::default();
    let (sink, _rx) = sink();
    let id = registry
        .open(
            "v1",
            spec("/bin/sh", &["-c", "sleep 300"], PathBuf::from("/")),
            sink,
        )
        .unwrap();
    let pid = registry.process_id(&id).expect("a live child");
    assert!(is_alive(pid));

    drop(registry.take(&id).expect("the session"));

    assert!(wait_until_gone(pid), "child {pid} survived tab close");
    assert!(registry.is_empty());
}

#[cfg(unix)]
#[test]
fn a_child_that_ignores_sigterm_is_still_killed() {
    let registry = TerminalRegistry::default();
    let (sink, rx) = sink();
    let id = registry
        .open(
            "v1",
            spec(
                "/bin/sh",
                &[
                    "-c",
                    "trap '' TERM; printf ready; while :; do sleep 1; done",
                ],
                PathBuf::from("/"),
            ),
            sink,
        )
        .unwrap();
    collect_until(&rx, |text, _| text.contains("ready"));
    let pid = registry.process_id(&id).expect("a live child");

    drop(registry.take(&id).expect("the session"));

    assert!(
        wait_until_gone(pid),
        "child {pid} survived SIGTERM and SIGKILL"
    );
}

#[cfg(unix)]
#[test]
fn switching_vaults_reaps_only_that_vault() {
    let registry = TerminalRegistry::default();
    let (sink_a, _rx_a) = sink();
    let (sink_b, _rx_b) = sink();
    let a = registry
        .open(
            "vault-a",
            spec("/bin/sh", &["-c", "sleep 300"], PathBuf::from("/")),
            sink_a,
        )
        .unwrap();
    let b = registry
        .open(
            "vault-b",
            spec("/bin/sh", &["-c", "sleep 300"], PathBuf::from("/")),
            sink_b,
        )
        .unwrap();
    let pid_a = registry.process_id(&a).unwrap();
    let pid_b = registry.process_id(&b).unwrap();

    drop(registry.drain_vault("vault-a"));

    assert!(wait_until_gone(pid_a), "vault-a child {pid_a} survived");
    assert!(is_alive(pid_b), "vault-b child was reaped by mistake");
    assert_eq!(registry.len(), 1);

    drop(registry.drain_all());
    assert!(wait_until_gone(pid_b));
}

#[cfg(unix)]
#[test]
fn disabling_the_plugin_reaps_every_child() {
    let registry = TerminalRegistry::default();
    let mut pids = Vec::new();
    let mut keep = Vec::new();
    for vault in ["vault-a", "vault-b"] {
        let (sink, rx) = sink();
        keep.push(rx);
        let id = registry
            .open(
                vault,
                spec("/bin/sh", &["-c", "sleep 300"], PathBuf::from("/")),
                sink,
            )
            .unwrap();
        pids.push(registry.process_id(&id).unwrap());
    }

    super::reap_all_blocking(&registry);

    assert!(registry.is_empty());
    for pid in pids {
        assert!(wait_until_gone(pid), "child {pid} survived plugin disable");
    }
}

#[cfg(unix)]
#[test]
fn a_shell_with_nothing_in_the_foreground_is_not_busy() {
    let registry = TerminalRegistry::default();
    let (sink, rx) = sink();
    let id = registry
        .open(
            "v1",
            spec(
                "/bin/sh",
                &["-c", "printf idle-ready; sleep 300"],
                PathBuf::from("/"),
            ),
            sink,
        )
        .unwrap();
    collect_until(&rx, |text, _| text.contains("idle-ready"));

    assert!(
        !registry.has_foreground_child(&id),
        "the terminal's own shell must not read as a foreground child"
    );

    drop(registry.take(&id).expect("the session"));
}

#[cfg(unix)]
#[test]
fn a_running_foreground_child_reads_as_busy() {
    let registry = TerminalRegistry::default();
    let (sink, rx) = sink();
    let id = registry
        .open(
            "v1",
            spec(
                "/bin/sh",
                &["-c", "set -m; printf job-ready; sleep 300; :"],
                PathBuf::from("/"),
            ),
            sink,
        )
        .unwrap();
    collect_until(&rx, |text, _| text.contains("job-ready"));

    let deadline = Instant::now() + SETTLE;
    while !registry.has_foreground_child(&id) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        registry.has_foreground_child(&id),
        "a foreground job should read as busy, so closing the tab asks first"
    );

    drop(registry.take(&id).expect("the session"));
}

#[test]
fn an_unknown_terminal_id_is_an_error_not_a_panic() {
    let registry = TerminalRegistry::default();

    assert!(registry.write("term-nope", b"x").is_err());
    assert!(registry.resize("term-nope", 10, 10).is_err());
    assert!(registry.take("term-nope").is_none());
    assert!(!registry.has_foreground_child("term-nope"));
}
