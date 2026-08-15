use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use portable_pty::{native_pty_system, PtySize};

use super::reap::{ChildReaper, SharedMaster};
use super::spawn::{build_command, OpenSpec};
use super::{TerminalChunk, TerminalExit};

const READ_BUF: usize = 8192;

pub type ChunkSink = Box<dyn FnMut(TerminalChunk) -> bool + Send + 'static>;
pub type ExitHook = Box<dyn FnOnce() -> TerminalExit + Send + 'static>;

pub struct TerminalSession {
    reaper: ChildReaper,
    master: SharedMaster,
    writer: Mutex<Box<dyn Write + Send>>,
}

impl TerminalSession {
    pub fn open(spec: OpenSpec, sink: ChunkSink, on_exit: ExitHook) -> Result<Self, String> {
        let size = PtySize {
            rows: spec.rows.max(1),
            cols: spec.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = native_pty_system()
            .openpty(size)
            .map_err(|e| format!("could not open a pty: {e}"))?;
        let child = pair
            .slave
            .spawn_command(build_command(&spec))
            .map_err(|e| format!("could not start {}: {e}", spec.program.display()))?;
        drop(pair.slave);

        let master = pair.master;
        let reader = master
            .try_clone_reader()
            .map_err(|e| format!("could not read from the pty: {e}"))?;
        let writer = master
            .take_writer()
            .map_err(|e| format!("could not write to the pty: {e}"))?;

        let master: SharedMaster = Arc::new(Mutex::new(master));
        let reaper = ChildReaper::new(child, Arc::clone(&master), spec.grace);

        std::thread::Builder::new()
            .name("cubical-pty-reader".to_string())
            .spawn(move || pump(reader, sink, on_exit))
            .map_err(|e| format!("could not start the pty reader: {e}"))?;

        Ok(Self {
            reaper,
            master,
            writer: Mutex::new(writer),
        })
    }

    #[cfg(all(test, unix))]
    pub fn process_id(&self) -> Option<u32> {
        self.reaper.process_id()
    }

    pub fn wait_exit(&mut self) -> TerminalExit {
        self.reaper.wait_exit()
    }

    #[cfg(unix)]
    pub fn has_foreground_child(&self) -> bool {
        let leader = lock(&self.master).process_group_leader();
        match (leader, self.reaper.process_id()) {
            (Some(fg), Some(pid)) => fg >= 0 && fg as u32 != pid,
            _ => false,
        }
    }

    #[cfg(not(unix))]
    pub fn has_foreground_child(&self) -> bool {
        false
    }

    pub fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = lock(&self.writer);
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|e| format!("could not write to the terminal: {e}"))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = lock(&self.master);
        master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("could not resize the terminal: {e}"))
    }

    #[cfg(all(test, unix))]
    pub fn winsize(&self) -> Result<(u16, u16), String> {
        let master = lock(&self.master);
        master
            .get_size()
            .map(|s| (s.cols, s.rows))
            .map_err(|e| e.to_string())
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    match m.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn pump(mut reader: Box<dyn Read + Send>, mut sink: ChunkSink, on_exit: ExitHook) {
    let mut buf = [0u8; READ_BUF];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if !sink(TerminalChunk::from_bytes(&buf[..n])) {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    sink(TerminalChunk::exited(on_exit()));
}
