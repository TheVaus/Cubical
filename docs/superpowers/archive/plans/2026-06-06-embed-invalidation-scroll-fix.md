# Embed re-render scroll-jump fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the editor viewport from jumping to the top while typing in a file that contains a rendered embed, by skipping embed + wiki-link resolver invalidation on the open file's own autosave echo.

**Architecture:** A pure `isOwnWriteEcho(...)` helper encodes the "this `vault:file-changed` event is the open file's own autosave write coming back" decision. `App.tsx`'s `onVaultFileChanged` handler computes it once and guards only the two resolver `invalidate()` calls with it. Other files' changes and genuine external edits to the open file still invalidate exactly as before.

**Tech Stack:** TypeScript, SolidJS, Vitest. No Rust changes. No CodeMirror changes.

**Design spec:** `docs/superpowers/specs/2026-06-06-embed-invalidation-scroll-fix-design.md`

---

## File structure

- **Create** `ui/src/ownWrite.ts` — pure `isOwnWriteEcho()` decision helper. No Solid / CodeMirror deps.
- **Create** `ui/src/ownWrite.test.ts` — vitest unit cases for the helper.
- **Modify** `ui/src/App.tsx` — import the helper; guard the two resolver invalidations inside `onVaultFileChanged`.
- **Modify** `docs/layer-4-spec.md` — §9.2 "Known issue (deferred)" → resolved.
- **Modify** `CLAUDE.md` — remove the "Known issue" line from Project state (done as part of session-close, not a code task).

---

### Task 1: Pure `isOwnWriteEcho` helper (TDD)

**Files:**
- Create: `ui/src/ownWrite.ts`
- Test: `ui/src/ownWrite.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/ownWrite.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isOwnWriteEcho } from "./ownWrite";

describe("isOwnWriteEcho", () => {
  it("is true when the open file's own write echoes back (paths + hashes match)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "abc123",
        lastWrittenHash: "abc123",
      }),
    ).toBe(true);
  });

  it("is false when a different file changed", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/B.md",
        selectedPath: "notes/A.md",
        incomingHash: "abc123",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });

  it("is false when the event carries no hash", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: null,
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });

  it("is false for a genuine external edit (hashes differ)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "external999",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });

  it("is false when nothing has been written yet (lastWrittenHash null)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "abc123",
        lastWrittenHash: null,
      }),
    ).toBe(false);
  });

  it("is false when no file is open (selectedPath null)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: null,
        incomingHash: "abc123",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/ownWrite.test.ts`
Expected: FAIL — `isOwnWriteEcho` not found / module `./ownWrite` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/ownWrite.ts`:

```ts
/**
 * Decision helper for the `vault:file-changed` handler in `App.tsx`.
 *
 * Returns true iff the incoming change event is the *open* file's own
 * autosave write echoing back through the OS file watcher — i.e. the
 * changed path is the open file, the event carries a content hash, and
 * that hash equals the hash of our most recent successful write.
 *
 * Used to skip embed / wiki-link resolver invalidation on own writes:
 * an own write to the open file cannot have changed any *other* file's
 * content, so cached resolutions stay valid, and a needless invalidate
 * only thrashes embed-card height (the L4-A-fix viewport-jump bug,
 * `docs/layer-4-spec.md` §9.2). External edits and other-file changes
 * return false, so they still invalidate.
 */
export function isOwnWriteEcho(p: {
  changedPath: string;
  selectedPath: string | null;
  incomingHash: string | null | undefined;
  lastWrittenHash: string | null;
}): boolean {
  if (p.selectedPath === null) return false;
  if (p.changedPath !== p.selectedPath) return false;
  if (!p.incomingHash) return false;
  return p.incomingHash === p.lastWrittenHash;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/ownWrite.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ownWrite.ts ui/src/ownWrite.test.ts
git commit -m "feat(embed-scroll-fix): pure isOwnWriteEcho helper + unit tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Guard resolver invalidation in `onVaultFileChanged`

**Files:**
- Modify: `ui/src/App.tsx` (import block near line 44; handler body near lines 758–770)

- [ ] **Step 1: Add the import**

In `ui/src/App.tsx`, the import for the embed resolver ends at line 44 (`} from "./editor/embedResolver";`). Immediately after it, add:

```ts
import { isOwnWriteEcho } from "./ownWrite";
```

- [ ] **Step 2: Guard the two invalidations**

In `onVaultFileChanged`, replace this block (currently lines 762–770):

```ts
      // L3 Session B: any vault file change may have created or
      // removed a wiki-link target. Drop the resolver cache so the
      // next decoration rebuild re-resolves.
      wikilinkResolver()?.invalidate();

      // L3 Session H.2: any vault file change may have altered embed
      // targets or their contents. Drop the resolver cache so the next
      // widget rebuild re-fetches.
      embedResolver()?.invalidate();
```

with:

```ts
      // L4-A-fix.1: skip resolver invalidation on the open file's own
      // autosave echo. An own write can't have changed another file's
      // content, so cached embed / wiki-link resolutions stay valid;
      // invalidating here would only thrash embed-card height and jump
      // the viewport (layer-4-spec §9.2). Other-file changes and
      // genuine external edits to the open file still invalidate.
      const ownWrite = isOwnWriteEcho({
        changedPath: p.path,
        selectedPath: selectedPath(),
        incomingHash: p.new_content_hash,
        lastWrittenHash,
      });
      if (!ownWrite) {
        // L3 Session B: a change may have created or removed a wiki-link
        // target — re-resolve on the next decoration rebuild.
        wikilinkResolver()?.invalidate();
        // L3 Session H.2: a change may have altered embed targets or
        // their contents — re-fetch on the next widget rebuild.
        embedResolver()?.invalidate();
      }
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: clean (no errors). Confirms `p.new_content_hash`, `selectedPath()`, and `lastWrittenHash` all type-match the helper's parameter shape.

- [ ] **Step 4: Run the full vitest suite**

Run: `cd ui && npx vitest run`
Expected: PASS — all existing tests plus the 6 new `ownWrite` tests green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "fix(embed-scroll-fix): skip resolver invalidation on own-write echo

The vault:file-changed handler invalidated the embed + wiki-link
resolvers unconditionally; autosave's own write echoes back through the
OS watcher, so every keystroke remounted every rendered embed (height
thrash -> viewport jump to top). Guard both invalidations with
isOwnWriteEcho so own autosave echoes are skipped while other-file
changes and external edits still invalidate. Closes layer-4-spec §9.2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Full gate sweep

**Files:** none (verification only)

- [ ] **Step 1: Run all six gates**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cd ui && npx tsc --noEmit && npm run build && npx vitest run
```

Expected: all green. (Rust gates unchanged by this session — they confirm no incidental breakage. Vitest count = prior + 6.)

- [ ] **Step 2: No commit** — this task only confirms the gates; nothing to stage.

---

### Task 4: Executed interactive smoke (Contract E — required before tag)

**Files:** record results in `docs/layer-4-spec.md` §9.2 (Task 5).

This step requires the running app and a human operator (jsdom has no layout engine; the scroll effect is operator-smoke-only). The agent runs the build and hands the operator the procedure; if the agent cannot drive the native window, it records best-available verification + honest transparency per the session-cadence rule.

- [ ] **Step 1: Boot**

Run: `cargo tauri dev` → File menu → Open Vault → `~/Developer/sandbox/cubical-l4a-smoke/`. Wait for the file tree to populate. Open A.md (carries an own-line `![[…]]` embed shown as a card).

- [ ] **Step 2: Type-with-embed test**

Type continuously for ~30 s in A.md while the embed card is visible.
Expected: the viewport does **not** jump to the top; the embed card stays rendered (does not flicker to `Loading…` / collapse to ~60 px and re-expand).

- [ ] **Step 3: External-edit regression test**

From another terminal:

```bash
echo "" >> ~/Developer/sandbox/cubical-l4a-smoke/A.md
```

Expected: within the debounce window the open file's embeds still refresh (the live-refresh substrate is intact). If A.md was clean in the editor, it silently reloads; if dirty, the conflict banner appears — both are pre-existing behaviour and confirm external edits still flow.

- [ ] **Step 4: If a jump persists**

Do **not** add a second fix blind. Add a dev-only `EditorView.updateListener` logging `view.scrollDOM.scrollTop` plus embed remount events, reproduce, and diagnose before touching `estimatedHeight`. (Same discipline that cracked the L4-A-fix cursor bug.)

---

### Task 5: Docs + session close

**Files:**
- Modify: `docs/layer-4-spec.md` (§9.2 "Known issue (deferred)")
- Modify: `CLAUDE.md` (Project state "Known issue" line)

- [ ] **Step 1: Update `docs/layer-4-spec.md` §9.2**

Change the "**Known issue (deferred) — embed re-render scroll jump on autosave.**" subsection so its heading reads "**Known issue — RESOLVED 2026-06-06 (own-write-echo guard).**" and append a short resolution paragraph: the fix landed as `isOwnWriteEcho` guarding the two resolver invalidations in `onVaultFileChanged`; Option 1 of the kickoff; plan `docs/superpowers/plans/2026-06-06-embed-invalidation-scroll-fix.md`; executed smoke result (from Task 4) recorded inline.

- [ ] **Step 2: Update `CLAUDE.md` Project state**

Remove the "**Known issue (deferred, documented):**" paragraph about the viewport scroll-jump from the Project state block, and rewrite the block (4–6 lines) to reflect: L4-A-fix.1 landed (embed scroll-jump fixed), next is L4-B. Update test counts (vitest +6).

- [ ] **Step 3: Commit**

```bash
git add docs/layer-4-spec.md CLAUDE.md
git commit -m "docs(embed-scroll-fix): mark §9.2 scroll-jump resolved; update project state

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Finishing the branch**

Use `superpowers:finishing-a-development-branch` to decide merge / PR. Optional `l4a-fix.1` tag is the operator's call (follow-up patch, not a layer transition).

---

## Self-review

**Spec coverage:**
- Pure helper `isOwnWriteEcho` → Task 1. ✓
- Handler wiring (guard both invalidations, leave rest of handler intact) → Task 2. ✓
- Five+ unit cases → Task 1 (6 cases: own-write, other file, no hash ×2, external, null lastWrittenHash, null selectedPath). ✓
- Six gates → Task 3. ✓
- Executed smoke (type-with-embed + external-edit regression + instrument-if-persists) → Task 4. ✓
- §9.2 → resolved; CLAUDE.md known-issue line removed → Task 5. ✓
- Out-of-scope items (other refreshers, resolver API, estimatedHeight) → not touched by any task. ✓

**Placeholder scan:** none — all code blocks and commands are concrete.

**Type consistency:** `isOwnWriteEcho` parameter object shape (`changedPath: string`, `selectedPath: string | null`, `incomingHash: string | null | undefined`, `lastWrittenHash: string | null`) is identical across the helper definition (Task 1 Step 3), the test (Task 1 Step 1), and the call site (Task 2 Step 2). Call site supplies `p.new_content_hash` (typed `string | null` on the event payload) into `incomingHash` (accepts `string | null | undefined`) — compatible. `selectedPath()` is the Solid accessor returning `string | null`; `lastWrittenHash` is the `let` binding of type `string | null`. All match.
