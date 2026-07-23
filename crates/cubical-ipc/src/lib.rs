#![forbid(unsafe_code)]

mod protocol;

pub use protocol::{Command, Outcome, Request, Response};

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
