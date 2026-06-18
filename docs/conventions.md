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
- UI has vitest coverage (live since L3). Current gate counts live in
  `CLAUDE.md`'s Tests block.

## Commits

- Conventional Commits (`feat:`, `fix:`, `refactor:`, etc.).
- One logical change per commit.
- Layer transitions get a tag (`l0`, `l1`, …).

## Branches

- **Branch per stream of work, off `main`.** A multi-session feature or
  layer shares one branch (e.g. `feat/typed-properties`, which several
  sessions build on in sequence). *Unrelated* work — a docs pass, an
  orthogonal fix — gets its **own** branch; don't graft it onto an active
  feature branch.
- **One session at a time in the checkout.** The repo is a single working
  directory with no worktrees, so two sessions running at once share one
  tree and race each other's commits. Run sessions sequentially; if isolated
  parallel work is genuinely needed, it still uses a branch in this same
  checkout, not a second working tree.

## Sessions

- Every session that touches user-facing surface area has an
  interactive `cargo tauri dev` smoke pass *executed* against a real
  vault before the layer or fix tag lands.
- Recorded recipes alone do not satisfy session close. The smoke
  is performed by a human operator; the executed runbook is
  committed alongside the spec with the operator's identifier and
  the build commit.
- A session that cannot run the smoke in its own context (automated
  harness, no operator) records the recipes and *blocks the tag*
  on a follow-up interactive session that runs them.
- Layer transitions get a tag (`l0`, `l1`, …); structural-fix
  sessions use a descriptive suffix (`l4a-fix`).

## Documentation

- Every public Rust item has rustdoc.
- Every Tauri command has a doc comment.
- The architecture docs in [`architecture/`](architecture/) and layer specs in `layer-N-spec.md` are the canonical reference. The doc-wins-over-code precedence rule is owned by [`architecture/README.md`](architecture/README.md).
