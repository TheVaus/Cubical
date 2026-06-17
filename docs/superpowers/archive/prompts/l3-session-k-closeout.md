# L3 Session K — Interactive smoke + L3 closeout

L3 Session K for the Cubical project. This is the L3 closeout session. It ships **no new feature code** — it is the hands-on verification pass across every L3 surface (with consolidated deferred smokes from G / H.2 / I / J riding along), the §5 architecture-deviation promotion, the `l3` tag, and the Project-state rewrite. Do NOT start any L4 work.

Design and per-session prose are locked across `docs/layer-3-spec.md` §9.1–§9.16 and the design specs under `docs/superpowers/specs/`. K does not change them — it ticks the §6 DoD checklist and adds §9.17 documenting the smoke pass + deviation promotions.

---

## What's already on disk

So a fresh subagent doesn't redo finished work — every L3 feature surface is closed before K starts:

- **Session A** (`§9.1`) — wiki-link parsing + `links` index + `resolve_link`.
- **Session B** (`§9.2`) — wiki-link Live Preview + click-to-navigate + create-offer dialog.
- **Session C** (`§9.3`) — Backlinks panel + right-sidebar shell.
- **Session D** (`§9.4`) — tags inline+frontmatter parsing + `tags` index + Live Preview chips.
- **Session E** (`§9.5`) — virtual `tag:` pages.
- **Scan resolution perf fix** (`§9.6`) — O(N²) → O(N) two-pass scan; 30k-file vault in ~10 s.
- **Session F** (`§9.7`) — `[[` link autocomplete + `#` tag autocomplete.
- **Session G backend** (`§9.8`) — block-ref minter + `blocks` / `block_refs` tables + broken-block-ref IPC.
- **Session G frontend** (`§9.9` + `§9.10`) — block-ref gesture + `^id` decoration + broken-ref status-bar item.
- **`[[#^` block-id autocomplete** (`§9.11`).
- **Session H.1** (`§9.12`) — embed content extractor + `get_embed` IPC.
- **Session H.2** (`§9.13`) — CM6 embed widget + per-vault `EmbedResolver`.
- **Session I** (`§9.14`) — unlinked-mentions scanner + `get_unlinked_mentions` / `link_mention` IPCs + sidebar segment.
- **Session J.1** (`§9.15`) — Pending Rewrites backend (migration 006, all 9 IPCs, four flush triggers, own-write gate).
- **Session J.2** (`§9.16`) — Pending Rewrites frontend (Toast, status-bar popover, file-rename right-click gesture, App.tsx wiring).

K only verifies that everything above works end-to-end against `cargo tauri dev`, ticks the §6 DoD checklist, promotes the load-bearing §5 deviations, and applies the `l3` tag.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — must report L3 Sessions A–F + G + H.1 + H.2 + I + **J done**; K pending. If not, STOP.
   - `docs/README.md` — orientation.
   - `docs/layer-3-spec.md` — §1 goals, §2 surfaces (the smoke checklist substrate), §5 architecture deviations (promotion targets), §6 Definition of Done (every box K must tick), §8 Session K, §9.1–§9.16 (what every L3 session shipped).
   - `docs/architecture/README.md` + `docs/architecture/document-model.md` + `docs/architecture/ui.md` — promotion targets for §5 deviations.
   - `docs/conventions.md` — only if a smoke-pass bug forces a code fix.

2. Skim for context (come back to specific lines):
   - `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` — J's smoke vault layout (the canonical L3 smoke fixture).
   - `docs/layer-2-spec.md` §9.7 — L2 closeout's voice + structure for the §9.17 write-up.

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` → `merge: L3 Session J.2 — pending rewrites frontend` (commit `54765b6`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`, `l1`, `l2`; does NOT contain `l3`.

4. Baseline test counts (must match CLAUDE.md "Project state" post-J.2):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'` → **406**.
   - `cd ui && npx vitest run` → **352**.
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-k-closeout`

---

## STEP 1 — SKILLS TO INVOKE

Invoke via the Skill tool, in this order:

- `using-superpowers` — ALWAYS, first.
- `verification-before-completion` — ALWAYS. This whole session IS verification; every §6 DoD checkbox needs fresh evidence before it is ticked. Evidence before assertions.
- `finishing-a-development-branch` — ALWAYS, at the very end.

**SKIP** `brainstorming`, `writing-plans`, `test-driven-development`, `subagent-driven-development` — no new design, no new code. If the smoke pass uncovers a bug, invoke `systematic-debugging` before fixing it, and `test-driven-development` to land a regression test for the fix.

---

## STEP 2 — THE CLOSEOUT WORK (layer-3-spec.md §8 Session K, §6 DoD)

No new feature code. The deliverables, in order:

### 2.1 L2 carry-over smoke (§6 DoD first box)

Open `cargo tauri dev` against any non-trivial vault and confirm L2's autosave + Live Preview + Properties still work. This is the first DoD box; if it fails, file a bug against the regressing L2 surface and stop. Record evidence (file path, before/after byte hash, audit_log row).

### 2.2 Build the L3 smoke vault (or reuse Session J's)

The canonical fixture lives in [`docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](../specs/2026-05-31-l3-session-j-pending-rewrites-design.md) — `Daily.md` / `Project.md` / `Notes.md` / `Pinned.md` / `Refs.md`. Extend it inline as the smoke matrix demands:
- Add `Aliases.md` carrying `aliases: [Daybook]` frontmatter for the unlinked-mentions case.
- Add a `Big.md` synthesized with 51 `[[Daily]]` occurrences for the >50 fuse case.
- Add a deeply-nested file like `notes/inbox/Stuff.md` for path-form wiki-link rename coverage.
- Add a depth-bomb chain — `A.md` embeds `![[B]]`, `B` embeds `![[C]]`, … up to depth 5 — for the embed recursion cap.

Record the vault path in §9.17; subsequent runs of the closeout can reuse it.

### 2.3 Interactive smoke pass — exercise every L3 surface

Open `cargo tauri dev` against the smoke vault. Tick each case below in §9.17 with **observed** evidence (timestamps, content-hashes, audit-log row IDs, `cat` output snippets, console assertions). If a case can't be verified hands-on, document the deferred-smoke note rather than ticking the box — same protocol as Sessions B / G / H.2 / I / J.

**Session A — Wiki-link parsing + index** (`§2.1`):
- `[[Daily]]`, `[[Daily|Today]]`, `[[Daily#Heading]]`, `[[Daily#^anchor]]`, `![[Daily]]` all parse — DevTools `getCanonicalAst` shows the right `WikiLink` nodes.
- `links` table reflects every reference; `resolve_link({ target_raw: "Daily" })` resolves to `Daily.md`.
- A `[[Nonexistent]]` reference resolves to `null` (unresolved).

**Session B — Live Preview + navigation** (`§2.2`):
- Off-cursor-line wiki-link renders as display text in accent color; on-cursor-line raw `[[…]]` shows through.
- Unresolved wiki-link decorates in warning color (dashed underline).
- Click on a resolved link navigates (incl. heading anchor scroll). Click on an unresolved link opens the create-offer dialog; "Create note" creates the file and navigates.

**Session C — Backlinks panel** (`§2.3`):
- Right sidebar lists every backlink for the open note, with context snippets.
- Sidebar refreshes within ~200 ms of a new `[[…]]` landing in another file.
- Empty state surfaces correctly for an unreferenced file.

**Session D — Tags** (`§2.4`):
- Inline `#planning` decorates as an accent chip; frontmatter `tags:` entries decorate via Properties chips.
- Tags inside fenced code (` ``` `), inline code, or wiki-link targets do NOT decorate (boundary regression).
- `tags` table reflects every tag; nested `#work/active` resolves both `work` and `work/active` levels.

**Session E — Virtual tag pages** (`§2.5`):
- Click `#planning` → virtual `tag:` page lists every file carrying that tag or any descendant. Empty state when unused. File row click navigates back to the editor.

**Session F — Autocomplete** (`§2.6`):
- Typing `[[` opens link autocomplete; selecting a candidate inserts `[[Title]]`.
- Typing `[[Daily#` lists headings; `[[Daily#^` lists block ids (§9.11).
- Typing `#` at a word boundary opens tag autocomplete; inside a fenced code block, no trigger fires.

**Session G — Block refs + broken-ref status bar** (`§2.7` + §9.9 + §9.10):
- "Copy block reference" gesture mints (or reuses) `^id` and copies `[[Pinned#^id]]` to the clipboard.
- `[[Pinned#^anchor]]` in `Refs.md` resolves; navigation jumps to the right line.
- Delete the defining line; status-bar shows "⚠ 1 broken block ref" with the right tooltip.

**Session H — Embeds** (`§2.8` + §9.12 + §9.13):
- `![[Daily]]` renders the note inline; `![[Daily#Heading]]` renders only that section; `![[Pinned#^anchor]]` renders only that block.
- Depth-5 chain caps at 4 — the depth-4 child renders as a styled link rather than inlined content.
- An unresolved `![[Nope]]` renders the placeholder.

**Session I — Unlinked mentions** (`§2.9`):
- For `Daily.md` open, sidebar lists every plain-text occurrence of "Daily" (and any alias) in other files that isn't already a link.
- "Link it" rewrites the plain text into `[[Daily]]` (or `[[Daily|alias]]` when alias ≠ title); the row drops; `cat` confirms disk reflects the rewrite.
- Already-linked occurrences are excluded.

**Session J — Rename → Pending Rewrites** (`§2.10` + §9.15 + §9.16). This is the full smoke matrix from the J prompt; do every case:
1. **File rename** — right-click `Daily.md` → "Rename…" → `Journal.md`. Disk `Daily.md → Journal.md`; old `[[Daily]]` survives on disk; editor view of `Project.md` materializes as `[[Journal]]`; status bar shows "2 pending changes"; popover → "Save all pending changes" → toast "Applied 2 reference updates across 2 files."; `cat Project.md` shows `[[Journal]]`.
2. **Tag rename** — from devtools: `await ipc.renameTag({ vault_id, old_tag: 'planning', new_tag: 'scheduling' })`. Status bar bumps; flush; `cat` confirms.
3. **Nested tag rename** — `renameTag({ old_tag: 'work', new_tag: 'projects' })`. `#work/active` → `#projects/active` post-flush.
4. **Block-id rename** — `renameBlockId({ file_path: 'Pinned.md', old_id: 'anchor', new_id: 'pinned' })`. Defining line + referrer rewrite post-flush.
5. **Undo before flush** — rename, see +1 pending, click Undo in the popover → count returns to 0; referrer's editor view reverts to the old token.
6. **External-write conflict** — rename Daily → Journal; in the terminal, `sed -i ''` the `[[Daily]]` line out of `Project.md`; flush — the row drops silently, no error toast.
7. **>50 fuse** — open `Big.md` (51 `[[Daily]]` occurrences); rename `Daily` → `Journal`; `Big.md` flushes immediately (status bar drops by 51 then bumps by the remaining referrer files' counts); other files stay pending.
8. **5-min timer** — `await ipc.setSetting(vault_id, 'pending_rewrites.flush_interval_secs', 5)` from devtools; enqueue a rename; wait ~6 s; observe automatic flush (toast appears, status bar → 0).
9. **App-close mandatory flush** — enqueue a rename; quit the app; reopen the vault; verify disk reflects the rewrite + an `audit_log` row marks the flush.

Record evidence per case in §9.17.

### 2.4 Tick the §6 DoD checklist

Walk every box in `docs/layer-3-spec.md` §6 (16 boxes today) and check it off with evidence drawn from the smoke pass + the recorded test counts. Any box that cannot be ticked is a bug — STOP, report it, file the regression against the owning session, and do NOT apply the `l3` tag until it is resolved.

### 2.5 Architecture-deviation promotion (§5)

§5 lists six deviations across L3:
1. Parsing extends two parsers (Rust + Lezer).
2. L3 defines the `links` table schema.
3. Block IDs are content, not file identity.
4. Right sidebar lands in L3.
5. Scan parses each markdown file 3× — **deferred to L5** per the spec; do NOT promote, but note that it survived L3 untouched.
6. Bulk-scan O(N²) — **fixed 2026-05-28**; preserves resolution semantics, so the architecture promotion is just "the locked resolution semantics still hold; only time complexity changed." Spec already calls this out; check whether a promotion line is appropriate or whether §5's existing prose is enough.

For each load-bearing deviation (most likely #1 and #2), promote into `docs/architecture/document-model.md` (or `docs/architecture/ui.md` for #4). Mirror the L2 §9.7 promotion pattern — short crisp sentences in the right architecture sub-file, with a back-link to §9.17. Record what was promoted in §9.17.

### 2.6 Spec write-up — §9.17

Fill `docs/layer-3-spec.md` §9.17 "Session K — Interactive smoke + L3 closeout" mirroring L2's §9.7 voice. Contents:
- The smoke-vault layout used.
- A subsection per L3 surface with the observed evidence (or deferred-smoke note).
- The §5 deviation promotions, what was promoted, and where.
- Bugs found (if any) and how resolved.
- Final test counts, gates, the `l3` tag, and "L3 closed."

### 2.7 CLAUDE.md "Project state" rewrite (do not append)

Rewrite the Project state block to:
- Current layer advances to 4 — Search.
- L3 closed: Sessions A–F + scan perf fix + G full + `[[#^` autocomplete + H.1 + H.2 + I + J + K all done.
- `l3` tag noted with its date.
- Final test counts (406 Rust + 352 vitest unless K's smoke uncovers a bug + lands a regression test).
- "Next" set to L4 Session A — Tantivy search.

### 2.8 Apply the `l3` git tag

Only after every §6 DoD box is ticked. Tag the closeout commit:
```
git -C /Users/user/Developer/Cubical tag -a l3 -m "Layer 3 — Knowledge Graph closed (2026-06-01)"
```
Adjust the date to the actual closeout date.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output. Counts must match CLAUDE.md "Project state" pre-K (no new code unless a bug forces it):

- `cd /Users/user/Developer/Cubical && cargo test --workspace` → **406** green.
- `cd ui && npx tsc --noEmit` → clean.
- `cd ui && npm run build` → clean.
- `cd ui && npx vitest run` → **352** green.
- `cargo clippy --workspace --all-targets -- -D warnings` → clean.
- `cargo fmt --all --check` → clean.
- The interactive smoke pass itself — recorded in §9.17 with observed evidence per case.

This session changes only docs (and architecture sub-files). If a smoke-pass bug forces a code fix, the fix needs a TDD regression test and the counts will rise — document why in §9.17.

---

## DEFINITION OF DONE

- [ ] Step 0 state checks passed; branch `l3-session-k-closeout` created from `main`.
- [ ] L2 carry-over smoke confirmed (autosave + Live Preview + Properties still work).
- [ ] Interactive `cargo tauri dev` smoke pass completed across every L3 surface (Sessions A–J) including the full J smoke matrix (9 cases); deferred-smoke notes recorded where hands-on is blocked.
- [ ] Every `docs/layer-3-spec.md` §6 DoD checkbox ticked with evidence (or a bug filed and the tag withheld).
- [ ] §9.17 filled with smoke evidence, deviation promotions, bugs + resolutions, final counts.
- [ ] Load-bearing §5 deviations promoted into `docs/architecture/document-model.md` (and `ui.md` where appropriate).
- [ ] CLAUDE.md "Project state" rewritten to L3 closed / L4 next; final test counts recorded.
- [ ] All gates clean: `cargo test --workspace` (406, or higher with documented regression), `tsc`, `build`, `vitest` (352, or higher), `clippy`, `fmt`.
- [ ] `l3` git tag applied on the closeout commit.

---

## OUT OF SCOPE (do not build in this session)

- Any new L3 feature code. K is verification + closeout only.
- Any L4 work (Tantivy search, Omni-Bar `Cmd/Ctrl+K`, persistent search panel).
- H.3 polish (rich markdown inside embed bodies, click navigation, `⎘` retirement) — explicitly deferred at H.2 close; not on §6 DoD critical path.
- Tag-chip context menu / block-ref hover menu / keyboard-shortcut rename gesture — deferred at J.2 close.
- Settings UI for `pending_rewrites.flush_interval_secs` — devtools `setSetting` is the documented affordance.
- New tests, except a regression test mandatory for any bug the smoke pass uncovers.
- Refactors. K is a closeout, not a polish session.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching the L2 closeout precedent:
   - `docs(l3): Session K — smoke evidence + DoD §9.17`
   - `docs(architecture): promote L3 deviations` (separate commit if any architecture sub-files change)
   - `docs(claude-md): L3 closed; L4 next`

   Do NOT skip hooks. Do NOT push.

2. Apply the `l3` tag on the final closeout commit (after every DoD box is ticked).

3. Invoke `finishing-a-development-branch`. Default per project workflow: merge `l3-session-k-closeout` into `main` after verifying green, `--no-ff`, with commit message `merge: L3 Session K — interactive smoke + L3 closeout`.

4. Report back: smoke results per case, every DoD box's status, any bugs found and how resolved, the `l3` tag's existence + date, final test counts, and name the next session — **L4 Session A** (Tantivy search index — see `docs/build-order.md`).
