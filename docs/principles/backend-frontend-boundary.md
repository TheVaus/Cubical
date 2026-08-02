# backend-frontend-boundary — The webview never gets shell or broad filesystem access

**Rule:** Route every frontend request through the typed IPC surface; do all heavy work in Rust.

**Gate:** none yet — planned `dependency-boundary`.

**Why:** A strict IPC allowlist is what makes the webview untrusted-by-default. All file I/O, parsing, indexing, CRDT work and embeddings run Rust-side — for security and because that is where the performance bar is met. IPC is a single chokepoint so a mistyped key fails to compile rather than reading `undefined` at runtime.

**Exceptions:** none, and the terminal is not one. Rust owns the PTY and the child process; the webview receives an opaque byte stream and sends keystrokes. The capability is granted to the *child process*, by the Rust core, at the user's explicit request — see [`native-capability-gateway.md`](native-capability-gateway.md).

**Detail:** [`../architecture/foundation.md`](../architecture/foundation.md) §2 · [`../implementation/engine-ipc.md`](../implementation/engine-ipc.md) · [`../migration-touchpoints.md`](../migration-touchpoints.md).
