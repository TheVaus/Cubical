//! `cubical-sync` — CRDT abstraction.
//!
//! L0 ships the `CrdtBackend` trait as the planned interface; no implementation
//! exists yet. Loro lands at L7 alongside WebRTC P2P, optional E2EE relay, and
//! the two-tier asset pipeline. See `docs/architecture/planned.md` — "Sync (Layer 7)".
//!
//! Code outside this crate calls the trait, not Loro directly. The trait exists
//! so the boundary is clean — not because a swap is planned.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
