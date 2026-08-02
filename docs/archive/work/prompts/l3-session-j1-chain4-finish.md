> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session J.1 — Chain 4 finish (rename + flush IPCs + triggers + own-write gate)

L3 Session J.1's infrastructure half (chains 1–3) landed and merged to `main` on 2026-05-31. This session finishes J.1 by building the IPC half: rename handlers, flush handlers, flush triggers, the backend own-write hash gate, IPC registration, and `ipc.ts` binding stubs. After this session lands, J.1 is fully closed and J.2 (UI) is the next gate.

Design is locked in [`docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md`](../specs/2026-05-31-l3-session-j-pending-rewrites-design.md). The §9.15 entry in `docs/layer-3-spec.md` catalogues exactly what's already on disk and what's left — read both before touching code.

Do NOT start Session J.2 or K in this session.

---

## STEP 0 — VERIFY STATE (do this before touching anything; STOP if any check fails)

Working directory: `/Users/user/Developer/Cubical`

1. Read these files in full:
   - `CLAUDE.md` — "Project state" must report J.1 partial (chains 1+2+3 landed, chain 4 pending). If not, STOP.
   - `docs/layer-3-spec.md` §9.15 — the precise inventory of what landed and what's left. **This is the closest thing to a chain-4 task list.**
   - `docs/superpowers/specs/2026-05-31-l3-session-j-pending-rewrites-design.md` — focus on these sections under "J.1 — Backend": **Rename IPCs**, **Flush + helpers**, **Backend own-write hash gate**, **Flush triggers**, **IPC registration**, **J.1 frontend stub**. Every decision is pre-locked.
   - `docs/architecture/document-model.md` §5.7 — the locked schema and behaviour spec.
   - `docs/conventions.md`, `docs/migration-touchpoints.md`.

2. Read for context (skim; come back to specific lines):
   - `crates/cubical-app/src/commands/rename.rs` — the J.1 chain-3 stub. The `flush_target_for_link_mention` helper inside is the per-target flush executor; rename it to `flush_pending_for_target` (`pub(crate)`) and call it from both new IPC shims (`flush_pending_rewrites` and `flush_pending_rewrites_for_target`).
   - `crates/cubical-app/src/commands/mentions.rs` — `link_mention` already calls the stub; update its call site to the new name.
   - `crates/cubical-app/src/state.rs` (per-vault state lives here; `OpenVault { … }` is the struct literal). **Critical:** there are 9 existing `OpenVault { … }` struct-literal call sites; the chain-4 attempt that ran on 2026-05-31 added three new fields (`flush_own_writes`, `flush_in_progress`, `flush_timer_cancel`) but did NOT migrate those call sites, which broke the build. Migrate ALL of them in the same commit as the field addition. Alternatively introduce an `OpenVault::new(...)` constructor and rewrite all literals to use it.
   - `crates/cubical-app/src/events.rs` — the watcher dispatcher. The `Modified` branch needs the own-write hash gate check inserted just before the `vault:file-changed` emit (after the fresh raw-bytes hash is computed). Also defines / would define the new event names + payloads.
   - `crates/cubical-app/src/lib.rs` — `generate_handler!` registration site. Nine new entries land here.
   - `crates/cubical-app/src/commands/mentions.rs` — `get_unlinked_mentions` is the closest precedent for a vault-scoped read IPC; `link_mention` for read-modify-write.
   - `crates/cubical-app/src/commands/vault.rs` — `open_vault` + `close_vault` are where the periodic-timer task is spawned + cancelled.
   - `crates/cubical-core/src/atomic.rs` — `atomic_write` (used by the existing flush helper). For the file move in `rename_file`, use `tokio::fs::rename` (same-FS) with `atomic_write` + remove as the cross-FS fallback.
   - `crates/cubical-index/src/pending.rs` (chain 1) — every query function the chain-4 handlers consume.
   - `crates/cubical-index/src/error.rs` — `IndexError::UnknownEnum` already exists.
   - `crates/cubical-core/src/vault/pending.rs` (chain 2) — `apply_pending` is what the flush executor calls; consider adding a sibling `apply_pending_with_counts(source, rows) -> (String, usize)` if a clean `refs_updated` count is needed (the chain-3 stub counted via the cmp; either approach is fine — pick one and be consistent).
   - `ui/src/api/ipc.ts` — IPC binding shape (chain-4 ships typed stubs only).

3. Git checks (STOP and report if any fails):
   - `git -C /Users/user/Developer/Cubical status` → working tree clean.
   - `git -C /Users/user/Developer/Cubical branch --show-current` → `main`.
   - `git -C /Users/user/Developer/Cubical log --oneline -1` → `merge: L3 Session J.1 (partial) — pending rewrites infrastructure` (commit `1e26269`).
   - `git -C /Users/user/Developer/Cubical tag --list` → contains `l0`, `l1`, `l2`; does NOT contain `l3`.

4. Baseline test counts (must match CLAUDE.md "Project state" post-J.1 partial):
   - `cd /Users/user/Developer/Cubical && cargo test --workspace 2>&1 | grep -E "^test result:" | grep -oE "[0-9]+ passed" | awk '{sum+=$1} END {print sum}'` → **381**.
   - `cd ui && npx vitest run` → **329** (unchanged through J.1 partial — no UI work yet).
   If either differs, STOP and report.

5. Create the working branch from `main`:
   `git -C /Users/user/Developer/Cubical checkout -b l3-session-j1-chain4-finish`

---

## STEP 1 — SKILLS TO INVOKE

- `using-superpowers` — ALWAYS, first.
- **Skip `brainstorming`** — every decision is locked in the design spec and §9.15. Re-read both instead.
- `writing-plans` — produces `docs/superpowers/plans/<date>-l3-session-j1-chain4-finish.md`. The §9.15 "what did NOT land" list is the substrate; the design spec sections named above are the per-item detail.
- `subagent-driven-development` (preferred — clean independent chains: per-vault state + own-write gate / rename IPCs / flush IPCs / triggers / IPC registration + ipc.ts) — but **do NOT split chain-4 across a session boundary the way the original drive did**. Either one subagent does it all in one bounded pass, or land each chain with a commit so a session-limit hit doesn't lose state. The original chain-4 subagent burnt 245 s + 52 tool calls and then session-limited before reporting; size your subagent budgets accordingly.
- `test-driven-development` — every behaviour change lands with a failing test first. Especially load-bearing here for: rename handlers' explicit-rekey FK behaviour (no `ON UPDATE CASCADE`), flush idempotency, external-write conflict re-apply (silent drop), undo deletes only the right `rename_op_id` group, backend own-write gate suppresses the flush bounce-back through the watcher.
- `verification-before-completion` — fresh test output before merge. The chain-4 surface is headless; J.2 handles interactive smoke.
- `finishing-a-development-branch` — ALWAYS, at the very end. Merge `l3-session-j1-chain4-finish` into `main` with `--no-ff` and message `merge: L3 Session J.1 — chain 4 finish (rename + flush IPCs)`.

---

## STEP 2 — THE WORK

§9.15 is the source of truth for what's left; the design spec is the source of truth for HOW. Tight summary:

### 1. Per-vault state additions (`state.rs`)

Three new fields on `OpenVault`:

```rust
pub struct OpenVault {
    // ... existing fields ...
    pub flush_own_writes:   Arc<tokio::sync::Mutex<HashSet<(PathBuf, ContentHash)>>>,
    pub flush_in_progress:  Arc<tokio::sync::Mutex<()>>,
    pub flush_timer_cancel: tokio_util::sync::CancellationToken,
}
```

**Migrate all 9 existing `OpenVault { … }` struct-literal call sites in the same commit** (or introduce `OpenVault::new(...)` and rewrite call sites to use it — likely cleaner). Add `tokio-util = { version = "0.7", features = ["rt"] }` to `crates/cubical-app/Cargo.toml` if not already present.

### 2. `mint_rename_op_id` helper (`commands/rename.rs`)

Reads `config['pending_rewrites.next_rename_op_id']` (default `1` if absent), increments, writes back inside a single transaction. Returns the value just minted.

### 3. Three rename IPCs (`commands/rename.rs`)

Per the design spec's pseudocode + §9.15's "what did NOT land" notes:

- **`rename_file`** — `SELECT DISTINCT source_path, target_raw FROM links WHERE target_path = ?from`, derive old/new tokens per the spec's "Wiki-link old_token derivation" decision (basename form ↔ basename form, path form ↔ path form). **Explicit rekeys** for `links`, `tags`, `blocks`, `block_refs`, `frontmatter` BEFORE `UPDATE files SET path = ?to` (since no `ON UPDATE CASCADE`). `tokio::fs::rename` for the file move (cross-FS: `atomic_write` + remove). Re-extract the moved file's outbound `refresh_{links,tags,blocks,frontmatter}` under the new path. All inside one transaction. Emit `vault:pending-rewrites-changed`.
- **`rename_tag`** — `SELECT DISTINCT file_path FROM tags WHERE tag_path = ?old OR tag_path LIKE ?old || '/%'`. One row per distinct file_path (kind = `Tag`). Emit event.
- **`rename_block_id`** — referrer rows via `block_refs WHERE target_file_path = ?file AND target_block_id = ?old`, **plus** one extra row targeting `?file` itself (defining-line rewrite). Reject if `?old` block doesn't exist (`cubical_index::block_exists`). Emit event.

### 4. Flush IPCs (`commands/rename.rs`)

- **`flush_pending_rewrites`** — acquire per-vault `flush_in_progress` mutex; iterate `pending_targets`; call per-target executor on each; emit `vault:flush-complete { vault_id, files_rewritten, refs_updated }`; emit `vault:pending-rewrites-changed { count: pending_count_total }`.
- **`flush_pending_rewrites_for_target`** — same mutex; single-file path; same events.
- **Per-target executor** — rename the chain-3 stub `flush_target_for_link_mention` → `pub(crate) async fn flush_pending_for_target`. Update its sole existing caller (`link_mention`) to the new name. Logic stays: read fresh raw bytes, `apply_pending`, compute fresh hash, **insert `(path, hash)` into `flush_own_writes` BEFORE the atomic_write**, atomic_write, `delete_pending_for_target`, best-effort `files.content_hash` update. External-write conflict → silent drop (textual find-then-replace naturally yields this).

### 5. Read-only IPCs (`commands/rename.rs`)

Thin wrappers around chain-1 query functions:
- `get_pending_rewrites_count` → `{ count }`
- `get_pending_rewrites_breakdown` → `{ rows: Vec<{target_file, count}> }`
- `list_recent_rename_ops` → `{ ops: Vec<{rename_op_id, kind, row_count, created_at}> }`
- `undo_rename { rename_op_id }` → `delete_rename_op`; emit `vault:pending-rewrites-changed`.

### 6. Backend own-write hash gate (watcher integration in `events.rs`)

In the `Modified` branch, after the fresh hash is computed (the existing raw-bytes pass) and BEFORE emitting `vault:file-changed`:

```rust
let key = (path_buf.clone(), fresh_hash.clone());
if state.flush_own_writes.lock().await.remove(&key) {
    return Ok(()); // own-write; suppress the emit
}
```

Tests: flush a file → assert watcher does NOT emit; external edit → emits normally.

### 7. Flush triggers

- **Periodic timer** — per-vault `tokio::spawn` task in `open_vault`'s success path. Reads `pending_rewrites.flush_interval_secs` (default `300`) from `config` on each tick. Cancelled via `flush_timer_cancel.cancel()` in `close_vault`.
- **App close** — `close_vault` `.await`s `flush_pending_rewrites` BEFORE dropping the index handle. Errors logged, do not block close.
- **>50 fuse** — in each rename handler, after `enqueue_pending` commits, check `pending_count_for_target` for each target that received rows. If any > 50, call `flush_pending_rewrites_for_target` synchronously.
- **Manual** — covered by `flush_pending_rewrites` IPC.

### 8. IPC registration (`lib.rs`)

Add nine entries to `generate_handler!`:
`rename_file`, `rename_tag`, `rename_block_id`,
`flush_pending_rewrites`, `flush_pending_rewrites_for_target`,
`get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`,
`undo_rename`.

### 9. `ipc.ts` typed stubs

Add bindings + the two new listeners (`onVaultPendingRewritesChanged`, `onVaultFlushComplete`) + `pending_rewrites.flush_interval_secs` in the `Setting` union. Exported but unused — `tsc` allows it.

### 10. Spec + state write-up

- **Rewrite `docs/layer-3-spec.md` §9.15** — change "Session J.1 (partial)" → "Session J.1 — Pending Rewrites backend" and merge what landed in chain 4 into the existing "what landed" prose. Delete the "what did NOT land" block. Voice should mirror §9.14.
- **Rewrite `CLAUDE.md` "Project state"** — mark J.1 done; J.2 + K pending; final test count; "Next" = Session J.2.

---

## VERIFICATION (evidence required — never "should work")

Run and paste actual output:

- `cd /Users/user/Developer/Cubical && cargo test --workspace` → 381 baseline + new (rename × 3, flush × 2, count + breakdown + list-ops + undo, periodic timer, close-time flush, >50 fuse, own-write gate). Expected delta: ~25–40 new tests.
- `cd ui && npx tsc --noEmit && npm run build && npx vitest run` → all clean; vitest still 329.
- `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check` → clean.
- **Headless smoke recipe** documented (J.1 has no UI; full hands-on lives in J.2).

---

## DEFINITION OF DONE

- [ ] Step 0 state checks passed; branch `l3-session-j1-chain4-finish` created from `main`.
- [ ] Plan written referencing the design spec + §9.15.
- [ ] `OpenVault` gains three fields; all 9 struct-literal call sites migrated (or `OpenVault::new` introduced and used).
- [ ] `mint_rename_op_id` helper + 3 rename IPC handlers (each minting an op_id + emitting `vault:pending-rewrites-changed`).
- [ ] `rename_file`'s explicit rekey of `links` / `tags` / `blocks` / `block_refs` / `frontmatter` BEFORE `UPDATE files` — covered by a test that asserts post-rename rows reference the new path.
- [ ] `flush_pending_rewrites` + `flush_pending_rewrites_for_target` IPCs ship; the chain-3 stub renamed to `flush_pending_for_target` and reused as the per-target executor.
- [ ] `get_pending_rewrites_count`, `get_pending_rewrites_breakdown`, `list_recent_rename_ops`, `undo_rename` IPCs ship.
- [ ] All four flush triggers exercised in tests (periodic-timer, app-close, >50 fuse, manual).
- [ ] Backend own-write hash gate in `events.rs` `Modified` branch; covered by a test that asserts the gate suppresses `vault:file-changed` for own writes and lets external edits through.
- [ ] Nine new IPC handlers registered in `lib.rs` `generate_handler!`.
- [ ] `ui/src/api/ipc.ts` typed binding stubs + listeners + setting key land (unused).
- [ ] §9.15 rewritten as "Session J.1 — Pending Rewrites backend" (the "partial" framing removed); voice mirrors §9.14.
- [ ] CLAUDE.md "Project state" rewritten to A–F + G + H.1 + H.2 + I + J.1 done; J.2 + K pending; final test counts.
- [ ] All gates clean: `cargo test --workspace`, `tsc`, `build`, `vitest`, `clippy`, `fmt`.
- [ ] Headless smoke recipe documented; hands-on smoke explicitly deferred to J.2.

---

## OUT OF SCOPE (do not build in this session)

- Any UI surface (status bar, toast, undo affordance, file-rename gesture) — J.2.
- Vitest coverage of pending-rewrites behaviours — there's no frontend behaviour to test in chain-4.
- Hands-on `cargo tauri dev` smoke — J.2.
- L3 closeout, `l3` tag, full L3 smoke pass — Session K.
- Post-flush undo (full reverse rewrite) — L8.
- 3-way merge UI / diff modal on toast — L8.
- H.3 polish (rich markdown in embed bodies, click navigation, `⎘` retirement).
- A new `vault:index-changed` event (still no second consumer materialised).
- Cross-vault renames — `ui.md` §11.5 out of scope project-wide.
- Rename of headings / arbitrary text — only file / tag / block-id are first-class.
- Migration 007 to add `ON UPDATE CASCADE` — explicit rekeys in `rename_file` cover it; do not alter shipped FK constraints.

---

## SESSION END PROTOCOL

1. Commit in logical units, Conventional Commits matching recent sessions:
   - `feat(app): OpenVault flush fields + own-write hash gate`
   - `feat(app): rename_file/rename_tag/rename_block_id IPCs`
   - `feat(app): flush_pending_rewrites + per-target executor`
   - `feat(app): pending-rewrites read IPCs (count, breakdown, list-ops, undo)`
   - `feat(app): periodic flush timer + close-time flush + >50 fuse`
   - `feat(app): register J.1 IPC handlers + ipc.ts stubs`
   - `docs(l3): close Session J.1 — pending rewrites backend`
   Do NOT skip hooks. Do NOT push.
2. Invoke `finishing-a-development-branch`. Merge `l3-session-j1-chain4-finish` into `main` after verifying green, `--no-ff`, with commit message `merge: L3 Session J.1 — chain 4 finish (rename + flush IPCs)`.
3. Report back: every DoD box's status, new test counts, the headless smoke recipe location, and name the next session — **L3 Session J.2** (status bar + toast + undo + right-click rename gesture).
