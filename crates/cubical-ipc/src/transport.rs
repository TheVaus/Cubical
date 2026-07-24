use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::protocol::{Request, Response};

const MAX_FRAME: u32 = 64 * 1024 * 1024;
pub const IO_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug)]
pub enum TransportError {
    Io(std::io::Error),
    Protocol(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "{e}"),
            TransportError::Protocol(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for TransportError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            TransportError::Io(e) => Some(e),
            TransportError::Protocol(_) => None,
        }
    }
}

impl From<std::io::Error> for TransportError {
    fn from(e: std::io::Error) -> Self {
        TransportError::Io(e)
    }
}

pub type TransportResult<T> = Result<T, TransportError>;

pub async fn write_msg<W, T>(w: &mut W, msg: &T) -> TransportResult<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(msg)
        .map_err(|e| TransportError::Protocol(format!("message is not encodable: {e}")))?;
    let len = u32::try_from(bytes.len())
        .ok()
        .filter(|len| *len <= MAX_FRAME)
        .ok_or_else(|| TransportError::Protocol("frame exceeds maximum size".into()))?;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_msg<R, T>(r: &mut R) -> TransportResult<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(TransportError::Protocol(
            "frame exceeds maximum size".into(),
        ));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf)
        .map_err(|e| TransportError::Protocol(format!("frame is not valid JSON: {e}")))
}

pub async fn read_msg_timeout<R, T>(r: &mut R, timeout: std::time::Duration) -> TransportResult<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    match tokio::time::timeout(timeout, read_msg(r)).await {
        Ok(res) => res,
        Err(_) => Err(TransportError::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            "timed out waiting for a framed message",
        ))),
    }
}

pub fn app_socket_path(pid: u32) -> PathBuf {
    cubical_engine::vault_lock::runtime_dir().join(format!("cubical-{pid}.sock"))
}

#[cfg(unix)]
pub async fn client_send(socket_path: &Path, req: &Request) -> TransportResult<Response> {
    use tokio::net::UnixStream;
    let mut stream = UnixStream::connect(socket_path).await?;
    write_msg(&mut stream, req).await?;
    read_msg_timeout(&mut stream, IO_TIMEOUT).await
}

#[cfg(not(unix))]
pub async fn client_send(_socket_path: &Path, _req: &Request) -> TransportResult<Response> {
    Err(TransportError::Io(std::io::Error::other(
        "socket attach is not supported on this platform",
    )))
}

#[cfg(unix)]
pub async fn handle_connection(
    mut stream: tokio::net::UnixStream,
    state: &cubical_engine::state::AppState,
    sink: &dyn cubical_engine::events::EventSink,
) -> TransportResult<()> {
    use cubical_engine::api::types::ScanStatus;

    let req: Request = read_msg_timeout(&mut stream, IO_TIMEOUT).await?;
    let canonical =
        std::fs::canonicalize(&req.vault_path).unwrap_or_else(|_| req.vault_path.clone());
    let response = match cubical_engine::commands::vault::resolve_open_vault(state, &canonical)
        .await
    {
        Some((vault_id, ScanStatus::Complete)) => {
            match crate::dispatch::dispatch(&vault_id, req.command, state, sink).await {
                Ok(outcome) => Response::Ok(outcome),
                Err(e) => Response::Err(e.to_string()),
            }
        }
        Some((_, ScanStatus::InProgress)) => Response::Err("vault is still scanning".to_string()),
        Some((_, ScanStatus::Cancelled)) => Response::Err("vault scan was cancelled".to_string()),
        None => Response::Err("vault not open".to_string()),
    };
    write_msg(&mut stream, &response).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Command, Request};

    #[tokio::test]
    async fn frame_round_trips_over_a_duplex() {
        let (mut a, mut b) = tokio::io::duplex(64);
        let req = Request {
            vault_path: std::path::PathBuf::from("/v"),
            command: Command::List,
        };
        let sent = req.clone();
        let writer = tokio::spawn(async move {
            write_msg(&mut a, &sent).await.unwrap();
        });
        let got: Request = read_msg(&mut b).await.unwrap();
        writer.await.unwrap();
        assert_eq!(got, req);
    }

    #[tokio::test]
    async fn write_msg_rejects_a_frame_over_the_maximum() {
        let (mut a, _b) = tokio::io::duplex(64);
        let huge = "x".repeat(MAX_FRAME as usize + 16);
        let err = write_msg(&mut a, &huge).await.unwrap_err();
        assert!(matches!(err, TransportError::Protocol(_)), "{err:?}");
        assert!(err.to_string().contains("exceeds maximum size"));
    }

    #[tokio::test]
    async fn read_msg_timeout_gives_up_on_a_silent_peer() {
        let (mut a, _b) = tokio::io::duplex(64);
        let err = read_msg_timeout::<_, Request>(&mut a, std::time::Duration::from_millis(20))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, TransportError::Io(e) if e.kind() == std::io::ErrorKind::TimedOut),
            "a silent peer is an I/O condition, not a protocol one: {err:?}",
        );
    }

    #[tokio::test]
    async fn a_reachable_peer_sending_garbage_is_a_protocol_error_not_an_io_error() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let garbage = b"{not json at all";
        let writer = tokio::spawn(async move {
            let len = u32::try_from(garbage.len()).unwrap();
            a.write_all(&len.to_be_bytes()).await.unwrap();
            a.write_all(garbage).await.unwrap();
            a.flush().await.unwrap();
        });
        let err = read_msg::<_, Request>(&mut b).await.unwrap_err();
        writer.await.unwrap();

        assert!(
            matches!(err, TransportError::Protocol(_)),
            "the peer was reachable; only its payload was bad: {err:?}",
        );
    }

    #[tokio::test]
    async fn a_truncated_stream_is_an_io_error() {
        let (a, mut b) = tokio::io::duplex(1024);
        drop(a);
        let err = read_msg::<_, Request>(&mut b).await.unwrap_err();
        assert!(matches!(err, TransportError::Io(_)), "{err:?}");
    }

    #[tokio::test]
    async fn an_oversized_declared_length_is_a_protocol_error() {
        let (mut a, mut b) = tokio::io::duplex(1024);
        let writer = tokio::spawn(async move {
            a.write_all(&(MAX_FRAME + 1).to_be_bytes()).await.unwrap();
            a.flush().await.unwrap();
        });
        let err = read_msg::<_, Request>(&mut b).await.unwrap_err();
        writer.await.unwrap();
        assert!(matches!(err, TransportError::Protocol(_)), "{err:?}");
    }

    #[test]
    fn app_socket_path_lands_in_runtime_dir_and_names_the_pid() {
        let _env = crate::RUNTIME_ENV_GUARD.lock().unwrap();
        std::env::set_var("CUBICAL_RUNTIME_DIR", "/tmp/cubical-ipc-test-rt");
        let p = app_socket_path(4242);
        assert!(p.starts_with("/tmp/cubical-ipc-test-rt"));
        assert_eq!(
            p.file_name().unwrap().to_string_lossy(),
            "cubical-4242.sock"
        );
        std::env::remove_var("CUBICAL_RUNTIME_DIR");
    }
}
