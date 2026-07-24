use cubical_engine::events::{AppEvent, EventSink};
use tauri::{Emitter, Runtime};

pub struct TauriEventSink<R: Runtime = tauri::Wry> {
    app: tauri::AppHandle<R>,
}

impl<R: Runtime> TauriEventSink<R> {
    #[must_use]
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> EventSink for TauriEventSink<R> {
    fn emit(&self, event: AppEvent) {
        let name = event.name();
        let res = match event {
            AppEvent::ScanProgress(p) => self.app.emit(name, p),
            AppEvent::ScanComplete(p) => self.app.emit(name, p),
            AppEvent::ScanCancelled(p) => self.app.emit(name, p),
            AppEvent::FileChanged(p) => self.app.emit(name, p),
            AppEvent::Audit(p) => self.app.emit(name, p),
            AppEvent::PendingRewritesChanged(p) => self.app.emit(name, p),
            AppEvent::FlushComplete(p) => self.app.emit(name, p),
            AppEvent::SettingChanged(p) => self.app.emit(name, p),
        };
        if let Err(e) = res {
            tracing::warn!(error = %e, event = name, "failed to emit event");
        }
    }
}
