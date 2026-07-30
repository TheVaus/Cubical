use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{Child, MasterPty};

pub type SharedMaster = Arc<Mutex<Box<dyn MasterPty + Send>>>;

const POLL_INTERVAL: Duration = Duration::from_millis(20);
const HARD_GRACE: Duration = Duration::from_millis(500);

pub struct ChildReaper {
    child: Box<dyn Child + Send + Sync>,
    master: SharedMaster,
    grace: Duration,
}

impl ChildReaper {
    pub fn new(child: Box<dyn Child + Send + Sync>, master: SharedMaster, grace: Duration) -> Self {
        Self {
            child,
            master,
            grace,
        }
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.process_id()
    }

    fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }

    fn wait_for_exit(&mut self, budget: Duration) -> bool {
        let deadline = Instant::now() + budget;
        loop {
            if self.has_exited() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }

    fn reap(&mut self) {
        if self.has_exited() {
            return;
        }
        let targets = self.signal_targets();
        self.terminate(&targets);
        if self.wait_for_exit(self.grace) {
            return;
        }
        self.hard_kill(&targets);
        if !self.wait_for_exit(HARD_GRACE) {
            tracing::error!(
                "terminal child {:?} survived SIGKILL — process may be orphaned",
                self.child.process_id()
            );
        }
    }

    #[cfg(unix)]
    fn signal_targets(&self) -> Vec<nix::unistd::Pid> {
        use nix::unistd::Pid;

        let mut targets: Vec<Pid> = Vec::new();
        if let Some(pid) = self.child.process_id() {
            targets.push(Pid::from_raw(pid as i32));
        }
        let master = match self.master.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(fg) = master.process_group_leader() {
            let fg = Pid::from_raw(fg);
            if !targets.contains(&fg) {
                targets.push(fg);
            }
        }
        targets
    }

    #[cfg(unix)]
    fn terminate(&mut self, targets: &[nix::unistd::Pid]) {
        signal_groups(targets, nix::sys::signal::Signal::SIGTERM);
    }

    #[cfg(unix)]
    fn hard_kill(&mut self, targets: &[nix::unistd::Pid]) {
        signal_groups(targets, nix::sys::signal::Signal::SIGKILL);
    }

    #[cfg(not(unix))]
    fn signal_targets(&self) -> Vec<()> {
        Vec::new()
    }

    #[cfg(not(unix))]
    fn terminate(&mut self, _targets: &[()]) {}

    #[cfg(not(unix))]
    fn hard_kill(&mut self, _targets: &[()]) {
        if let Err(e) = self.child.kill() {
            tracing::warn!("terminal child could not be terminated: {e}");
        }
    }
}

#[cfg(unix)]
fn signal_groups(targets: &[nix::unistd::Pid], signal: nix::sys::signal::Signal) {
    for pid in targets {
        if let Err(e) = nix::sys::signal::killpg(*pid, signal) {
            if e != nix::errno::Errno::ESRCH {
                tracing::warn!("could not signal terminal process group {pid}: {e}");
            }
            if let Err(e) = nix::sys::signal::kill(*pid, signal) {
                if e != nix::errno::Errno::ESRCH {
                    tracing::warn!("could not signal terminal process {pid}: {e}");
                }
            }
        }
    }
}

impl Drop for ChildReaper {
    fn drop(&mut self) {
        self.reap();
    }
}
