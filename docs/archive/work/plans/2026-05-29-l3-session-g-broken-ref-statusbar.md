> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# L3 Session G follow-up — broken block-ref status-bar indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a passive "⚠ N broken block refs" indicator in the existing footer status bar, fed by the already-wired `getBrokenBlockRefs` IPC, refreshed on scan-complete and on vault file changes.

**Architecture:** Frontend-only. A pure, unit-tested formatter (`formatBrokenBlockRefs`) turns the IPC's `BrokenBlockRef[]` into an optional `{ label, title }`. `App.tsx` holds a `brokenBlockRefs` signal, refreshes it (debounced) from the existing `vault:file-changed` + `scan-complete` hooks, clears it on the vault-open reset, and renders the indicator in the `<footer>` via `<Show>`.

**Tech Stack:** SolidJS, TypeScript, Vitest. Reuses the `getBrokenBlockRefs` / `BrokenBlockRef` IPC bindings already in `ui/src/api/ipc.ts`.

**Branch:** Work on a new branch `l3-session-g-statusbar` cut from `main` (single-checkout workflow — no worktrees).

**Design:** `docs/superpowers/specs/2026-05-29-l3-session-g-broken-ref-statusbar-design.md`.

---

## Background — read before touching code

- **The status-bar shell already exists.** `App.tsx` `<footer>` (~line 1345) is a flex `space-between` row: left `<span>` = scan status, right `<span>` = `vaultId()`. The indicator joins this footer between them.
- **IPC is ready** (`ui/src/api/ipc.ts`): `getBrokenBlockRefs(req): Promise<GetBrokenBlockRefsResponse>`, `BrokenBlockRef { source_file_path, target_file_path, target_block_id }`, `GetBrokenBlockRefsResponse { refs: BrokenBlockRef[] }`. Backend returns them stably ordered.
- **Refresh hooks** (`App.tsx`): `onVaultScanComplete` handler (~line 615) and `onVaultFileChanged` handler (~line 626, which already calls `scheduleRefresh()` + `scheduleBacklinksRefresh()`). `scheduleBacklinksRefresh` (~line 352) is the debounce pattern to mirror: a `let …Timer` + `setTimeout(…, 200)`. `BACKLINKS_REFRESH_DEBOUNCE_MS = 200` exists (line 203).
- **Vault reset** (~line 732, inside `openVaultFlow`): a block of `setX(...)` resets clearing per-vault state (`setFiles([])`, `setBacklinksRefreshTick(0)`, `setWikilinkResolver(null)`, etc.). `setBrokenBlockRefs([])` joins this block.
- **`Show` is already imported** from `solid-js` (line 7). **Warning color:** `var(--c-warning, var(--c-accent))` (decorations.ts precedent).

---

## File Structure

**Create:**
- `ui/src/statusbar/brokenRefs.ts` — pure `formatBrokenBlockRefs(refs)` → `{ label, title } | null`.
- `ui/src/statusbar/brokenRefs.test.ts` — unit tests.

**Modify:**
- `ui/src/App.tsx` — import the IPC + formatter, add the `brokenBlockRefs` signal + refresh/debounce, wire into the two event handlers + the reset block, render the footer indicator.
- `docs/layer-3-spec.md` — append a paragraph to §9.9 (or a short §9.10) noting the indicator.
- `CLAUDE.md` — rewrite the Project state block.

---

### Task 1: Pure formatter

**Files:**
- Create: `ui/src/statusbar/brokenRefs.ts`
- Create: `ui/src/statusbar/brokenRefs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/statusbar/brokenRefs.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { BrokenBlockRef } from "../api/ipc";
import { formatBrokenBlockRefs } from "./brokenRefs";

const ref = (
  source_file_path: string,
  target_file_path: string,
  target_block_id: string,
): BrokenBlockRef => ({
  source_file_path,
  target_file_path,
  target_block_id,
});

describe("formatBrokenBlockRefs", () => {
  it("returns null when there are no broken refs", () => {
    expect(formatBrokenBlockRefs([])).toBeNull();
  });

  it("uses the singular noun for exactly one", () => {
    const d = formatBrokenBlockRefs([ref("a.md", "b.md", "x")]);
    expect(d?.label).toBe("⚠ 1 broken block ref");
    expect(d?.title).toBe("a.md → b.md#^x");
  });

  it("uses the plural noun and one tooltip line per ref", () => {
    const d = formatBrokenBlockRefs([
      ref("a.md", "b.md", "x"),
      ref("c.md", "b.md", "y"),
    ]);
    expect(d?.label).toBe("⚠ 2 broken block refs");
    expect(d?.title).toBe("a.md → b.md#^x\nc.md → b.md#^y");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ui && npx vitest run src/statusbar/brokenRefs.test.ts`
Expected: FAIL — `./brokenRefs` does not exist (module not found).

- [ ] **Step 3: Implement the formatter**

Create `ui/src/statusbar/brokenRefs.ts`:

```ts
import type { BrokenBlockRef } from "../api/ipc";

export interface BrokenRefsDisplay {
  /** Footer label, e.g. "⚠ 2 broken block refs". */
  label: string;
  /** Tooltip: one "source → target#^id" line per ref. */
  title: string;
}

/**
 * Footer display for broken block refs, or `null` when there are none
 * (so the caller renders nothing). Pure — the visual wiring lives in
 * `App.tsx`. See `docs/layer-3-spec.md` §9.9.
 */
export function formatBrokenBlockRefs(
  refs: BrokenBlockRef[],
): BrokenRefsDisplay | null {
  if (refs.length === 0) return null;
  const noun = refs.length === 1 ? "broken block ref" : "broken block refs";
  const label = `⚠ ${refs.length} ${noun}`;
  const title = refs
    .map(
      (r) =>
        `${r.source_file_path} → ${r.target_file_path}#^${r.target_block_id}`,
    )
    .join("\n");
  return { label, title };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ui && npx vitest run src/statusbar/brokenRefs.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/statusbar/brokenRefs.ts ui/src/statusbar/brokenRefs.test.ts
git commit -m "feat(ui): pure formatter for broken block-ref status indicator"
```

---

### Task 2: Signal + refresh wiring in App

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the IPC + formatter imports**

In `ui/src/App.tsx`, add `getBrokenBlockRefs` and the `BrokenBlockRef` type to the `./api/ipc` import group (the block ending `} from "./api/ipc";`, ~line 30). Add `getBrokenBlockRefs,` among the function imports and `type BrokenBlockRef,` among the type imports:

```ts
  getBrokenBlockRefs,
```

```ts
  type BrokenBlockRef,
```

And add the formatter import near the other editor/statusbar imports (e.g. after the `./editor/blockRef` import, ~line 41):

```ts
import { formatBrokenBlockRefs } from "./statusbar/brokenRefs";
```

- [ ] **Step 2: Add the signal + debounce timer**

Next to the `backlinksRefreshTick` signal + `backlinksRefreshTimer` (~lines 201–203), add:

```ts
  const [brokenBlockRefs, setBrokenBlockRefs] = createSignal<BrokenBlockRef[]>(
    [],
  );
  let brokenBlockRefsTimer: ReturnType<typeof setTimeout> | undefined;
```

- [ ] **Step 3: Add the refresh + debounce functions**

After `scheduleBacklinksRefresh` (the function ending ~line 360), add:

```ts
  /**
   * Re-query the vault's broken block refs (L3 Session G). A transient
   * IPC error keeps the prior value rather than flickering to empty.
   */
  const refreshBrokenBlockRefs = async (): Promise<void> => {
    const id = vaultId();
    if (!id) return;
    try {
      const resp = await getBrokenBlockRefs({ vault_id: id });
      setBrokenBlockRefs(resp.refs);
    } catch (e) {
      console.error("broken block-ref refresh failed", e);
    }
  };

  /** Debounced `refreshBrokenBlockRefs` for the file-changed firehose. */
  const scheduleBrokenBlockRefsRefresh = () => {
    if (brokenBlockRefsTimer !== undefined) {
      clearTimeout(brokenBlockRefsTimer);
    }
    brokenBlockRefsTimer = setTimeout(() => {
      brokenBlockRefsTimer = undefined;
      void refreshBrokenBlockRefs();
    }, BACKLINKS_REFRESH_DEBOUNCE_MS);
  };
```

- [ ] **Step 4: Trigger on scan-complete**

In the `onVaultScanComplete` handler (~line 615–621), after `void refreshFileList();`, add:

```ts
      void refreshBrokenBlockRefs();
```

- [ ] **Step 5: Trigger on file change**

In the `onVaultFileChanged` handler, next to the existing `scheduleBacklinksRefresh();` call (~line 638), add:

```ts
      scheduleBrokenBlockRefsRefresh();
```

- [ ] **Step 6: Clear on vault reset**

In the vault-open reset block, next to `setBacklinksRefreshTick(0);` (~line 744), add:

```ts
      setBrokenBlockRefs([]);
```

- [ ] **Step 7: Verify it compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: clean. (`brokenBlockRefs` is read in Task 3; an unused-signal warning is not a tsc error, so this passes now.)

- [ ] **Step 8: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): track + refresh broken block refs in App state"
```

---

### Task 3: Render the footer indicator

**Files:**
- Modify: `ui/src/App.tsx`

- [ ] **Step 1: Add the indicator to the footer**

In the `<footer>` (~line 1356–1365), between the scan-status `<span>` (the one ending `</span>` after the `scanStatus()` ternary) and the `<span>{vaultId()}</span>`, insert:

```tsx
          <Show when={formatBrokenBlockRefs(brokenBlockRefs())}>
            {(display) => (
              <span
                title={display().title}
                style={{ color: "var(--c-warning, var(--c-accent))" }}
              >
                {display().label}
              </span>
            )}
          </Show>
```

- [ ] **Step 2: Verify it compiles + tests pass**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; vitest all green (was 279 + 3 new in `brokenRefs.test.ts`) = 282.

- [ ] **Step 3: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(ui): render broken block-ref indicator in the footer"
```

---

### Task 4: Verification, docs, finish branch

**Files:**
- Modify: `docs/layer-3-spec.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Frontend gates**

```bash
cd ui && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: tsc clean; vitest 282 green; build succeeds (pre-existing chunk-size warning is fine).

- [ ] **Step 2: Rust suite unchanged (sanity)**

Run: `cargo test --workspace 2>&1 | tail -5`
Expected: PASS, 271 (no backend edits). (If `runner::tests::schema_too_new_is_rejected` trips, it's a known parallel-run flake — re-run in isolation.)

- [ ] **Step 3: Real-app smoke (best-effort)**

```bash
cargo build -p cubical-app
# then: cargo tauri dev, open a sandbox vault.
#  - In note A write `[[B#^missing]]` where B.md has no ^missing.
#  - Confirm the footer shows "⚠ 1 broken block ref" with a tooltip
#    listing "A.md → B.md#^missing".
#  - Add `^missing` to B (or via Cmd/Ctrl+Shift+B on a B paragraph);
#    confirm the indicator disappears after the file-change refresh.
```
The native Tauri window can't be browser-driven in this automated context (same constraint as Sessions D–G). Record the smoke honestly: the formatter is fully unit-tested; the signal/refresh/render glue is thin and exercised end-to-end only by this hands-on smoke.

- [ ] **Step 4: Update docs + state**

- Append to `docs/layer-3-spec.md` §9.9 (or add a short `### 9.10`): the footer indicator — `getBrokenBlockRefs` refreshed on scan-complete + debounced `vault:file-changed`, the pure `formatBrokenBlockRefs` helper, warning styling, passive (no click). Note broken *wiki-link* surfacing stays deferred (no backend query), and that this indicator would host it once that lands.
- Rewrite the `CLAUDE.md` "Project state" block (do not append): broken block-ref status bar done; update the vitest count (282) and Rust count (271 unchanged); set "Next: in-bracket `[[#^` autocomplete (needs a backend block-ids-in-file query), then Session H — Embeds."

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch.

---

## Self-review notes (for the executor)

- **YAGNI:** the indicator is passive display. No click-to-navigate, no panel, no broken-wiki-link surfacing (no backend query exists). Don't add them.
- **`formatBrokenBlockRefs` is the only testable unit** — keep formatting (label/pluralization/tooltip) there, not inline in JSX, so it stays covered.
- **Debounce reuse:** `scheduleBrokenBlockRefsRefresh` mirrors `scheduleBacklinksRefresh` exactly (same 200ms constant, same `let timer` pattern). Refresh on scan-complete is immediate (not debounced) since it fires once.
- **Transient-error policy:** a failed `getBrokenBlockRefs` logs and keeps the last value — no flicker to zero.
- **Reset:** `setBrokenBlockRefs([])` must sit in the vault-open reset block so a new vault doesn't briefly show the old vault's count.
```
