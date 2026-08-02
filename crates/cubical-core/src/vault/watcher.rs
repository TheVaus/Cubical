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

const DEBOUNCE_MS: u64 = 100;

const TICK_MS: u64 = 25;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchEvent {
    Created(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
    Renamed { from: PathBuf, to: PathBuf },
}

pub struct WatcherHandle {
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

pub fn start_watcher(
    vault: &Vault,
    cancel: CancellationToken,
    events: mpsc::Sender<WatchEvent>,
) -> Result<WatcherHandle, VaultError> {
    let root = std::fs::canonicalize(vault.root()).map_err(VaultError::Io)?;

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

        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if ev.paths.len() < 2 {
                tracing::warn!(?ev.paths, "watcher: Rename(Both) without 2 paths");
                return Vec::new();
            }
            let from_rel = relativize(root, &ev.paths[0]);
            let to_rel = relativize(root, &ev.paths[1]);
            match (from_rel, to_rel) {
                (Some(from), Some(to)) => vec![WatchEvent::Renamed { from, to }],
                (Some(from), None) => vec![WatchEvent::Removed(from)],
                (None, Some(to)) => vec![WatchEvent::Created(to)],
                (None, None) => Vec::new(),
            }
        }

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

        EventKind::Modify(ModifyKind::Name(RenameMode::Any)) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(|rel| {
                if root.join(&rel).exists() {
                    WatchEvent::Created(rel)
                } else {
                    WatchEvent::Removed(rel)
                }
            })
            .collect(),

        EventKind::Modify(_) => ev
            .paths
            .iter()
            .filter_map(|p| relativize(root, p))
            .map(WatchEvent::Modified)
            .collect(),

        _ => Vec::new(),
    }
}

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
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::time::timeout;

    const RECV_TIMEOUT: Duration = Duration::from_millis(1000);

    const SETTLE: Duration = Duration::from_millis(400);

    const DROP_SETTLE_LIVENESS: Duration = Duration::from_secs(30);

    async fn open_watched_vault() -> (
        tempfile::TempDir,
        Vault,
        mpsc::Receiver<WatchEvent>,
        WatcherHandle,
    ) {
        open_watched_vault_with(&[]).await
    }

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
        tokio::time::sleep(Duration::from_millis(200)).await;
        (dir, vault, rx, handle)
    }

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
            other => panic!("expected Created, got {other:?}"),
        }
    }

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
    fn translate_rename_any_for_gone_path_emits_removed() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let gone = root.join("trashed.md");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            vec![gone],
        );
        let out = translate_event(root, &ev);
        assert_eq!(out, vec![WatchEvent::Removed(PathBuf::from("trashed.md"))]);
    }

    #[test]
    fn translate_rename_any_for_existing_path_emits_created() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let here = root.join("arrived.md");
        fs::write(&here, b"hi\n").unwrap();
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Any)),
            vec![here],
        );
        let out = translate_event(root, &ev);
        assert_eq!(out, vec![WatchEvent::Created(PathBuf::from("arrived.md"))]);
    }

    #[test]
    fn translate_rename_with_excluded_to_collapses_to_removed() {
        let root = Path::new("/v");
        let ev = synth_event(
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            vec![PathBuf::from("/v/a.md"), PathBuf::from("/v/.cubical/b.md")],
        );
        let out = translate_event(root, &ev);
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
        drain(&mut rx);

        for sub in [".cubical", ".git", ".obsidian", "node_modules"] {
            let p = dir.path().join(sub).join("inside.txt");
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"should be ignored\n").unwrap();
        }

        tokio::time::sleep(SETTLE).await;
        match rx.try_recv() {
            Err(mpsc::error::TryRecvError::Empty) => {}
            Ok(ev) => panic!("expected no events from excluded dirs, got {ev:?}"),
            Err(e) => panic!("unexpected channel error: {e:?}"),
        }
    }

    #[tokio::test]
    async fn dropping_handle_stops_event_delivery() {
        let (dir, _vault, mut rx, handle) = open_watched_vault().await;

        drop(handle);

        match timeout(DROP_SETTLE_LIVENESS, rx.recv()).await {
            Ok(None) => {}
            Ok(Some(ev)) => panic!("expected channel close after drop, got {ev:?}"),
            Err(_) => panic!(
                "bridge did not close the channel within {DROP_SETTLE_LIVENESS:?} of the handle dropping"
            ),
        }

        fs::write(dir.path().join("posthumous.md"), b"x\n").unwrap();
        tokio::time::sleep(SETTLE).await;
        assert!(rx.try_recv().is_err());
    }
}
