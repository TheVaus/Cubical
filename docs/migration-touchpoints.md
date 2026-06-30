# Migration touchpoints

Cubical's shell is **Tauri 2.x**. We don't plan to migrate, but the architecture is structured so that if a swap is ever needed (most likely candidate: `tauri-runtime-verso` for engine consistency, or a future shell that doesn't exist yet), the work is bounded and predictable.

This document is the inventory of Tauri-coupled surfaces. If migration becomes a real conversation, start here.

## Bounded by design — these are the only surfaces that touch Tauri

### Backend (Rust)

1. **`crates/cubical-app/src/lib.rs`** — the Tauri builder, `tauri::generate_context!()` macro call, plugin registration (`tauri-plugin-dialog`, etc.), and `#[tauri::command]`-decorated shim functions. Each shim is a 3-line forwarder to a pure handler in `commands/`.

2. **`crates/cubical-app/src/main.rs`** — desktop entry point that calls `cubical_app::run()`. Trivial.

3. **`crates/cubical-app/src/events.rs`** — defines the transport-agnostic `AppEvent` enum + `EventSink` trait, and the one Tauri adapter `TauriEventSink` (the only place that names `app_handle.emit()`). Pure handlers take `&dyn EventSink` / `Arc<dyn EventSink>` and never name a Tauri type. The lib.rs shims construct a `TauriEventSink` and pass it in; a CLI passes its own sink (`NoopEventSink`, or one that prints).

4. **`crates/cubical-app/Cargo.toml`** — `tauri = "2"`, `tauri-build = "2"`, `tauri-plugin-*` dependencies. Removed/replaced on migration.

5. **`crates/cubical-app/build.rs`** — calls `tauri_build::build()`. Replaced.

6. **`crates/cubical-app/tauri.conf.json`** — Tauri configuration (windows, frontendDist, devUrl, bundle, identifier). Replaced.

7. **`crates/cubical-app/capabilities/`** — Tauri's permission/capability manifests. Replaced; the new shell will need its own permission model.

### Frontend (TypeScript)

8. **`ui/src/api/ipc.ts`** — the **single chokepoint** for backend communication. Imports from `@tauri-apps/api/core` (`invoke`) and `@tauri-apps/api/event` (`listen`). Components only ever import from this file, never directly from `@tauri-apps/*`. On migration, rewrite this file's internals; component call sites don't change.

9. **`ui/package.json`** — `@tauri-apps/api`, `@tauri-apps/plugin-dialog` dependencies. Replaced.

### Tauri-specific user-facing files

10. **App icons** at `crates/cubical-app/icons/` — Tauri's bundle config references them. Most replacement shells will want their own icon format/layout.

## Out by design — these never touch Tauri

By construction, these crates and modules **do not** import `tauri`:

- `crates/cubical-core/` — vault, file watcher, file-type registry, frontmatter I/O
- `crates/cubical-ast/` — canonical AST
- `crates/cubical-index/` — libSQL schema and queries
- `crates/cubical-search/` — Tantivy wrapper (L4)
- `crates/cubical-sync/` — `CrdtBackend` trait, Loro impl (L7)
- `crates/cubical-app/src/commands/` — pure async command handlers
- `crates/cubical-app/src/state.rs` — `AppState` definition (plain Rust types)
- `crates/cubical-app/src/api/types.rs` — request/response struct definitions

This is enforced by code review at minimum, and ideally by a CI check that greps the relevant directories for `use tauri` and fails. A pure handler that imports `tauri` is a bug.

## What a migration would actually look like

For the most likely candidate (`tauri-runtime-verso`):

- Cargo.toml change: add the runtime crate, configure Tauri to use it.
- Possibly `tauri.conf.json` adjustments.
- Frontend: no changes (Verso speaks the same web APIs).
- Test on all three desktop targets.

That's it. This is the path the architecture is optimized for.

For a non-Tauri shell (hypothetical), the bounded surfaces above are the rewrite list. Pure handlers, domain crates, AST, index, search, sync, and the entire frontend logic are reused unchanged. The work is real but contained.

## What we deliberately did NOT do

To keep migration-readiness from costing us today:

- **No `Backend` trait abstraction** with hypothetical alternative implementations. YAGNI; the right abstraction is the pure-handler pattern, not an interface against vapor.
- ~~**No event-emission trait.** A small helper function is enough.~~ **Superseded 2026-06-30:** an `EventSink` trait now exists (see touchpoint 3). The original call was right *while Tauri was the only frontend* — a helper sufficed. The trait earns its keep now that a **CLI is a concrete second consumer**: the engine emits transport-agnostic `AppEvent`s and each frontend supplies its own sink. This is abstracting against a real second implementation, not vapor — the exact threshold the `Backend`-trait bullet above is guarding.
- **No Tauri capability/permission system abstraction.** That's Tauri's unique value; any migration would re-pick a permission model on the new shell.
- **No facade over `tauri-plugin-*` plugins.** The `ipc.ts` chokepoint is the migration boundary; building a second facade adds layers without payoff.

These are the temptations to resist if "migration-friendly" ever drifts into "framework-agnostic for its own sake."
