# Rename durability journal — design

**Date:** 2026-06-27
**Status:** built 2026-06-27 (see "What landed" below)
**Owner area:** L3 rename / pending-rewrites (`crates/cubical-app/src/commands/rename.rs`,
`crates/cubical-core/src/vault/pending.rs`)

## What landed (2026-06-27)

- **Pure core + I/O** — `crates/cubical-core/src/vault/rename_journal.rs`:
  `RenameJournalEntry`, serialize/parse/parse_all/compact, plus
  `journal_path` / `append_entry` / `read_entries` / `rewrite_without` over the
  `.cubical/renames.jsonl` sidecar. 9 tests.
- **Append on rename** — `rename_file` appends a `file` entry after the on-disk
  move (best-effort; a journal write failure logs, doesn't fail the rename).
- **Replay on open** — `replay_rename_journal` runs in the scan-success arm of
  `spawn_scan_dispatcher` (`events.rs`). For each surviving entry whose `from` is
  gone but `to` is tracked: reconnect broken referrers naming `from`
  (case-insensitive) + re-enqueue their rewrites under a fresh op; prune the
  entry once no referrer text still names `from` (rewrites flushed) or `to` is
  gone (stale). Idempotent. Integration test simulates the index wipe and asserts
  reconnection + rewrite regeneration.

**Deferred from this pass (follow-ups, not blockers):**
- The reconnect SQL is duplicated, not extracted: `rename_file`'s inline repair
  and `replay_rename_journal`'s reconnect use **identical** case-insensitive
  predicates but live in two places. Extracting a shared
  `reconnect_broken_links_to` helper (as this doc originally specced) is a clean
  follow-up to remove the drift risk.
- No dedicated post-flush prune hook; replay prunes opportunistically on the next
  open instead. So a journal entry can persist between a rename and the next
  open's flush+replay — bounded and harmless, but a flush-time prune would keep
  the file smaller.

## Problem

`pending_rewrites` is the one piece of **non-derivable** state in the system: it
records, per referrer file, the `[[OldName]] → [[NewName]]` text edits a rename
deferred. It lives in the libSQL index — which the architecture treats as
**disposable / rebuildable from `.md`**.

But the file move itself is committed to disk *immediately* during `rename_file`
([rename.rs §"Move the file on disk"](../../../crates/cubical-app/src/commands/rename.rs)),
while the referrer text edits are deferred. So if the index is wiped/rebuilt
while rewrites are unflushed:

- the file is at `NewName.md` on disk,
- referrers still say `[[OldName]]`,
- the `Old → New` mapping lived **only** in the wiped `pending_rewrites` table,
- on rescan those links resolve to nothing → **silently broken**, with no
  breadcrumb left to auto-fix them.

A normal crash/quit does **not** hit this — `pending_rewrites` persists in libSQL
and flushes on the next timer tick or close. The hole is specifically: *wipe the
disposable index while a rename is in-flight.*

## Goal (the property we want)

Losing the index can cost **unflushed text propagation** (the last few minutes)
but must **never** cost correctness. Reopen → links reconnect by name → the
deferred text edits regenerate and flush normally.

## Decision

Add a durable **rename journal** sidecar at `<vault>/.cubical/renames.jsonl`,
mirroring the existing `.cubical/config.toml` sidecar pattern
(`vault::settings::settings_path` + `atomic::atomic_write`).

Rejected alternative — *defer the on-disk file move too* (so the whole rename
lives in the disposable cache): cleaner in theory, but it leaks the old filename
to external tools until flush, needs filename virtualization + create/collision
handling, and is far more invasive for the same payoff. Not worth it.

### Why this respects the non-negotiables

- `.cubical/` is already part of the portable vault (it holds `config.toml`),
  travels with it, and needs no external service.
- Zero `.md` bytes touched; no file-identity UUIDs (paths only) — Layer-7 rule
  intact.
- The journal does not make the **index** non-rebuildable; it makes one fact the
  index *already* couldn't rebuild (`pending_rewrites`) survive an index wipe.
  This is consistent with "index is derived state", not a violation of it.

## Format

Append-only JSONL, one object per rename op:

```json
{"op_id": 7, "kind": "file", "from": "notes/Daily.md", "to": "notes/Journal.md", "at": 1750000000}
```

- `kind` is `file` for v1. (Tag / block-id renames don't strand *files*, so they
  are out of v1 scope — see below. Field is present so the format extends.)
- Keyed by path, no UUIDs. Append-only so writes are O(1) and crash-safe;
  compaction (rewrite without pruned lines) happens opportunistically.

## Lifecycle

1. **Write** — inside `rename_file`, after the on-disk move succeeds, append one
   line for the op. Best-effort: a journal write failure logs and does not fail
   the rename (the in-index `pending_rewrites` still covers the common path).

2. **Prune** — an op is "done" once no `pending_rewrites` rows reference its
   `rename_op_id` (all referrers flushed → the rename is baked into the `.md`
   files and needs no journal). Prune opportunistically after flush, when
   `pending_count` for the op hits zero. So in the happy path journal entries are
   short-lived; only in-flight renames persist — exactly the recovery window.

3. **Replay** — on vault open, after the scan has populated `files` + `links`,
   for each surviving journal entry whose `from` no longer exists but `to` does:
   reconnect broken links naming `from` (basename or path form, case-insensitive
   — reuse the repair logic already in `rename_file`) to `to`, and re-enqueue the
   text rewrites. Then normal flush proceeds. Entries whose `to` is also gone
   (renamed again externally, or the journal is stale) are dropped.

The replay reconnection is **the same operation** `rename_file` already performs
for broken links (`wikilinks.rewrite_broken_links_on_rename`); extract it into a
shared `reconnect_broken_links_to(vault, from_path, to_path)` helper so the
rename path and the replay path can't drift.

## Integration points

- `crates/cubical-core/src/vault/rename_journal.rs` (new) — pure-ish module:
  serialize/parse one entry, `append`, `read_all`, `compact` (drop a set of
  op_ids). Pure parse/serialize is unit-tested; the file I/O is a thin wrapper.
- `rename.rs` — append on rename; prune after flush; call replay on open.
- A shared `reconnect_broken_links_to` helper (extracted from the existing
  repair block) used by both rename and replay.

## Out of scope (v1)

- Tag / block-id rename journaling — those don't strand *files*; a wiped index
  just loses the deferred text edits for those, which is acceptable (the tag /
  block still exists; only some referrers keep old text until re-edited). Can
  extend the same format later if we decide it's worth it.
- Post-flush undo of a journaled rename (that's L8 Time Machine, same as the
  existing `undo_rename` boundary).
- Cross-vault.

## Test plan (TDD)

Pure core first:
- parse/serialize round-trip; tolerate blank / malformed lines (skip, don't
  crash); `read_all` ordering; `compact` drops the right op_ids.
Then integration:
- rename appends a journal line; flush-to-zero prunes it.
- simulate index wipe: drop the index, reopen, assert broken referrers reconnect
  + pending rewrites regenerate (the core "never lose correctness" guarantee).
- stale entry (`to` missing) is dropped on replay without error.
