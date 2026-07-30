# Vault convergence — external renames keep their semantics

**Date:** 2026-07-30
**Status:** design approved, implementing
**Branch:** `feat/vault-convergence`
**Sibling spec:** [`2026-07-30-terminal-design.md`](2026-07-30-terminal-design.md) (Spec B — depends on this landing first)

## Why

The embedded terminal (Spec B) will let arbitrary external processes — `claude`, `python`, `git`, a stray `mv` — mutate the vault. Cubical cannot intercept those mutations, so the architectural commitment is **convergence, not interception** ([`foundation.md`](../../architecture/foundation.md) §2.2).

Convergence is already almost true. The index is derived state and the watcher rebuilds it: external `touch`, `cat >`, content edits, `mkdir`, and `rm` all reconcile correctly today with no work. There is exactly **one** hole, and it is the hole that matters, because it destroys information the index cannot re-derive:

**An external move loses its referrer rewrite.** `mv Note.md Renamed.md` leaves every `[[Note]]` in the vault dangling. An in-app rename would have rewritten them and journalled the operation; the watcher path does neither.

This spec closes that hole. It is worth building independently of the terminal — it fixes `mv` in iTerm, in Finder, and in `vim` today.

## What already exists (and does not need building)

This was mis-scoped in early brainstorming; the correction shrank the work substantially. All of the following is already present:

| Piece | Where | State |
|---|---|---|
| `WatchEvent::Renamed { from, to }` | [`watcher.rs:24`](../../../crates/cubical-core/src/vault/watcher.rs) | Exists |
| Inode-based rename pairing | `notify-debouncer-full` + `FileIdMap`, translated at [`watcher.rs:116`](../../../crates/cubical-core/src/vault/watcher.rs) via `RenameMode::Both` | Exists |
| `files.inode` column | index schema | Exists, but written as literal `NULL` by the watcher upsert ([`events.rs:365`](../../../crates/cubical-engine/src/events.rs)) |
| Referrer rewrite + journal + fuse | `rename_file` ([`rename.rs:297`](../../../crates/cubical-engine/src/commands/rename.rs)) | Exists, but reachable only via explicit command |
| Reattach dangling links to a target | `reconnect_broken_links_to` ([`rename.rs:1173`](../../../crates/cubical-engine/src/commands/rename.rs)) | Exists |

**No index migration is required.** The rename-pairing machinery is not being built — it is being *wired up*.

## The actual gap

`apply_watch_event_to_db`'s `Renamed` arm ([`events.rs:457`](../../../crates/cubical-engine/src/events.rs)) does only two things: bumps `last_seen` on the old path and deletes the old search doc. It never rekeys the file row, never collects referrers, never enqueues rewrites, never journals. Worse, it discards `to` entirely (`Renamed { from, to: _ }`), so after an external move the index still believes the file lives at the old path.

## Design

### 1. Extract the rename-commit core from `rename_file`

`rename_file` currently interleaves three concerns: validation, the `fs::rename` syscall, and committing the consequences. For an external rename the syscall **already happened** — that is why the event arrived — and validation inverts (the destination *must* exist; the source must be gone).

Split it:

```
commit_rename(vault, state, app, from, to, kind) -> RenameCommit
    collect_referrers → mint_rename_op_id → TX{enqueue_referrers, rekey_file}
    → journal append → refresh {frontmatter,links,tags,blocks,block_refs,search} at `to`
    → delete old search doc → enforce_fifty_per_file_fuse → emit pending-rewrites-changed

rename_file(...)            = validate_forward  + fs::rename + commit_rename
adopt_external_rename(...)  = validate_adopted               + commit_rename
```

`commit_rename` performs no filesystem mutation. That is the invariant that makes it safely shareable between a rename Cubical is about to perform and one it is discovering after the fact.

This is a genuine SRP improvement to a file that is already 2953 lines and serving several masters. It is in scope because the alternative — duplicating the commit sequence for the watcher path — would guarantee the two drift, which is the same failure mode `dispatch` was centralised to avoid.

### 2. Wire `WatchEvent::Renamed` to `adopt_external_rename`

The `Renamed` arm calls `adopt_external_rename(from, to)` instead of its current two-statement stub. Constraints:

- **Own-write suppression must be respected.** An in-app rename also produces a `Renamed` watch event; adopting it would double-apply. The existing `flush_own_writes` / `consume_own_write_hash` gate is the wrong instrument here (it is hash-keyed, and `Renamed` deliberately carries no hash — see the `Renamed must not carry a hash` assertion at [`events.rs:832`](../../../crates/cubical-engine/src/events.rs)). Instead, adoption is skipped when the index already reflects the move: if `files` has no row at `from` and does have one at `to`, the rename was ours and is already committed. This is idempotent by construction rather than by bookkeeping.
- **Markdown only.** Adopting a rename of a binary file has no referrers to rewrite; it still needs the file row rekeyed, which `commit_rename` does anyway.
- **Failure is non-fatal.** A failed adoption logs and falls back to the current remove+create behaviour. The index must never be left mid-transaction; `commit_rename` already wraps its index work in one TX.

### 3. Recovering renames the watcher failed to pair

`FileIdMap` pairing is not reliable enough to be the only mechanism. Two distinct failure modes, confirmed by measurement during T3:

**(a) Split events.** The two halves land outside the 100 ms debounce window, or the platform emits `RenameMode::From`/`RenameMode::To` separately — the translator already degrades those to `Removed`/`Created` ([`watcher.rs:131`](../../../crates/cubical-core/src/vault/watcher.rs)).

**(b) Dropped source (macOS).** The *first* `mv` of a file after the watcher starts arrives as a bare `Created(dest)` — **the source side is dropped entirely, including any `Removed`.** FSEvents re-reports a stale `ItemCreated` flag on the source path, and `notify-debouncer-full`'s `push_rename_event` sees `was_created()` on the source queue and collapses the pair. Measured directly in `cubical-core`: rename #1 → `[Created]`, renames #2–#15 → `Renamed`, reproducible across runs. Linux inotify pairs reliably via rename cookies, so this is macOS-specific — and macOS is a primary target, so it must be handled, not documented away.

These need *different* mechanisms, because (b) leaves no `Removed` for a buffer to capture.

**Mechanism 1 — index reverse-lookup (durable).** On `Created`, stat the new file and query `files` for a row with the **same inode at a different path**. If that other path no longer exists on disk, the file moved: adopt it. This needs no buffer and no TTL, because §4 makes the index itself the tombstone. It is what rescues case (b).

**Mechanism 2 — tombstone buffer (ephemeral).** A `Removed` of a tracked file deletes its `files` row, destroying the reverse-lookup record. So before that delete, capture `(path, content_hash, inode, at)` into a bounded, 2-second-TTL buffer. A subsequent `Created` matching a live tombstone is promoted to an adopted rename. Unmatched tombstones expire and the `Removed` stands. This is what rescues case (a).

**Pairing precedence in both: inode first, hash second.** Inode is exact for same-volume moves. Hash covers cross-volume moves, where the inode necessarily changes but content is preserved. **Hash matching is skipped entirely when more than one tracked file shares that hash** — duplicate files would mis-pair, and a wrong rewrite is worse than no rewrite.

Both mechanisms funnel into the same `adopt_external_rename` from §2, so there is one commit path regardless of how the rename was recovered.

### 4. Populate `files.inode`

The watcher upsert writes `inode` as `NULL`. Replace with the real value from the already-performed `metadata` call (`MetadataExt::ino()` on Unix; `None` on Windows, where the fallback degrades to hash-only pairing). Backfill is unnecessary — the column is only read for files the watcher has seen since this ships, and a `NULL` inode simply means hash-only pairing for that row.

### 5. Integrity view for what cannot be paired

Some scrambles are genuinely unrecoverable: an agent that moves *and* rewrites a file in one step leaves no thread to follow. Silent rot is the one unacceptable outcome, so the residue must be visible.

A new engine query returns links whose `target_path` no longer resolves to a tracked file, grouped by target token, each with ranked repair candidates (existing `reconnect_broken_links_to` heuristics: basename match, case-insensitive match, title match). The UI surfaces this as a panel listing dangling links with a per-group "reattach to…" action; repair is **always user-confirmed**, never automatic — an unconfirmed guess would write wrong links into the user's `.md` files.

Automatic adoption (§2, §3) is confident and silent. Ambiguous repair (§5) is surfaced and consented. That boundary is the whole design.

## Out of scope

- No migration, no backfill of `inode` for existing rows.
- No folder-rename adoption in v1. An external `mv dir/ other/` arrives as a directory rename; adopting it means replaying `rename_folder`'s multi-file plan from watch events, which is a materially harder problem. v1 lets the per-file events inside it flow through the normal path and surfaces the residue in the integrity view. **Recorded as a known limitation, not a silent gap.**
- No interception, shimming, or sandboxing of external processes (see `foundation.md` §2.2).
- Nothing about the terminal itself — that is Spec B.

## Testing

Convergence claims are only worth what the tests prove, and the load-bearing tests must drive **real filesystem operations against a real engine**, not simulated watch events — a hand-constructed `WatchEvent::Renamed` would pass while the actual notify translation was broken.

1. **`commit_rename` extraction is behaviour-preserving.** The existing `rename_file` suite must pass unchanged. This is the regression gate for the refactor.
2. **End-to-end external rename.** Real vault, real watcher, `std::fs::rename` performed out-of-band; assert on disk that referrers were rewritten and that `.cubical/renames.jsonl` gained an entry.
3. **In-app rename is not double-applied.** Perform `rename_file`, let the watch event arrive, assert referrers were rewritten exactly once and one journal entry exists.
4. **Split-event pairing.** Emit `Removed` then `Created` outside the debounce window; assert promotion to an adopted rename via inode, and separately via hash with inode unavailable.
5. **Ambiguous hash is not paired.** Two tracked files with identical content; remove one, create a third with the same content; assert no rename is adopted and no links are rewritten.
6. **Tombstone expiry.** `Created` after the window leaves the `Removed` standing.
8. **Dropped-source recovery (macOS case b).** A bare `Created` with no preceding `Removed`, where a tracked `files` row holds the same inode at a path now absent from disk, is adopted. The real-watcher end-to-end test must cover the **first** rename in a watcher's lifetime — the T3 test's warm-up-move workaround exists precisely to dodge this, and once this lands the workaround must be removed, not kept.
7. **Integrity query.** Dangling links are reported with ranked candidates; a genuinely resolvable link is not reported.

Test 5 is the one that matters most — it is the case where a plausible implementation silently corrupts the user's files.

## Verification caveat

The **Tauri GUI smoke remains unrun** in non-interactive sessions, consistent with prior layers. Standing in for it: tests 2–6 drive a real watcher against a real vault, which is where all the risk in this spec lives. The integrity *panel* (§5 UI) is vault-gated and cannot be exercised without the Tauri backend; its engine query is covered by test 7.
