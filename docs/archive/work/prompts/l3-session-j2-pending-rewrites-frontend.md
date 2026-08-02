> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session J.2 — Pending Rewrites Cache (frontend)

L3 Session J.2 for the Cubical project. J.1 closed across two merges on `main` (`1e26269` + `5bc0ce6`); every backend IPC, both new events, and the typed binding stubs are already on disk. J.2 wires that surface into a usable UI: status-bar count, flush toast, per-op undo dropdown, and the **file-rename gesture** (right-click → "Rename…"). Tag-rename and block-id-rename gestures are explicitly out of J.2's scope (their IPCs ship in J.1 and are exercised by tests + the manual flush); the bindings stay plumbed for K polish (tag-chip context menus, block-ref hover menu).

Design is locked in [`docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](../specs/2026-05-31-l3-session-j-pending-rewrites-design.md) — read the **J.2 — Frontend** section as the source of truth. §9.15 in `docs/layer-3-spec.md` catalogues what the backend already exposes.

Do NOT start Session K in this session.

---

## What's already on disk from J.1 (do NOT rebuild)

So a fresh subagent doesn't redo work — these all exist after `5bc0ce6`:

- **Typed IPC bindings + listeners** in `ui/src/api/ipc.ts`:
  - `renameFile`, `renameTag`, `renameBlockId`
  - `flushPendingRewrites`, `flushPendingRewritesForTarget`
  - `getPendingRewritesCount`, `getPendingRewritesBreakdown`
  - `listRecentRenameOps`, `undoRename`
  - `onVaultPendingRewritesChanged(handler)` → payload `{ vault_id, count }`
  - `onVaultFlushComplete(handler)` → payload `{ vault_id, files_rewritten, refs_updated }`
  - `Setting` union includes `pending_rewrites.flush_interval_secs: number` (default 300 server-side).
- **All 9 backend IPCs registered** in `crates/cubical-app/src/lib.rs`'s `generate_handler!`.
- **Backend events emitted** by every rename / flush / undo path; the watcher own-write hash gate already suppresses flush bounce-backs so the listeners don't double-fire.
- **Periodic flush timer** running per-vault (reads `pending_rewrites.flush_interval_secs` each tick); **close-time flush** runs synchronously inside `close_vault` before the index drops; **>50-per-file fuse** synchronous on each rename.

J.2 only has to call these bindings, subscribe to the two listeners, and build the four UI pieces below.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — must report L3 A–F + G + H.1 + H.2 + I + **J.1 done**; J.2 + K pending. If not, STOP.
   - `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` — re-read the **J.2 — Frontend** section in full.
   - `docs/layer-3-spec.md` §2.10, §3.4, §3.5, §4 (frontend file map), §9.15 (J.1 closeout — what's already on disk; the "Headless smoke recipe" paragraph at the end shows the IPC shapes you'll be calling).
   - `docs/architecture/document-model.md` §5.7 — locked behaviour.
   - `docs/architecture/ui.md` §11.1 (sidebar + status bar layout), §11.4 (theming + tokens — no hardcoded colours).
   - `docs/conventions.md`.

2. Read for context (skim; come back to specific lines):
   - `ui/src/api/ipc.ts` — the J.1 binding stubs you'll now consume (full list under "What's already on disk" above).
   - `ui/src/App.tsx` — status-bar footer (the `BrokenBlockRefs` status item via `formatBrokenBlockRefs` + `refreshBrokenBlockRefs` + the `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` debounce timer is the closest precedent for the pending-rewrites count; for J.2 the equivalent is **event-driven via `onVaultPendingRewritesChanged`** rather than polled, so no debounce timer is needed). Vault open/close flow. `setSetting` consumer for the new key. The file list is rendered inline (`<For each={visibleFiles()}>` around the row at `role="option" onClick={handleSelectFile}` — no separate `FileList.tsx` exists; the right-click handler is attached to the existing row).
   - `ui/src/statusbar/brokenRefs.ts` + `ui/src/statusbar/brokenRefs.test.ts` — pure formatter template for `pendingRewrites.ts`.
   - `ui/src/sidebar/Backlinks.tsx` + `ui/src/sidebar/UnlinkedMentions.tsx` — Solid component shape precedent.
   - `ui/src/styles/tokens.css` + `ui/src/styles/theme.ts` — tokens for the toast component (must be tokenised; lint rule enforces this per `ui.md` §11.4).
   - `ui/src/Editor.tsx` — for the inline rename input pattern (if a similar inline input exists elsewhere, reuse it; otherwise the design spec's "inline rename input" is a small new component).

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` → `merge: L3 Session J.1 — chain 4 finish (rename + flush IPCs)` (commit `5bc0ce6`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`, `l1`, `l2`; does NOT contain `l3`.

4. Baseline test counts (must match CLAUDE.md "Project state" post-J.1):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'` → **406**.
   - `cd ui && npx vitest run` → **329** (J.1 added no new vitest; the ipc.ts stubs are unused).
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-j2-pending-rewrites-frontend`

---

## STEP 1 — SKILLS TO INVOKE

- `using-superpowers` — ALWAYS, first.
- **Skip `brainstorming`** — the design is already locked. The file-rename gesture, toast component, status-bar shape, and click-out content are all decided. Re-read the spec.
- `writing-plans` — produces `docs/superpowers/plans/<date>-l3-session-j2-pending-rewrites-frontend.md`. Same shape as the Session I plan.
- `subagent-driven-development` (preferred — independent task chains: Toast + formatter, status-bar item + click-out, file-rename gesture, App.tsx wiring) or `executing-plans` if subagents aren't available. **Size subagent budgets carefully** — the J.1 chain-4 attempt session-limited; if you split, land each chain with a commit so a limit hit doesn't lose state.
- `test-driven-development` — every behaviour change lands with a failing test first. Especially load-bearing here for: `formatPendingRewrites` formatter (0 / 1 / >1), Toast lifecycle (use vitest fake timers for the 4s auto-dismiss), status-bar dropdown content rendering, the inline rename input commit/cancel branches.
- `verification-before-completion` — fresh test output + recorded smoke evidence before any merge. Hands-on smoke against `cargo tauri dev` is the full J smoke matrix (see VERIFICATION below).
- `finishing-a-development-branch` — ALWAYS, at the very end.

---

## STEP 2 — THE WORK (design spec is the source of truth)

Pull the **J.2 — Frontend** section of the design spec into the plan as the substrate. Summary checklist:

1. **`ui/src/Toast.tsx`** — minimal single-slot Solid toast (auto-dismiss 4 s, dismissible, tokenised — only `var(--*)` tokens, no hardcoded colours). Public API: a small `showToast(message)` helper backed by a top-level signal (or an exported `ToastHost` component that owns the signal — pick the simpler shape, document why). ~50 LOC. Vitest covers show / dismiss / auto-timeout using fake timers.

2. **`ui/src/statusbar/pendingRewrites.ts`** — pure `formatPendingRewrites(count) -> string` mirroring `formatBrokenBlockRefs` in `statusbar/brokenRefs.ts`. Vitest: `0` → empty / hidden label (match `brokenRefs.ts`'s convention exactly so the status bar reads uniformly); `1` → singular ("1 pending change"); `>1` → plural ("N pending changes").

3. **`ui/src/statusbar/PendingRewrites.tsx`** — clickable status-bar item. Click opens a small popover with:
   - Total count (header).
   - Top-N per-target breakdown via `getPendingRewritesBreakdown` (re-query on open; rows hidden when count = 0).
   - "Save all pending changes" button → `flushPendingRewrites({ vault_id })`; closes the popover on success.
   - "Recent renames" section listing last N rename ops via `listRecentRenameOps({ vault_id, limit: 5 })` with a per-op "Undo" button → `undoRename({ vault_id, rename_op_id })`.

   Use the existing popover/dropdown primitive if one exists; otherwise inline a minimal one for now (clean up in K polish).

4. **File-rename gesture** — right-click on a file row in the inline file list (the `<For each={visibleFiles()}>` block in `App.tsx`; no separate component to extract) → context menu → "Rename…" → inline rename input replaces the row's label text. Enter commits → `renameFile({ vault_id, from_path: selected, to_path: typed })`. Esc cancels. Reuses any existing context-menu primitive; otherwise builds a minimal one (a Solid component + a `position: fixed` div positioned at the click coords; close on outside-click / Esc). The list refreshes from the existing `vault:file-changed` listener; the status-bar count bumps from `vault:pending-rewrites-changed`. Reject empty / unchanged / duplicate target with a toast surfaced via `showToast` (no full modal needed; the backend returns `InvalidRequest` for same-path / existing-dest which we render verbatim).

5. **`ui/src/App.tsx` wiring**:
   - Subscribe to `onVaultPendingRewritesChanged` → update a `pendingRewritesCount` signal; pass to `<PendingRewrites>` next to the existing `<BrokenBlockRefs>` status item.
   - Subscribe to `onVaultFlushComplete` → render the toast: `Applied {refs_updated} reference updates across {files_rewritten} files.` (When both totals are 0 — e.g. a manual flush with nothing queued — suppress the toast; or render a "Nothing to flush" variant. Pick one; document.)
   - On `close_vault`, drop the count + cancel both subscriptions.
   - Surface `pending_rewrites.flush_interval_secs` through the existing `setSetting` flow (no new settings UI required — the value is read by the backend timer; J.2 only needs the binding to exist so power users can `setSetting(id, 'pending_rewrites.flush_interval_secs', 5)` from devtools).
   - The existing `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` debounce for `refreshBrokenBlockRefs` does NOT apply here — the pending-rewrites count is push-event-driven, not polled.

6. **Spec write-up** — fill `docs/layer-3-spec.md` §9.16 ("Session J.2 — Pending Rewrites frontend") mirroring §9.13's voice (the H.2 frontend follow-up is the closest split-session precedent).

7. **CLAUDE.md "Project state"** — rewrite to A–F + G + H.1 + H.2 + I + J done; K pending; "Next" = Session K (interactive smoke + L3 closeout + `l3` tag).

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` → unchanged at **406** (no Rust changes in J.2).
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → **329** baseline + new (formatter + Toast + status-bar dropdown rendering + inline rename input). Document the new count.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` → clean.
- **Interactive smoke** against `cargo tauri dev`. Smoke vault from the design spec ("Verification" section). Cases — for each, record evidence (screenshot path, transcript snippet, or `cat` output of the touched file):
  - **File rename:** right-click `Daily.md` → "Rename…" → type `Journal.md` → Enter. Disk old token survives until flush; editor view of `Project.md` shows `[[Journal]]` (materialize-on-read); status bar shows "2 pending changes"; click → dropdown → "Save all pending" → toast "Applied 2 reference updates across 2 files."; `cat Project.md` shows `[[Journal]]`.
  - **Tag rename:** invoke `renameTag({ vault_id, old_tag: 'planning', new_tag: 'scheduling' })` from devtools (no UI gesture in J.2) — verify status bar bumps, materialize-on-read works, flush rewrites disk.
  - **Nested tag rename:** `renameTag({ vault_id, old_tag: 'work', new_tag: 'projects' })` — verify `#work/active` becomes `#projects/active` post-flush.
  - **Block-id rename:** `renameBlockId({ vault_id, file_path: 'Pinned.md', old_id: 'anchor', new_id: 'pinned' })` from devtools — verify defining-line + referrers rewrite post-flush.
  - **Undo before flush:** rename a file, see "+1 pending", click Undo in the status-bar dropdown → count returns to 0; the referrer file's editor view reverts to the old token (materialize-on-read picks up the gone row).
  - **External-write conflict:** rename `Daily` → `Journal`, externally remove the `[[Daily]]` line from `Project.md` (vim / `sed -i`), flush — row drops silently, no error toast.
  - **>50 fuse:** synthesize a file with 51 `[[Daily]]` occurrences, rename `Daily` — that file flushes immediately (status bar drops by 51 then bumps by the remaining referrer files' counts); other files stay pending until manual flush.
  - **5-min timer:** `setSetting(id, 'pending_rewrites.flush_interval_secs', 5)` from devtools (the backend tick reads the new value on the NEXT tick), enqueue a rename, wait ~6 s, observe automatic flush (toast appears, status bar → 0).
  - **App-close mandatory flush:** enqueue a rename, close the vault (or the app), reopen, verify disk reflects the rewrite + an `audit_log` row marks the flush.

If a surface can't be verified hands-on, say so explicitly and record the deferred-smoke note — same protocol as Sessions B, G, H.2, I.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks passed; branch `l3-session-j2-pending-rewrites-frontend` created from `main`.
- [ ] Plan written at `docs/superpowers/plans/<date>-l3-session-j2-pending-rewrites-frontend.md` referencing the locked design spec.
- [ ] `ui/src/Toast.tsx` ships, tokenised, vitest-covered (show / dismiss / auto-timeout).
- [ ] `formatPendingRewrites` formatter + vitest coverage (0 / 1 / >1).
- [ ] `PendingRewrites.tsx` status-bar item with click-out (count + breakdown + "Save all pending" + per-op undo list).
- [ ] File-rename context-menu + inline rename input → `renameFile`.
- [ ] `App.tsx` wires both new event listeners, the count signal, and the toast; setting key path remains intact.
- [ ] §9.16 filled with what was built (mirroring §9.13's voice).
- [ ] CLAUDE.md "Project state" rewritten to A–F + G + H.1 + H.2 + I + J done; K pending.
- [ ] All gates clean: `cargo test --workspace` (406), `tsc`, `build`, `vitest`, `clippy`, `fmt`.
- [ ] Interactive smoke recorded against the smoke vault above (or explicitly documented as deferred, per H.2 / I).

---

## OUT OF SCOPE (do not build in this session)

- Any new backend behaviour — J.1 closed.
- A keyboard-shortcut rename gesture — K polish.
- A tag-chip context menu / block-ref hover menu for tag/block-id rename gestures — K polish or post-L3.
- A separate `FileList.tsx` extraction — leave the inline `<For>` in App.tsx; refactoring belongs in K polish if at all.
- A reusable popover / context-menu primitive across the app — inline the minimal version for now; harvesting into a primitive is K polish.
- Click-to-diff on the flush toast — L8 Time Machine.
- L3 closeout, `l3` tag, full L3 smoke pass — Session K.
- Post-flush undo (full reverse rewrite) — L8.
- 3-way merge UI on external-write conflicts — L8.
- H.3 polish (rich markdown in embed bodies, click navigation, `⎘` retirement).
- Cross-vault renames — out of scope project-wide.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching recent sessions:
   - `feat(ui): Toast component`
   - `feat(ui): pending-rewrites status-bar item + dropdown`
   - `feat(ui): file rename context menu + inline input`
   - `feat(ui): wire pending-rewrites events + toast`
   - `test(ui): …` (as appropriate)
   - `docs(l3): close Session J.2 — pending rewrites frontend`

   Do NOT skip hooks. Do NOT push.

2. Invoke `finishing-a-development-branch`. Default per project workflow: merge `l3-session-j2-pending-rewrites-frontend` into `main` after verifying green, `--no-ff`, with commit message `merge: L3 Session J.2 — pending rewrites frontend`.

3. Report back: every DoD box's status, new test counts, the smoke evidence (per-case), and name the next session — **L3 Session K** (interactive smoke + L3 closeout + `l3` tag).
