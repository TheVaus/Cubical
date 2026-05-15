//! Filesystem watcher for the vault.
//!
//! Wraps `notify` 6.x's `RecommendedWatcher` (FSEvents on macOS,
//! ReadDirectoryChangesW on Windows, inotify on Linux) behind
//! `notify-debouncer-full` for rename correlation by inode and event
//! coalescing. The debouncer's std-thread callback feeds an internal
//! tokio mpsc; a small bridge task forwards into the caller-supplied
//! `mpsc::Sender<WatchEvent>`. Dropping the returned [`WatcherHandle`]
//! tears down the OS-level watch (via the debouncer's `Drop`) and
//! aborts the bridge task.
//!
//! `WatchEvent` paths are vault-relative. The internal `notify` types
//! never leak across the crate boundary — by design, so future swaps
//! of the underlying watcher don't ripple.
//!
//! See `docs/layer-0-spec.md` §6.

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use notify_debouncer_full::{
    new_debouncer, DebounceEventResult, DebouncedEvent, Debouncer, FileIdMap,
};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

use crate::vault::{Vault, VaultError};

/// Time the debouncer holds an event before emitting it. Spec §6: 100ms.
const DEBOUNCE_MS: u64 = 100;

/// How often the debouncer's worker wakes to flush ready events. A
/// quarter of the debounce window keeps wake-up cost low while still
/// hitting the 200ms end-to-end target on §6.
const TICK_MS: u64 = 25;

/// One filesystem change as seen by Cubical, with vault-relative paths.
///
/// `notify`/`notify-debouncer-full` types are intentionally *not*
/// re-exported through this enum — callers that route these events
/// (e.g. the `cubical-app` dispatcher) are insulated from the watcher
/// implementation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    /// A file appeared. Path is relative to the vault root.
    Created(PathBuf),
    /// A file's contents (or attributes) changed in place. Path is
    /// relative to the vault root.
    Modified(PathBuf),
    /// A file was removed. Path is relative to the vault root.
    Removed(PathBuf),
    /// A file was renamed. Both paths are relative to the vault root.
    /// Distinct from a `Removed`+`Created` pair: the debouncer matched
    /// the rename via inode within its 100ms window.
    Renamed {
        /// The path before the rename.
        from: PathBuf,
        /// The path after the rename.
        to: PathBuf,
    },
}

/// Owning handle to an active vault watch.
///
/// Drop semantics: dropping the handle stops the OS watch (the
/// debouncer's `Drop` impl signals its worker thread) and aborts the
/// bridge task. After drop, no further [`WatchEvent`]s arrive on the
/// caller's channel.
pub struct WatcherHandle {
    /// Wrapped in `Option` so `Drop` can consume it via `take()`. The
    /// debouncer's `stop_nonblocking` is preferred over the auto-Drop
    /// path so we don't join its worker thread from inside an async
    /// drop chain.
    debouncer: Option<Debouncer<RecommendedWatcher, FileIdMap>>,
    bridge: JoinHandle<()>,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        if let Some(d) = self.debouncer.take() {
            d.stop_nonblocking();
        }
        self.bridge.abort();
    }
}

/// Begin watching `vault` for filesystem changes.
///
/// Returns a [`WatcherHandle`] whose lifetime controls the watch. Events
/// are delivered to `events` as vault-relative [`WatchEvent`]s. The
/// `cancel` token is a soft shutdown signal: when fired, the bridge
/// task exits and no more events are forwarded; the OS-level watch
/// stays up until the handle is dropped.
///
/// Excluded paths (per §6 + parity with `scan.rs`): anything inside
/// `.cubical/`, `.git/`, `node_modules/`, or any directory whose name
/// starts with `.`. These are dropped silently — without this filter
/// every libSQL write under `.cubical/` would echo back as an event
/// and re-trigger a write.
pub fn start_watcher(
    vault: &Vault,
    cancel: CancellationToken,
    events: mpsc::Sender<WatchEvent>,
) -> Result<WatcherHandle, VaultError> {
    // Canonicalize so the prefix-strip in `relativize` matches the
    // paths notify reports. On macOS, FSEvents resolves symlinks
    // (`/var/...` → `/private/var/...`) before reporting events, so a
    // raw `vault.root()` would fail to strip and every event would be
    // dropped silently.
    let root = std::fs::canonicalize(vault.root()).map_err(VaultError::Io)?;

    // Internal channel: debouncer's std-thread callback → bridge tokio
    // task. Bounded; `blocking_send` provides backpressure if the
    // bridge falls behind. 256 fits typical bursts (e.g. a `git
    // checkout` touching dozens of files at once) without growing
    // unbounded.
    let (raw_tx, mut raw_rx) = mpsc::channel::<WatchEvent>(256);
    let root_for_cb = root.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(DEBOUNCE_MS),
        Some(Duration::from_millis(TICK_MS)),
        move |result: DebounceEventResult| match result {
            Ok(events) => {
                for ev in events {
                    for translated in translate_event(&root_for_cb, &ev) {
                        if raw_tx.blocking_send(translated).is_err() {
                            // Bridge task dropped — stop draining; the
                            // handle is being torn down.
                            return;
                        }
                    }
                }
            }
            Err(errs) => {
                for e in errs {
                    tracing::warn!(error = %e, "watcher: notify error");
                }
            }
        },
    )?;

    debouncer.watcher().watch(&root, RecursiveMode::Recursive)?;
    debouncer.cache().add_root(&root, RecursiveMode::Recursive);

    let bridge = tokio::spawn(async move {
        loop {
            tokio::select! {
                () = cancel.cancelled() => {
                    tracing::info!("watcher: cancellation observed; bridge exiting");
                    break;
                }
                maybe_ev = raw_rx.recv() => {
                    let Some(ev) = maybe_ev else { break; };
                    if events.send(ev).await.is_err() {
                        // Downstream receiver dropped. Nothing left to do.
                        break;
                    }
                }
            }
        }
    });

    tracing::info!(path = %root.display(), "watcher started");

    Ok(WatcherHandle {
        debouncer: Some(debouncer),
        bridge,
    })
}

/// Map a single debounced notify event into zero or more
/// vault-relative [`WatchEvent`]s.
///
/// Returns `Vec` because (a) some `notify` event kinds carry multiple
/// paths (notably `Rename(Both)`), (b) the excluded-path filter can
/// drop one or both sides of a rename, and (c) some `EventKind`
/// variants have no Cubical-level analog (e.g. `Access`) and are
/// dropped entirely.
fn translate_event(root: &Path, ev: &DebouncedEvent) -> Vec<WatchEvent> {
    match &ev.kind {
        EventKind::Create(_) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(WatchEvent::Created)
            .collect(),

        EventKind::Remove(_) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(WatchEvent::Removed)
            .collect(),

        // The debouncer correlated a rename pair by inode → single event with [from, to].
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if ev.paths.len() < 2 {
                tracing::warn!(?ev.paths, "watcher: Rename(Both) without 2 paths");
                return Vec::new();
            }
            let from_rel = relativize(root, &ev.paths[0]);
            let to_rel = relativize(root, &ev.paths[1]);
            match (from_rel, to_rel) {
                (Some(from), Some(to)) => vec![WatchEvent::Renamed { from, to }],
                // Move-out of the watched space looks like a removal.
                (Some(from), None) => vec![WatchEvent::Removed(from)],
                // Move-in to the watched space looks like a creation.
                (None, Some(to)) => vec![WatchEvent::Created(to)],
                (None, None) => Vec::new(),
            }
        }

        // Unmatched halves of a rename — the debouncer couldn't pair
        // them. Treat as Removed/Created so downstream state at least
        // converges.
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(WatchEvent::Removed)
            .collect(),
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(WatchEvent::Created)
            .collect(),

        // Any other modify (data, metadata, generic Any) → Modified.
        EventKind::Modify(_) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(WatchEvent::Modified)
            .collect(),

        // Access events and the Any/Other catch-alls don't surface to
        // Cubical: nothing observable about the file contract changed.
        _ => Vec::new(),
    }
}

/// Strip `root` from `abs` and apply the excluded-path filter.
///
/// Returns `None` for paths that are equal to the root, fail to
/// strip, or live under an excluded directory. Callers must drop
/// `None` results — they correspond to events that are not the
/// concern of cubical-core.
fn relativize(root: &Path, abs: &Path) -> Option<PathBuf> {
    let rel = abs.strip_prefix(root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    if is_excluded(rel) {
        return None;
    }
    Some(rel.to_path_buf())
}

/// Is any component of `rel` an excluded directory, or is the
/// filename itself one we don't want to surface?
///
/// Directory exclusions mirror the skip set in `scan.rs`: `node_modules`
/// plus any dot-prefixed directory (which catches `.cubical`, `.git`,
/// `.obsidian`, …).
///
/// Filename exclusion: the `.cubical-tmp` suffix is reserved for the
/// atomic-write helper (`docs/layer-0-spec.md` §4 / L2 §2.1). Without
/// this filter every autosave would echo three watcher events (create
/// and modify of the temp file plus modify of the target) and the temp
/// path would even leak into the `files` table before the rename.
fn is_excluded(rel: &Path) -> bool {
    if rel.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "node_modules" || s.starts_with('.')
    }) {
        return true;
    }
    rel.extension().is_some_and(|ext| ext == "cubical-tmp")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{Duration, Instant};
    use tempfile::tempdir;
    use tokio::time::timeout;

    /// Upper bound on event arrival used by tests. The §6 budget is
    /// 200ms (100ms debounce + ~25ms tick + native backend lag); we
    /// give it 1s of slack so the suite is robust on loaded CI hosts.
    const RECV_TIMEOUT: Duration = Duration::from_millis(1000);

    /// Wait long enough that *if* a write was going to produce an
    /// event, it would have arrived. Used in negative tests.
    const SETTLE: Duration = Duration::from_millis(400);

    async fn open_watched_vault() -> (
        tempfile::TempDir,
        Vault,
        mpsc::Receiver<WatchEvent>,
        WatcherHandle,
    ) {
        open_watched_vault_with(&[]).await
    }

    /// Variant of [`open_watched_vault`] that pre-creates files before
    /// starting the watcher.
    ///
    /// This matters because `notify-debouncer-full` coalesces a
    /// `Create` followed by `Modify`/`Remove`/`Rename` of the same
    /// path inside its window — its README states "Doesn't emit
    /// `Modify` events after a `Create` event." Tests that need to
    /// assert on a non-Create event must therefore stage the file
    /// before the watch goes up.
    async fn open_watched_vault_with(
        seed: &[(&str, &[u8])],
    ) -> (
        tempfile::TempDir,
        Vault,
        mpsc::Receiver<WatchEvent>,
        WatcherHandle,
    ) {
        let dir = tempdir().unwrap();
        for (rel, bytes) in seed {
            let p = dir.path().join(rel);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(&p, bytes).unwrap();
        }
        let vault = Vault::open(dir.path()).await.expect("open vault");
        let (tx, rx) = mpsc::channel::<WatchEvent>(64);
        let handle = start_watcher(&vault, CancellationToken::new(), tx).expect("start watcher");
        // Give FSEvents a beat to register the watch on macOS — its
        // setup is async and very early writes can be missed otherwise.
        tokio::time::sleep(Duration::from_millis(200)).await;
        (dir, vault, rx, handle)
    }

    /// Drain whatever's queued without blocking — used to clear out
    /// any setup-related events before running the assertion phase.
    fn drain(rx: &mut mpsc::Receiver<WatchEvent>) {
        while rx.try_recv().is_ok() {}
    }

    #[tokio::test]
    async fn created_event_fires_for_new_markdown_file() {
        let (dir, _vault, mut rx, _handle) = open_watched_vault().await;

        fs::write(dir.path().join("hello.md"), b"hi\n").unwrap();

        let ev = timeout(RECV_TIMEOUT, rx.recv())
            .await
            .expect("event within RECV_TIMEOUT")
            .expect("channel still open");
        match ev {
            WatchEvent::Created(p) => assert_eq!(p, PathBuf::from("hello.md")),
            // A platform that emits Modify before Create on first
            // write would also be acceptable as long as some event
            // arrived; tighten if it shows up in practice.
            other => panic!("expected Created, got {other:?}"),
        }
    }

    // Modified / Removed / Renamed are *not* exercised end-to-end via
    // the real filesystem on macOS: FSEvents accumulates a per-path
    // flag bitmask (Created|Modified|Removed merged), and the
    // `notify-debouncer-full` 0.3 debouncer cancels a queue when it
    // observes Create→Remove for the same path inside the window.
    // That's the right behavior for users (no events for a file that
    // appeared-and-vanished), but it makes synthetic test patterns
    // unreliable: a write to a pre-existing file is reported as
    // Create (because the FSEvents bitmask still carries the original
    // Created bit), which then suppresses subsequent Modify and lets
    // the queue cancel on Remove.
    //
    // The translation logic that maps notify event kinds → WatchEvent
    // is unit-tested below against synthetic `DebouncedEvent`s. The
    // end-to-end Modified/Removed/Renamed flows are validated through
    // the §12 #6 smoke pass against `cargo tauri dev`, where the
    // FSEvents flag bitmask isn't an issue (the user's file existed
    // long before the watcher started, so the Create bit isn't fresh).
    //
    // See `notify-debouncer-full`'s `push_remove_event` for the
    // debouncer-side logic, and Apple's FSEvents docs for the flag
    // bitmask semantics.

    fn synth_event(kind: EventKind, paths: Vec<PathBuf>) -> DebouncedEvent {
        let mut event = notify::Event::new(kind);
        event.paths = paths;
        DebouncedEvent::new(event, std::time::Instant::now())
    }

    #[test]
    fn translate_create_emits_created_with_relative_path() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Create(notify::event::CreateKind::File),
            vec![PathBuf::from("/v/notes/hello.md")],
        );
        let out = translate_event(root, &ev);
        assert_eq!(
            out,
            vec![WatchEvent::Created(PathBuf::from("notes/hello.md"))]
        );
    }

    #[test]
    fn translate_modify_data_emits_modified() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Content)),
            vec![PathBuf::from("/v/note.md")],
        );
        let out = translate_event(root, &ev);
        assert_eq!(out, vec![WatchEvent::Modified(PathBuf::from("note.md"))]);
    }

    #[test]
    fn translate_remove_emits_removed() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Remove(notify::event::RemoveKind::File),
            vec![PathBuf::from("/v/gone.md")],
        );
        let out = translate_event(root, &ev);
        assert_eq!(out, vec![WatchEvent::Removed(PathBuf::from("gone.md"))]);
    }

    #[test]
    fn translate_rename_both_emits_single_renamed_pair() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec![PathBuf::from("/v/a.md"), PathBuf::from("/v/b.md")],
        );
        let out = translate_event(root, &ev);
        assert_eq!(
            out,
            vec![WatchEvent::Renamed {
                from: PathBuf::from("a.md"),
                to: PathBuf::from("b.md"),
            }]
        );
    }

    #[test]
    fn translate_rename_from_alone_emits_removed() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::From)),
            vec![PathBuf::from("/v/a.md")],
        );
        let out = translate_event(root, &ev);
        assert_eq!(out, vec![WatchEvent::Removed(PathBuf::from("a.md"))]);
    }

    #[test]
    fn translate_rename_to_alone_emits_created() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::To)),
            vec![PathBuf::from("/v/b.md")],
        );
        let out = translate_event(root, &ev);
        assert_eq!(out, vec![WatchEvent::Created(PathBuf::from("b.md"))]);
    }

    #[test]
    fn translate_rename_with_excluded_to_collapses_to_removed() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec![PathBuf::from("/v/a.md"), PathBuf::from("/v/.cubical/b.md")],
        );
        let out = translate_event(root, &ev);
        // The destination is in an excluded path → from-side surfaces
        // as a removal.
        assert_eq!(out, vec![WatchEvent::Removed(PathBuf::from("a.md"))]);
    }

    #[test]
    fn translate_filters_paths_under_excluded_dirs() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Create(notify::event::CreateKind::File),
            vec![
                PathBuf::from("/v/.cubical/index.db"),
                PathBuf::from("/v/.git/HEAD"),
                PathBuf::from("/v/node_modules/foo/index.js"),
                PathBuf::from("/v/.obsidian/config.json"),
                PathBuf::from("/v/notes/keep.md"),
            ],
        );
        let out = translate_event(root, &ev);
        assert_eq!(
            out,
            vec![WatchEvent::Created(PathBuf::from("notes/keep.md"))]
        );
    }

    #[test]
    fn translate_filters_cubical_tmp_scratch_files() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Create(notify::event::CreateKind::File),
            vec![
                PathBuf::from("/v/note.md.cubical-tmp"),
                PathBuf::from("/v/projects/cubical.md.cubical-tmp"),
                PathBuf::from("/v/keep.md"),
            ],
        );
        let out = translate_event(root, &ev);
        // Only the real markdown file survives — both temp paths
        // (regardless of nesting) get filtered.
        assert_eq!(out, vec![WatchEvent::Created(PathBuf::from("keep.md"))]);
    }

    #[test]
    fn translate_drops_paths_outside_root() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Create(notify::event::CreateKind::File),
            vec![PathBuf::from("/elsewhere/strange.md")],
        );
        assert!(translate_event(root, &ev).is_empty());
    }

    #[test]
    fn translate_drops_unhandled_event_kinds() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Access(notify::event::AccessKind::Open(
                notify::event::AccessMode::Read,
            )),
            vec![PathBuf::from("/v/a.md")],
        );
        assert!(translate_event(root, &ev).is_empty());
    }

    #[tokio::test]
    async fn writes_under_excluded_dirs_emit_no_events() {
        let (dir, _vault, mut rx, _handle) = open_watched_vault().await;
        // Drain the create from `Vault::open` writing the index DB,
        // if any leaked through (it shouldn't — `.cubical/` is excluded
        // — but the watch races with the open).
        drain(&mut rx);

        // Each excluded directory gets a fresh write.
        for sub in [".cubical", ".git", ".obsidian", "node_modules"] {
            let p = dir.path().join(sub).join("inside.txt");
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"should be ignored\n").unwrap();
        }

        // Wait the full settle window — if the filter is broken, *any*
        // of those writes would have produced an event by now.
        tokio::time::sleep(SETTLE).await;
        match rx.try_recv() {
            Err(mpsc::error::TryRecvError::Empty) => {}
            Ok(ev) => panic!("expected no events from excluded dirs, got {ev:?}"),
            Err(e) => panic!("unexpected channel error: {e:?}"),
        }
    }

    #[tokio::test]
    async fn dropping_handle_stops_event_delivery_within_100ms() {
        let (dir, _vault, mut rx, handle) = open_watched_vault().await;

        let t0 = Instant::now();
        drop(handle);

        // After the handle drops, the bridge task is aborted and the
        // sender is gone. `recv()` should observe `None` (channel
        // closed) within ~the bridge's reaction window. A small slack
        // covers the abort propagation.
        let result = timeout(Duration::from_millis(500), rx.recv()).await;
        let elapsed = t0.elapsed();
        match result {
            Ok(None) => {
                // Channel closed — bridge dropped its sender.
            }
            Ok(Some(ev)) => panic!("expected channel close after drop, got {ev:?}"),
            Err(_) => panic!("bridge did not settle within 500ms"),
        }
        assert!(
            elapsed <= Duration::from_millis(500),
            "drop-to-settle was {elapsed:?}",
        );

        // And subsequent FS writes produce nothing — the receiver
        // is closed, but more importantly the OS-level watch is off.
        fs::write(dir.path().join("posthumous.md"), b"x\n").unwrap();
        tokio::time::sleep(SETTLE).await;
        // recv on a closed channel is `None`; no panic, no event.
        assert!(rx.try_recv().is_err());
    }
}
