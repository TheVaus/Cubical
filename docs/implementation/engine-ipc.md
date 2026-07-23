# Implementation — engine command + event layer (`cubical-engine`)

Boundary inventory owner:
[`../migration-touchpoints.md`](../migration-touchpoints.md).

## Handler pattern

Every command is a plain `async fn(&AppState, TypedRequest) -> Result<Response,
CubicalError>` with **no Tauri import**. The Tauri shims in `cubical-app` are
3-line forwarders that pull state and call in. Two reasons, both load-bearing:
handlers stay unit-testable without booting Tauri, and a shell swap rewrites
only the shims.

IPC request/response types are framework-free `serde` structs for the same
reason — they survive a shell migration unchanged.

## Error folding

The IPC boundary speaks exactly one error type. `CubicalError` folds the
crate-local errors into one enum with a stable JSON shape.

It lives **downstream of both** `cubical-core` and `cubical-index` because the
dep graph requires it (core consumes index). The layer spec originally placed
it in core; that placement is not achievable and the divergence is deliberate.

## Event sink

The engine produces transport-agnostic events and hands them to an
`EventSink`. Tauri supplies one forwarding to `AppHandle::emit`, the CLI a
no-op, tests a collector. This is what lets handlers and background tasks carry
no Tauri dependency — the only Tauri code is the sink adapter.

`events.rs` is the **single chokepoint** for backend → frontend events.
Handlers never emit directly; they call the `emit_*` helpers. A transport
migration touches this one file.

## Dispatchers

Both are spawned by `open_vault` and live beside the sink because they touch
the transport, keeping the pure handlers clean.

- **Scan dispatcher** — forwards progress events and emits exactly one terminal
  event (complete or cancelled), updating the stored scan status so later
  `get_vault_info` calls agree.
- **Watcher dispatcher** — persists each event to the index, writes an
  `audit_log` row, and emits the file-changed event. Errors are logged and the
  loop continues; one failed event must not take the watcher down.

On a delete the file's row is dropped so it leaves the tree, and the cascading
foreign keys carry its **outbound** rows with it. **Inbound** references from
other files have no FK and are left intact, so they correctly degrade to broken
links.

## Own-write hash gate

A flush inserts `(path, content_hash)` into a per-vault gate **before** the
atomic write. The watcher dispatcher, after hashing the post-write file,
removes the matching entry and suppresses the file-changed emit.

This is the backend mirror of the editor-side hash gate: flush writes have no
editor to match them, so without the gate they bounce back into the UI as
external edits and re-trigger reads.

## Rename

`rename_file` runs as one transaction: resolve referrers → mint a rename op id
→ enqueue one pending row per distinct referrer → **explicit FK rekey** of every
child table → update the path. After commit: move the file, re-extract its
outbound rows, emit.

Two ordering constraints are easy to break:

- **No FK has `ON UPDATE CASCADE`**, so children must be rekeyed *before* the
  parent path update, and the transaction must already have
  `PRAGMA defer_foreign_keys = 1` so the intermediate state doesn't trip
  `ON UPDATE NO ACTION`.
- Phase A (collect referrers) is **read-only**, so it is safe to call for every
  file in a batch before any of them are rewritten — each call sees the same
  pre-rename snapshot. `rename_folder` reuses the same per-file phases across a
  subtree in one transaction under a single shared op id, resolving referrers
  that are themselves being renamed to their final path first.

Cross-filesystem folder moves (`EXDEV`) are unsupported — a recursive
copy-then-remove fallback for a whole subtree is out of scope. For a single
file, the same-FS `rename` fast path falls back to copy-then-remove through the
atomic writer so observers never see a half-written destination.

### Coalescing

Enqueue coalesces on `(target_file, kind, old_token)`. `old_token` is the
referrer's untouched on-disk text, which is stable across a chain of renames
because the referrer isn't flushed between them. So repeated renames collapse
onto one row instead of stacking, and when the resulting `new_token` equals
`old_token` the row is dropped (never inserted, if brand-new).

The effect: an `A → B → A` round trip cancels to zero rather than doubling. The
count reflects *net* edits. Coalescing runs inside the caller's transaction so
it is atomic with the FK rekeys.

### Journal replay

After a scan, each surviving journal entry whose `from` is gone but whose `to`
is tracked reconnects referrer links still naming `from` and re-enqueues their
rewrites under a fresh op. This is what makes "wipe the disposable index
mid-rename" recover instead of stranding referrers.

An entry is pruned once no referrer text still names `from` (the rewrites baked
into the `.md` files) or once `to` itself vanishes. Best-effort: errors are
logged and swallowed so a bad journal can never wedge vault open.

## Audit log retention

`audit_log` is capped at the newest `AUDIT_LOG_MAX_ROWS` (10 000) rows, per
layer-0-spec §7. `cubical_index::prune_audit_log` is called from two places,
both **best-effort** — a prune failure is logged and never blocks the caller:

- `open_index`, so growth is bounded across sessions;
- the watcher's per-burst batch, so one long-running session stays bounded too.

The prune is cheap enough to call per burst because it short-circuits on an
O(1) guard: ids are unique and increasing, so when `MAX(id) - MIN(id)` is under
the cap the table cannot exceed it and the delete is skipped entirely.

## Batching (a fixed perf cliff — don't undo it)

The watcher dispatcher deliberately does **not** commit the search index per
event. It applies a drained burst to the index and then commits Tantivy **once**
for the whole batch.

This is not a micro-optimisation. A bulk rewrite — a rename flushing pending
rewrites across thousands of backlinks — fires one watch event per file. A
commit per event means O(n) segment merges, fsyncs and GC, which turned a large
flush into a multi-minute hang. One commit per burst makes it O(1) commits
instead of O(events). A regression test guards it.

The same "caller commits" contract is what the scan path and the search
refresher already follow. Don't add a per-event commit back.

## State handles

`AppState` is plain Rust with no Tauri import; the shell manages it and pure
handlers take `&AppState`.

The vault map is `Arc<RwLock<…>>` rather than a bare `RwLock` specifically so
background tasks (the scan and watcher dispatchers) can hold a **stable handle
across `await` points**. An open vault stores its cancellation token but not
the dispatcher's join handle — the dispatcher detaches once started, and
cancelling is enough to bring it down responsively.

## Settings routing

Writes are routed by key: durable (non-`ui.*`) keys go to the portable
`.cubical/config.toml` via an atomic fsync+rename inside `spawn_blocking`;
`ui.*` workspace keys upsert the index `config` table. Session-local layout
state must not land in the portable vault file.

Config values are JSON-encoded so non-string types round-trip. A missing key
and a stored JSON `null` are **distinct** results; a value that isn't valid
JSON is surfaced as an invalid-request error rather than panicking.

## Lock discipline

Handlers clone the vault handle out from under the read lock and drop the guard
before any per-item loop that awaits — the lock must never be held across
`await`, and sync file I/O inside such a loop goes through `spawn_blocking`.
Otherwise a file with many backlinks interleaves blocking reads with awaits and
can stall under concurrent watcher activity.

## Idempotent vault re-open

Re-opening an already-open folder returns the existing session rather than
constructing a second vault (and a second Tantivy `IndexWriter`) on the same
directory, which throws a lock-busy error. Identity is the **canonical** path;
a stored root that no longer canonicalizes simply doesn't match.

## Cross-process vault ownership lock

The idempotent re-open guard above only sees vaults open in *this* process's
`AppState`. `vault_lock` extends it across processes so a second frontend (the
CLI) can never become a concurrent writer on a vault the app already owns.
`open_vault` acquires an exclusive lock before `Vault::open`; on contention it
returns `VaultLocked { pid, socket_path }` without touching the index. The guard
lives on `OpenVault`, so `close_vault` (and process exit) releases it.

- **Enforcement is an OS advisory lock** (`fs4::try_lock_exclusive`), not
  PID-liveness polling. The kernel releases it when the holder exits — including
  on crash — so a dead owner never wedges the vault. The lockfile's JSON payload
  (`pid`, path, `socket_path`) is informational: it feeds the "who owns it"
  message and, in Phase 2, the socket the CLI attaches to.
- **The lockfile lives in the OS runtime dir**, keyed by a SHA-256 of the
  canonical vault path — never in `.cubical/`. A socket path or PID synced to
  another machine via Dropbox would be poison. `CUBICAL_RUNTIME_DIR` overrides
  the dir (tests, and headless CLI use). This mirrors `recent_vaults.json`:
  machine-local state belongs outside the portable vault.
- **The lockfile is not deleted on release**, only unlocked. Unlinking a lock
  file races with a waiter that already holds a descriptor to it; the next
  acquirer truncates and rewrites the payload after it wins the lock. Leftover
  files are bounded by the count of distinct vault paths ever opened.

Both frontends share this path because it is in the engine's `open_vault`: the
GUI taking the lock is precisely what lets the CLI detect it. Phase 2 turns the
CLI's `VaultLocked` branch from *decline* into *attach* over `socket_path`.

## Degrade-not-throw surfaces

Dataview and search deliberately fold failures into a structured result rather
than a thrown IPC error, so the editor widget always renders an answer. Only
vault-not-open is hard. `write_file_text`'s `expected_seen_hash` is advisory:
a mismatch still writes (preserving the user's "keep my edits" choice) but
records an override row in `audit_log` at `warn`.
