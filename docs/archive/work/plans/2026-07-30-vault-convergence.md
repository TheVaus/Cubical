> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Plan — vault convergence (Spec A)

**Spec:** [`2026-07-30-vault-convergence-design.md`](../specs/2026-07-30-vault-convergence-design.md)
**Branch:** `feat/vault-convergence`
**Gate:** `scripts/check.sh` (run the script, not the pieces)

## Task graph

```
T1 extract commit_rename ──┐
                           ├──> T3 wire Renamed → adopt_external_rename ──> T4 tombstone pairing
T2 populate files.inode ───┘

T5 integrity query + panel        (independent)
T6 isolate the console           (independent — Spec B step 2, requested now)
```

Parallel batch 1: **T1, T2, T6** (disjoint files).
Then: **T3** → **T4**. Batch alongside: **T5**.

## T1 — Extract `commit_rename` from `rename_file`

`crates/cubical-engine/src/commands/rename.rs`

Pull the post-syscall commit sequence out of `rename_file` into a helper that performs **no filesystem mutation**:

- collect referrers → mint op id → TX{enqueue referrers, rekey file} → journal append → refresh frontmatter/links/tags/blocks/block_refs/search at `to` → delete old search doc → fuse → emit pending-rewrites-changed.

`rename_file` becomes `validate_forward + fs::rename + commit_rename`.

**Acceptance:** pure refactor. Every existing `rename_file` / `rename_folder` test passes **unchanged**. No new behaviour, no signature change on `rename_file`.

## T2 — Populate `files.inode`

`crates/cubical-engine/src/events.rs` (~L365, the watcher upsert writing `inode` as literal `NULL`)

Write the real inode from the metadata already read by `read_file_stats`. `MetadataExt::ino()` under `#[cfg(unix)]`; `None` elsewhere. Update the `ON CONFLICT` arm to refresh it too.

**Acceptance:** a file seen by the watcher has a non-null `inode` on Unix; a `NULL` inode remains legal and simply means hash-only pairing later. No migration, no backfill.

## T3 — Wire `WatchEvent::Renamed` → `adopt_external_rename`

`crates/cubical-engine/src/events.rs` (the `Renamed { from, to: _ }` arm, ~L457) + `rename.rs`

Add `adopt_external_rename` = `validate_adopted + commit_rename` (destination exists, source gone — inverted from `rename_file`). Call it from the `Renamed` arm, which currently discards `to`.

**Idempotency without bookkeeping:** skip adoption when `files` has no row at `from` and does have one at `to` — that means the move was ours and is already committed. Do **not** try to reuse the hash-keyed `flush_own_writes` gate; `Renamed` deliberately carries no hash (see the existing `Renamed must not carry a hash` assertion).

Failed adoption logs and degrades to today's remove+create behaviour.

**Acceptance:** spec tests 2 and 3 — real out-of-band `std::fs::rename` rewrites referrers and journals; an in-app `rename_file` is **not** double-applied.

## T4 — Recover renames the watcher failed to pair

`crates/cubical-engine/src/events.rs`. **Revised after T3's measurement** — see spec §3.

Two failure modes needing two mechanisms, both funnelling into `adopt_external_rename`:

**M1 — index reverse-lookup (durable).** On `Created`, stat the file and look for a `files` row with the **same inode at a different path** that no longer exists on disk → adopt. No buffer, no TTL; T2 made the index the tombstone. Rescues the macOS dropped-source case, where **no `Removed` arrives at all** and a buffer would have nothing to hold.

**M2 — tombstone buffer (ephemeral).** `Removed` deletes the `files` row, destroying M1's record — so capture `(path, content_hash, inode, at)` *before* the delete into a bounded 2 s TTL buffer. A later `Created` matching a live tombstone is adopted. Rescues split `Removed`+`Created`.

Precedence in both: **inode first, then hash**. **Skip hash matching entirely when more than one tracked file shares that hash** — a wrong rewrite is worse than no rewrite.

**Acceptance:** spec tests 4, 5, 6, 8. Test 5 (ambiguous hash must not pair) is the one that matters — a plausible implementation silently corrupts user files here. Test 8 requires **removing** the warm-up-move workaround in T3's real-watcher test, which exists only to dodge this bug.

## T5 — Integrity query + panel

Engine: query links whose `target_path` resolves to no tracked file, grouped by target token, each with ranked repair candidates reusing `reconnect_broken_links_to`'s heuristics (basename, case-insensitive, title).

UI: panel listing dangling links with a per-group "reattach to…" action. Repair is **always user-confirmed** — never automatic.

**Acceptance:** spec test 7. Resolvable links are not reported.

## T6 — Isolate the console (do not delete)

Collapse the console's surface to a single wiring point so terminal work cannot collide with it. Currently spread across `ui/src/console/`, `ui/src/api/ipc.ts`, `ui/src/core/commands.ts`, `ui/src/settings/corePlugins.ts`, `ui/src/tabs/*`, `crates/cubical-app/src/lib.rs`, `crates/cubical-ipc/`.

**Acceptance:** console still works exactly as today, its tests pass unchanged, and it is removable in one commit later. **Nothing deleted.**

## Out of scope

Folder-rename adoption (known limitation, recorded in the spec). Any interception or sandboxing of external processes. The terminal itself (Spec B).
