# L3 Session J.2 — Pending Rewrites Cache (frontend)

L3 Session J.2 for the Cubical project. The frontend half of Session J — wires J.1's IPCs into a usable surface: status-bar count, flush toast, per-op undo dropdown, and the **file-rename gesture** (right-click → "Rename…"). Tag-rename and block-id-rename gestures are out of scope for J.2 (their IPCs ship in J.1 and are exercised by tests + the manual flush); they remain plumbed for future surfaces (tag chip context menus, block-ref hover menu) and may land in K polish if time permits.

Design is locked in [`docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](../specs/2026-05-31-l3-session-j-pending-rewrites-design.md) — read the **J.2 — Frontend** section as the source of truth.

Do NOT start Session K in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — must report L3 A–F + G + H.1 + H.2 + I + J.1 done; J.2 + K pending. If not, STOP.
   - `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` — **the J design**; re-read the J.2 section in full.
   - `docs/layer-3-spec.md` §2.10, §3.4, §3.5, §4 (frontend file map), §9.15 (Session J.1's closeout — what's already on disk).
   - `docs/architecture/document-model.md` §5.7 — locked behaviour.
   - `docs/architecture/ui.md` §11.1 (sidebar + status bar layout), §11.4 (theming + tokens — no hardcoded colours).
   - `docs/conventions.md`.

2. Read for context (skim; come back to specific lines):
   - `ui/src/api/ipc.ts` — the J.1 binding stubs you'll now consume (`renameFile`, `renameTag`, `renameBlockId`, `flushPendingRewrites`, `getPendingRewritesCount`, `getPendingRewritesBreakdown`, `listRecentRenameOps`, `undoRename`, `onVaultPendingRewritesChanged`, `onVaultFlushComplete`).
   - `ui/src/App.tsx` — status-bar footer (the broken-block-refs item is the closest precedent for the pending-rewrites count). Right-sidebar refresh tick. Vault open/close flow. `Setting` consumer for the new `pending_rewrites.flush_interval_secs`.
   - `ui/src/statusbar/brokenRefs.ts` + `ui/src/statusbar/brokenRefs.test.ts` — pure formatter template for `pendingRewrites.ts`.
   - `ui/src/FileList.tsx` (or whatever the left-pane file explorer is called) — the right-click context menu integration site for the rename gesture.
   - `ui/src/Editor.tsx` — for the inline rename input pattern (if a similar inline input exists elsewhere, reuse it; otherwise the design spec's "inline rename input" is a small new component).
   - `ui/src/styles/tokens.css` — tokens for the toast component (must be tokenised; lint rule enforces this per `ui.md` §11.4).
   - `ui/src/sidebar/Backlinks.tsx` + `ui/src/sidebar/UnlinkedMentions.tsx` — Solid component shape precedent.

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` → `merge: L3 Session J.1 — pending rewrites backend`.
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`, `l1`, `l2`; does NOT contain `l3`.

4. Baseline test counts (must match CLAUDE.md "Project state" post-J.1):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'` → J.1 closing count (read from CLAUDE.md).
   - `cd ui && npx vitest run` → 329 (J.1 added no new vitest).
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-j2-pending-rewrites-frontend`

---

## STEP 1 — SKILLS TO INVOKE

- `using-superpowers` — ALWAYS, first.
- **Skip `brainstorming`** — the design is already locked in the J design spec. The file-rename gesture, toast component, status-bar shape, and click-out content are all decided. Re-read the spec.
- `writing-plans` — produces `docs/superpowers/plans/<date>-l3-session-j2-pending-rewrites-frontend.md`. Same shape as the Session I plan.
- `subagent-driven-development` (preferred — independent task chains: Toast component, status-bar item + click-out, file-rename gesture, App.tsx wiring) or `executing-plans` if subagents aren't available.
- `test-driven-development` — every behaviour change lands with a failing test first. Especially load-bearing here for: `formatPendingRewrites` formatter, status-bar dropdown state transitions, toast lifecycle, the inline rename input commit/cancel branches.
- `verification-before-completion` — fresh test output + recorded smoke evidence before any merge. Hands-on smoke against `cargo tauri dev` is the full J smoke matrix (see VERIFICATION below).
- `finishing-a-development-branch` — ALWAYS, at the very end.

---

## STEP 2 — THE WORK (design spec is the source of truth)

Pull the **J.2 — Frontend** section of the design spec into the plan as the substrate. Summary checklist:

1. **`ui/src/Toast.tsx`** — minimal single-slot Solid toast (auto-dismiss 4s, dismissible, tokenised). Public API: a small `showToast(message)` helper backed by a top-level signal. ~50 LOC; vitest covers show / dismiss / auto-timeout (use a fake timer).
2. **`ui/src/statusbar/pendingRewrites.ts`** — pure `formatPendingRewrites(count) -> string` mirroring `formatBrokenBlockRefs`. Vitest: `0` → empty / hidden label per design (check `brokenRefs.ts`'s convention); `1` → singular; `>1` → plural.
3. **`ui/src/statusbar/PendingRewrites.tsx`** — clickable status-bar item. Click opens a small popover with: total count, top-N per-target breakdown (via `getPendingRewritesBreakdown`), "Save all pending changes" button (calls `flushPendingRewrites`), and a "Recent renames" section listing last N rename ops (via `listRecentRenameOps`) with a per-op "Undo" button (calls `undoRename`). Use the existing popover/dropdown primitive if one exists; otherwise inline a minimal one for now (clean up in K polish).
4. **File-rename gesture** — right-click on a file row in the file list → context menu → "Rename…" → inline rename input (Enter commits → calls `renameFile`; Esc cancels). Reuses any existing context-menu primitive; otherwise builds a minimal one. The inline input replaces the row's label text during the rename. On commit, optimistically clears the input; the resulting `vault:file-changed` + `vault:pending-rewrites-changed` events refresh the list and bump the status bar.
5. **`ui/src/App.tsx` wiring**:
   - Subscribe to `onVaultPendingRewritesChanged` → update a `pendingRewritesCount` signal; pass to `<PendingRewrites>`.
   - Subscribe to `onVaultFlushComplete` → render the toast (`Applied {refs_updated} reference updates across {files_rewritten} files.`).
   - On `close_vault`, drop the count + cancel both subscriptions.
   - Surface `pending_rewrites.flush_interval_secs` through the existing `Setting` consumer flow (no new settings UI required — the value is read by the backend timer; J.2 only needs the binding to exist so power users can `set_setting` it).
6. **Spec write-up** — fill `docs/layer-3-spec.md` §9.16 ("Session J.2 — Pending Rewrites frontend") mirroring §9.13's voice (the H.2 frontend follow-up is the closest split-session precedent).
7. **CLAUDE.md "Project state"** — rewrite to A–F + G + H.1 + H.2 + I + J done; K pending; "Next" = Session K (interactive smoke + L3 closeout).

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` → unchanged from J.1 (no Rust changes in J.2).
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → 329 baseline + new (formatter + status-bar dropdown + Toast + inline rename input). Document the new count.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` → clean.
- **Interactive smoke** against `cargo tauri dev`. Smoke vault from the design spec ("Verification" section). Cases:
  - **File rename:** right-click `Daily.md` → "Rename…" → type `Journal.md` → Enter. Disk old token survives until flush; editor view of `Project.md` shows `[[Journal]]`; status bar shows "2 pending changes"; click → dropdown → "Save all pending" → toast "Applied 2 reference updates across 2 files."; `cat Project.md` shows `[[Journal]]`.
  - **Tag rename:** call `renameTag` from devtools (no UI gesture in J.2) — verify status bar bumps, materialize-on-read works, flush rewrites disk.
  - **Nested tag rename:** call `renameTag('work', 'projects')` — verify `#work/active` becomes `#projects/active` post-flush.
  - **Block-id rename:** call `renameBlockId` from devtools — verify defining-line + referrers rewrite post-flush.
  - **Undo before flush:** rename a file, see "+1 pending", click Undo in the status-bar dropdown → count returns to 0; referrer reverts to old token.
  - **External-write conflict:** rename Daily → Journal, externally remove the `[[Daily]]` line from Project.md, flush — row drops silently, no error toast.
  - **>50 fuse:** synthesize a file with 51 `[[Daily]]` occurrences, rename Daily — that file flushes immediately; others stay pending.
  - **5-min timer:** `setSetting('pending_rewrites.flush_interval_secs', 5)` from devtools, enqueue a rename, wait 6 s, observe automatic flush (toast appears, status bar → 0).
  - **App-close mandatory flush:** enqueue a rename, close the vault (or the app), reopen, verify disk reflects the rewrite + audit log row.

If a surface can't be verified hands-on, say so explicitly and record the deferred-smoke note — same protocol as Sessions B, G, H.2, I.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks passed; branch `l3-session-j2-pending-rewrites-frontend` created from `main`.
- [ ] Plan written at `docs/superpowers/plans/<date>-l3-session-j2-pending-rewrites-frontend.md` referencing the locked design spec.
- [ ] `ui/src/Toast.tsx` ships, tokenised, vitest-covered.
- [ ] `formatPendingRewrites` formatter + vitest coverage.
- [ ] `PendingRewrites.tsx` status-bar item with click-out (count + breakdown + "Save all pending" + per-op undo list).
- [ ] File-rename context-menu + inline rename input → `renameFile`.
- [ ] `App.tsx` wires both new event listeners, the count signal, and the toast; setting binding for `pending_rewrites.flush_interval_secs`.
- [ ] §9.16 filled with what was built (mirroring §9.13's voice).
- [ ] CLAUDE.md "Project state" rewritten to A–F + G + H.1 + H.2 + I + J done; K pending.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`, `vitest`, `clippy`, `fmt`.
- [ ] Interactive smoke recorded against the smoke vault above (or explicitly documented as deferred, per H.2 / I).

---

## OUT OF SCOPE (do not build in this session)

- Any new backend behaviour — J.1 closed.
- A keyboard-shortcut rename gesture — K polish.
- A tag-chip context menu / block-ref hover menu for tag/block-id rename gestures — K polish or post-L3.
- Click-to-diff on the flush toast — L8 Time Machine.
- L3 closeout, `l3` tag, full L3 smoke pass — Session K.
- Post-flush undo (full reverse rewrite) — L8.
- 3-way merge UI on external-write conflicts — L8.
- H.3 polish (rich markdown in embed bodies, click navigation, `⎘` retirement).
- Cross-vault renames — out of scope project-wide.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching recent sessions (`feat(ui): Toast component`, `feat(ui): pending-rewrites status-bar item`, `feat(ui): file rename context menu + inline input`, `feat(ui): wire pending-rewrites events + toast`, `test(ui): …`, `docs(l3): close Session J.2 — pending rewrites frontend`). Do NOT skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Default per project workflow: merge `l3-session-j2-pending-rewrites-frontend` into `main` after verifying green, `--no-ff`, with commit message `merge: L3 Session J.2 — pending rewrites frontend`.
3. Report back: every DoD box's status, new test counts, the smoke evidence, and name the next session — L3 Session K (interactive smoke + L3 closeout + `l3` tag).
