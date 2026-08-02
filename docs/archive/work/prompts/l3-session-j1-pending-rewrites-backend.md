> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session J.1 — Pending Rewrites Cache (backend + headless flow)

L3 Session J.1 for the Cubical project. The backend half of Session J — every behaviour spec'd in `docs/architecture/document-model.md` §5.7 and `docs/layer-3-spec.md` §2.10 lands behind direct IPC calls, with full Rust test coverage. Frontend ships **typed binding stubs only** (no UI). J.2 wires the bindings into the status bar, toast, undo affordance, and the file-rename gesture.

Design is locked in [`docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](../specs/2026-05-31-l3-session-j-pending-rewrites-design.md). That spec is the source of truth — every "Decisions to raise" item from the parent prompt is already resolved there.

Do NOT start Session J.2 or K in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, "Project state" block.
   - `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` — **the design spec; this prompt is its executor**. Re-read every section.
   - `docs/layer-3-spec.md` §1 goal 10, §2.10, §3.4, §3.5, §5 deviations, §6 DoD, §8 Session J, §9.14 (Session I — closest precedent for voice).
   - `docs/architecture/document-model.md` §5.7 — locked schema + behaviour.
   - `docs/conventions.md`, `docs/migration-touchpoints.md`.

2. Read for context (skim; come back to specific lines):
   - `crates/cubical-index/migrations/001..005_*.sql` — migration conventions.
   - `crates/cubical-index/src/runner.rs` — `HIGHEST_KNOWN_VERSION` constant (currently `5`, bumps to `6`).
   - `crates/cubical-index/src/{links,tags,blocks}.rs` — query module pattern.
   - `crates/cubical-core/src/vault/{links,tags,blocks,mentions}.rs` — pure scanner pattern.
   - `crates/cubical-core/src/vault/scan.rs` — two-pass scan; the materialize-on-read hook lands inside the extraction passes.
   - `crates/cubical-core/src/vault/watcher.rs` — `apply_watch_event_to_db` dispatch (own-write hash gate consumer).
   - `crates/cubical-app/src/commands/{vault,blocks,mentions,embeds}.rs` — handler patterns; `vault::write_file_text` is the atomic-write template; `mentions::link_mention` is the read-modify-write precedent.
   - `crates/cubical-app/src/lib.rs` — `generate_handler!` registration site.
   - `crates/cubical-app/src/api/types.rs` — wire-type style.
   - `ui/src/api/ipc.ts` — IPC binding shape (J.1's frontend deliverable is stubs here only).

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` → `merge: L3 Session I — unlinked mentions` (commit `30aa655`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`, `l1`, `l2`; does NOT contain `l3`.
   - CLAUDE.md "Project state" reports L3 Sessions A–F + G + H.1 + H.2 + I done; Sessions J + K pending. If not, STOP.

4. Baseline test counts (must match CLAUDE.md "Project state"):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'` → 326.
   - `cd ui && npx vitest run` → 329 vitest green.
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-j1-pending-rewrites-backend`

---

## STEP 1 — SKILLS TO INVOKE

- `using-superpowers` — ALWAYS, first.
- **Skip `brainstorming`** — the design is already locked in the spec above. Re-read the spec instead.
- `writing-plans` — produces `docs/superpowers/plans/2026-05-31-l3-session-j1-pending-rewrites-backend.md`. Same shape as the Session I plan. Use the design spec's "J.1 — Backend" section as the substrate; every Decision is already baked in.
- `subagent-driven-development` (preferred — backend has independent task chains: migration, pending query module, materializer, rename handlers, flush handlers) or `executing-plans` if subagents aren't available.
- `test-driven-development` — every behaviour change lands with a failing test first. Especially load-bearing here for: enqueue/materialize round-trip, flush idempotency, external-write conflict re-apply (silent drop), undo deletes only the right `rename_op_id` group, backend own-write gate suppresses flush bounce-backs.
- `verification-before-completion` — fresh test output before merge. J.1 has no UI to smoke; the headless smoke recipe is documented in §9.15.
- `finishing-a-development-branch` — ALWAYS, at the very end.

---

## STEP 2 — THE WORK (design spec is the source of truth)

Pull the **J.1 — Backend** section of the design spec into the plan as the substrate. Summary checklist (full breakdown lives in the plan):

1. **Migration `006_pending_rewrites.sql`** + `HIGHEST_KNOWN_VERSION = 6`; runner tests cover the upgrade.
2. **`cubical-index::pending` query module** — `PendingRewriteRow`, `RewriteKind`, `enqueue_pending`, `pending_for_target`, `pending_targets`, `pending_count_total`, `pending_count_for_target`, `pending_count_breakdown`, `delete_rename_op`, `delete_pending_for_target`, `list_recent_rename_ops`. Full unit coverage.
3. **`cubical-core::vault::pending`** — `PendingRewrite`, pure `apply_pending(source, &[PendingRewrite]) -> String` covering all three rewrite kinds incl. nested tags, `|display` + `#anchor` preservation, frontmatter `tags:` list updates, defining-line `^id` rewrite for `BlockRef`; async `materialize_on_read(idx, path, on_disk) -> Result<String, IndexError>` wrapper.
4. **Materialize-on-read wiring** — into `commands::vault::read_file_text`, `commands::vault::get_canonical_ast` (if it reads at the IPC boundary), `commands::embeds::get_embed`, `commands::mentions::get_unlinked_mentions` (source files), the scan + watcher extraction passes. `link_mention` flushes the source file's pending rows first, then re-reads disk, then splices.
5. **Rename IPCs** — new `cubical-app::commands::rename` module + `mint_rename_op_id` helper (using `config['pending_rewrites.next_rename_op_id']`):
   - `rename_file` — enqueues per distinct `(source_path, target_raw)` from `links`, moves the file via `fs::rename` (atomic-write fallback for cross-FS), updates `files.path` (ensure `ON UPDATE CASCADE` on all FKs — ship migration `007_*` only if a cascade is missing), re-extracts moved file's outbound links/tags/blocks.
   - `rename_tag` — enqueues per distinct `file_path` from `tags WHERE tag_path = ?old OR tag_path LIKE ?old || '/%'`.
   - `rename_block_id` — enqueues per distinct `source_file_path` from `block_refs WHERE (target_file_path, target_block_id) = (?file, ?old)` AND one extra row targeting `?file` itself (defining-line rewrite).
   - Each emits `vault:pending-rewrites-changed { vault_id, count }`.
6. **Flush + helpers**:
   - `flush_pending_rewrites` — read fresh, apply, atomic-write, eager `files.content_hash` update; external-write conflict per §5.7 (textual re-apply naturally drops missing tokens); emits `vault:flush-complete { vault_id, files_rewritten, refs_updated }`.
   - `flush_pending_rewrites_for_target` — same, scoped to one file (used by >50 fuse + `link_mention`'s precondition).
   - `get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`, `undo_rename`.
   - `Mutex<()>` per-vault `flush_in_progress` guard so concurrent triggers don't interleave.
7. **Backend own-write hash gate** — per-vault `Mutex<HashSet<(PathBuf, ContentHash)>>` populated by flush, drained by watcher dispatcher's `Modified` branch before emitting `vault:file-changed`. Tests: flush a file → assert watcher dispatcher does NOT propagate `vault:file-changed`; an unrelated external write does.
8. **Flush triggers**:
   - Periodic timer — per-vault tokio task; reads `pending_rewrites.flush_interval_secs` (default `300`); cancelled in `close_vault` via `CancellationToken`.
   - App close — `close_vault` awaits a flush before dropping the index handle. Failure logged, does not block close.
   - >50-per-file fuse — `enqueue_pending` checks; on cross calls `flush_pending_rewrites_for_target` synchronously.
   - Manual — IPC exposed.
9. **IPC registration** — `lib.rs` `generate_handler!` gains the seven new entries; wire types in `api/types.rs` (or `commands/rename.rs`).
10. **Frontend stub** — `ui/src/api/ipc.ts` gains typed bindings + the two listeners + `pending_rewrites.flush_interval_secs` in `Setting`. Exported but unused — `tsc` allows that.
11. **Spec write-up** — fill `docs/layer-3-spec.md` §9.15 ("Session J.1 — Pending Rewrites backend") mirroring §9.14's voice; explicitly note J.2 is the frontend follow-up.
12. **CLAUDE.md "Project state"** — rewrite to A–F + G + H.1 + H.2 + I + J.1 done; J.2 + K pending; final J.1 test counts; "Next" = Session J.2.

Refer to the design spec for the locked decisions, pseudocode, and per-area test catalogue.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` → 326 baseline + new (expected ~50 from migration + `pending` index + `apply_pending` per-kind + each rename handler + flush incl. silent-drop + own-write gate + each trigger + undo). Document the new count.
- `cd ui && npx tsc --noEmit` → clean (the new binding stubs typecheck).
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 329 (no new vitest in J.1; stubs are unused).
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` → clean.
- **Headless smoke recipe** documented in §9.15 (J.1 has no UI; hands-on smoke deferred to J.2 per Session I's precedent for split sessions).

---

## DEFINITION OF DONE

- [ ] Step 0 state checks passed; branch `l3-session-j1-pending-rewrites-backend` created from `main`.
- [ ] Plan written at `docs/superpowers/plans/2026-05-31-l3-session-j1-pending-rewrites-backend.md` referencing the locked design spec.
- [ ] Migration `006_pending_rewrites.sql` lands; `HIGHEST_KNOWN_VERSION = 6`; runner tests cover the upgrade.
- [ ] `cubical-index::pending` query module ships with full unit coverage.
- [ ] `cubical-core::vault::pending::apply_pending` covers all three rewrite kinds incl. nested tags + block-id literal-line rewrite + frontmatter `tags:` list updates + `|display` + `#anchor` preservation.
- [ ] Three rename IPCs end-to-end; each mints a fresh `rename_op_id` and emits `vault:pending-rewrites-changed`.
- [ ] `flush_pending_rewrites` + `flush_pending_rewrites_for_target` rewrite atomically with the backend own-write hash gate; silent-drop conflict re-apply works; `vault:flush-complete` emitted.
- [ ] `get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`, `undo_rename` ship.
- [ ] All four flush triggers exercised in tests (periodic-timer, app-close, >50 fuse, manual).
- [ ] Materialize-on-read wired into `read_file_text`, `get_canonical_ast`, `get_embed`, `get_unlinked_mentions`, and the scan extraction passes. `link_mention` flushes-then-reads-then-splices.
- [ ] `ui/src/api/ipc.ts` typed binding stubs land (unused).
- [ ] §9.15 filled with what was built (mirroring §9.14's voice); J.2 explicitly named as the follow-up.
- [ ] CLAUDE.md "Project state" rewritten to A–F + G + H.1 + H.2 + I + J.1 done; J.2 + K pending.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`, `vitest`, `clippy`, `fmt`.
- [ ] Headless smoke recipe documented; hands-on smoke explicitly deferred to J.2.

---

## OUT OF SCOPE (do not build in this session)

- Any UI surface (status bar, toast, undo affordance, file-rename gesture) — J.2.
- Vitest coverage of pending-rewrites behaviours — there's no frontend behaviour to test in J.1.
- Hands-on `cargo tauri dev` smoke of the J flows — J.2.
- L3 closeout, `l3` tag, full L3 smoke pass — Session K.
- Post-flush undo (full reverse rewrite) — L8 Time Machine.
- Diff-view modal on the flush toast click — L8.
- 3-way merge UI on external-write conflicts — L8.
- H.3 polish (rich markdown in embed bodies, click navigation, `⎘` retirement).
- A new `vault:index-changed` event (still no second consumer materialised).
- Cross-vault renames — `ui.md` §11.5 out of scope project-wide.
- Plugin capability surface for materialized reads — plugins land in a later layer.
- Rename of headings / arbitrary text — only file / tag / block-id are first-class.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching recent sessions (`feat(index): migration 006 …`, `feat(core): vault::pending materializer …`, `feat(app): rename IPCs …`, `feat(app): flush + triggers …`, `feat(ui): pending-rewrites IPC stubs …`, `test(…): …`, `docs(l3): close Session J.1 — pending rewrites backend`). Do NOT skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Default per project workflow: merge `l3-session-j1-pending-rewrites-backend` into `main` after verifying green, `--no-ff`, with commit message `merge: L3 Session J.1 — pending rewrites backend`.
3. Report back: every DoD box's status, new test counts, the headless smoke recipe location, and name the next session — L3 Session J.2 (status bar + toast + undo + file-rename gesture).
