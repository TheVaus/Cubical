# rust-style — Formatted, clippy-clean, no panics outside tests and `main`

**Rule:** `cargo fmt` and `cargo clippy -- -D warnings` must be clean, and `unwrap()`/`expect()` stay out of library code.

**Gate:** `scripts/check.sh` — enforces fmt and `clippy -D warnings`. The no-`unwrap` rule is **not** mechanically checked.

**Why:** The toolchain is pinned in `rust-toolchain.toml` so local builds match CI byte-for-byte and the clippy gate only shifts when the toolchain is bumped deliberately. Errors use `thiserror` in libraries and `anyhow` in the app crate, so a library caller can match on a cause rather than a string. A panic in library code takes down whatever embeds it, including a frontend that had a recovery path available.

**Exceptions:** Tests and `main` may panic. Edition 2021. Note that `examples/` binaries are held to the same no-`expect` standard — `crates/cubical-search/examples/bench.rs` has zero, and `crates/cubical-core/examples/scan_bench.rs` currently violates this with 24 and is known debt.

**Detail:** [`../conventions.md`](../conventions.md) → Rust.
