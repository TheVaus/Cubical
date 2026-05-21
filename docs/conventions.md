# Cubical — Code Conventions

Code-style rules enforced by review and (where noted) by tooling. Load this when editing code; not required reading for every session.

## Rust

- Edition 2021.
- `cargo fmt` and `cargo clippy -- -D warnings` clean before any commit.
- Errors via `thiserror` for libraries, `anyhow` for the app crate.
- No `unwrap()` or `expect()` outside tests and `main`.

## TypeScript

- Strict mode on.
- No `any`.
- Prettier + ESLint.
- Solid idioms: signals for fine-grained state, stores for structured state, `createResource` for async Tauri data.

## Tauri commands

- Coarse-grained, named as verb-noun.
- Every command takes a typed request struct and returns a typed response struct.

## Tests

- `cubical-core`, `cubical-ast`, `cubical-index` have unit tests.
- The app crate has integration tests against a temp vault.
- UI tests deferred until L3+.

## Commits

- Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.).
- One logical change per commit.
- Layer transitions get a tag (`l0`, `l1`, …).

## Documentation

- Every public Rust item has rustdoc.
- Every Tauri command has a doc comment.
- The architecture docs in [`architecture/`](architecture/) and layer specs in `layer-N-spec.md` are the canonical reference; if code disagrees with a spec, the spec wins until explicitly updated.
