//! `cubical-engine` — the frontend-agnostic core.
//!
//! Everything a frontend needs to drive a vault, with **no Tauri** (and no
//! UI assumptions): the pure async command handlers ([`commands`]), the
//! shared [`state`], the transport-agnostic event vocabulary + [`EventSink`]
//! trait ([`events`]), the IPC request/response types ([`api`]), and the
//! error type ([`error`]).
//!
//! Two frontends consume this crate:
//! - `cubical-app` — the Tauri shell. Its `#[tauri::command]` shims forward
//!   to these handlers and supply a `TauriEventSink`.
//! - a future CLI — calls the same handlers with its own [`EventSink`].
//!
//! The only place Tauri is named is the `TauriEventSink` adapter, which lives
//! with the Tauri shell, not here. See `docs/migration-touchpoints.md`.
//!
//! [`EventSink`]: events::EventSink

#![forbid(unsafe_code)]

pub mod api;
pub mod commands;
pub mod error;
pub mod events;
pub mod state;
