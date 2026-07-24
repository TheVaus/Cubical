#![forbid(unsafe_code)]

mod dispatch;
mod protocol;
mod render;
mod transport;

pub use dispatch::dispatch;
pub use protocol::{Command, Outcome, Request, Response};
pub use render::render;
#[cfg(unix)]
pub use transport::handle_connection;
pub use transport::{
    app_socket_path, client_send, read_msg, read_msg_timeout, write_msg, IO_TIMEOUT,
};

#[cfg(test)]
pub(crate) static RUNTIME_ENV_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[test]
    fn request_round_trips_through_json() {
        let req = Request {
            vault_path: std::path::PathBuf::from("/vaults/alpha"),
            command: Command::Write {
                path: "notes/A.md".into(),
                content: "hello".into(),
            },
        };
        let bytes = serde_json::to_vec(&req).unwrap();
        let back: Request = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn response_round_trips_through_json() {
        let resp = Response::Ok(Outcome::Renamed {
            to: "notes/B.md".into(),
            pending_count: 3,
        });
        let bytes = serde_json::to_vec(&resp).unwrap();
        let back: Response = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(resp, back);
    }
}
