# Cubical — Code Conventions

Code-style rules enforced by review and (where noted) by tooling. Load this when editing code; not required reading for every session.

## Comments

**Source files carry no explanatory comments.** Rationale, invariants and
design reasoning live in [`implementation/`](implementation/) (one file per
domain) or in the architecture docs — not in the code. A comment is allowed
only as a **brief one-liner**: a pointer to the owning doc, a `TODO(...)`
marker, or a short section label in a long stylesheet.

This applies to doc-comments too (`///`, `//!`, JSDoc `/** */`) — they are
prose about the code like any other comment. Consequences of that choice, all
deliberate:

- `#![warn(missing_docs)]` is **not** used. With crate-level docs removed it
  fires on the crate itself, and `clippy -D warnings` turns that into a build
  failure. Don't re-add it without also re-adding crate docs.
- **CLI help text is data, not documentation.** clap's `--help` strings are
  written as explicit `#[arg(help = "…")]` / `#[command(about = "…")]`
  attributes, never as doc comments — a doc comment there would be swept up by
  a cleanup pass and silently degrade `--help`.

### Comments that must never be stripped

A few comment-shaped lines are **functional** — the toolchain reads them, and
removing them breaks the build or the tests:

| Pragma | Where | Removing it |
|---|---|---|
| `// @vitest-environment jsdom` | first line of DOM-touching test files | drops those files to the `node` env — ~50 tests fail on `document is not defined` |
| `/// <reference types="vitest" />` | `ui/vite.config.ts` | loses the Vitest config types |

Treat these as code. Any future comment sweep must preserve them and re-run
`scripts/check.sh` to prove it.

## Rust

- Edition 2021; toolchain pinned in `rust-toolchain.toml` (CI uses the same).
- `cargo fmt` and `cargo clippy -- -D warnings` clean before any commit (CI enforces both).
- Errors via `thiserror` for libraries, `anyhow` for the app crate.
- No `unwrap()` or `expect()` outside tests and `main`.

## TypeScript

- Strict mode on.
- No `any`.
- Prettier + ESLint.
- Solid idioms: signals for fine-grained state, stores for structured state, `createResource` for async Tauri data.

## UI components

- **Reach for the design system (`@ds`) before hand-rolling a control.** `design-system/` is the app's component library and token source; `ui/` borrows from it. When a component is missing a prop you need, extend the design system additively (default to prior behavior) rather than forking it app-side, and keep DS components self-contained (no dependency on the playground's global stylesheets). The locked rules and the list of deliberately-bespoke exceptions live in [`architecture/ui.md`](architecture/ui.md) §11.6.

## Tauri commands

- Coarse-grained, named as verb-noun.
- Every command takes a typed request struct and returns a typed response struct.

## Tests

- `cubical-core`, `cubical-ast`, `cubical-index` have unit tests.
- The app crate has integration tests against a temp vault.
- UI has vitest coverage (live since L3). Counts are a query, not a recorded
  fact — run `scripts/check.sh`.

## Continuous integration & dependencies

- **CI runs the gate set on every PR to `main` and every push to `main`**
  (`.github/workflows/ci.yml`). It provisions toolchains and runs
  `scripts/check.sh` — *the* single source of truth for what "green" means
  (fmt, clippy, Rust tests, tsc, vitest, UI build, docs check). Add or remove a
  gate in `check.sh` and CI follows automatically; don't duplicate the gate list
  in the workflow.
- **A gate that reaches into a new workspace still needs an install step**, which
  is the one thing CI does *not* follow automatically. Adding the design-system
  `tsc` gate without one left `npx` in a directory with no local typescript, so
  it fetched a registry package of the same name and failed — silently killing
  every downstream gate for twelve days (fixed 2026-07-31). Two rules follow: a
  new gate directory gets a matching `npm ci` in the workflow, and a green run
  after such a change must be confirmed on the PR, not assumed from local.
- **Gate order is load-bearing: the frontend gates run first.** Tauri's
  `generate_context!()` embeds `ui/dist` at compile time, so the bundle must
  exist before any cargo step that builds `cubical-app`. Building it up front
  keeps the gate correct from a clean checkout (CI included), not just when a
  stale `ui/dist` happens to be lying around.
- **Rust toolchain is pinned** (`rust-toolchain.toml`). Local builds match CI
  byte-for-byte, and the `clippy -D warnings` gate only shifts when the toolchain
  is bumped deliberately, not whenever a new stable ships. Bump it in its own
  commit; the gate re-validates.
- **Third-party Actions are pinned to commit SHAs** (with a version comment), not
  mutable tags — supply-chain hardening consistent with the plugin-sandbox stance.
- **Dependabot** (`.github/dependabot.yml`) opens weekly update PRs for `cargo`,
  `npm`, and `github-actions` (minor/patch grouped, majors individual); security
  alerts + automated security fixes are on. Each Dependabot PR is CI-gated like
  any other.

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

**Ceremony scales with the work — don't pay layer-scale process for a small
change.** Pick the lightest row that fits:

| Task | Process | Process docs |
|---|---|---|
| Trivial / mechanical (typo, rename, obvious fix) | just do it, then commit | none |
| Standard feature surface | **one** working doc — design + task list together, written once — then record what landed in the layer spec at session end | 1 |
| Layer / novel / architectural | full brainstorm → spec → plan → closeout | the `superpowers/` set |

- **Write outcomes once, at the end — capture the *why*, not the *what*.**
  Don't live-update the layer spec mid-session. In its §"What was built",
  record **decisions** (including rejected alternatives), **deviations from
  the plan**, and **non-obvious constraints** — the things that evaporate if
  unwritten. Skip narration the code and git already show: files touched,
  step-by-step build logs, per-session test counts. A good record is closer
  to 5–10 lines of *why* than a 100-line build log.
- **Record divergence explicitly.** When the work departs from the plan
  written above it, note the deviation — don't leave the superseded plan to
  silently contradict what shipped. The plan stays (it's the valuable record
  of original intent); the deviation reconciles it with reality.

**Smoke testing.** Run an interactive `cargo tauri dev` smoke for any change
that touches a rendered or interactive surface, and note in the session that
it passed — that's enough for per-session work. Headless/backend-only work
needs no GUI smoke.

- The **recorded** runbook (operator identifier + build commit, committed
  alongside the spec) is required only at **layer-close**, as the gate for
  the layer tag — not every session.
- A layer-close that can't run the operator smoke in its own context records
  the recipe and blocks the **layer tag** (not individual sessions) on a
  follow-up interactive pass.
- Layer transitions get a tag (`l0`, `l1`, …); structural-fix sessions use a
  descriptive suffix (`l4a-fix`).
- **Discrete deferred / parked work goes to GitHub Issues** (labels `perf`,
  `parked`, `area:*`), not buried in doc prose where it rots — e.g. the perf
  anti-patterns and the typed-properties registry rework. The *roadmap* still
  lives in `build-order.md`; Issues hold the loose backlog that hangs off it.

## Documentation

- The architecture docs in [`architecture/`](architecture/) and layer specs in `layer-N-spec.md` are the canonical reference. The doc-wins-over-code precedence rule is owned by [`architecture/README.md`](architecture/README.md).
- Comment rules, doc-comments (`///`, `//!`, JSDoc) included, are owned solely by §Comments above.
