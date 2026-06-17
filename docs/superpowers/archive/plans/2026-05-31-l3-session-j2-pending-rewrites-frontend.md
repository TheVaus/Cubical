# L3 Session J.2 — Pending Rewrites frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Wire the J.1 backend (rename / flush / count / undo IPCs + the two new event listeners + the typed bindings) into a usable UI: a clickable status-bar **pending-changes** count, a flush-complete **toast**, a popover with per-target breakdown + "Save all pending" + per-op **Undo**, and a right-click **"Rename…"** gesture on file rows that calls `renameFile`. Tag-rename and block-id rename gestures are explicitly K polish — their backend IPCs already ship and are exercised by tests + the manual flush.

**Architecture:**
- No new backend code. J.1 closed the entire backend surface.
- Four new UI files: `Toast.tsx` (single-slot, ~50 LOC, auto-dismiss 4s), `statusbar/pendingRewrites.ts` (pure formatter mirroring `statusbar/brokenRefs.ts`), `statusbar/PendingRewrites.tsx` (status item + popover), and `fileRename.ts` (pure rename input commit/cancel branches).
- App.tsx subscribes to `onVaultPendingRewritesChanged` + `onVaultFlushComplete`, maintains a `pendingRewritesCount` signal, renders the toast, and adds an inline rename input inside the existing `<For each={visibleFiles()}>` row. Right-click on a row opens a minimal `position: fixed` context menu.
- Listeners + count signal are cancelled / reset on `close_vault`.
- The `Setting` union already carries `pending_rewrites.flush_interval_secs`; no settings UI shipped in J.2 (devtools `setSetting` is the documented affordance — Session K polish may add a control).

**Tech Stack:** TypeScript strict, Solid signals, Vitest (fake timers for Toast + auto-dismiss + retry path), CSS-variable tokens only (lint-enforced per `ui.md` §11.4). No new dependencies.

---

## Pre-flight decisions (locked at plan time)

If a step encounters a reality that contradicts one of these, surface in a review checkpoint — don't silently change.

| Decision | Choice | Rationale |
|---|---|---|
| Toast public API | Top-level signal `pendingToast` + a `<ToastHost>` component mounted once in `App.tsx`; expose `showToast(message)` helper | Simpler than a context provider for one consumer; matches the single-buffer flush event we're surfacing. |
| Toast auto-dismiss | 4000 ms via `setTimeout`; dismissible via close button; clearTimeout if re-shown before the timer fires | Spec calls 4 s; the re-show case (two flushes back-to-back) restarts the timer so the most recent message wins. |
| `formatPendingRewrites(0)` return | `null` (caller renders nothing) | Mirrors `formatBrokenBlockRefs` byte-for-byte. |
| Singular / plural labels | `1 pending change` / `N pending changes` | Spec literal. |
| Popover anchor | Click on the status-bar count item toggles open/closed; outside-click + Esc closes; inline minimal popover (a `position: absolute` `<div>` above the click target) | Reusable popover primitive is K polish (explicit OOS). |
| Popover refetch | On every open: re-issue `getPendingRewritesBreakdown` + `listRecentRenameOps({ limit: 5 })`; cached state lives only while the popover is open | Avoids stale rows when external events queued while the popover was closed. |
| "Save all pending" failure | Render `showToast(message)` and leave the popover open so the user can retry | Backend `flush_pending_rewrites` rejects (vault not open) are recoverable; keep the popover so they can retry without re-opening. |
| Recent rename ops limit | `listRecentRenameOps({ limit: 5 })` | Spec literal ("last N rename ops"). |
| Undo button affordance | Per-op row in the "Recent renames" section; click calls `undoRename({ vault_id, rename_op_id })` and refetches the breakdown + ops | Matches the design spec's "per-op Undo." |
| Empty-state messages | `"No pending changes."` when count = 0 (popover header still shows — clicking a zero-count item is unlikely but cheap to support); `"No recent renames."` when ops list empty | Sym with Backlinks/UnlinkedMentions empty-state voice. |
| File-rename gesture location | Inline on the existing `<For each={visibleFiles()}>` row in `App.tsx`; no extraction to `FileList.tsx` | OOS in J.2 ("leave the inline `<For>`"). |
| Inline rename input UX | Selected file path replaced by a `<input>` pre-populated with the current path; Enter commits; Esc cancels; outside-click commits (matches Obsidian / Finder norm) | Outside-click as commit avoids a "did I save?" footgun. |
| Rename validation | Same-path / empty / `from == to` rejected client-side without an IPC; existing-dest is the backend's `InvalidRequest` (rendered verbatim via `showToast`) | Cheap client-side filter; backend remains source of truth. |
| `vault:flush-complete` toast for no-op flush | Suppress when `files_rewritten === 0 && refs_updated === 0` | A devtools `flushPendingRewrites` with nothing queued is non-noteworthy; avoids the "0 reference updates" empty toast. |
| `vault:pending-rewrites-changed` debounce | None — push-event-driven, count maps 1:1 to backend state | The existing `RIGHT_SIDEBAR_REFRESH_DEBOUNCE_MS` is a `vault:file-changed` debounce, irrelevant here. |
| Drop count on close | Reset the count signal to 0 + clear `pendingToast` + cancel both new listeners + close the popover | Same lifecycle shape as the other vault-scoped state in `App.tsx`. |

---

## File Structure

### New TypeScript files

- `ui/src/Toast.tsx` — minimal toast component + `showToast(message)` helper + `<ToastHost>` mount. ~50 LOC.
- `ui/src/Toast.test.ts` — vitest with fake timers for show / dismiss / auto-timeout / re-show-resets-timer.
- `ui/src/statusbar/pendingRewrites.ts` — pure `formatPendingRewrites(count) -> { label: string } | null`.
- `ui/src/statusbar/pendingRewrites.test.ts` — three cases (`0`, `1`, `>1`).
- `ui/src/statusbar/PendingRewrites.tsx` — status-bar item + popover content (breakdown + Save-all + recent ops + per-op undo).
- `ui/src/statusbar/PendingRewrites.test.tsx` — popover renders breakdown rows + ops; clicking undo invokes the IPC; clicking save-all invokes the IPC.
- `ui/src/fileRename.ts` — pure `validateRenameTarget(from, to)` returning `null | { code, message }` + tests.
- `ui/src/fileRename.test.ts` — empty / same-path / valid cases.

### Modified TypeScript files

- `ui/src/App.tsx`:
  - Import `Toast` (`ToastHost` + `showToast`), `PendingRewrites`, IPC helpers (`onVaultPendingRewritesChanged`, `onVaultFlushComplete`, `renameFile`).
  - Add `pendingRewritesCount` signal + `renamingPath` signal + `contextMenu` signal (anchored to a row).
  - Subscribe to the two new event listeners in `onMount`; unsubscribe in `onCleanup` + reset on close.
  - Render `<ToastHost>` once near the conflict-banner `<Show>`.
  - Render `<PendingRewrites>` next to the existing `<BrokenBlockRefs>` status item in the footer.
  - Add `onContextMenu` to each visible-file row; render the minimal context menu when `contextMenu()` matches the row; render the inline rename input when `renamingPath()` matches.

### Files NOT modified (out of scope this session)

- Any Rust file — J.1 closed the backend.
- `ui/src/api/ipc.ts` — the J.1 stubs already cover every IPC + listener J.2 needs.

---

## Task 1 — `Toast.tsx` (and host)

**Files:**
- New: `ui/src/Toast.tsx`
- New: `ui/src/Toast.test.ts`

The Toast surface is a single-slot signal-backed component. `showToast(message)` sets the signal and arms a 4 s `setTimeout`. `<ToastHost>` reads the signal and renders a tokenised box at the bottom-centre; a close `×` button clears the signal early.

- [ ] **Step 1: Failing tests first.** Write `ui/src/Toast.test.ts` with:
  - `showToast` populates the host's rendered message.
  - After 4000 ms (fake timers; `vi.advanceTimersByTime(4000)`) the toast clears.
  - Clicking the close button clears the toast before the timer.
  - Calling `showToast` twice within 4 s shows the second message and resets the timer (the first message's timer must not clear the second).
  - Use `@solidjs/testing-library` (already in package.json — confirm during the step) or a minimal manual render via Solid's `render` helper if not present.

  Run: `cd ui && npx vitest run src/Toast.test.ts` — expect 4 failures.

- [ ] **Step 2: Implement.** `Toast.tsx` exports:
  ```ts
  export function showToast(message: string): void;
  export const ToastHost: Component;
  ```
  Internal:
  ```ts
  const [toast, setToast] = createSignal<{ message: string; nonce: number } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  ```
  `showToast(message)` clears any existing timer, sets a fresh `{ message, nonce: prev + 1 }`, and arms a 4 s timer that clears the signal *only if the nonce still matches*. `<ToastHost>` renders nothing when `toast() === null`; otherwise a `position: fixed; bottom: var(--space-5); left: 50%; transform: translateX(-50%);` card with `var(--c-bg-tertiary)` background, `var(--c-border-subtle)` border, `var(--shadow-md)`, `var(--c-fg-primary)` text, and a `×` close button styled like the existing context-menu Cancel button in the create-offer dialog. **No hardcoded colours.**

  Run: same vitest — expect 4 passes.

- [ ] **Step 3: Verify token usage.** `grep -E '#[0-9a-fA-F]{3,8}|rgb\(' ui/src/Toast.tsx` returns nothing.

---

## Task 2 — `statusbar/pendingRewrites.ts` formatter + tests

**Files:**
- New: `ui/src/statusbar/pendingRewrites.ts`
- New: `ui/src/statusbar/pendingRewrites.test.ts`

Pure formatter mirroring `statusbar/brokenRefs.ts` byte-for-byte.

- [ ] **Step 1: Failing test.** `pendingRewrites.test.ts`:
  - `formatPendingRewrites(0)` → `null`.
  - `formatPendingRewrites(1)` → `{ label: "1 pending change" }`.
  - `formatPendingRewrites(7)` → `{ label: "7 pending changes" }`.
  - Run: `npx vitest run src/statusbar/pendingRewrites.test.ts` — three failures.

- [ ] **Step 2: Implement.** Same shape as `formatBrokenBlockRefs`; no tooltip (the popover supersedes it). Returns `{ label }` (no `title` field — the popover is the affordance).

  Run: vitest — three passes.

---

## Task 3 — `fileRename.ts` validator + tests

**Files:**
- New: `ui/src/fileRename.ts`
- New: `ui/src/fileRename.test.ts`

Pure validation so the rename input doesn't fire an IPC for a guaranteed no-op.

- [ ] **Step 1: Failing test.** Cases:
  - `validateRenameTarget("Daily.md", "")` → `{ code: "empty", message: "Name cannot be empty." }`.
  - `validateRenameTarget("Daily.md", "Daily.md")` → `{ code: "same", message: "Name unchanged." }`.
  - `validateRenameTarget("Daily.md", "Journal.md")` → `null`.
  - `validateRenameTarget("notes/Daily.md", "notes/Journal.md")` → `null`.
  - `validateRenameTarget("Daily.md", "  ")` → `{ code: "empty", ... }` (trim-whitespace).

- [ ] **Step 2: Implement.** ~10 LOC; trim the input, compare to `from`, return the discriminated `null | { code, message }`.

  Run: vitest — five passes.

---

## Task 4 — `statusbar/PendingRewrites.tsx` + tests

**Files:**
- New: `ui/src/statusbar/PendingRewrites.tsx`
- New: `ui/src/statusbar/PendingRewrites.test.tsx`

A clickable status-bar item that opens a popover. The popover queries the backend on each open (no caching). Inline-renders the breakdown, "Save all pending" button, and a "Recent renames" section with one Undo button per op.

- [ ] **Step 1: Failing tests.** Mock `getPendingRewritesBreakdown`, `listRecentRenameOps`, `flushPendingRewrites`, `undoRename` via `vi.mock("../api/ipc", ...)`. Test:
  - Closed popover renders just the label (`formatPendingRewrites(props.count)`); when count is 0, renders nothing.
  - Clicking the label calls `getPendingRewritesBreakdown` + `listRecentRenameOps`, then renders the breakdown rows + ops.
  - Clicking "Save all pending" calls `flushPendingRewrites({ vault_id })`.
  - Clicking an Undo row calls `undoRename({ vault_id, rename_op_id })` and triggers a re-query.
  - Clicking outside closes the popover.
  - Pressing Esc closes the popover (DOM event on `document`).

- [ ] **Step 2: Implement.** Props:
  ```ts
  export interface PendingRewritesProps {
    vaultId: string;
    count: number;
    onError: (message: string) => void;
  }
  ```
  Internal state:
  ```ts
  type View =
    | { kind: "closed" }
    | { kind: "loading" }
    | { kind: "loaded"; breakdown: PendingRewriteBreakdownRow[]; ops: RecentRenameOp[] }
    | { kind: "error"; message: string };
  ```
  Layout: a `<button>` showing `formatPendingRewrites(count).label`, a `position: absolute; bottom: 100%; right: 0;` popover panel above the bar. Close on outside-click (`document.addEventListener("mousedown", …)` with cleanup) and Esc (`document.addEventListener("keydown", …)`).
  Pass `onError` from `App.tsx` to surface failures via `showToast`.

- [ ] **Step 3: Token check + vitest pass.**

---

## Task 5 — File-rename gesture in `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

Add a right-click context menu on each visible row → "Rename…" → inline rename input replaces the row's label. Enter commits, Esc cancels, outside-click commits.

- [ ] **Step 1: Signals + helpers.**

  Add to the top of `App` (near the existing per-file state):
  ```ts
  const [contextMenu, setContextMenu] = createSignal<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [renamingPath, setRenamingPath] = createSignal<string | null>(null);
  ```

  Add `handleRenameCommit(from: string, to: string)`:
  - Trim `to`, run `validateRenameTarget(from, to)`.
  - If validator returns non-null: `showToast(result.message)`; clear `renamingPath`.
  - Else: `await renameFile({ vault_id, from_path: from, to_path: to })`; clear `renamingPath`. Backend `InvalidRequest` is caught → `showToast(message)`.

- [ ] **Step 2: Row `onContextMenu` + menu render.**

  On each row in `<For each={visibleFiles()}>`, attach `onContextMenu={(e) => { e.preventDefault(); setContextMenu({ path: file.path, x: e.clientX, y: e.clientY }); }}` — only when `file.type_id === "markdown"` (binary files don't rename).

  Render the menu in a `<Show when={contextMenu()}>` block at top level (inside the existing `<Show when={vaultId()}>` section): `position: fixed; top/left = clientX/Y; min-width: 10rem; background: var(--c-bg-primary); border: 1px solid var(--c-border-subtle); border-radius: var(--radius-md); padding: var(--space-1) 0;`. One item: `Rename…` button that calls `setRenamingPath(contextMenu()!.path); setContextMenu(null);`. Outside-click / Esc closes the menu (same listeners pattern as PendingRewrites — extract a tiny `useDismissable` hook? **No — inline the listeners; two consumers don't justify a primitive yet**, per OOS).

- [ ] **Step 3: Inline rename input.**

  Inside the row's render, when `renamingPath() === file.path`, replace the `<span>{file.path}</span>` with an `<input>` pre-populated with `file.path`, `autofocus`, styled with the row's existing font tokens (no border, transparent background, `var(--c-fg-primary)` text). Handlers:
  - `onKeyDown` Enter → `handleRenameCommit(file.path, e.currentTarget.value)`.
  - `onKeyDown` Escape → `setRenamingPath(null)`.
  - `onBlur` → `handleRenameCommit(file.path, e.currentTarget.value)` (outside-click commit).
  - Stop propagation on click so a click inside the input doesn't trigger the row's `onClick={handleSelectFile}`.

- [ ] **Step 4: Verify.** `cd ui && npx tsc --noEmit && npx vitest run` clean. The rename-input + menu interaction is exercised through the smoke pass — no vitest unit test is added for `App.tsx` itself (precedent: Session I's segment selector tests live in `RightSidebar`, not `App.tsx`).

---

## Task 6 — Wire `onVaultPendingRewritesChanged` + `onVaultFlushComplete` in `App.tsx`

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Signals.**

  Add near the existing vault-scoped state:
  ```ts
  const [pendingRewritesCount, setPendingRewritesCount] = createSignal(0);
  let unlistenPendingChanged: UnlistenFn | undefined;
  let unlistenFlushComplete: UnlistenFn | undefined;
  ```

- [ ] **Step 2: Subscriptions in `onMount`.**

  Inside the existing `onMount` callback, after the file-changed listener wiring:
  ```ts
  unlistenPendingChanged = await onVaultPendingRewritesChanged((p) => {
    if (p.vault_id !== vaultId()) return;
    setPendingRewritesCount(p.count);
  });
  unlistenFlushComplete = await onVaultFlushComplete((p) => {
    if (p.vault_id !== vaultId()) return;
    if (p.files_rewritten === 0 && p.refs_updated === 0) return;
    showToast(
      `Applied ${p.refs_updated} reference update${p.refs_updated === 1 ? "" : "s"} across ${p.files_rewritten} file${p.files_rewritten === 1 ? "" : "s"}.`,
    );
  });
  ```

  In the existing `onCleanup`:
  ```ts
  unlistenPendingChanged?.();
  unlistenFlushComplete?.();
  ```

  In `handleOpen` (where other vault-scoped signals reset):
  ```ts
  setPendingRewritesCount(0);
  ```

- [ ] **Step 3: Render the status item.**

  In the footer, alongside the existing `<Show when={formatBrokenBlockRefs(brokenBlockRefs())}>` clause, insert:
  ```tsx
  <PendingRewrites
    vaultId={vaultId() ?? ""}
    count={pendingRewritesCount()}
    onError={(m) => showToast(m)}
  />
  ```
  (Component handles the count === 0 hide internally via `formatPendingRewrites`.)

  Add `<ToastHost />` once near the create-offer dialog `<Show>`.

---

## Task 7 — Spec write-up §9.16 + CLAUDE.md state

**Files:**
- Modify: `docs/layer-3-spec.md` (append §9.16 after §9.15)
- Modify: `CLAUDE.md` Project state block

- [ ] **Step 1: Draft §9.16** mirroring §9.13's voice — "What landed", per-component bullets (Toast / formatter / PendingRewrites / rename gesture / App.tsx wiring), tests delta, verification line. Reference the design spec.

- [ ] **Step 2: Update CLAUDE.md** Project state to read "A–F + G + H.1 + H.2 + I + **J done**; K pending." Rewrite Next to "Session K (interactive smoke + L3 closeout + `l3` tag)."

---

## Task 8 — Verification gates + smoke

- [ ] `cargo test --workspace` → **406** (unchanged).
- [ ] `cd ui && npx tsc --noEmit` clean.
- [ ] `cd ui && npm run build` clean.
- [ ] `cd ui && npx vitest run` → **329 baseline + new** (Toast: 4, pendingRewrites: 3, fileRename: 5, PendingRewrites: 6 — expected delta ~18).
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] `cargo fmt --all --check` clean.

**Interactive smoke** against `cargo tauri dev` (smoke vault per the design spec). Auto context can't reliably drive a Tauri window; expectation per Session I precedent is that hands-on smoke is **deferred-with-note** if blocked, with the headless devtools recipe documented in §9.16.

If hands-on smoke is possible: record each case (file rename, tag rename, nested tag rename, block-id rename, undo before flush, external-write conflict, >50 fuse, 5-min timer, app-close mandatory flush) with `cat` output or a screenshot path. Otherwise document the deferred-smoke note as Session I did.

---

## Task 9 — Commit + finishing-a-development-branch

- [ ] Commit in logical units, Conventional Commits:
  - `feat(ui): Toast component`
  - `feat(ui): pending-rewrites status-bar item + dropdown`
  - `feat(ui): file rename context menu + inline input`
  - `feat(ui): wire pending-rewrites events + toast`
  - `test(ui):` chunks where they don't fit cleanly with the feat commits
  - `docs(l3): close Session J.2 — pending rewrites frontend`

  Hooks ON; no push.

- [ ] Invoke `superpowers:finishing-a-development-branch`. Default per project workflow: merge `l3-session-j2-pending-rewrites-frontend` into `main` with `--no-ff`, commit message `merge: L3 Session J.2 — pending rewrites frontend`.

- [ ] Report back: every DoD box's status, final test counts, smoke evidence (or deferred-smoke note), and name the next session — **L3 Session K**.
