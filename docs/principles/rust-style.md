# rust-style — Formatted, clippy-clean, no panics outside tests and `main`

**Rule:** `cargo fmt` and `cargo clippy -- -D warnings` must be clean, and `unwrap()`/`expect()` stay out of library code.

**Gate:** `scripts/check.sh` — enforces fmt and `clippy -D warnings`. The no-`unwrap` rule is **not** mechanically checked.

**Why:** The toolchain is pinned in `rust-toolchain.toml` so local builds match CI byte-for-byte and the clippy gate only shifts when the toolchain is bumped deliberately. Errors use `thiserror` in libraries and `anyhow` in the app crate, so a library caller can match on a cause rather than a string. A panic in library code takes down whatever embeds it, including a frontend that had a recovery path available.

**Exceptions:** Tests may panic. Edition 2021. `main` is *permitted* to, but no `main` in the workspace does, and `examples/` binaries are held to the same no-`expect` standard as library code — a harness that panics on a missing fixture reports "thread panicked" where it could have named the missing path, and a benchmark whose whole job is measurement is the worst place to lose that signal. An example that can fail returns `Result` and lets the runtime print the cause.

**Detail:** `rust-toolchain.toml` for the pin; `Cargo.toml` for the `thiserror`/`anyhow` split.
