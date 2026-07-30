use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use super::session::{ChunkSink, TerminalSession};
use super::spawn::OpenSpec;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub struct Entry {
    pub vault_id: String,
    pub session: TerminalSession,
}

type Sessions = Mutex<HashMap<String, Entry>>;

#[derive(Default)]
pub struct TerminalRegistry {
    sessions: Arc<Sessions>,
}

impl TerminalRegistry {
    pub fn open(&self, vault_id: &str, spec: OpenSpec, sink: ChunkSink) -> Result<String, String> {
        let terminal_id = format!(
            "term-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        );
        let on_exit = exit_hook(Arc::downgrade(&self.sessions), terminal_id.clone());
        let session = TerminalSession::open(spec, sink, on_exit)?;
        lock(&self.sessions).insert(
            terminal_id.clone(),
            Entry {
                vault_id: vault_id.to_string(),
                session,
            },
        );
        Ok(terminal_id)
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let sessions = lock(&self.sessions);
        entry(&sessions, terminal_id)?.session.write(data)
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let sessions = lock(&self.sessions);
        entry(&sessions, terminal_id)?.session.resize(cols, rows)
    }

    pub fn take(&self, terminal_id: &str) -> Option<Entry> {
        lock(&self.sessions).remove(terminal_id)
    }

    pub fn drain_vault(&self, vault_id: &str) -> Vec<Entry> {
        let mut sessions = lock(&self.sessions);
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, e)| e.vault_id == vault_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| sessions.remove(&id))
            .collect()
    }

    pub fn drain_all(&self) -> Vec<Entry> {
        lock(&self.sessions).drain().map(|(_, e)| e).collect()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        lock(&self.sessions).len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        lock(&self.sessions).is_empty()
    }

    #[cfg(test)]
    pub fn process_id(&self, terminal_id: &str) -> Option<u32> {
        lock(&self.sessions)
            .get(terminal_id)
            .and_then(|e| e.session.process_id())
    }
}

fn exit_hook(sessions: Weak<Sessions>, terminal_id: String) -> super::session::ExitHook {
    Box::new(move || {
        let Some(sessions) = sessions.upgrade() else {
            return;
        };
        let removed = lock(&sessions).remove(&terminal_id);
        drop(removed);
    })
}

fn entry<'a>(
    sessions: &'a MutexGuard<'a, HashMap<String, Entry>>,
    terminal_id: &str,
) -> Result<&'a Entry, String> {
    sessions
        .get(terminal_id)
        .ok_or_else(|| format!("no such terminal: {terminal_id}"))
}

fn lock(sessions: &Sessions) -> MutexGuard<'_, HashMap<String, Entry>> {
    match sessions.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}
