# Cubical — Layer 0: Bedrock

The foundation everything else is built on. Layer 0's job is to make the vault concept real, give Rust safe and fast access to it, set up the database and IPC scaffolding, and prove the dev loop works end-to-end with an empty app.

**No feature work in Layer 0.** No editor, no search, no parsing. Just bedrock.

---

## 1. Goals

By the end of Layer 0:

1. A user can launch Cubical, pick a directory to use as a vault, and see an empty Cubical window connected to that vault. `open_vault` returns within 100ms regardless of vault size; scan progress streams to the UI as files are discovered.
2. The vault has a `.cubical/index.db` file with the initial schema.
3. Cubical detects when files in the vault are added, modified, deleted, or renamed (file watcher works).
4. Markdown files are tracked in the index by path. **No UUID injection happens in Layer 0** — frontmatter UUIDs are introduced at L7 as part of "enable sync" onboarding.
5. Non-markdown files are tracked through the polymorphic file-type registry without crashing.
6. There is a working Tauri command from the webview that returns vault metadata, demonstrating the IPC contract.
7. The dev loop (`cargo tauri dev`) is fast and the build is clean (no warnings, clippy clean).
8. The frontend ships a CSS-variable token-surface scaffold (placeholder values are fine) so L2 can drop in real themes without retrofitting components.

What's *not* in Layer 0: parsing markdown into AST, indexing links, computing backlinks, search, the editor, Live Preview, frontmatter content parsing into structured columns, the Pending Rewrites Cache. Those are L1 and beyond. Layer 0 is the load-bearing concrete.

---

## 2. Repository layout

Cargo workspace at the repo root. TypeScript frontend in `ui/`, owned by Vite.

```
cubical/
├── Cargo.toml                  # workspace manifest
├── CLAUDE.md
├── README.md
├── LICENSE                     # MIT
├── .gitignore
├── crates/
│   ├── cubical-core/           # vault, file watcher, file-type registry, frontmatter I/O
│   │   ├── Cargo.toml
│   │   └── src/
│   ├── cubical-ast/            # canonical AST (skeleton only in Layer 0)
│   │   ├── Cargo.toml
│   │   └── src/
│   ├── cubical-index/          # libSQL schema and queries
│   │   ├── Cargo.toml
│   │   └── src/
│   ├── cubical-search/         # Tantivy wrapper (skeleton only in L0; live at L4)
│   │   ├── Cargo.toml
│   │   └── src/
│   ├── cubical-sync/           # CrdtBackend trait (Loro impl lands at L7)
│   │   ├── Cargo.toml
│   │   └── src/
│   └── cubical-app/            # Tauri app
│       ├── Cargo.toml
│       ├── tauri.conf.json
│       ├── build.rs
│       └── src/
├── ui/                         # Solid + TS + Vite frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
└── docs/
    ├── architecture.md
    └── layer-0-spec.md
```

> Note: this was the initial L0 layout. See `CLAUDE.md` for the current repository structure.

### Workspace `Cargo.toml`

Workspace-level dependencies are pinned here so all crates use the same versions.

```toml
[workspace]
members = ["crates/*"]
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"
repository = "https://github.com/<org>/cubical"

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["rt"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml_ng = "0.10"             # YAML 1.2 strict; serde_yaml is unmaintained as of 2024
thiserror = "1"
anyhow = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
notify = "6"
walkdir = "2"
libsql = "0.6"
sha2 = "0.10"                       # content hashing for change detection
# uuid + filetime are NOT in L0 — added at L7 when frontmatter UUIDs are introduced
```

Versions above are placeholders; the first session pins the actual current versions and locks them.

### Crate dependency graph

```
cubical-app
  ├── cubical-core
  ├── cubical-index
  ├── cubical-ast    (skeleton)
  ├── cubical-search (skeleton)
  └── cubical-sync   (skeleton — trait only)

cubical-core   (no workspace deps)
cubical-ast    (no workspace deps)
cubical-index  (depends on cubical-core for shared types)
cubical-search (depends on cubical-ast — indexes the canonical AST, not raw markdown)
cubical-sync   (depends on cubical-ast for diff payloads)
```

`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync` must build and test without Tauri. This is enforced — none of them may depend on `tauri` directly.

The `cubical-search` and `cubical-sync` crates ship as empty skeletons in L0. `cubical-sync` contains only the `trait CrdtBackend` definition (no impl) until L7.

---

## 3. The vault — directory contract

A vault is any directory the user picks. Cubical creates one subdirectory inside it:

```
<vault>/
└── .cubical/
    ├── index.db        # libSQL database
    ├── config.toml     # vault-local config (not used in Layer 0; created empty)
    ├── themes/         # reserved for L5+ user themes (not created in L0)
    └── recovery/       # reserved for L2+ external-edit safety snapshots (not created in L0)
```

The `themes/` and `recovery/` directories are created on demand when their respective layers ship; L0 does not eagerly create them.

### Vault validation

When opening a path as a vault:

1. The path must exist and be a directory.
2. The path must be readable and writable by the current process.
3. If `.cubical/` does not exist, it is created.
4. If `.cubical/index.db` does not exist, the schema is initialized.
5. If `.cubical/index.db` exists with an unknown schema version, the user is prompted (in Layer 0, just refuse to open with a clear error — migration UX is a later concern).

### Vault scanning on open

On vault open, Cubical walks the directory tree. For each file:

- Skip everything inside `.cubical/`, `.git/`, `node_modules/`, and any directory beginning with `.` (configurable later).
- Dispatch to the file-type registry to classify the file.
- For tracked file types, ensure an entry exists in `index.db` keyed by relative path. Compute SHA-256 of file content for change detection.

**The scan is non-blocking.** `open_vault` returns immediately with a `vault_id`; the scan runs as a background Tokio task with a `tokio_util::sync::CancellationToken`. Progress streams to the UI via `vault:scan-progress` events. The UI is fully usable during scan — files appear in the list as they are discovered. Closing the vault during scan cancels cleanly.

No UUID injection happens here — files are tracked by path. Renames detected by the file watcher (post-L0) update the path; renames while the app is closed are reconciled at next scan via inode + content-hash heuristics.

---

## 4. File identity in Layer 0

**Path-based.** Files are identified in the index by their path relative to the vault root. No UUIDs are written into user files at this layer.

Frontmatter UUIDs (`cubical_id: <uuid>` in YAML) are introduced at L7 as part of "enable sync" onboarding. The mtime-preservation dance (read mtime → atomic rewrite → restore mtime via `filetime::set_file_mtime`) lives there, not here. L0 never modifies a `.md` file's content.

### Atomic writes (still relevant)

Even without UUID injection, L0 writes files in some cases — vault-local config (`.cubical/config.toml`), and the libSQL database itself. Any L0 write to a user-visible file uses temp-file-and-rename:

1. Write to `<path>.cubical-tmp`.
2. `fsync` the temp file.
3. `rename` to `<path>` (atomic on POSIX; near-atomic via `MoveFileEx` on Windows).

**Windows retry.** `rename` on Windows can fail if the target is locked (antivirus, OneDrive). Retry 3 times with exponential backoff (50ms, 200ms, 800ms). On final failure: surface a `Io` error to the user, preserve the temp file, log to the audit table.

L0 user-file writes are limited to none — but the helper is in place from day one for L1+ consumers.

---

## 5. File-type registry

A polymorphic registry so non-`.md` files are tracked from day one without special-casing. This is the architecture that lets Canvas (long-tail layer) and other formats slot in cleanly later.

### The trait

```rust
pub trait FileTypeHandler: Send + Sync {
    /// A stable identifier for this handler (e.g., "markdown", "binary", "canvas").
    fn type_id(&self) -> &'static str;

    /// Whether this handler claims the file based on path/extension/sniff.
    fn matches(&self, path: &Path) -> bool;

    /// Compute a content hash for change detection. Implementations may choose
    /// how to derive this (e.g., SHA-256 of the byte stream).
    fn content_hash(&self, path: &Path) -> Result<String, FileTypeError>;

    /// Strip Cubical-specific metadata from a content buffer for export sanitization.
    /// In L0 this is a no-op for all handlers; at L7 the markdown handler will
    /// strip the `cubical_id` frontmatter key.
    fn sanitize_for_export(&self, content: &[u8]) -> Result<Vec<u8>, FileTypeError>;
}
```

The trait is intentionally narrow at L0 — content hashing and export sanitization are the only behaviors. Identity logic (UUID read/write) is added to the trait at L7 when frontmatter UUIDs land.

### Layer 0 implementations

- `MarkdownHandler` — handles `.md` and `.markdown`. Hashes file content. `sanitize_for_export` is a no-op until L7.
- `BinaryHandler` — handles everything else. Records the file in libSQL by path + content hash. Asset deduplication (`.assets/<hash>` paths) lands in the L1+ asset pipeline; L0 just tracks that the file exists.

The registry is a `Vec<Box<dyn FileTypeHandler>>` queried in order; first match wins.

### Why this matters in Layer 0

If we don't put the registry in place now, every later piece of code will assume "files are markdown" and we'll find ourselves rewriting half of `cubical-core` when Canvas arrives. Cost-of-doing-it-now is small; cost-of-doing-it-later is enormous.

---

## 6. File watcher

`notify` 6.x with the `RecommendedWatcher` (uses native OS APIs: FSEvents on macOS, ReadDirectoryChangesW on Windows, inotify on Linux).

### Events

The watcher emits these events to a Tokio channel:

- `Created(path)`
- `Modified(path)`
- `Removed(path)`
- `Renamed { from: path, to: path }` — when the OS reports it as a rename. When the OS reports a delete-then-create, the watcher tries to correlate by inode within a short window.

### Debouncing

Some platforms emit multiple events for a single user action. The watcher uses a 100ms debounce window, coalescing events for the same path.

### What Layer 0 does with events

In Layer 0, events are routed to a stub handler that:

1. Logs the event to `tracing` and the audit table.
2. Updates the `files` table's `last_seen` and (for `Modified`/`Created`) `mtime_unix` and `content_hash`.
3. Emits a `vault:file-changed` event to the frontend within 200ms (via the 100ms debounce + a small queue).

The full event-handling logic — link rewrites, Pending Rewrites integration, external-edit reconciliation with the merge UI — lands in L1 and L2.

---

## 7. libSQL schema (Layer 0 initial)

Stored at `<vault>/.cubical/index.db`. The schema is versioned via a `schema_version` table. Migrations run on open; if version is unknown (newer than this build), refuse to open.

### Tables

```sql
-- Schema versioning. version = 1 in Layer 0.
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY
);
INSERT INTO schema_version (version) VALUES (1);

-- The vault's tracked files. Identified by path in L0; gains a nullable
-- `cubical_id` column at L7 when frontmatter UUIDs are introduced.
CREATE TABLE files (
    path          TEXT PRIMARY KEY,           -- relative to vault root
    type_id       TEXT NOT NULL,              -- file-type handler id
    size_bytes    INTEGER NOT NULL,
    mtime_unix    INTEGER NOT NULL,           -- last modification time
    content_hash  TEXT NOT NULL,              -- SHA-256 hex; used for change detection
    inode         INTEGER,                    -- nullable; used for rename heuristics on close-time scans
    last_seen     INTEGER NOT NULL,           -- unix ts of last vault scan that saw this
    created_at    INTEGER NOT NULL,           -- unix ts of first scan
    updated_at    INTEGER NOT NULL            -- unix ts of last metadata update
);
CREATE INDEX idx_files_type  ON files(type_id);
CREATE INDEX idx_files_inode ON files(inode);

-- App-level config (vault-scoped). Used for things like "last opened tab",
-- "user-set asset folder if ever made configurable", etc. Layer 0 leaves empty.
CREATE TABLE config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Audit log of significant Cubical operations. Useful for debugging.
-- Auto-pruned to 10000 most recent rows.
CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    level     TEXT NOT NULL,                  -- 'info' | 'warn' | 'error'
    category  TEXT NOT NULL,                  -- 'scan' | 'watcher' | 'uuid' | 'ipc' | ...
    message   TEXT NOT NULL,
    detail    TEXT                            -- optional JSON blob
);
CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
```

### Tables reserved but not created in Layer 0

These come online in their own layers but are listed here so future migrations are predictable:

- `frontmatter` (parsed YAML keys for Dataview-style queries) — Layer 1
- `wiki_links`, `block_refs`, `blocks`, `tags`, `pending_rewrites` — Layer 3
- `tantivy_meta` — Layer 4
- `crdt_operations`, `crdt_snapshots` — Layer 7
- `time_machine_snapshots`, `time_machine_blobs` — Layer 8 (post-v1.0)
- `embeddings` — exposed as a plugin capability post-L6; no core schema commitment

### Migration system

A simple linear migration runner:

```rust
const MIGRATIONS: &[Migration] = &[
    Migration { version: 1, up: include_str!("../migrations/001_initial.sql") },
    // future:
    // Migration { version: 2, up: include_str!("../migrations/002_links.sql") },
];
```

On open: read current `schema_version`, run all migrations with `version > current`, in order, in a single transaction.

---

## 8. Tauri command surface (Layer 0)

The full Lane 1 ↔ Lane 2 IPC contract for Layer 0. Each command has a typed request and response struct. All commands are async and return `Result<Response, CubicalError>`.

### Pattern: pure handler + thin Tauri shim

Every command is implemented as a **pure async function** in `cubical-app/src/commands/*.rs` taking a plain `&AppState` reference and a typed request, returning a typed response. **The pure handler imports nothing from `tauri`.** Tauri-specific wiring lives in a thin shim in `cubical-app/src/lib.rs`.

```rust
// crates/cubical-app/src/commands/vault.rs — pure, no tauri imports
pub async fn open_vault(
    state: &AppState,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    // ... actual logic ...
}

// crates/cubical-app/src/lib.rs — thin Tauri shim
#[tauri::command]
async fn open_vault(
    state: tauri::State<'_, AppState>,
    req: OpenVaultRequest,
) -> Result<OpenVaultResponse, CubicalError> {
    commands::vault::open_vault(state.inner(), req).await
}
```

This pattern serves two purposes simultaneously:

1. **Testability.** Pure handlers are unit-testable without booting a Tauri test harness — you construct an `AppState`, call the handler, assert on the result.
2. **Migration-friendliness.** If Cubical ever swaps Tauri (e.g., for `tauri-runtime-verso` later, or a different shell entirely), the migration is "rewrite the shims," not "rewrite the logic." See `docs/migration-touchpoints.md`.

`AppState` is plain Rust — no `tauri::State<T>` baked into the type. Tauri wraps it via `app.manage(state)`; the shim does the `state.inner()` unwrap before calling the pure handler.

### Request / response types

Defined in `cubical-app/src/api/types.rs`. Plain serde structs, no Tauri-specific decorators.

### Commands

```rust
// Open a vault at the given path. Creates .cubical/ if missing.
// Returns immediately — the scan runs as a background Tokio task.
#[command]
async fn open_vault(req: OpenVaultRequest) -> Result<OpenVaultResponse, CubicalError>;

struct OpenVaultRequest {
    path: PathBuf,
}
struct OpenVaultResponse {
    vault_id: String,            // session-scoped vault handle
    scan_status: ScanStatus,     // "in_progress" on first open
}
enum ScanStatus {
    InProgress,
    Complete,                    // returned if a prior scan already finished and DB is fresh
}

// Cancel an in-flight scan for a vault. Idempotent — no-op if scan is already complete.
#[command]
async fn cancel_vault_scan(req: CancelVaultScanRequest) -> Result<(), CubicalError>;

struct CancelVaultScanRequest {
    vault_id: String,
}

// Get summary metadata for the open vault. Safe to call during scan;
// counts reflect what's been discovered so far.
#[command]
async fn get_vault_info(req: GetVaultInfoRequest) -> Result<GetVaultInfoResponse, CubicalError>;

struct GetVaultInfoRequest {
    vault_id: String,
}
struct GetVaultInfoResponse {
    path: PathBuf,
    file_count: u32,
    markdown_count: u32,
    binary_count: u32,
    schema_version: u32,
    scan_status: ScanStatus,
}

// List files in the vault. Layer 0 returns a flat list; Layer 3 will add hierarchy.
// Safe to call during scan; returns whatever has been discovered so far.
#[command]
async fn list_files(req: ListFilesRequest) -> Result<ListFilesResponse, CubicalError>;

struct ListFilesRequest {
    vault_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
}
struct ListFilesResponse {
    files: Vec<FileEntry>,
    total: u32,
}
struct FileEntry {
    path: String,                // primary identifier in L0
    type_id: String,
    size_bytes: u64,
    mtime_unix: i64,
}

// Close the open vault. Cancels any in-flight scan; flushes any pending writes.
#[command]
async fn close_vault(req: CloseVaultRequest) -> Result<(), CubicalError>;

struct CloseVaultRequest {
    vault_id: String,
}
```

### Events (Lane 2 → Lane 1)

Tauri events emitted by the backend during Layer 0:

- `vault:scan-progress { vault_id, files_processed, files_total_estimate }` — `files_total_estimate` is a rolling estimate based on directory entries seen so far; it converges to the true total as scan completes.
- `vault:scan-complete { vault_id, file_count, duration_ms }` — emitted exactly once per vault open.
- `vault:scan-cancelled { vault_id }` — emitted if `cancel_vault_scan` or `close_vault` was called during scan.
- `vault:file-changed { vault_id, path, kind: "created"|"modified"|"removed"|"renamed", from_path?: string }` — `from_path` is set only when `kind == "renamed"`.
- `vault:audit { level, category, message }` — live tail of the audit log for debugging UIs.

### Event names + payloads live in one place

Event name strings and their typed payload structs are defined in `cubical-app/src/events.rs` — one constant per event, one struct per payload. Pure handlers call a small `emit_*` helper that wraps `app_handle.emit()`; they never hand-roll the string name or call Tauri's emit API directly. If the event surface ever migrates, only `events.rs` changes.

---

## 9. Errors

Defined in `cubical-core` and re-exported. Every fallible operation in Layer 0 returns `Result<T, CubicalError>`.

```rust
#[derive(Debug, thiserror::Error)]
pub enum CubicalError {
    #[error("vault not found: {0}")]
    VaultNotFound(PathBuf),

    #[error("vault path is not writable: {0}")]
    VaultNotWritable(PathBuf),

    #[error("schema version {0} is newer than this build supports")]
    SchemaVersionUnsupported(u32),

    #[error("file not found: {0}")]
    FileNotFound(PathBuf),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Db(#[from] libsql::Error),

    #[error("watcher error: {0}")]
    Watcher(#[from] notify::Error),

    #[error("file type error: {0}")]
    FileType(String),

    #[error("scan cancelled")]
    ScanCancelled,

    #[error("invalid request: {0}")]
    InvalidRequest(String),
}
```

`CubicalError` serializes to a JSON shape suitable for the frontend:

```json
{ "code": "VaultNotWritable", "message": "vault path is not writable: /Users/x/foo" }
```

---

## 10. Frontend (Layer 0)

A minimal Solid app that proves the dev loop works.

### What it does

1. On startup, shows an empty window with an "Open Vault" button.
2. Clicking the button opens a native folder picker.
3. After selection, calls `open_vault`. The window is fully usable from t=0 — no blocking spinner.
4. The status bar shows scan progress driven by `vault:scan-progress` events.
5. The file list streams in as `vault:scan-progress` fires; clicking a file in the partial list shows its metadata immediately.
6. On `vault:scan-complete`, the status bar replaces "Scanning…" with the final file count.

The point is to prove the IPC contract works end-to-end and the Solid + Vite + Tauri integration is healthy. Visual polish is intentionally minimal.

### Token surface scaffold

Even at L0, the frontend ships `ui/src/styles/tokens.css` with a placeholder token surface. Components consume tokens (`var(--c-bg-primary)`, etc.) instead of hardcoded colors. The token values can be placeholders — the goal is structural: when L2 lands real themes, every component already consumes the surface and there's no retrofit.

### Stack pin

- Solid 1.x
- TypeScript strict mode
- Vite 5+
- `@tauri-apps/api` 2.x

### File structure

```
ui/
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
└── src/
    ├── main.tsx              # entry point
    ├── App.tsx               # the empty-window UI
    ├── api/
    │   └── ipc.ts            # typed wrappers — single chokepoint for backend calls
    └── styles/
        ├── tokens.css        # CSS-variable token surface (placeholders in L0)
        └── base.css          # element resets + token consumption
```

The `api/ipc.ts` module is the **single point in the frontend that knows about the backend transport.** Today that transport is Tauri's `invoke` + event system; the file is named `ipc.ts` rather than `tauri.ts` so the name doesn't lie about its role and so a future transport swap doesn't leave a misleading filename. Components call typed functions like `openVault(path)` and `getVaultInfo(id)`, never raw `invoke('open_vault', ...)`. When the API surface grows, the cost of finding-and-replacing is paid in one file.

The `styles/tokens.css` file is the **single source of truth for design tokens.** It is enforced (by code review at minimum, lint rule by L2) that no other file hardcodes colors, fonts, or spacings — they all reference token variables. This makes L2's theming work additive, not a refactor.

---

## 11. Logging and observability

Both Rust and the frontend log structured events.

### Rust

`tracing` with `tracing-subscriber`. Logs go to stderr in dev and to a file in release (`<vault>/.cubical/cubical.log`, rotated daily). Significant events also write to the `audit_log` table.

### Frontend

Console logging in dev. The frontend can subscribe to the `vault:audit` event to display live backend logs in a debug panel — useful during Layer 0 development.

---

## 12. Definition of done for Layer 0

The Layer is complete when *all* of these are true:

1. `cargo build` and `cargo build --release` succeed cleanly with no warnings on macOS, Windows, and Linux.
2. `cargo clippy --all-targets --all-features -- -D warnings` passes.
3. `cargo test` passes with at least:
   - File-type registry dispatch tests (`MarkdownHandler::matches`, `BinaryHandler::matches`, content hashing).
   - libSQL schema migration test (fresh DB, version 1 applied).
   - Atomic write tests (temp-file-and-rename round-trip, retry-on-lock simulation).
   - Tauri command unit tests for each command in §8.
   - Vault scan correctness test: 100 sample files, scan completes, all 100 rows in `files` table.
4. `cargo tauri dev` opens a window. Clicking "Open Vault" on a folder containing 10 sample `.md` files results in: `index.db` containing 10 rows in `files` (no file content modified — verified by SHA-256 of each `.md` file before and after open), the UI listing all 10 files, no UUID injected anywhere.
5. **`open_vault` returns within 100ms regardless of vault size.** Tested with a synthetic 10,000-file vault: command resolves in <100ms; `vault:scan-progress` events fire; `vault:scan-complete` fires with the final count.
6. Modifying one of the `.md` files externally (in a separate editor) while Cubical is open results in a `vault:file-changed` event reaching the frontend within 200ms.
7. Closing the vault during an in-flight scan results in a clean `vault:scan-cancelled` event and no orphan Tokio tasks (verified via task tracking in tests).
8. The frontend ships `ui/src/styles/tokens.css` and consumes it; no component contains hardcoded colors, fonts, or spacings.
9. `CLAUDE.md`'s "Project state" section is updated to reflect Layer 0 complete and Layer 1 next.

---

## 13. First-session task list

The very first Claude Code session, in order:

1. Initialize the repo, write `.gitignore`, write `LICENSE` (MIT), write `README.md` (one paragraph).
2. Create the workspace `Cargo.toml` and the **six** crate directories (`cubical-core`, `cubical-ast`, `cubical-index`, `cubical-search`, `cubical-sync`, `cubical-app`) with their `Cargo.toml` skeletons.
3. Set up the Tauri scaffolding in `cubical-app` (`tauri.conf.json`, `build.rs`, minimal `main.rs`).
4. Set up the `ui/` Vite + Solid + TS skeleton **including `styles/tokens.css` with placeholder values and `styles/base.css` consuming the tokens**.
5. Verify `cargo tauri dev` opens an empty window. **Stop here, commit.**

The `cubical-app` crate is structured around the pure-handler / thin-shim pattern from §8 even at scaffold time:

```
crates/cubical-app/src/
├── api/
│   ├── mod.rs
│   └── types.rs        # request/response structs (no tauri imports)
├── commands/
│   └── mod.rs          # pure handlers go here (no tauri imports)
├── events.rs           # event names + payloads + emit_* helpers (Tauri-coupled)
├── state.rs            # AppState (no tauri imports)
├── lib.rs              # tauri::Builder; #[tauri::command] shims forward to commands::*
└── main.rs             # desktop entry point
```

Subsequent sessions implement, in roughly this order: file-type registry trait → markdown + binary handlers (no UUID logic) → libSQL schema and migrations → vault open/scan logic (non-blocking) → file watcher → pure command handlers in `commands::vault` → Tauri shims in `lib.rs` → frontend wiring through `ui/src/api/ipc.ts` → tests → DoD verification.

Session protocol is maintained in `CLAUDE.md` — see the "Session protocol" section there.

---

## 14. What was built

### 14.1 Sessions

- **2026-05-05** — Initial workspace, Tauri scaffold, `ui/` skeleton, `tokens.css` + `base.css`, `ipc.ts`. `cargo tauri dev` verified.
- **2026-05-06 (registry)** — `FileTypeHandler` trait, `FileTypeError`, `FileTypeRegistry`, `MarkdownHandler`, `BinaryHandler`, `sha256_file_hex` helper. 10 unit tests.
- **2026-05-06 (migration runner)** — `open_index`, `Migration` struct, `MIGRATIONS` slice, `IndexError`, `001_initial.sql` (4 tables + 3 indexes). 4 `tokio::test` tests.
- **2026-05-07** — `Vault` type, `scan()`, 5 Tauri shims (`open_vault` / `cancel_vault_scan` / `get_vault_info` / `list_files` / `close_vault`), `spawn_scan_dispatcher`, `CubicalError`, frontend open-vault flow, 200ms-throttled list refresh. 28 tests total.
- **2026-05-08** — `WatchEvent` enum, `start_watcher()`, `WatcherHandle`, `notify` + `notify-debouncer-full` (100ms debounce + 25ms tick), `spawn_watcher_dispatcher`, `apply_watch_event_to_db`, audit_log rows. Frontend `VaultFileChanged` listener. 43 tests total.

### 14.2 Deviations from spec

1. **Dep direction (§2 crate graph):** `cubical-index` no longer depends on `cubical-core`; direction reversed. `cubical-core` now depends on `cubical-index` (for `IndexConn`) and on `libsql` (for `params!`).
2. **CubicalError location (§9):** lives in `cubical-app`, not `cubical-core`. Required by dep direction — must be downstream of all error sources.
3. **macOS FSEvents (§6):** `notify-debouncer-full` 0.3 coalesces synthetic Modify/Remove events in tests. Real editor flows work correctly. `translate_event` is fully unit-tested via synthetic `DebouncedEvent`s. `notify` 8.x + debouncer 0.6 is a candidate future fix.
4. **Rename persistence (§6):** `apply_watch_event_to_db` for `Renamed` refreshes `last_seen` on the from-row only — does not update the `path` column or insert a to-row. Next vault scan handles it. Proper rename handler deferred to L3 Pending Rewrites Cache.

### 14.3 Outstanding items

- `audit_log` auto-pruning to 10 000 rows (spec §7) is a TODO. Table grows unbounded until this lands.

### 14.4 Smoke test status — BLOCKING for `l0` tag

§12 DoD #4 and #6 were NOT completed interactively (non-interactive session harness).

Before tagging `l0`:
- **(a)** Run `cargo tauri dev`; open a 10-file folder; verify the five scan DoD points (§12 #4).
- **(b)** Modify a `.md` file externally; verify `vault:file-changed` reaches the frontend within ~300ms (§12 #6).
- **(c)** Recreate the `cubical-cancel-test` fixture (2000–5000 plain `.md` files outside the repo) for the cancel-during-scan check.

### 14.5 Test counts (final)

`cubical-core` 34 · `cubical-app` 5 · `cubical-index` 4 = **43 tests**

### 14.6 Session protocol change

The session protocol in §13 was updated to redirect to `CLAUDE.md` rather than state the protocol inline. Current protocol: sessions rewrite the 4-6 line Project state block in `CLAUDE.md` and record milestones in the relevant layer spec's "What was built" section.
