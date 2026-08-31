# Implementation — engine command + event layer (`cubical-engine`)

Boundary inventory owner:
`scripts/dependency-boundary.json` + [`../generated/ipc-surface.md`](../generated/ipc-surface.md).

## Handler pattern

Every command is a plain `async fn(&AppState, TypedRequest) -> Result<Response,
CubicalError>` with **no Tauri import**. The Tauri shims in `cubical-app` are
3-line forwarders that pull state and call in. Two reasons, both load-bearing:
handlers stay unit-testable without booting Tauri, and a shell swap rewrites
only the shims.

IPC request/response types are framework-free `serde` structs for the same
reason — they survive a shell migration unchanged.

## Caller-supplied paths

**Anchors:** validate_rel_file · validate_rel_dir · contained_join · vault_file · vault_dir

A path arriving in a request is untrusted input. The vault root is the
containment boundary, and `commands::paths` is the only way a request path
becomes a `PathBuf`: `vault_file` and `vault_dir` wrap
`vault::relpath::contained_join`, which is the one owner of what a
vault-relative path may be.

Two properties, both learned the hard way. It splits on `/` **and** `\`,
because a validator that understands only forward slashes passes
`..\..\evil.md` as a single segment and hands it to an OS that does read the
backslashes. And it checks containment *after* joining — canonicalising the
deepest existing ancestor and requiring it under the root — because segment
parsing is exactly the part that was got wrong, and because a symlinked
subdirectory escapes a purely textual check.

Constraining only the source is not enough. `rename_file` once checked that
`from_path` was tracked and nothing at all about `to_path`, which made it an
arbitrary-write primitive over a `#[tauri::command]` that is also reachable on
the `cubical-ipc` socket. Commands that resolve a path through the index first
(`get_embed`, `get_backlinks`) are contained by that lookup — the scan walks
with `follow_links(false)`, so no key in `files` can escape the root. Anything
that joins a request path directly routes through `commands::paths` regardless,
including the index-gated writers, so the rule needs no exemption to state.

The drive-letter rule is deliberately **minimal**: a segment that is exactly
`C:` is refused everywhere, and anything longer is left to the host's own path
parsing. So `C: A Study.md` is an ordinary filename on macOS and Linux and is
refused on Windows, which reads it as drive-relative. That divergence is not
this validator's to settle — which names are legal on all three platforms is
[#122](https://github.com/TheVaus/Cubical/issues/122), and the point of that
issue is that the answer must not emerge from wherever the first validator
happens to get written.

Two deliberate asymmetries. A **leading separator is vault-root-relative, not
absolute**: `/notes/a.md` means `notes/a.md`, leniency retained from the
original validator and contained either way. A **backslash is rejected, never
translated**: `a\b.md` is one legal filename on Unix and two segments on
Windows, so folding it to `a/b.md` would let a request reach a different file
than the one it named — a wrong-target `delete_path`, not merely a lax check.

## Error folding

The IPC boundary speaks exactly one error type. `CubicalError` folds the
crate-local errors into one enum with a stable JSON shape.

It lives **downstream of both** `cubical-core` and `cubical-index` because the
dep graph requires it (core consumes index). The layer spec originally placed
it in core; that placement is not achievable and the divergence is deliberate.

## Event sink

**Anchors:** EventSink

The engine produces transport-agnostic events and hands them to an
`EventSink`. Tauri supplies one forwarding to `AppHandle::emit`, the CLI a
no-op, tests a collector. This is what lets handlers and background tasks carry
no Tauri dependency — the only Tauri code is the sink adapter.

`events.rs` is the **single chokepoint** for backend → frontend events.
Handlers never emit directly; they call the `emit_*` helpers. A transport
migration touches this one file.

## Dispatchers

**Anchors:** dispatch

Both are spawned by `open_vault` and live beside the sink because they touch
the transport, keeping the pure handlers clean.

- **Scan dispatcher** — forwards progress events and emits exactly one terminal
  event (complete or cancelled), updating the stored scan status so later
  `get_vault_info` calls agree. Every spawn passes the **open vault's own**
  cancellation token; a rebuild given a fresh one keeps scanning against a
  closed vault's index because nothing can reach it to stop it.
- **Watcher dispatcher** — persists each event to the index, writes an
  `audit_log` row, and emits the file-changed event. Errors are logged and the
  loop continues; one failed event must not take the watcher down. It carries a
  per-vault context (sink, vault id, own-write gate, settings) so the `Renamed`
  arm can adopt an external rename — see [Adopting an external
  rename](#adopting-an-external-rename).

Each batch runs in its own `tokio::spawn`ed task that the loop awaits, so
ordering is unchanged but a panic anywhere under `handle_watch_batch` costs one
batch instead of every future external edit. A panic that a `Result` cannot
express is exactly the case "errors are logged and the loop continues" did not
cover.

On a delete the file's row is dropped so it leaves the tree, and the cascading
foreign keys carry its **outbound** rows with it. **Inbound** references from
other files have no FK and are left intact, so they correctly degrade to broken
links.

## Own-write hash gate

**Anchors:** flush_own_writes

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

**Anchors:** rename_file · adopt_external_rename · commit_rename · path_tracked · rekey_file_in_tx · enqueue_referrers_in_tx · is_vacant · find_rename_source

`rename_file` validates, performs `fs::rename`, then calls `commit_rename`.
`adopt_external_rename` validates and calls `commit_rename` — nothing else.
Beyond the shared path check below, each does its validation inline, and the
only extracted piece is `commit_rename` itself.

**`exists()` is not "is this path really on disk."** On a case-insensitive
volume a bare `exists()` is true for `Note.md` when only `note.md` is there, so
every question about path occupancy goes through one predicate,
`paths::is_vacant(counterpart_rel, rel, abs)`. It reads the directory's real
entries, and disbelieves `exists()` only when the path that could be
masquerading is the counterpart of the very move being considered — a genuinely
distinct file still occupies its path.

One predicate because the same lie broke three call sites, one per direction of
the question. `rename_file` and `rename_folder` ask whether the **destination**
is vacant, which is what makes fixing a title's capitalisation possible on macOS
and Windows. `adopt_external_rename` asks whether the **source** is vacant —
`exists()` there reported the file still present after Finder had renamed it,
so adoption declined, the rename degraded to delete + create, and every referrer
went stale. `find_rename_source` asks the same of each pairing candidate, so a
case-only `Removed`/`Created` pair is unambiguous rather than filtered away.

`commit_rename` performs **no filesystem mutation** — that is the invariant
that lets one sequence serve both a rename Cubical is about to perform and one
it is discovering after the fact (a shell `mv`, Finder, vim). Duplicating the
commit sequence for the watcher path would guarantee the two drift.

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

### Recovering renames the watcher failed to pair

`WatchEvent::Renamed` only arrives when `notify-debouncer-full` pairs the two
halves, and it does not always manage it. Two measured failure modes, each
needing its own mechanism, both funnelling into the one `adopt_external_rename`
so there is a single commit path regardless of how the rename was recovered:

**(a) Split events.** The halves land outside the 100 ms debounce window, or the
platform emits `RenameMode::From`/`To` separately; the translator degrades those
to `Removed` + `Created`.

**(b) Dropped source (macOS).** FSEvents re-reports a stale `ItemCreated` flag on
the source path of an early move. `push_rename_event` in the debouncer checks
`was_created()` on the source queue and, when it is set, **omits the
`Modify(Name(Both))` event entirely** — the surviving source-queue events are
re-pathed onto the destination, so the move surfaces as a bare `Created(dest)`
with **no `Removed` anywhere**. Measured directly against the real watcher: the
first *two* moves after start emitted `[Created]`, moves #3–#12 emitted
`Renamed`, reproducible. A raw `notify` probe confirms the cause — every rename
carries a spurious `Create(File)` on the source path alongside
`Modify(Name(Any))`. Linux inotify pairs reliably via rename cookies.

**M1 — index reverse-lookup (durable).** On `Created`, before the `files` upsert,
look for a tracked row carrying the **same inode at a different path** that no
longer exists on disk. No buffer and no TTL are needed, because the populated
`files.inode` column makes the index itself the tombstone. This is what rescues
(b), where nothing else survives the move.

**M2 — tombstone buffer (ephemeral).** `Removed` deletes the `files` row, which
destroys M1's record — so the row is captured into a bounded buffer *before* the
delete. A later `Created` matching a live tombstone resurrects the row and
adopts through the same predicate; if adoption then declines, the resurrection is
rolled back so no phantom row survives. The buffer is bounded in **both**
dimensions (2 s TTL, 256 entries, oldest evicted first) because it sits in the
watcher hot path and a vault-wide `rm -rf` must not balloon memory. Unmatched
tombstones expire and the `Removed` stands.

**Precedence is inode first, then content hash.** Inode is exact for
same-volume moves; hash covers cross-volume moves, where the inode necessarily
changes but content is preserved.

The inode lookup rides `idx_files_inode`, but `files.content_hash` has **no
index**, so an unconditional hash lookup would full-scan `files` on every single
`Created` — quadratic when a vault is bulk-imported. The hash pass is therefore
gated on a live tombstone already carrying that hash, which costs an in-memory
scan of a ≤256-entry buffer and reaches SQL only in the seconds after a
deletion. Nothing is lost: a cross-volume move is a copy-then-delete, so it
always emits a `Removed` and always leaves a tombstone. The dropped-source case
is an FSEvents *rename*, which is same-volume by definition and keeps its inode
— and both `scan` and the watcher upsert populate `files.inode` on Unix, so M1
is never inode-blind there.

**On Windows `inode` is always `NULL`**, so pairing there is tombstone-and-hash
only — and hash matching is refused whenever two tracked files share a hash,
which empty notes and templates make ordinary. Windows rename detection is
therefore genuinely weaker, not merely untested; the inode-pairing test is
`#[cfg(unix)]` because a platform reporting no inode cannot satisfy it. NTFS
does have a volume-scoped file ID, but `MetadataExt::file_index` is unstable
(`windows_by_handle`), so reaching it means `GetFileInformationByHandle` through
a declared dependency — a change with its own review, tracked in
[#124](https://github.com/TheVaus/Cubical/issues/124), not folded into the
matrix that revealed it.

**Hash matching is skipped entirely when more than one tracked file shares the
hash.** Duplicate files are ordinary in a vault (empty notes, templates,
boilerplate), and the candidate count is therefore taken across *all* tracked
entities — live `files` rows **and** live tombstones — **before** filtering to
those missing from disk. Counting after the disk filter looks equivalent and is
not: it would leave a single missing candidate whenever its twin is still on
disk, and pair them. A missed rename is recoverable; a wrong rewrite silently
corrupts the user's markdown. Ambiguous inode matches are refused on the same
grounds. Both mechanisms then re-check that the chosen source is genuinely
absent from disk — a file that is still there did not move.

Recovery cannot double-apply, because it reuses the same
row-at-`from`/no-row-at-`to` predicate: a `Created` whose path is already tracked
is skipped outright, which is what makes an in-app rename (already rekeyed by
`commit_rename`) and a re-delivered event both no-ops.

### Journal replay

**Anchors:** replay_rename_journal · prune_materialized_journal

After a scan, each surviving journal entry whose `from` is gone but whose `to`
is tracked reconnects referrer links still naming `from` and re-enqueues their
rewrites under a fresh op. This is what makes "wipe the disposable index
mid-rename" recover instead of stranding referrers.

An entry is pruned once no referrer text still names `from` (the rewrites baked
into the `.md` files) or once `to` itself vanishes. Best-effort: errors are
logged and swallowed so a bad journal can never wedge vault open.

## Link integrity: the visible residue

Adoption (above) is confident and silent. What it cannot pair must never rot
silently, so `commands::integrity` surfaces the remainder and lets the user —
never the engine — decide the repair.

**One notion of "what file does this token name."** `commands::link_match` owns
the ranking: `classify_candidate` returns a `CandidateRank` (exact path → exact
basename → case-insensitive path → case-insensitive basename), and
`reconnect_broken_links_to` matches the same set. That equality is not a
convention, it is a test: `classification_agrees_with_the_reattachment_predicate`
runs the real `UPDATE` against a real index and asserts the matched set equals
`classify_candidate`'s. Two notions of token matching is precisely the drift this
layer exists to prevent — extend `link_match`, never re-derive.

**Case-insensitive means one function, everywhere.**
"Case-insensitive" above is `cubical_index::names_eq_folded`, and
`PathResolver`, wikilink autocomplete and the graph's ghost interning all fold
through the same `fold_name`. It cannot be SQL: `LOWER()` in libSQL is ASCII-only
under the core-only pin ([`Cargo.toml`](../../Cargo.toml)), so a SQL-side fold
would resolve `[[CAFÉ]]` to `café.md` when rendering and then fail to reattach
that referrer on rename — a stale link produced by the fold, not by a missing
rewrite. Every query that folds therefore reads its candidates and folds them in
Rust. `classification_folds_the_way_path_resolution_folds` is what holds the two
sides together.

The fold lives in `cubical-index` rather than beside the path validators in
`vault::relpath` for one reason: the layering. `cubical-graph` and
`cubical-index` sit below `cubical-core`, so a fold owned by core is a fold they
cannot call — and each site that cannot call it writes its own. Layer 0 is the
lowest place all four callers share.

**Whitespace is trimmed at the boundary, never by a matcher.** `cubical_ast::wikilink`
(and its TypeScript twin, held together by the parity fixtures) yields the
trimmed target, so `[[  Daily  ]]` is the token `Daily` everywhere the index
carries it. Requests are the other boundary: the engine has more than one
frontend and the UI has trigger-detecting regexes that are not the parser, so
`commands` trims what arrives — `split_target_anchor` for the link and embed
resolvers, `block_id_autocomplete` for its own target.

Past those two boundaries nothing trims again. `PathResolver`,
`classify_candidate` and `token_names_file` all take the token as given: a
matcher that re-normalises hides whether its input was normalised, and the three
would then be free to disagree about what a token is. `MATRIX_TOKENS` carries a
padded row so the agreement is pinned rather than assumed. A rewrite that touches
a padded link emits the canonical unpadded form, because `emit_wikilink`
round-trips the parsed target — the rename normalises spacing it did not create,
which is the cost of having exactly one spelling of a token.

`FrontmatterTitle` is the one rank with no reattachment twin. It is
**candidate-only**: offered to the user, never used by any automatic rewrite. That asymmetry is the
whole boundary — confident matching stays narrow, consented matching can afford
to be generous.

**What counts as dangling.** A link row whose `target_path` no longer names a
tracked file. Two shapes reach that state: a stale non-null path (the watcher's
`Removed` arm deletes the `files` row and leaves referring link rows pointing at
it — that *is* the rot), and a null path that never resolved. A null path with no
repair candidate is dropped from the report: in a PKM, `[[a note I have not
written yet]]` is normal authoring, and a panel that lists it is a panel nobody
reads. Groups are keyed by exact `target_raw`, which is also what
`apply_pending`'s rewrite matches on, so a group is exactly one repairable unit.

**Repair routes through the pending queue.** `repair_dangling_link` mints an op
id, enqueues one coalesced `wiki_link` rewrite per referring file, reconnects the
index rows in the same transaction, then flushes those targets through
`flush_pending_for_target` (so the own-write hash gate is honoured and the
watcher doesn't echo). No markdown is written by hand and no second rewrite path
exists. The new token keeps the shape the author used — a bare token stays bare —
except when the basename would collide with the token that was already ambiguous,
where it widens to the path form, since that is the only form that disambiguates.
There is deliberately **no repair-all**: an unconfirmed guess writes wrong links
into the source of truth.

## Audit log retention

**Anchors:** audit_log

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
across `await` points**. An open vault stores cancellation tokens but not the
dispatchers' join handles — a dispatcher detaches once started, and cancelling
is enough to bring it down responsively.

### The watcher's lifetime is its own

`cancel` bounds the **scan**; `watcher_cancel` bounds the watcher; the
already-separate `flush_timer_cancel` bounds the flush timer. They were not
always distinct: the watcher was started on `cancel`, so `cancel_vault_scan`
tore down the bridge task and the vault silently stopped seeing external edits
for the rest of the session — the failure
[`convergence-over-interception`](../principles/convergence-over-interception.md)
can least afford, reachable from a button. `close_vault` cancels every token;
nothing else cancels the watcher's.

That separation is what makes a dead watcher *detectable*. The dispatcher's
receive loop can only end when the channel closes, so ending while
`watcher_cancel` is uncancelled means the watcher died rather than being shut
down. That case clears `OpenVault.watcher_live` and writes a
`watcher_unavailable` row at `warn`, the same category the failure-to-start
path uses, because the user-visible consequence is identical. `watcher_live`
rides out on `get_vault_info` so a frontend can say so; the `audit_log` row is
the forensic record either way.

A restart is deliberately **not** attempted. Re-registering with the OS watch
API leaves a gap of unknown length during which the index and disk diverge with
nothing recording what was missed, and the honest repair for that gap is the
rescan that reopening the vault already performs.

### The flush timer is supervised the same way, and it matters more

The periodic flush timer is the only background task guarding state that a
rescan cannot rebuild —
[`derived-state-disposable`](../principles/derived-state-disposable.md) names
the pending-rewrites queue as its single exception. So a timer that stops is
not a degraded convenience: referrer links stay unrewritten with nothing
saying so, and `.cubical/renames.jsonl` exists precisely because that queue is
worth a sidecar.

It is therefore structured in two nested pieces rather than one detached
`tokio::spawn`. Each tick runs in its own spawned task the loop awaits, so a
panic under `flush_all_for_vault` costs one tick — its rewrites simply stay
queued for the next one — and is audited as `flush_timer_tick_panic`. The loop
itself runs in a task whose `JoinHandle` an outer supervisor awaits, so a panic
in the parts a tick cannot isolate (reading the interval, the `select!`) is
still observed instead of ending the task list silently.

The supervisor distinguishes death from shutdown the way the watcher does: if
`flush_timer_cancel` is cancelled the loop was stopped on purpose and nothing
is reported; otherwise it clears `OpenVault.flush_timer_live` and writes a
`flush_timer_unavailable` row at `warn`. A loop that returns *without*
cancellation is treated as death too — today the loop can only exit that way if
someone edits it, and inventing a second silent exit should cost an audit row.
`flush_timer_live` rides out on `get_vault_info` alongside `watcher_live`.

`record_vault_warning` is shared by both subsystems rather than duplicated: the
category argument is the only thing that differs, and a second copy would let
the two drift on level or payload shape.

## Settings routing

Writes are routed by key: durable (non-`ui.*`) keys go to the portable
`.cubical/config.toml` via an atomic fsync+rename inside `spawn_blocking`;
`ui.*` workspace keys upsert the index `config` table. Session-local layout
state must not land in the portable vault file.

Config values are JSON-encoded so non-string types round-trip. A missing key
and a stored JSON `null` are **distinct** results; a value that isn't valid
JSON is surfaced as an invalid-request error rather than panicking.

## Feature toggles gate commands, not derived state

**Anchors:** Feature, open_vault_cloned_for

`plugins.*_enabled` keys decide whether the engine will **serve a command**, not
whether it will **build derived state**. Those are different questions and the
answers deliberately differ.

Derived state stays warm. Property-ref link rows, the graph model and the search
index are built whether or not their feature is on, because
[composability](../principles/composability.md) already says switching a feature
off drops its derived state and rebuilds it if it comes back — so keeping it
current costs a little work and makes the toggle instant, and skipping it would
buy nothing a rescan does not already provide.

Commands are refused. `cubical_engine::plugins::Feature` maps a feature to its
setting key, its default and what it requires, and `open_vault_cloned_for`
applies the check as part of the vault lookup every command already performs.
The gate is one chokepoint rather than a check per command because the reason
the toggle was unenforced is that there is more than one caller: the frontend
was the only thing declining to call `terminal_open`, while the CLI socket
never consulted the setting and a plugin host would be a third caller. A
per-command check repeats the omission at each new entry point; a check inside
the shared preamble cannot be forgotten.

This is what [native-capability-gateway](../principles/native-capability-gateway.md)
requires of the terminal specifically. `plugins.terminal_enabled` defaults to
**false**, and before this the backend would spawn a PTY for a caller that
simply asked.

Defaults live in two places that must agree — `Feature::default_enabled` here
and the registry in `ui/src/settings/corePlugins.ts` — so a test parses the
TypeScript and asserts the Rust matches, key for key and default for default.

## Lock discipline

**Anchors:** with_open_vault · open_vault_cloned

One `RwLock` covers *every* open vault, so its scope is a backend-wide
coupling, not a per-vault one. `tokio::sync::RwLock` is write-preferring:
a read guard held across a slow await blocks a pending writer
(`open_vault`, `close_vault`, the scan dispatcher's terminal status write),
and every later reader then queues behind that writer. A dataview query holding
the guard across `cubical_query::run` stalled `list_files`, `search` and
`read_file_text` together — one slow feature stalling unrelated ones.

So the guard is a **lookup**, never a work scope. `with_open_vault` takes a
synchronous closure and hands back what it extracted; the guard is gone before
the caller resumes. It is deliberately not `async`: a closure that could await
would put the stall straight back. `open_vault_cloned` is the common case —
everything reachable from the vault handle (index connection, search index,
root) is clonable, so almost every handler needs nothing else. What must
outlive the guard is cloned out with it: the settings map, the search-state
cell, the cancellation token, the own-write gate.

Sync CPU work goes through `spawn_blocking` for the same reason the guard
does — `run_search` and every markdown parse are off-executor.

A poisoned `std::sync::Mutex` guarding **plain data** is recovered with
`into_inner()` rather than treated as fatal. `LayoutRegistry` used to
let-else-return on `PoisonError`, which turned one panic elsewhere into a
`cancel()` that silently did nothing for the rest of the process — a graph
layout the user asked to stop kept burning a core. The map holds cancellation
flags, not an invariant a panic can break, so the only thing poisoning proved
was that some unrelated thread died. This does not extend to a lock guarding a
half-updated structure, where poisoning is the signal it was designed to be.

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

- **Enforcement is an OS lock** (`fs4::try_lock_exclusive`), not PID-liveness
  polling. The kernel releases it when the holder exits — including on crash —
  so a dead owner never wedges the vault.
- **The lock and the advertisement are two files.** `<hash>.lock` is only ever
  locked and unlocked; the JSON payload (`pid`, path, `socket_path`) lives
  beside it in `<hash>.owner`, which is never locked. That payload is
  informational: it feeds the "who owns it" message and the socket the CLI
  attaches to. They are separate because the lock is *advisory* on Unix but
  **mandatory** on Windows — `LockFileEx` makes a plain read of the locked
  region fail, so a contender reading the owner out of the lockfile itself got
  `pid: 0` and could not name the owner or find the socket. Splitting them is
  what makes "who holds this vault?" answerable on every platform.
- **Contention is not one errno.** Unix reports it as `EWOULDBLOCK`
  (`ErrorKind::WouldBlock`); Windows reports `ERROR_LOCK_VIOLATION`, which has
  no `ErrorKind` of its own. Matching on `fs4::lock_contended_error()` asks the
  locking crate what contention looks like on this platform rather than
  hardcoding one spelling of it.
- **The lockfile lives in the OS runtime dir**, keyed by a SHA-256 of the
  canonical vault path — never in `.cubical/`. A socket path or PID synced to
  another machine via Dropbox would be poison. `CUBICAL_RUNTIME_DIR` overrides
  the dir (tests, and headless CLI use). This mirrors `recent_vaults.json`:
  machine-local state belongs outside the portable vault.
- **The lockfile is not deleted on release**, only unlocked — unlinking it races
  with a waiter that already holds a descriptor to it. The `.owner` file *is*
  removed on release, because it is a claim rather than a lock and a stale claim
  is misleading; a contender that finds none falls back to `pid: 0`. The next
  acquirer rewrites it after it wins. Leftover lockfiles are bounded by the
  count of distinct vault paths ever opened.

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
[`2026-07-24-cli-attach-phase2-design.md`](../archive/work/specs/2026-07-24-cli-attach-phase2-design.md);
this section records only why the boundary is shaped this way.

### The text boundary runs both ways (Phase 3)

`cubical-ipc` owns the text boundary in **both** directions, not just the
`Outcome`→text one above: `parse.rs` holds `Cli`/`Cmd`/`to_command` alongside
`render`/`render_to`, moved there out of `cubical-cli`'s `main.rs`.
Text→`Command` and `Command`→text are the same boundary in opposite
directions, and both exist so every frontend produces identical parsing and
output — the reasoning is one, not two.

`needs_body` lives in `parse.rs` for the same reason, checked once rather than
at each call site: a frontend with no stdin to read a body from rejects `write`
without restating the rule, and a future body-needing verb is caught
automatically.

An in-app command console was briefly a fourth caller of `dispatch`, calling it
in-process against the app's own `AppState`. It was removed when the PTY
terminal replaced it ([`2026-07-30-terminal-design.md`](../archive/work/specs/2026-07-30-terminal-design.md)
→ "Retiring the console"); the terminal reaches the same verbs by putting
`cubical` on the child's `PATH`, so it is a client of the socket server rather
than a fifth in-process caller. That the removal touched only one wiring point
in `lib.rs` is the payoff of having collapsed its surface in the first place.

## Degrade-not-throw surfaces

**Anchors:** resolve_text_file

Dataview deliberately folds failures into a structured result rather than a
thrown IPC error, so the editor widget always renders an answer: it renders
*inside* a document, where a thrown error would take the surrounding render
down with it. Search is the deliberate counter-example — `run_search`'s error
propagates, because the search panel owns an error slot of its own and a
second, in-band error channel would only duplicate it. Only vault-not-open is
hard. `write_file_text`'s `expected_seen_hash` is advisory: a mismatch still
writes (preserving the user's "keep my edits" choice) but records an override
row in `audit_log` at `warn`.

**An index row is not permission to touch a file.** `resolve_text_file` asks
the index for the type and the last known hash, and when there is no row it
answers from disk instead: the file-type registry classifies the path and the
bytes supply the hash. Only a path that is absent from the index *and* absent
from disk is `FileNotFound`. The type gate is unchanged either way, so a `.png`
is still refused as text. `read_file_text` treats a failed
`materialize_on_read` the same way — raw source plus a log — matching the scan
and watcher call sites of the same read.

This is the [derived-state-disposable](../principles/derived-state-disposable.md)
rule applied to the read path: a partial scan, an aborted transaction or a
corrupt index left an intact `.md` unreadable *and unsavable*, which is the
worst possible way for disposable state to fail. `list_files` still reads the
tree from `files` — the file tree is a projection of the index by design, and
replacing it with a live walk is an architecture decision, not a bug fix
([#235](https://github.com/TheVaus/Cubical/issues/235)).
