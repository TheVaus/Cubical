> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session J — Rename → Pending Rewrites Cache

L3 Session J for the Cubical project. Renaming a file, a tag, or a block-id becomes **instant**; the disk impact — rewriting referrer files — is **coalesced** through a new `pending_rewrites` libSQL table. Every read of a file's effective content materializes pending rewrites against the on-disk source. Flush triggers: 5-minute timer (configurable), app close (mandatory), >50-pending-per-file fuse, manual "save all pending changes." Status bar shows the unflushed count; flush emits a toast. Undo within the unflushed window is instant. Builds on Sessions A (`links`), D (`tags`), and G (`blocks` / `block_refs`).

**Scope warning — this is the largest L3 session.** It spans three rename surfaces × backend enqueue × materialize-on-read × four flush triggers × status bar × toast × undo × external-write-conflict re-apply. If your STEP-1 plan grows past ~12 substantial tasks, **stop and brainstorm a J.1 / J.2 split** — mirroring how Session H split into H.1 (backend extractor) and H.2 (frontend widget). The natural seam: J.1 = migration + enqueue + materialize-on-read + IPC + flush; J.2 = status bar + toast + undo button + the file-rename UI gesture. Default to a single session if the plan stays tight.

Do NOT start Session K in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — session primer, non-negotiables, "Project state" block (currently reports L3 Sessions A–F + scan perf fix + G + `[[#^` + H.1 + H.2 + I done; Sessions J + K pending).
   - `docs/README.md` — docs index.
   - `docs/layer-3-spec.md` — especially §1 goal 10, §2.10 (Rename → Pending Rewrites Cache surface), §3.4 (IPC: `rename_file`, `rename_tag`, `rename_block_id`, `flush_pending_rewrites`, `get_pending_rewrites_count`, `undo_rename`), §3.5 (events incl. `vault:pending-rewrites-changed`), §4 (frontend file map — `statusbar/PendingRewrites.tsx`), §5 deviations, §6 Definition of Done, §8 Session J, plus the §9 closeouts for the surfaces this session integrates with: §9.1–§9.2 (links), §9.4 (tags/frontmatter), §9.8 (block refs), §9.14 (mentions — uses the same atomic-write pattern).
   - `docs/architecture/document-model.md` §5.7 (Pending Rewrites Cache — the locked schema and behaviour spec; this is the *source of truth* for materialize-on-read, flush triggers, conflict re-apply).
   - `docs/architecture/ui.md` §11 (sidebar + status bar surfaces).
   - `docs/conventions.md` — code style.
   - `docs/migration-touchpoints.md` — if you touch IPC.

2. Read for context (skim; come back to specific lines):
   - `crates/cubical-index/migrations/` — five existing migrations (`001_initial.sql` through `005_blocks.sql`). J adds `006_pending_rewrites.sql`. The runner (`runner.rs`) needs `HIGHEST_KNOWN_VERSION` bumped to 6.
   - `crates/cubical-index/src/{links,tags,blocks}.rs` — query module pattern (`replace_X_for_file`, `X_for_file`).
   - `crates/cubical-core/src/vault/{links,tags,blocks,mentions}.rs` — pure scanner + `refresh_X` shape. Pending rewrites needs its own pure module (`cubical-core::vault::pending` or similar) for materialize-on-read.
   - `crates/cubical-core/src/vault/scan.rs` — two-pass scan pattern. Pending materialization may need to slot in here so the scan sees post-rewrite content (decide in the plan — see decisions below).
   - `crates/cubical-app/src/commands/{vault,blocks,mentions}.rs` — handler patterns. `vault::write_file_text` is the atomic-write + hash-gate precedent; `mentions::link_mention` is the freshest read-modify-write precedent (atomic write, file hash eager update, no `expected_seen_hash` for non-open files).
   - `crates/cubical-app/src/commands/vault.rs::read_file_text` — the existing read path. Materialize-on-read changes its contract.
   - `crates/cubical-app/src/events.rs` (or wherever the existing `vault:file-changed` is emitted) — the new `vault:pending-rewrites-changed` event lives next to it.
   - `crates/cubical-app/src/lib.rs` — `generate_handler!` registration. The freshest precedents are `get_unlinked_mentions` + `link_mention` (Session I) and `get_embed` (Session H.1).
   - `crates/cubical-app/src/api/types.rs` — wire-type style.
   - `ui/src/App.tsx` — autosave timer + various `scheduleX` debounce patterns (the broken-block-refs ticker and the right-sidebar refresh ticker are the freshest precedents). The status-bar footer (around line 1404–1436) is where the pending-rewrites count lands.
   - `ui/src/statusbar/brokenRefs.ts` (pure formatter) — model for `pendingRewrites.ts` (count → label).
   - `ui/src/api/ipc.ts` — IPC binding shape; recent `getUnlinkedMentions` + `linkMention` are the freshest precedents.

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
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-j-pending-rewrites`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `using-superpowers` — ALWAYS, first.
- `brainstorming` — **REQUIRED for this session** (unlike Session I, which skipped it). The Session J scope is wide enough that the J.1 / J.2 split decision is real and should be made before plan-writing. Use the brainstorm to: (a) decide single-session vs split; (b) lock the materialize-on-read invariant (which readers see materialized vs raw content); (c) decide the file-rename UI gesture (the spec doesn't pin one).
- `writing-plans` — produces a fresh plan at `docs/superpowers/plans/<date>-l3-session-j-pending-rewrites.md` (or `…-j1-…` / `…-j2-…` if split). Same shape as the Session I plan (`docs/superpowers/plans/2026-05-30-l3-session-i-unlinked-mentions.md`).
- `subagent-driven-development` (preferred — independent task chains across migration, IPC, materialize helper, frontend) or `executing-plans` if subagents aren't available.
- `test-driven-development` — every behaviour change lands with a failing test first. Especially load-bearing here for: enqueue/materialize round-trip, flush idempotency, external-write conflict re-apply, undo deletes only the right `rename_op_id` group.
- `verification-before-completion` — fresh test output + recorded smoke evidence before any merge. The smoke matrix is bigger than I's — see VERIFICATION below.
- `finishing-a-development-branch` — ALWAYS, at the very end.

---

## STEP 2 — THE WORK (layer-3-spec.md §2.10 + §8 Session J + document-model.md §5.7)

In summary (full task breakdown lives in the plan):

1. **Migration — `006_pending_rewrites.sql`.** Locked schema (document-model.md §5.7):

   ```sql
   CREATE TABLE pending_rewrites (
       id              INTEGER PRIMARY KEY AUTOINCREMENT,
       target_file     TEXT NOT NULL,
       rewrite_kind    TEXT NOT NULL,         -- 'wiki_link' | 'tag' | 'block_ref'
       old_token       TEXT NOT NULL,
       new_token       TEXT NOT NULL,
       created_at      INTEGER NOT NULL,
       rename_op_id    INTEGER NOT NULL
   );
   CREATE INDEX idx_pending_target ON pending_rewrites(target_file);
   CREATE INDEX idx_pending_op     ON pending_rewrites(rename_op_id);
   ```

   No FK on `target_file → files(path)` because (a) the spec doesn't lock one, (b) a rewrite targeting a since-deleted file should silently drop on flush rather than block the migration runner. Bump `HIGHEST_KNOWN_VERSION = 6` in `runner.rs`.

2. **`cubical-index::pending` query module.** Functions: `enqueue_pending`, `pending_for_target`, `pending_count_total`, `pending_count_for_target`, `delete_rename_op`, `delete_pending_for_target` (used after a successful flush). Mirror the shape of `cubical-index::blocks` / `cubical-index::links`.

3. **Pure materialization — `cubical-core::vault::pending` (new module).** Two pure helpers:
   - `apply_pending(source: &str, rewrites: &[PendingRewrite]) -> String` — apply each `(old_token, new_token)` in `created_at` order. Pure string ops; no DB, no I/O. Three rewrite kinds:
     - `wiki_link`: replaces every `[[old_target…]]` / `![[old_target…]]` occurrence, preserving optional `|display` and `#anchor`. Reuse `cubical_ast::scan_wikilinks` (already `pub` since Session I) — walk tokens, rewrite only the `target` field, re-emit.
     - `tag`: replaces inline `#old_tag` (whole-tag boundary; nested tags `#old_tag/child` rename to `#new_tag/child`) AND frontmatter `tags:` list entries equal to `old_tag` or rooted at `old_tag/`. Heavy unit tests required.
     - `block_ref`: replaces every `[[note#^old_id]]` referrer AND the `^old_id` literal on the defining line.
   - `materialize_on_read(vault, path, on_disk: &str) -> String` — pull pending rows for `path`, call `apply_pending`. Used by every read path that needs effective content.

4. **Read-path integration.** Decide once: which read paths see materialized content?
   - `cubical-app::commands::vault::read_file_text` — **MUST materialize** (the editor displays this). Frontend sees post-rename text.
   - `cubical-app::commands::vault::get_canonical_ast` — **MUST materialize** (otherwise the AST disagrees with the editor view).
   - `cubical-app::commands::embeds::get_embed` — **MUST materialize** (embed content reflects renames).
   - `cubical-app::commands::mentions::get_unlinked_mentions` / `link_mention` — see decision below; default is materialize the *source* file but leave the open note's title/aliases at on-disk values (a self-rename hasn't flushed yet either).
   - Scan / watcher (`cubical-core::vault::scan`, `cubical-core::vault::watcher::apply_watch_event_to_db`) — see decision below; the cleanest call is "scan sees materialized content for the link/tag/block extractors" so backlinks reflect the post-rename world. This is the trickiest plumbing — get the brainstorm to lock it.
   - **Watcher own-write suppression for flush:** the flush writes files itself; the watcher will fire `vault:file-changed` for each. The existing `last_written_hash` mechanism is per-buffer (editor side); flush has no editor. Decide a backend-side own-write hash gate (a short-lived set of (path, hash) tuples the flush populates and the watcher dispatcher drains).

5. **Rename IPC handlers — `cubical-app::commands::rename`** (new module). Each rename mints a fresh `rename_op_id` (UUID or monotonically-increasing — decide), enqueues one `pending_rewrites` row per referrer, and emits `vault:pending-rewrites-changed { vault_id, count }`. Three handlers:
   - `rename_file { vault_id, from_path, to_path }` — query `links` for every referrer; enqueue `wiki_link` rewrites; **also rename the file itself on disk** (atomic move + update `files.path` + cascade). The rename of the file is synchronous (instant); the referrer rewrites are deferred. Returns `{ rename_op_id }`.
   - `rename_tag { vault_id, old_tag, new_tag }` — query `tags` for every carrying file; enqueue `tag` rewrites; no file move. Returns `{ rename_op_id }`.
   - `rename_block_id { vault_id, file_path, old_id, new_id }` — query `block_refs` for every referrer; enqueue `block_ref` rewrites that target both the referrer files (for the `[[note#^old_id]]` updates) AND the defining file (for the `^old_id` → `^new_id` literal). Returns `{ rename_op_id }`.

6. **Flush + helpers — `cubical-app::commands::rename` continued.**
   - `flush_pending_rewrites { vault_id }` → `{ files_rewritten, refs_updated }`. For each distinct `target_file` with pending rows: read on-disk content; call `apply_pending`; if it changed, write atomically (`atomic_write`) with the backend-side own-write hash gate; `DELETE FROM pending_rewrites WHERE target_file = ?`. External-write conflict per §5.7: re-apply textually — find `old_token` in the freshly-read disk content; if present, replace; if not, drop the row silently. Emits `vault:pending-rewrites-changed { count: 0 }` on completion + a `vault:flush-complete { files_rewritten, refs_updated }` event the toast subscribes to.
   - `get_pending_rewrites_count { vault_id }` → `{ count }`. Sum across the table.
   - `undo_rename { vault_id, rename_op_id }` — `DELETE FROM pending_rewrites WHERE rename_op_id = ?`. Emits the count-changed event. Spec §5.7 footnote: "After flush, undo is a full reverse rewrite — same flush mechanism, opposite direction" — that's L8 territory, NOT in scope here. Pre-flush undo only in J.

7. **Flush triggers.**
   - **Periodic timer** — 5 min default; setting key `pending_rewrites.flush_interval_secs`. A new tokio task spawned per open vault, cancelled on `close_vault`.
   - **App close** — `close_vault` calls `flush_pending_rewrites` synchronously before tearing down.
   - **>50-per-file fuse** — checked in `enqueue_pending`; if the count for any single `target_file` would cross 50, call flush immediately for that file (or all? — decide). Document-model says "exceeding 50" so it's a hard ceiling.
   - **Manual** — exposed as the existing IPC; the frontend wires a "Save all pending changes" button into the status bar.

8. **Frontend — IPC bindings (`ui/src/api/ipc.ts`).** `renameFile`, `renameTag`, `renameBlockId`, `flushPendingRewrites`, `getPendingRewritesCount`, `undoRename` + `onVaultPendingRewritesChanged` + `onVaultFlushComplete` listeners. Plus the new setting key in the `Setting` union: `pending_rewrites.flush_interval_secs`.

9. **Frontend — status bar + toast (`ui/src/statusbar/PendingRewrites.tsx`).** Pure formatter `formatPendingRewrites(count) -> string` (mirror `formatBrokenBlockRefs`). Tooltip lists the per-target counts (`get_pending_rewrites_count_breakdown`? — see decisions). Click → opens an Undo dropdown (or a diff view — spec mentions "Click → diff view" but that's L8 territory; J ships click → "Flush now" / "Undo last rename"). Toast on flush complete: "Applied {refs_updated} reference updates across {files_rewritten} files."

10. **Frontend — file-rename UI gesture.** Spec doesn't lock one. **Decision required at plan time.** Default: right-click on a file in the file list → context menu → "Rename…" → inline rename input. Alternative: keyboard shortcut on the selected file. Whatever you pick, the plan must own the UX choice.

11. **App.tsx wiring.** Subscribe to `vault:pending-rewrites-changed`, store the count in a signal, pass to the status-bar item. Subscribe to `vault:flush-complete`, render the toast. Drop the count on `close_vault`. Add the periodic-timer setting to the vault-open block.

12. **Spec write-up.** Fill `docs/layer-3-spec.md` §9.15 ("Session J — Rename → Pending Rewrites Cache") mirroring the §9.14 voice + structure (Wire shape · Migration · Materialize helper · Rename handlers · Flush · Frontend · Decisions worth noting · Tests · Smoke status · What's left for L3). If you split into J.1 / J.2, write §9.15 (backend) + §9.16 (frontend) accordingly.

13. **Project state.** Rewrite the CLAUDE.md "Project state" block: L3 Sessions A–F + G + H.1 + H.2 + I + J done; Session K pending; final test counts; "Next" = Session K (closeout + `l3` tag + full L3 smoke pass).

---

## Decisions to raise in the plan (the spec leaves them open)

- **Single session vs J.1 / J.2 split.** Make this call FIRST. If the plan grows past ~12 substantial tasks, split. The natural seam is "backend lands + IPC + flush works headlessly" (J.1) and "status bar + toast + undo button + file-rename UI gesture" (J.2). H.1 / H.2 is the precedent.
- **`rename_op_id` type.** Monotonic `INTEGER` (auto-incremented per-vault counter in the `config` table) vs `TEXT` UUID. Lean: monotonic — easier to display, sortable, no UUID dependency. Spec says "groups all rewrites from one rename" — either works.
- **File-rename UI gesture.** Right-click menu (default) vs keyboard shortcut vs both. Lock one for J; the other can land in K's polish if needed.
- **Materialize for the scanner.** If the scan reads raw on-disk content, backlinks after a rename will reflect the *old* tokens until flush. If the scan materializes, the index agrees with the editor view. Materialize — but it adds one indexed query per file-scan iteration. Recommend materialize and benchmark on the 30k-file vault if time permits.
- **Watcher own-write suppression for flush writes.** A short-lived `HashSet<(PathBuf, ContentHash)>` populated by flush and drained by the watcher dispatcher. Same idea as the editor's `lastWrittenHash` but backend-owned, vault-scoped.
- **>50 fuse: flush this file only, or full flush?** Document-model says "exceeding 50" as a per-file ceiling. Recommend: flush only the offending target_file synchronously (still emit the count-changed event); rest stays deferred.
- **Pending count breakdown for the tooltip.** New IPC `get_pending_rewrites_breakdown` returning `Vec<{target_file, count}>` ordered by count desc. Or just show the flat total + a list in the click-out. Lean: total only in the status bar, breakdown in the click-out dropdown.
- **`read_file_text` materialize vs raw.** Always materialize. The watcher's hash pass reads raw bytes for `content_hash` (already does, via the hash primitive); no IPC consumer needs raw.
- **`get_canonical_ast` materialize vs raw.** Materialize. Otherwise the editor's Lezer view disagrees with the indexer's canonical view.
- **Undo button placement.** Per-rename undo within the unflushed window. Recommend the status-bar click-out lists the last N pending rename ops with an "Undo" affordance per op.
- **Toast UI.** The codebase has no toast component yet. Either build a minimal one (`ui/src/Toast.tsx` — auto-dismiss after 4s, single-slot, dismissible) or piggyback on the existing error banner. Recommend: minimal toast — also useful for future flush/error/save events. Build cost is small (~50 lines).
- **External-write-conflict re-apply boundary.** If the user edited the file between rename and flush, and the new content **also** changed the link they intended to rewrite, the textual re-apply may silently drop. Confirm this is fine (spec says drop silently).

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` → 326 baseline + N new (migration + index module + materialize helper + rename handlers + flush + undo + external-write re-apply). Document the new count.
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 329 baseline + N new (status-bar formatter + IPC bindings + Solid toast if built). Document the new count.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all --check` → clean.
- **Interactive smoke** against `cargo tauri dev`. Smoke vault:
  ```
  Daily.md
  ---
  tags: [planning, work/active]
  ---
  Today's daily.

  Project.md
  See [[Daily]] for context. Also tagged #planning and #work/active.

  Notes.md
  Another reference to [[Daily]] and the #work/active tag.

  Pinned.md
  body ^anchor

  Refs.md
  See [[Pinned#^anchor]] for the pinned bit.
  ```
  Verify:
  - **File rename:** rename `Daily.md` → `Journal.md` via the chosen gesture. `Daily.md` vanishes from the file list; `Journal.md` appears. Open `Project.md` — editor shows `[[Journal]]` (materialized) even though disk still has `[[Daily]]`. Status bar shows "2 pending changes." Click "Save all pending" → toast "Applied 2 reference updates across 2 files." Status bar goes to 0. Reopen `Project.md` — `cat` on disk now shows `[[Journal]]`.
  - **Tag rename:** rename `#planning` → `#scheduling`. Status bar shows "1 pending change" (one file carries the inline tag). Open `Project.md` — editor shows `#scheduling`. Flush — disk updates.
  - **Nested tag rename:** rename `#work` → `#projects`. The `#work/active` instance becomes `#projects/active`. Verify both Project.md and Notes.md.
  - **Block-id rename:** rename `^anchor` in `Pinned.md` → `^pinned`. Pinned.md's defining line updates; `Refs.md`'s `[[Pinned#^anchor]]` becomes `[[Pinned#^pinned]]`. Both materialized in the editor; both flushed to disk on click.
  - **Undo before flush:** rename a file, see "1 pending change," click Undo on the status bar dropdown → status bar goes to 0; open the referrer — no rewrite applied (still old token).
  - **External-write conflict:** rename `Daily.md` → `Journal.md`, then in Finder/vim edit `Project.md` to remove the `[[Daily]]` link entirely, then flush — the row drops silently (no error).
  - **>50 fuse:** synthesize a file referencing `Daily.md` 51 times (one per line); rename `Daily.md`; verify the fuse fires immediately and that single file flushes while the rest stay deferred.
  - **5-min timer:** lower `pending_rewrites.flush_interval_secs` to 5 (via `set_setting` from the devtools or a test fixture), enqueue a rename, wait 6 seconds, observe flush fires automatically.
  - **App-close mandatory flush:** enqueue a rename, close the vault — verify the flush runs (audit_log row + on-disk content reflects the rewrite).

  If a surface can't be verified hands-on, say so explicitly and record the recommended smoke vault — same protocol as Sessions B, G, H.2, I.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks all passed; branch `l3-session-j-pending-rewrites` created from `main`.
- [ ] Brainstorming pass recorded (single session vs J.1/J.2 split decided; materialize-on-read invariant locked; file-rename UI gesture picked).
- [ ] Plan written at `docs/superpowers/plans/<date>-l3-session-j-pending-rewrites.md` (or split filenames) with every "Decisions to raise" item resolved.
- [ ] Migration `006_pending_rewrites.sql` lands; `HIGHEST_KNOWN_VERSION = 6`; runner tests cover the upgrade.
- [ ] `cubical-index::pending` query module ships with full unit coverage (enqueue, list, count, delete-by-target, delete-by-op).
- [ ] `cubical-core::vault::pending::apply_pending` covers all three rewrite kinds incl. nested tags + block-id literal-line rewrite + frontmatter `tags:` list updates + `|display` + `#anchor` preservation on wiki-link rewrites.
- [ ] Three rename IPCs end-to-end (`rename_file` + `rename_tag` + `rename_block_id`); each mints a fresh `rename_op_id` and emits `vault:pending-rewrites-changed`.
- [ ] `flush_pending_rewrites` rewrites referrers atomically with the backend-side own-write hash gate; external-write conflict re-apply works per §5.7; emits `vault:flush-complete`.
- [ ] `get_pending_rewrites_count` + `undo_rename` IPCs ship.
- [ ] Periodic-timer flush + app-close flush + >50 fuse + manual flush all exercised in tests.
- [ ] Materialize-on-read wired into `read_file_text`, `get_canonical_ast`, `get_embed`, and the scan (per the plan's locked decision).
- [ ] Status-bar pending count + toast on flush + undo affordance + file-rename UI gesture all land.
- [ ] §9.15 (or §9.15 + §9.16 if split) filled with what was built.
- [ ] CLAUDE.md "Project state" rewritten to A–F + G + H.1 + H.2 + I + J done; K pending; next = Session K.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`, `vitest`, `clippy`, `fmt`.
- [ ] Interactive smoke recorded against the smoke vault above (or explicitly documented as deferred, per H.2 / I's protocol).

---

## OUT OF SCOPE (do not build in this session)

- L3 closeout, `l3` tag, hands-on smoke pass of ALL L3 surfaces (Session K).
- Post-flush undo (full reverse rewrite) — L8 Time Machine.
- Diff-view modal on the flush toast click — L8 Time Machine (spec §5.7 says "Click → diff view" but flags this as Time Machine territory).
- 3-way merge UI on external-write conflicts — L8. J uses the §5.7 textual re-apply (find-old-then-replace, silent drop on miss).
- H.3 polish — rich markdown rendering inside embed bodies, click navigation, `⎘`-indicator retirement.
- A new `vault:index-changed` event (still no second consumer materialised). Per-event listeners (`vault:file-changed`, `vault:pending-rewrites-changed`, `vault:flush-complete`) remain the substrate.
- Cross-vault renames — `ui.md` §11.5 declares cross-vault out of scope project-wide.
- Plugin capability surface for materialized reads — spec §5.7 references it but plugins land in a later layer.
- Rename of headings / arbitrary text — only file / tag / block-id are first-class rename targets.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching recent sessions (`feat(core): …`, `feat(index): …`, `feat(app): …`, `feat(ui): …`, `test(…): …`, `docs(l3): close Session J — …`). Do NOT skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Default per project workflow: merge `l3-session-j-pending-rewrites` (or both J.1 + J.2 branches) into `main` after verifying green, `--no-ff`, with a `merge: L3 Session J — pending rewrites cache` commit message mirroring the I / H.2 / H.1 merge style.
3. Report back: every DoD box's status, decisions deferred to / resolved in the plan, the split decision (single session vs J.1/J.2), new test counts, the smoke evidence, and name the next session — L3 Session K (interactive smoke + L3 closeout).
