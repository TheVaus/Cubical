> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Configurable Status Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bottom status bar user-configurable — a master on/off that unmounts the footer, per-item visibility toggles for the four chrome segments, and an omnibar "Toggle status bar" command.

**Architecture:** Five new durable `statusbar.*` boolean settings (per-vault, in `.cubical/config.toml`; no Rust changes — the settings layer is schemaless). Two new pure, unit-tested helper modules (`segments.ts`, `separators.ts`). App.tsx grows a `statusbarConfig` signal seeded on vault-open, mirrors the existing `corePlugins` pattern for persistence, rewrites the footer to interleave separators from the visible set, and gains a new Settings tab. The omnibar gains a `kind:"command"` variant seeded with one command.

**Tech Stack:** SolidJS + TypeScript (vitest) front end; Tauri IPC for settings persistence. Spec: `docs/superpowers/specs/2026-06-20-configurable-statusbar-design.md`.

---

## File structure

- **Modify** `ui/src/api/ipc.ts` — add 5 keys to the `Setting` union.
- **Create** `ui/src/statusbar/segments.ts` — segment descriptors + `segmentVisible`; master-key constant.
- **Create** `ui/src/statusbar/segments.test.ts`.
- **Create** `ui/src/statusbar/separators.ts` — `leadingSeparators` pure helper.
- **Create** `ui/src/statusbar/separators.test.ts`.
- **Modify** `ui/src/omnibar/ranker.ts` — `kind:"command"` union member + tie-break.
- **Modify** `ui/src/omnibar/ranker.test.ts` — command ordering.
- **Create** `ui/src/omnibar/commands.ts` — command registry (pure).
- **Create** `ui/src/omnibar/commands.test.ts`.
- **Modify** `ui/src/omnibar/OmniBar.tsx` — command badge, `activate`, `onRunCommand` prop.
- **Modify** `ui/src/App.tsx` — state/seed/setter, footer rewrite, Settings tab, omnibar wiring.

App.tsx itself has no unit-test harness in this repo (only pure modules are vitest-tested); App tasks are verified with `tsc` + `vitest` (for the pure modules they consume) + `vite build`, plus a manual smoke at the end.

---

## Task 1: Settings keys + `segments.ts` pure module

**Files:**
- Modify: `ui/src/api/ipc.ts:253-264` (the `Setting` union)
- Create: `ui/src/statusbar/segments.ts`
- Test: `ui/src/statusbar/segments.test.ts`

- [ ] **Step 1: Add the five keys to the `Setting` union**

In `ui/src/api/ipc.ts`, add these members to the `Setting` union (after `properties.tags_key_as_tags`, keeping the trailing `;` on the final member):

```ts
  | { key: "statusbar.enabled"; value: boolean }
  | { key: "statusbar.show_vault_path"; value: boolean }
  | { key: "statusbar.show_file_path"; value: boolean }
  | { key: "statusbar.show_word_count"; value: boolean }
  | { key: "statusbar.show_block_count"; value: boolean };
```

(The previous final member `...tags_key_as_tags"; value: boolean }` loses its `;` and gains a `|`-prefixed sibling; the new last line keeps the `;`.)

- [ ] **Step 2: Write the failing test**

Create `ui/src/statusbar/segments.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  STATUSBAR_SEGMENTS,
  STATUSBAR_ENABLED_KEY,
  segmentVisible,
} from "./segments";

describe("statusbar segments", () => {
  it("exposes exactly the four configurable item segments", () => {
    expect(STATUSBAR_SEGMENTS.map((s) => s.id)).toEqual([
      "vault_path",
      "file_path",
      "word_count",
      "block_count",
    ]);
  });

  it("every segment id and settingKey is unique", () => {
    const ids = new Set(STATUSBAR_SEGMENTS.map((s) => s.id));
    const keys = new Set(STATUSBAR_SEGMENTS.map((s) => s.settingKey));
    expect(ids.size).toBe(STATUSBAR_SEGMENTS.length);
    expect(keys.size).toBe(STATUSBAR_SEGMENTS.length);
  });

  it("the master key is not one of the segment keys", () => {
    expect(STATUSBAR_SEGMENTS.map((s) => s.settingKey)).not.toContain(
      STATUSBAR_ENABLED_KEY,
    );
  });

  it("segmentVisible returns the stored value when present", () => {
    const seg = STATUSBAR_SEGMENTS[0];
    expect(segmentVisible({ [seg.settingKey]: false }, seg)).toBe(false);
    expect(segmentVisible({ [seg.settingKey]: true }, seg)).toBe(true);
  });

  it("segmentVisible falls back to the default (visible) when absent", () => {
    const seg = STATUSBAR_SEGMENTS[0];
    expect(segmentVisible({}, seg)).toBe(seg.defaultVisible);
    expect(seg.defaultVisible).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/statusbar/segments.test.ts`
Expected: FAIL — cannot resolve `./segments`.

- [ ] **Step 4: Implement `segments.ts`**

Create `ui/src/statusbar/segments.ts`:

```ts
import type { BooleanSettingKey } from "../settings/corePlugins";

/** Master on/off key. When false, the whole footer is unmounted. */
export const STATUSBAR_ENABLED_KEY = "statusbar.enabled" as const;

/** All statusbar booleans default to visible/on, so an upgraded vault with
 *  no `statusbar.*` keys looks identical to before. */
export const STATUSBAR_DEFAULT = true;

/** One configurable status-bar segment (the always-on system alerts —
 *  scanning, broken refs, pending rewrites — are deliberately not here). */
export interface StatusbarSegment {
  id: "vault_path" | "file_path" | "word_count" | "block_count";
  name: string;
  description: string;
  settingKey: BooleanSettingKey;
  defaultVisible: boolean;
}

export const STATUSBAR_SEGMENTS: StatusbarSegment[] = [
  {
    id: "vault_path",
    name: "Vault path",
    description: "Show the open vault's folder path on the left.",
    settingKey: "statusbar.show_vault_path",
    defaultVisible: true,
  },
  {
    id: "file_path",
    name: "File path",
    description: "Show the current note's vault-relative path on the right.",
    settingKey: "statusbar.show_file_path",
    defaultVisible: true,
  },
  {
    id: "word_count",
    name: "Word count",
    description: "Show the current note's word count.",
    settingKey: "statusbar.show_word_count",
    defaultVisible: true,
  },
  {
    id: "block_count",
    name: "Block count",
    description: "Show the current note's block count.",
    settingKey: "statusbar.show_block_count",
    defaultVisible: true,
  },
];

/** Resolve a segment's visibility: the stored value, else its default. */
export function segmentVisible(
  state: Record<string, boolean>,
  seg: StatusbarSegment,
): boolean {
  return state[seg.settingKey] ?? seg.defaultVisible;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd ui && npx vitest run src/statusbar/segments.test.ts && npx tsc --noEmit`
Expected: PASS (5 tests) and no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/ipc.ts ui/src/statusbar/segments.ts ui/src/statusbar/segments.test.ts
git commit -m "feat(statusbar): add statusbar.* settings keys + segments module"
```

---

## Task 2: `separators.ts` pure helper

**Files:**
- Create: `ui/src/statusbar/separators.ts`
- Test: `ui/src/statusbar/separators.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/statusbar/separators.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { leadingSeparators } from "./separators";

describe("leadingSeparators", () => {
  it("never puts a separator before the first visible item", () => {
    expect(leadingSeparators([true, true, true])).toEqual([false, true, true]);
  });

  it("skips hidden items and never marks them", () => {
    // vault path hidden, scanning visible, broken hidden, pending visible
    expect(leadingSeparators([false, true, false, true])).toEqual([
      false,
      false,
      false,
      true,
    ]);
  });

  it("handles all-hidden", () => {
    expect(leadingSeparators([false, false])).toEqual([false, false]);
  });

  it("handles a single visible item", () => {
    expect(leadingSeparators([false, true, false])).toEqual([
      false,
      false,
      false,
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/statusbar/separators.test.ts`
Expected: FAIL — cannot resolve `./separators`.

- [ ] **Step 3: Implement `separators.ts`**

Create `ui/src/statusbar/separators.ts`:

```ts
/**
 * Given an ordered list of segment visibilities, decide whether each visible
 * segment needs a leading `·` separator — true only when some earlier segment
 * is also visible. Hidden segments always get `false`. Lets the footer render
 * separators from the live visible set instead of hardcoded leading `·`s that
 * dangle when a preceding segment is toggled off.
 */
export function leadingSeparators(visible: boolean[]): boolean[] {
  let anyBefore = false;
  return visible.map((v) => {
    const sep = v && anyBefore;
    if (v) anyBefore = true;
    return sep;
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd ui && npx vitest run src/statusbar/separators.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/statusbar/separators.ts ui/src/statusbar/separators.test.ts
git commit -m "feat(statusbar): add leadingSeparators helper"
```

---

## Task 3: App.tsx — state, seeding, persistence setter

**Files:**
- Modify: `ui/src/App.tsx` (imports; signal near line 278; setter after line 770; seed after line 1277)

- [ ] **Step 1: Add imports**

In `ui/src/App.tsx`, alongside the other `./statusbar/...` imports (near line 62-63), add:

```ts
import {
  STATUSBAR_SEGMENTS,
  STATUSBAR_ENABLED_KEY,
  STATUSBAR_DEFAULT,
  segmentVisible,
  type StatusbarSegment,
} from "./statusbar/segments";
import { leadingSeparators } from "./statusbar/separators";
```

- [ ] **Step 2: Add the config signal**

After the `corePlugins` signal declaration (`App.tsx:278`), add:

```ts
  // Configurable status bar: master enable + per-item visibility, keyed by
  // full setting key (e.g. "statusbar.show_word_count"). Seeded on vault open.
  const [statusbarConfig, setStatusbarConfig] = createSignal<
    Record<string, boolean>
  >({});
  const statusbarEnabled = () =>
    statusbarConfig()[STATUSBAR_ENABLED_KEY] ?? STATUSBAR_DEFAULT;
  const segVisible = (seg: StatusbarSegment) =>
    segmentVisible(statusbarConfig(), seg);
```

- [ ] **Step 3: Add the persistence setter**

After `setCorePlugin` (`App.tsx:770`), add:

```ts
  /** Set a status-bar setting (master or a segment) and persist to the vault. */
  const setStatusbarSetting = (
    key: BooleanSettingKey,
    value: boolean,
  ) => {
    const v = vaultId();
    if (!v) return;
    setStatusbarConfig((prev) => ({ ...prev, [key]: value }));
    setSetting(v, key, value).catch((e) => {
      console.error(`saving ${key} failed`, e);
    });
  };
```

(`BooleanSettingKey` is already imported from `./settings/corePlugins` — confirm it is in the import list; it is used by `setCorePlugin`.)

- [ ] **Step 4: Seed config on vault open**

After the core-plugins seeding block (`App.tsx:1277`, right after `setCorePlugins(enab);`'s closing `}`), add:

```ts
      // Seed status-bar config (master + each segment). Absent ⇒ default (on).
      {
        const cfg: Record<string, boolean> = {};
        const keys: BooleanSettingKey[] = [
          STATUSBAR_ENABLED_KEY,
          ...STATUSBAR_SEGMENTS.map((s) => s.settingKey),
        ];
        for (const k of keys) {
          try {
            cfg[k] = (await getSetting(resp.vault_id, k)) ?? STATUSBAR_DEFAULT;
          } catch (e) {
            console.error(`loading ${k} failed`, e);
            cfg[k] = STATUSBAR_DEFAULT;
          }
        }
        setStatusbarConfig(cfg);
      }
```

- [ ] **Step 5: Verify it type-checks**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors. (`statusbarEnabled`, `segVisible`, `setStatusbarSetting`, `leadingSeparators` are defined but not yet used — that's fine, they're top-level `const`s, not locals, so no unused-var error. If the linter flags them, the next task consumes them.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(statusbar): seed + persist statusbar config in App"
```

---

## Task 4: App.tsx — rewrite the footer

**Files:**
- Modify: `ui/src/App.tsx:2291-2342` (the `<Show when={vaultId()}>` footer block)

- [ ] **Step 1: Replace the footer block**

Replace the entire block from `<Show when={vaultId()}>` (`App.tsx:2291`) through its matching `</Show>` (`App.tsx:2342`) with:

```tsx
      <Show when={vaultId() && statusbarEnabled()}>
        <footer class="statusbar">
          {/* left: vault dir + system status (alerts always render when active) */}
          {(() => {
            const vaultVis = () => segVisible(STATUSBAR_SEGMENTS[0]); // vault_path
            const scanVis = () => scanStatus() === "in_progress";
            const brokenVis = () => !!formatBrokenBlockRefs(brokenBlockRefs());
            const pendingVis = () => !!formatPendingRewrites(pendingRewritesCount());
            const sep = () =>
              leadingSeparators([
                vaultVis(),
                scanVis(),
                brokenVis(),
                pendingVis(),
              ]);
            return (
              <span class="statusbar__group statusbar__group--proj">
                <Show when={vaultVis()}>
                  <span class="statusbar__dir" title={vaultPath() ?? ""}>
                    {vaultPath() ?? vaultId()}
                  </span>
                </Show>
                <Show when={scanVis()}>
                  <Show when={sep()[1]}>
                    <span class="statusbar__sep">·</span>
                  </Show>
                  <span>
                    Scanning… {filesProcessed()} / {filesTotalEstimate()}
                  </span>
                </Show>
                <Show when={formatBrokenBlockRefs(brokenBlockRefs())}>
                  {(display) => (
                    <>
                      <Show when={sep()[2]}>
                        <span class="statusbar__sep">·</span>
                      </Show>
                      <span
                        title={display().title}
                        style={{ color: "var(--c-warning, var(--c-accent))" }}
                      >
                        {display().label}
                      </span>
                    </>
                  )}
                </Show>
                <Show when={sep()[3]}>
                  <span class="statusbar__sep">·</span>
                </Show>
                <PendingRewrites
                  vaultId={vaultId()}
                  count={pendingRewritesCount()}
                  onError={(m: string) => showToast(m)}
                />
              </span>
            );
          })()}

          {/* middle: current file info */}
          <Show when={view().kind === "file" && !!selectedPath()}>
            {(() => {
              const wordVis = () => segVisible(STATUSBAR_SEGMENTS[2]); // word_count
              const blockVis = () => segVisible(STATUSBAR_SEGMENTS[3]); // block_count
              const sep = () => leadingSeparators([wordVis(), blockVis()]);
              return (
                <span class="statusbar__group statusbar__mid">
                  <Show when={wordVis()}>
                    <b>{wordCount()}</b> words
                  </Show>
                  <Show when={blockVis()}>
                    <Show when={sep()[1]}>
                      <span class="statusbar__sep">·</span>
                    </Show>
                    <b>{blockCount()}</b> blocks
                  </Show>
                </span>
              );
            })()}
          </Show>

          {/* right: current file dir (vault-relative path) */}
          <span class="statusbar__group statusbar__group--file">
            <Show
              when={
                view().kind === "file" &&
                selectedPath() &&
                segVisible(STATUSBAR_SEGMENTS[1]) /* file_path */
              }
            >
              <span class="statusbar__dir" title={selectedPath() ?? ""}>
                {selectedPath()}
              </span>
            </Show>
          </span>
        </footer>
      </Show>
```

- [ ] **Step 2: Add the `formatPendingRewrites` import**

The footer now references `formatPendingRewrites` for the pending-visibility predicate. Confirm it is imported in `App.tsx`; if not, add alongside the other `./statusbar/...` imports:

```ts
import { formatPendingRewrites } from "./statusbar/pendingRewritesLabel";
```

(Run `grep -n "formatPendingRewrites" ui/src/App.tsx` — add the import only if it is not already present.)

- [ ] **Step 3: Verify type-check + build**

Run: `cd ui && npx tsc --noEmit && npx vite build`
Expected: no type errors; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(statusbar): per-item visibility + interleaved separators in footer"
```

---

## Task 5: App.tsx — "Status bar" Settings tab

**Files:**
- Modify: `ui/src/App.tsx:276` (`SettingsTab` type), `:1844-1853` (nav list), `:2157` area (tab body, after the Plugins `<Show>`)

- [ ] **Step 1: Extend the `SettingsTab` union**

At `App.tsx:276`, change:

```ts
  type SettingsTab = "appearance" | "editor" | "plugins" | "vault" | "shortcuts";
```

to:

```ts
  type SettingsTab =
    | "appearance"
    | "editor"
    | "plugins"
    | "statusbar"
    | "vault"
    | "shortcuts";
```

- [ ] **Step 2: Add the nav entry**

In the nav `For` list (`App.tsx:1847-1851`), add the Status bar entry after the Plugins entry:

```ts
                    { id: "plugins", label: "🧩 Plugins" },
                    { id: "statusbar", label: "📊 Status bar" },
                    { id: "vault", label: "🗄 Vault" },
```

- [ ] **Step 3: Add the tab body**

Immediately after the Plugins tab's closing `</Show>` (`App.tsx:2157`) and before `<Show when={settingsTab() === "vault"}>`, insert:

```tsx
              <Show when={settingsTab() === "statusbar"}>
                <h2 class="modal__h2">Status bar</h2>
                <div class="set-row">
                  <div>
                    <div class="set-row__lab">Show status bar</div>
                    <div class="set-row__desc">
                      The bar along the bottom. When off, it disappears entirely.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": !statusbarEnabled(),
                      }}
                      onClick={() =>
                        setStatusbarSetting(STATUSBAR_ENABLED_KEY, false)
                      }
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": statusbarEnabled(),
                      }}
                      onClick={() =>
                        setStatusbarSetting(STATUSBAR_ENABLED_KEY, true)
                      }
                    >
                      On
                    </button>
                  </div>
                </div>
                <For each={STATUSBAR_SEGMENTS}>
                  {(seg) => {
                    const on = () => segVisible(seg);
                    return (
                      <div
                        class="set-row"
                        style={{
                          opacity: statusbarEnabled() ? 1 : 0.5,
                          "pointer-events": statusbarEnabled() ? "auto" : "none",
                        }}
                      >
                        <div>
                          <div class="set-row__lab">{seg.name}</div>
                          <div class="set-row__desc">{seg.description}</div>
                        </div>
                        <div class="seg-control">
                          <button
                            type="button"
                            class="seg-control__btn"
                            classList={{ "seg-control__btn--active": !on() }}
                            onClick={() =>
                              setStatusbarSetting(seg.settingKey, false)
                            }
                          >
                            Off
                          </button>
                          <button
                            type="button"
                            class="seg-control__btn"
                            classList={{ "seg-control__btn--active": on() }}
                            onClick={() =>
                              setStatusbarSetting(seg.settingKey, true)
                            }
                          >
                            On
                          </button>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </Show>
```

- [ ] **Step 4: Verify type-check + build**

Run: `cd ui && npx tsc --noEmit && npx vite build`
Expected: no type errors; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(statusbar): add Status bar settings tab"
```

---

## Task 6: Omnibar command-kind — ranker + registry

**Files:**
- Modify: `ui/src/omnibar/ranker.ts:2-4` (union), `:153-160` (tie-break)
- Modify: `ui/src/omnibar/ranker.test.ts`
- Create: `ui/src/omnibar/commands.ts`
- Create: `ui/src/omnibar/commands.test.ts`

- [ ] **Step 1: Write the failing ranker test**

Add to `ui/src/omnibar/ranker.test.ts` (inside the existing top-level `describe`, or as a new one):

```ts
import { rankItems, type OmniItem } from "./ranker";

describe("command-kind ranking", () => {
  it("ranks note < tag < command when score and length tie", () => {
    // All three share the same matchable text so score/length tie and the
    // kind tie-break decides order.
    const items: OmniItem[] = [
      { kind: "command", id: "x.toggle", title: "abc" },
      { kind: "tag", tag: "abc" },
      { kind: "note", title: "abc", path: "abc.md" },
    ];
    const ranked = rankItems("abc", items, 10);
    expect(ranked.map((r) => r.item.kind)).toEqual(["note", "tag", "command"]);
  });

  it("matches commands by their title", () => {
    const items: OmniItem[] = [
      { kind: "command", id: "statusbar.toggle", title: "Toggle status bar" },
    ];
    const ranked = rankItems("toggle", items, 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].item.kind).toBe("command");
  });
});
```

(If `ranker.test.ts` already imports `rankItems`/`OmniItem`, don't duplicate the import — add only the `describe` blocks.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ui && npx vitest run src/omnibar/ranker.test.ts`
Expected: FAIL — `kind: "command"` is not assignable to `OmniItem` (type error / compile failure).

- [ ] **Step 3: Extend the union and tie-break in `ranker.ts`**

Change the `OmniItem` union (`ranker.ts:2-4`) to:

```ts
export type OmniItem =
  | { kind: "note"; title: string; path: string }
  | { kind: "tag"; tag: string }
  | { kind: "command"; id: string; title: string };
```

Update `matchText` (`ranker.ts:7-9`) to:

```ts
export function matchText(item: OmniItem): string {
  if (item.kind === "note") return item.title;
  if (item.kind === "tag") return item.tag;
  return item.title;
}
```

Add a kind-rank helper above `rankItems` (near `ranker.ts:110`):

```ts
/** Stable kind ordering for tie-breaks: note < tag < command. */
function kindRank(item: OmniItem): number {
  return item.kind === "note" ? 0 : item.kind === "tag" ? 1 : 2;
}
```

Replace the kind tie-break line (`ranker.ts:158`):

```ts
    if (a.item.kind !== b.item.kind) return a.item.kind === "note" ? -1 : 1;
```

with:

```ts
    const ar = kindRank(a.item);
    const br = kindRank(b.item);
    if (ar !== br) return ar - br;
```

Also update the doc comment on `rankItems` (`ranker.ts:112-113`) from "note before tag" to "note before tag before command".

- [ ] **Step 4: Run the ranker test to verify it passes**

Run: `cd ui && npx vitest run src/omnibar/ranker.test.ts`
Expected: PASS (existing tests + the 2 new ones).

- [ ] **Step 5: Write the failing commands test**

Create `ui/src/omnibar/commands.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OMNI_COMMANDS } from "./commands";

describe("omni commands registry", () => {
  it("includes the status-bar toggle", () => {
    expect(OMNI_COMMANDS.some((c) => c.id === "statusbar.toggle")).toBe(true);
  });

  it("every command id and title is unique and non-empty", () => {
    expect(OMNI_COMMANDS.length).toBeGreaterThan(0);
    for (const c of OMNI_COMMANDS) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
    expect(new Set(OMNI_COMMANDS.map((c) => c.id)).size).toBe(
      OMNI_COMMANDS.length,
    );
    expect(new Set(OMNI_COMMANDS.map((c) => c.title)).size).toBe(
      OMNI_COMMANDS.length,
    );
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd ui && npx vitest run src/omnibar/commands.test.ts`
Expected: FAIL — cannot resolve `./commands`.

- [ ] **Step 7: Implement `commands.ts`**

Create `ui/src/omnibar/commands.ts`:

```ts
/**
 * Omni-bar command registry — pure data. Each command has a stable `id` (the
 * dispatch key, handled in App) and a searchable `title`. App maps `id` →
 * effect; descriptors hold no app state.
 */
export interface OmniCommand {
  id: string;
  title: string;
}

export const OMNI_COMMANDS: OmniCommand[] = [
  { id: "statusbar.toggle", title: "Toggle status bar" },
];
```

- [ ] **Step 8: Run both omnibar tests to verify they pass**

Run: `cd ui && npx vitest run src/omnibar/`
Expected: PASS (ranker + commands).

- [ ] **Step 9: Commit**

```bash
git add ui/src/omnibar/ranker.ts ui/src/omnibar/ranker.test.ts ui/src/omnibar/commands.ts ui/src/omnibar/commands.test.ts
git commit -m "feat(omnibar): add command-kind to ranker + command registry"
```

---

## Task 7: OmniBar.tsx — render + activate command kind

**Files:**
- Modify: `ui/src/omnibar/OmniBar.tsx:22-31` (props), `:69-74` (activate), `:230` (badge)

- [ ] **Step 1: Add the `onRunCommand` prop**

In `OmniBarProps` (`OmniBar.tsx:22-31`), add after `onOpenTag`:

```ts
  onRunCommand: (id: string) => void;
```

- [ ] **Step 2: Handle the command kind in `activate`**

Replace the body of `activate` (`OmniBar.tsx:69-74`):

```ts
  const activate = (r: RankedItem | undefined) => {
    if (!r) return;
    if (r.item.kind === "note") props.onOpenNote(r.item.path);
    else if (r.item.kind === "tag") props.onOpenTag(r.item.tag);
    else props.onRunCommand(r.item.id);
    props.onClose();
  };
```

- [ ] **Step 3: Add a command badge**

Replace the badge expression (`OmniBar.tsx:230`):

```tsx
        {props.ranked.item.kind === "tag" ? "#" : "◧"}
```

with:

```tsx
        {props.ranked.item.kind === "tag"
          ? "#"
          : props.ranked.item.kind === "command"
            ? "⚡"
            : "◧"}
```

(The subtitle `<Show when={props.ranked.item.kind === "note"}>` stays as-is — commands have no subtitle.)

- [ ] **Step 4: Verify type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: ONE error in `App.tsx` — `<OmniBar>` is missing the required `onRunCommand` prop. That's expected; Task 8 wires it. (If you want a clean checkpoint, proceed straight to Task 8 before committing.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/omnibar/OmniBar.tsx
git commit -m "feat(omnibar): render + activate command items"
```

---

## Task 8: App.tsx — wire omnibar commands

**Files:**
- Modify: `ui/src/App.tsx:78` (import), `:339-345` (`omniItems` memo), setter region (~line 770), `:1816-1822` (`<OmniBar>` props)

- [ ] **Step 1: Import the registry**

Near the omnibar import (`App.tsx:77-78`), add:

```ts
import { OMNI_COMMANDS } from "./omnibar/commands";
```

- [ ] **Step 2: Append commands to `omniItems`**

Replace the `omniItems` memo (`App.tsx:339-345`):

```ts
  const omniItems = createMemo<OmniItem[]>(() => {
    const notes: OmniItem[] = files()
      .filter((f) => f.type_id === "markdown")
      .map((f) => ({ kind: "note", title: fileStem(f.path), path: f.path }));
    const tags: OmniItem[] = vaultTags().map((t) => ({ kind: "tag", tag: t }));
    const commands: OmniItem[] = OMNI_COMMANDS.map((c) => ({
      kind: "command",
      id: c.id,
      title: c.title,
    }));
    return [...notes, ...tags, ...commands];
  });
```

- [ ] **Step 3: Add the command dispatcher**

After `setStatusbarSetting` (added in Task 3, near line 770), add:

```ts
  /** Run an omni-bar command by id. */
  const handleRunCommand = (id: string) => {
    if (id === "statusbar.toggle") {
      setStatusbarSetting(STATUSBAR_ENABLED_KEY, !statusbarEnabled());
    }
  };
```

- [ ] **Step 4: Pass the prop to `<OmniBar>`**

In the `<OmniBar>` element (`App.tsx:1816-1822`), add after `onOpenTag`:

```tsx
        onRunCommand={handleRunCommand}
```

- [ ] **Step 5: Verify type-check + build**

Run: `cd ui && npx tsc --noEmit && npx vite build`
Expected: no errors; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(omnibar): wire status-bar toggle command in App"
```

---

## Task 9: Full gate + docs + manual smoke

**Files:**
- Modify: `CLAUDE.md` (Project state block), `docs/build-order.md` if it tracks this surface

- [ ] **Step 1: Run the full gate**

Run: `bash scripts/check.sh`
Expected: cargo fmt/clippy/test, tsc, vitest, build, and docs check all pass. The new vitest count should be the prior 500 + new tests (segments 5, separators 4, ranker 2, commands 2 ≈ +13).

- [ ] **Step 2: Manual smoke (interactive — `cargo tauri dev`)**

Open a vault and verify:
1. Status bar shows as before (all segments on by default).
2. Settings ▸ Status bar: toggle Vault path off → it disappears, no dangling `·`.
3. Toggle Word count off, Block count on → middle shows "N blocks" with no leading `·`.
4. Master Off → the whole footer disappears (not an empty strip); the segment rows dim/disable.
5. Reopen the vault → choices persist (durable in `.cubical/config.toml`).
6. Cmd/Ctrl+K → type "toggle" → "⚡ Toggle status bar" appears → Enter flips the bar.

Record the result honestly in the closeout; if `cargo tauri dev` can't run in this environment, report that the automated gate passed and the manual steps are pending an operator smoke (consistent with the existing `l4` close-tag protocol).

- [ ] **Step 3: Update the Project state block in CLAUDE.md**

Rewrite the `## Project state` "Now" block to reflect the configurable status bar landing (branch, what shipped, test counts). Keep it terse per the session protocol.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/build-order.md
git commit -m "docs: record configurable status bar in project state"
```

---

## Notes for the implementer

- **DRY:** the On/Off segmented-control markup is intentionally repeated from the Plugins tab rather than extracted — matches the existing house style (each tab inlines its own `seg-control`). Don't refactor the Plugins tab as part of this work.
- **No Rust changes:** `crates/cubical-core/src/vault/settings.rs` is schemaless; durable `statusbar.*` keys route to `config.toml` automatically via `is_workspace_key` (non-`ui.` ⇒ durable). Do not add validation there.
- **Defaults uniformly `true`:** every `statusbar.*` boolean defaults on, so the seeding fallback is a flat `?? STATUSBAR_DEFAULT`.
- **Indices into `STATUSBAR_SEGMENTS`** in the footer (`[0]` vault_path, `[1]` file_path, `[2]` word_count, `[3]` block_count) match the array order defined in `segments.ts` Task 1 — keep them in sync if you reorder.
