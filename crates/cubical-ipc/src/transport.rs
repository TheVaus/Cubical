use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::protocol::{Request, Response};

const MAX_FRAME: u32 = 64 * 1024 * 1024;

pub async fn write_msg<W, T>(w: &mut W, msg: &T) -> std::io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(msg).map_err(std::io::Error::other)?;
    let len = u32::try_from(bytes.len()).map_err(|_| std::io::Error::other("frame too large"))?;
    w.write_all(&len.to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}

pub async fn read_msg<R, T>(r: &mut R) -> std::io::Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf).await?;
    let len = u32::from_be_bytes(len_buf);
    if len > MAX_FRAME {
        return Err(std::io::Error::other("frame exceeds maximum size"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map_err(std::io::Error::other)
}

pub fn app_socket_path(pid: u32) -> PathBuf {
    runtime_dir().join(format!("cubical-{pid}.sock"))
}

fn runtime_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CUBICAL_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    dirs::runtime_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("cubical")
        .join("locks")
}

#[cfg(unix)]
pub async fn client_send(socket_path: &Path, req: &Request) -> std::io::Result<Response> {
    use tokio::net::UnixStream;
    let mut stream = UnixStream::connect(socket_path).await?;
    write_msg(&mut stream, req).await?;
    read_msg(&mut stream).await
}

#[cfg(not(unix))]
pub async fn client_send(_socket_path: &Path, _req: &Request) -> std::io::Result<Response> {
    Err(std::io::Error::other(
        "socket attach is not supported on this platform",
    ))
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
