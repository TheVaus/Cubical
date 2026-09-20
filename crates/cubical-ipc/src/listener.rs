use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::Duration;

use cubical_engine::events::EventSink;
use cubical_engine::state::AppState;

const ACCEPT_ERROR_BACKOFF: Duration = Duration::from_millis(100);

pub fn bind_socket(sock: &Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    if let Some(parent) = sock.parent() {
        std::fs::create_dir_all(parent)?;
        if let Err(e) = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)) {
            tracing::warn!("could not restrict {}: {e}", parent.display());
        }
    }
    if let Err(e) = std::fs::remove_file(sock) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!("could not clear stale socket {}: {e}", sock.display());
        }
    }
    let listener = std::os::unix::net::UnixListener::bind(sock)?;
    std::fs::set_permissions(sock, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

pub async fn serve(
    listener: std::os::unix::net::UnixListener,
    state: &AppState,
    sink: &dyn EventSink,
) {
    let listener = match tokio::net::UnixListener::from_std(listener) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!("cubical-ipc socket could not join the runtime: {e}");
            return;
        }
    };
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _)) => stream,
            Err(e) => {
                tracing::warn!("cubical-ipc accept failed: {e}");
                tokio::time::sleep(ACCEPT_ERROR_BACKOFF).await;
                continue;
            }
        };
        let served =
            std::panic::AssertUnwindSafe(crate::transport::handle_connection(stream, state, sink));
        match futures_util::FutureExt::catch_unwind(served).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!("cubical-ipc connection error: {e}"),
            Err(_) => tracing::error!("cubical-ipc connection handler panicked"),
        }
    }
}
