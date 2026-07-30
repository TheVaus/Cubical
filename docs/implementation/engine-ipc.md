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
  loop continues; one failed event must not take the watcher down. It carries a
  per-vault context (sink, vault id, own-write gate, settings) so the `Renamed`
  arm can adopt an external rename — see [Adopting an external
  rename](#adopting-an-external-rename).

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

### Adopting an external rename

`rename_file` is `validate_forward + fs::rename + commit_rename`;
`adopt_external_rename` is `validate_adopted + commit_rename`. `commit_rename`
performs **no filesystem mutation** — that is the invariant that lets one
sequence serve both a rename Cubical is about to perform and one it is
discovering after the fact (a shell `mv`, Finder, vim). Duplicating the commit
sequence for the watcher path would guarantee the two drift.

Validation inverts: the destination must exist on disk, the source must be
gone. The watcher's `Renamed` arm calls it, so an external move keeps its
referrer rewrite, its journal entry and its index rekey instead of silently
dangling every `[[wikilink]]` that named the file.

**Idempotency is by construction, not bookkeeping.** An in-app rename also
produces a `Renamed` watch event, and the hash-keyed own-write gate is the wrong
instrument (`Renamed` deliberately carries no hash). Adoption instead requires
`files` to have a row at `from` and **no** row at `to`:

- in-app rename — `commit_rename` already moved the row, so the arriving event
  finds no row at `from` and skips;
- external rename — the row is still at `from` and none exists at `to`, so it
  adopts;
- a source that was never tracked, or a destination that already is (an
  external move that clobbered a tracked file), fails the predicate and
  degrades rather than risking a wrong rewrite or a `files.path` uniqueness
  violation mid-transaction.

Adoption is skipped, never fatal: a failed or inapplicable adoption logs and
falls back to the arm's previous behaviour. Directory renames fail the
destination-is-a-file check, which is how folder-rename adoption stays out of
scope for v1.

**Non-UTF-8 destinations are tolerated.** `commit_rename` reads the destination
as bytes and only runs the content-derived refreshes (frontmatter, links, tags,
blocks, block refs, search) when the bytes are valid UTF-8. A moved PNG or PDF
still gets its `files` row rekeyed and its rename journalled; treating the read
as fatal would abort *after* the index transaction had already committed,
leaving exactly the inconsistency adoption exists to prevent.

**Platform caveat.** `WatchEvent::Renamed` depends on `notify-debouncer-full`
pairing the two halves. On macOS FSEvents re-reports a stale `ItemCreated` flag
on the **first** move of a file after the watcher starts, and the debouncer
collapses that pair into a bare `Created(dest)` — the source side never arrives
at all, so neither adoption nor a tombstone buffer can see it. Subsequent moves
of the same file pair correctly. Linux inotify pairs reliably via rename
cookies. This is why the end-to-end adoption test performs a warm-up move
before the move under test.

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

### Socket boundary (Phase 2)

The wire boundary lives in a new crate, `cubical-ipc`, not in `cubical-engine`
— the engine stays free of serialization concerns, matching the Handler
pattern's reason for framework-free IPC types above. `cubical-ipc` owns the
`Command`/`Outcome`/`Response` wire types, the length-prefixed JSON framing,
and a single `dispatch(vault_id, command, &AppState, &dyn EventSink) ->
Result<Outcome, CubicalError>`. Both `cubical-cli` and `cubical-app` depend on
it; the engine has no reverse dependency.

`dispatch` is the same reasoning as the event-sink chokepoint above, applied
one layer up: there is exactly one command→engine-fn mapping and one
`render`, called identically by the CLI running standalone (`NoopEventSink`),
the app's socket server (`TauriEventSink`), and the CLI attached as a client —
so the three callers cannot drift apart.

`cubical-app` advertises its socket path (`open_vault`'s `advertise_socket`
parameter, threaded into `vault_lock::acquire`/`write_payload`) rather than a
fixed location, because the path is keyed by the app's own pid
(`cubical-<pid>.sock`) — the same machine-local reasoning that keeps the
lockfile itself out of `.cubical/`, above. The server is a
`.setup()`-spawned, **sequential** accept loop (not one task per connection):
`handle_connection` borrows `&AppState`, and `AppState`'s own locks already
serialize mutations (see Lock discipline above), so a second concurrency
layer here would be redundant. A transient `accept` error backs off and
retries rather than ending the loop, and a panicking handler is caught, so
neither can silently take CLI attach offline for the app's lifetime. Both
sides of a connection read under a deadline (`cubical_ipc::IO_TIMEOUT`): a
local process that connects and sends nothing would otherwise wedge the
sequential loop for every later `cubical` invocation.

Routing an attached command through the app's real `AppState` and a real
`TauriEventSink` — instead of a second engine — is what keeps the app's
index, rename journal and audit log authoritative, and what carries the
rename/flush/audit events to the UI. It is **not** what updates the editor
after a socket `write`: `write_file_text` never populates `flush_own_writes`
(only the rename referrer-rewrite flush does, and `close_vault` consumes it),
so the app's file watcher sees the write as a change and fires — which is
precisely what makes the GUI pick it up. Suppressing that echo would leave
the GUI unaware of the CLI's write.

`cubical set …` has no watcher to ride on — `.cubical/` is excluded from it,
and the workspace half of `set_setting` writes to libsql, not to a file at
all — so it carries its own event, `vault:setting-changed`. That event is
emitted from `dispatch`'s `Set` arm rather than from `set_setting` itself,
which is what keeps it from firing on the UI's *own* writes: the GUI's
setting changes go through the Tauri command, never through `dispatch`, so a
control the user just moved is not knocked back by an echo of itself. The
CLI-local caller's `NoopEventSink` swallows it, correctly — no app is running
to hear it. The event carries `key` and `value`, but the frontend re-reads
the whole settings set rather than applying the payload: the key→signal
mapping already exists once, at the vault-open hydration path, and a second
copy in an event handler is the kind of thing that drifts. Re-hydration costs
~20 reads and only happens when a setting is changed from outside the GUI.

The event fires only after `set_setting` returns `Ok`, so a rejected key never
tells the UI something changed.

The socket's only auth boundary is filesystem permissions, so the app asserts
them rather than inheriting whatever the runtime dir happens to have: `0o700`
on the directory, `0o600` on the socket after bind. The `std::env::temp_dir()`
fallback in `runtime_dir` can otherwise land in a world-writable `/tmp`. That
`runtime_dir` is the engine's — `cubical-ipc` calls
`vault_lock::runtime_dir` rather than keeping a copy, because the two must
resolve identically or the CLI attaches to a path nobody bound. A runtime
directory is not a wire type, so this does not breach the engine's
serialization-free rule. The socket is unlinked on `RunEvent::Exit`; a
crashed app leaves one behind until the same pid is reused.

The transport (`#[cfg(unix)]`) is Unix-domain-socket only; Windows is a
deliberate, confined stub — the CLI simply never receives a `socket_path` to
attach to and falls back to the Phase-1 decline.

The transport's error type is `TransportError`, split `Io` vs `Protocol`,
because the CLI's user-facing message turns on exactly that distinction:
"could not reach the running Cubical app" is a lie when the app was reached
and answered with something unparseable. `Io` is the unreachable / timed-out /
truncated case; `Protocol` covers a non-encodable message, an over-maximum
frame, and a frame that is not valid JSON. Collapsing both into
`io::Error::other` — as Phase 2 did — makes a corrupt-response bug look like a
socket bug and sends debugging in the wrong direction.

The CLI rejects a `--vault` that is not a directory *before* it builds the
command, because `cubical write` reads stdin to EOF at build time (stdin is
not seekable, and the `Command` has to exist before the lock check can run).
Without the pre-check, `cubical --vault /nonexistent write x.md` sits waiting
for a body it will never use at an interactive terminal. The check is a plain
`is_dir`, and it applies to every subcommand rather than just `write`.

Design and data flow are owned by
[`docs/superpowers/specs/2026-07-24-cli-attach-phase2-design.md`](../superpowers/specs/2026-07-24-cli-attach-phase2-design.md);
this section records only why the boundary is shaped this way.

### Console: the fourth caller (Phase 3)

`cubical-ipc` owns the text boundary in **both** directions now, not just the
`Outcome`→text one above: `parse.rs` moved `Cli`/`Cmd`/`to_command` out of
`cubical-cli`'s `main.rs` into the same crate, alongside `render`/`render_to`.
Text→`Command` and `Command`→text are the same boundary in opposite
directions, and both exist so every frontend produces identical parsing and
output — the reasoning is one, not two.

The in-app console (`cubical-app/src/console.rs`) is the **fourth caller of
the one `dispatch`**, joining CLI-local, the app's socket server, and the CLI
client above. It calls `dispatch` in-process against the app's own `AppState`
via `TauriEventSink` — no socket, no `cubical` binary, no `#[cfg(unix)]`
restriction, so it works on Windows where the socket transport is deliberately
stubbed out.

Being in-process rather than a client of the socket server is also why it
needs its own rejections instead of inheriting the CLI's: it rejects `write`
(`needs_body`, checked once in `parse.rs` so a future body-needing verb is
caught automatically — the console has no stdin to read a body from) and
`--vault` (the console is bound to the vault the app already has open; the
socket path's `--vault` handling doesn't apply here since there's no attach
step to bind at).

Everything console-specific on the Rust side lives in that one module —
`ConsoleResult`, the tokenizer, the `write`/`--vault` rejections and the
`console_exec` command — and `lib.rs` knows it only as `mod console;`, the
`console::console_exec` handler entry, and a `pub use` for the integration
test. `parse`/`dispatch`/`render_to` stay in `cubical-ipc` where all four
callers share them; moving any of that next to the console would reintroduce
the drift the shared boundary exists to prevent.

Design and rationale: [`docs/superpowers/specs/2026-07-25-cli-console-phase3-design.md`](../superpowers/specs/2026-07-25-cli-console-phase3-design.md).
The console is scheduled for removal once the PTY terminal replaces it
([`2026-07-30-terminal-design.md`](../superpowers/specs/2026-07-30-terminal-design.md)
→ "Retiring the console"), which is why its surface is deliberately collapsed
to that single wiring point rather than spread across `lib.rs`.

## Degrade-not-throw surfaces

Dataview and search deliberately fold failures into a structured result rather
than a thrown IPC error, so the editor widget always renders an answer. Only
vault-not-open is hard. `write_file_text`'s `expected_seen_hash` is advisory:
a mismatch still writes (preserving the user's "keep my edits" choice) but
records an override row in `audit_log` at `warn`.
