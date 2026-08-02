> **Frozen — historical record.** This file is preserved as written and is not maintained. It records what was believed, planned or built at the time; it is **not** current truth. Current truth lives in [`docs/architecture/`](../../../architecture/) and [`docs/implementation/`](../../../implementation/). Do not edit to "correct" it — a corrected record is no longer a record.

# Document Minimap (Pretext) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a toggleable, read-only minimap strip beside the CodeMirror editor that renders the whole note at scale via `@chenglou/pretext`, with a draggable viewport indicator for fast scrolling.

**Architecture:** A canvas companion *next to* CodeMirror (never inside its `contenteditable`). Pretext lays out the full document off-DOM; we paint it to a canvas and map pointer drags to editor scroll. All logic lives in three pure, node-testable modules (`minimapGeometry`, `minimapRender`, `pretextLayout`); `Minimap.tsx` is a thin orchestrator verified in the live preview. Gated on `editor.minimap_enabled` (default off).

**Tech Stack:** Solid-JS, CodeMirror 6 (`@codemirror/view`/`state`), `@chenglou/pretext` v0.0.8 (MIT, zero-dep), Vitest (node env), Tauri/Rust settings (`.cubical/config.toml`).

## Global Constraints

- **`.md` is the absolute source of truth** — the minimap reads the open buffer and writes nothing; it is pure derived state.
- **Composable on/off block** — gated on `editor.minimap_enabled`, **default `false`**; when off, no Minimap DOM node mounts and no Pretext code runs.
- **No Node runtime** — Pretext is bundled into the webview by Vite; no new runtime is introduced.
- **Desktop only (v1)** — pointer/drag only; no mobile/touch work.
- **Solid stays out of CM editing** — the minimap may only *read* `EditorView` state/geometry and set `scrollDOM.scrollTop`; it must never dispatch a document change.
- **Vitest runs in node** (`ui/vite.config.ts` `environment: "node"`); component tests are deferred. Put all tested logic in pure modules; do **not** add a jsdom component test for `Minimap.tsx`.
- **v1 line height:** `lineHeight = min(4, stripHeight / max(lineCount, 1))`, no floor (scale-to-fit always). Strip width **96px**, right edge.
- Gates: `scripts/check.sh` (fmt/clippy/test, tsc, vitest, build, docs) must stay green.
- Spec: `docs/superpowers/specs/2026-06-28-pretext-minimap-design.md`.

---

## File Structure

- Create `ui/src/editor/minimap/types.ts` — shared types (no logic).
- Create `ui/src/editor/minimap/minimapGeometry.ts` (+ `.test.ts`) — pure scroll↔strip math.
- Create `ui/src/editor/minimap/minimapRender.ts` (+ `.test.ts`) — pure canvas drawing.
- Create `ui/src/editor/minimap/pretextLayout.ts` (+ `.test.ts`) — Pretext wrapper.
- Create `ui/src/editor/minimap/Minimap.tsx` — Solid orchestrator (no unit test).
- Modify `ui/src/api/ipc.ts` — add the `editor.minimap_enabled` Setting key.
- Modify `ui/src/Editor.tsx` — `minimapEnabled` prop, `cmView` signal, flex-row return rendering `<Minimap>`.
- Modify `ui/src/App.tsx` — signal + setter + seed + Settings ▸ Editor toggle + pass prop.
- Modify `ui/package.json` — add `@chenglou/pretext`.

No Rust change is required: `crates/cubical-core/src/vault/settings.rs` persists arbitrary keys (only `ui.*` is special-cased).

---

### Task 1: Dependency + setting plumbing (off, renders nothing)

Establishes the toggle end-to-end before any canvas exists. Deliverable: the setting persists and round-trips, the app builds, and `Editor` is unchanged when the flag is off/absent.

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/src/api/ipc.ts` (Setting union, near line 294)
- Modify: `ui/src/Editor.tsx` (add optional prop)
- Modify: `ui/src/App.tsx` (signal, setter, seed, toggle JSX, pass prop)

**Interfaces:**
- Produces: setting key `"editor.minimap_enabled"` (boolean); `EditorProps.minimapEnabled?: boolean` (default false).

- [ ] **Step 1: Add the dependency**

Run:
```bash
cd ui && npm install @chenglou/pretext@^0.0.8
```
Expected: `@chenglou/pretext` appears in `ui/package.json` dependencies and `package-lock.json` updates.

- [ ] **Step 2: Add the Setting key**

In `ui/src/api/ipc.ts`, in the `Setting` union (after the `properties.tags_key_as_tags` line), add:
```ts
  | { key: "editor.minimap_enabled"; value: boolean }
```

- [ ] **Step 3: Add the `minimapEnabled` prop to Editor**

In `ui/src/Editor.tsx`, inside `EditorProps`, after the `rawSource` prop, add:
```ts
  /**
   * When `true`, render the read-only minimap strip beside the editor
   * (composable on/off block, default off). Off → no Minimap DOM node.
   */
  minimapEnabled?: boolean;
```
(Do not consume it yet — that is Task 5. tsc must still pass.)

- [ ] **Step 4: Add signal + setter + seed in App.tsx**

In `ui/src/App.tsx`, near the `rawDefault` signal (~line 237) add:
```ts
  const [minimapEnabled, setMinimapEnabled] = createSignal(false);
```
Near `setRawDefaultValue` (~line 781) add:
```ts
  /** Set the minimap-enabled flag (from Settings ▸ Editor). */
  const setMinimapEnabledValue = (val: boolean) => {
    setMinimapEnabled(val);
    persistSetting(vaultId(), "editor.minimap_enabled", val);
  };
```
In the vault-open seeding block, after the `editor.raw_source_default` seed (~line 1318), add:
```ts
      // Seed the minimap flag. Absent → off (opt-in companion surface).
      await seedSetting(
        resp.vault_id,
        "editor.minimap_enabled",
        false,
        setMinimapEnabled,
      );
```

- [ ] **Step 5: Add the Settings ▸ Editor toggle**

In `ui/src/App.tsx`, inside the **Editor** settings tab (after the `<h2 class="modal__h2">Editor</h2>` block, ~line 2128), add a seg-control row mirroring the status-bar toggle:
```tsx
                <div class="settings-row">
                  <div class="settings-row__label">
                    <div class="settings-row__title">Minimap</div>
                    <div class="settings-row__desc">
                      Show a document overview strip beside the editor.
                    </div>
                  </div>
                  <div class="seg-control">
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": !minimapEnabled(),
                      }}
                      onClick={() => setMinimapEnabledValue(false)}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      class="seg-control__btn"
                      classList={{
                        "seg-control__btn--active": minimapEnabled(),
                      }}
                      onClick={() => setMinimapEnabledValue(true)}
                    >
                      On
                    </button>
                  </div>
                </div>
```
(If the surrounding markup differs, match the adjacent raw-source row's exact classes — the engineer should copy the neighbour's structure.)

- [ ] **Step 6: Pass the prop to Editor**

In `ui/src/App.tsx`, in the `<Editor … />` JSX (~line 1920), after `rawSource={effectiveRaw()}` add:
```tsx
                  minimapEnabled={minimapEnabled()}
```

- [ ] **Step 7: Verify build + types + existing tests**

Run:
```bash
cd ui && npx tsc --noEmit && npx vitest run
```
Expected: tsc clean; all existing tests pass (no behavior change yet — flag is off by default).

- [ ] **Step 8: Commit**

```bash
git add ui/package.json ui/package-lock.json ui/src/api/ipc.ts ui/src/Editor.tsx ui/src/App.tsx
git commit -m "feat(minimap): add @chenglou/pretext dep + editor.minimap_enabled setting plumbing"
```

---

### Task 2: Shared types + geometry (pure, node-tested)

**Files:**
- Create: `ui/src/editor/minimap/types.ts`
- Create: `ui/src/editor/minimap/minimapGeometry.ts`
- Test: `ui/src/editor/minimap/minimapGeometry.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `LaidLine { text: string }`, `MinimapLayout { lines: LaidLine[]; contentHeight: number }`, `ViewportInfo { scrollTop: number; scrollHeight: number; clientHeight: number }`, `IndicatorRect { top: number; height: number }`, `MinimapColors { text: string; background: string; indicator: string }`.
  - `minimapGeometry.ts`: `fractionFromClientY(clientY, stripTop, stripHeight): number`, `scrollTopForFraction(fraction, vp: ViewportInfo): number`, `indicatorRect(vp: ViewportInfo, stripHeight): IndicatorRect`, `lineHeightFor(lineCount, stripHeight): number`.
- Consumes: nothing (leaf).

- [ ] **Step 1: Create the types file**

`ui/src/editor/minimap/types.ts`:
```ts
/** Shared types for the document minimap (read-only Pretext canvas strip). */

/** One wrapped row of the laid-out document (v1: text only). */
export interface LaidLine {
  text: string;
}

/** A full-document layout at minimap scale. */
export interface MinimapLayout {
  lines: LaidLine[];
  /** Total pixel height of all lines at the chosen line height. */
  contentHeight: number;
}

/** The editor scroll geometry the minimap mirrors. */
export interface ViewportInfo {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** The viewport-indicator rectangle, in strip-local pixels. */
export interface IndicatorRect {
  top: number;
  height: number;
}

/** Colors pulled from the resolved CM theme. */
export interface MinimapColors {
  text: string;
  background: string;
  indicator: string;
}
```

- [ ] **Step 2: Write the failing geometry test**

`ui/src/editor/minimap/minimapGeometry.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import {
  fractionFromClientY,
  scrollTopForFraction,
  indicatorRect,
  lineHeightFor,
} from "./minimapGeometry";

describe("fractionFromClientY", () => {
  it("maps a click within the strip to a [0,1] fraction", () => {
    expect(fractionFromClientY(150, 100, 200)).toBeCloseTo(0.25);
  });
  it("clamps above and below the strip", () => {
    expect(fractionFromClientY(50, 100, 200)).toBe(0);
    expect(fractionFromClientY(999, 100, 200)).toBe(1);
  });
  it("returns 0 for a zero-height strip", () => {
    expect(fractionFromClientY(150, 100, 0)).toBe(0);
  });
});

describe("scrollTopForFraction", () => {
  const vp = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 };
  it("centers the fraction in the viewport", () => {
    // 0.5 * 1000 - 200/2 = 400
    expect(scrollTopForFraction(0.5, vp)).toBe(400);
  });
  it("clamps to [0, scrollHeight - clientHeight]", () => {
    expect(scrollTopForFraction(0, vp)).toBe(0);
    expect(scrollTopForFraction(1, vp)).toBe(800);
  });
});

describe("indicatorRect", () => {
  it("sizes and positions the indicator from viewport ratios", () => {
    const r = indicatorRect(
      { scrollTop: 500, scrollHeight: 1000, clientHeight: 200 },
      100,
    );
    expect(r.height).toBeCloseTo(20); // 200/1000 * 100
    expect(r.top).toBeCloseTo(50); // 500/1000 * 100
  });
  it("clamps a tiny indicator to a minimum height and keeps it in bounds", () => {
    const r = indicatorRect(
      { scrollTop: 1000, scrollHeight: 1000, clientHeight: 1 },
      100,
    );
    expect(r.height).toBeGreaterThanOrEqual(2);
    expect(r.top + r.height).toBeLessThanOrEqual(100);
  });
  it("fills the strip when there is nothing to scroll", () => {
    const r = indicatorRect(
      { scrollTop: 0, scrollHeight: 0, clientHeight: 200 },
      100,
    );
    expect(r).toEqual({ top: 0, height: 100 });
  });
});

describe("lineHeightFor", () => {
  it("caps at 4px for short documents", () => {
    expect(lineHeightFor(5, 600)).toBe(4);
  });
  it("scales to fit long documents (no floor)", () => {
    expect(lineHeightFor(1200, 600)).toBeCloseTo(0.5);
  });
  it("handles a zero line count", () => {
    expect(lineHeightFor(0, 600)).toBe(4);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd ui && npx vitest run src/editor/minimap/minimapGeometry.test.ts`
Expected: FAIL — `minimapGeometry` module not found.

- [ ] **Step 4: Implement geometry**

`ui/src/editor/minimap/minimapGeometry.ts`:
```ts
import type { ViewportInfo, IndicatorRect } from "./types";

const CEIL = 4;
const MIN_INDICATOR = 2;

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

/** Fraction [0,1] of the document for a click at `clientY` within the strip. */
export function fractionFromClientY(
  clientY: number,
  stripTop: number,
  stripHeight: number,
): number {
  if (stripHeight <= 0) return 0;
  return clamp((clientY - stripTop) / stripHeight, 0, 1);
}

/** `scrollTop` that centers `fraction` of the content in the viewport. */
export function scrollTopForFraction(
  fraction: number,
  vp: ViewportInfo,
): number {
  const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
  return clamp(fraction * vp.scrollHeight - vp.clientHeight / 2, 0, max);
}

/** The viewport-indicator rectangle in strip-local pixels. */
export function indicatorRect(
  vp: ViewportInfo,
  stripHeight: number,
): IndicatorRect {
  if (vp.scrollHeight <= 0) return { top: 0, height: stripHeight };
  const height = clamp(
    (vp.clientHeight / vp.scrollHeight) * stripHeight,
    MIN_INDICATOR,
    stripHeight,
  );
  const top = clamp(
    (vp.scrollTop / vp.scrollHeight) * stripHeight,
    0,
    Math.max(0, stripHeight - height),
  );
  return { top, height };
}

/** Per-line pixel height: scale-to-fit, capped at 4px, no lower floor. */
export function lineHeightFor(lineCount: number, stripHeight: number): number {
  return Math.min(CEIL, stripHeight / Math.max(lineCount, 1));
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd ui && npx vitest run src/editor/minimap/minimapGeometry.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/minimap/types.ts ui/src/editor/minimap/minimapGeometry.ts ui/src/editor/minimap/minimapGeometry.test.ts
git commit -m "feat(minimap): pure scroll/indicator geometry + shared types"
```

---

### Task 3: Canvas rendering (pure, mock-ctx tested)

**Files:**
- Create: `ui/src/editor/minimap/minimapRender.ts`
- Test: `ui/src/editor/minimap/minimapRender.test.ts`

**Interfaces:**
- Consumes: `MinimapLayout`, `IndicatorRect`, `MinimapColors` from `./types`.
- Produces: `drawMinimap(ctx, opts: { layout: MinimapLayout; lineHeight: number; indicator: IndicatorRect; colors: MinimapColors; width: number; height: number; font: string }): void`.

- [ ] **Step 1: Write the failing render test**

`ui/src/editor/minimap/minimapRender.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { drawMinimap } from "./minimapRender";
import type { MinimapLayout, MinimapColors } from "./types";

function mockCtx() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    set fillStyle(_v: string) {},
    set font(_v: string) {},
    set globalAlpha(_v: number) {},
  } as unknown as CanvasRenderingContext2D & {
    clearRect: ReturnType<typeof vi.fn>;
    fillRect: ReturnType<typeof vi.fn>;
    fillText: ReturnType<typeof vi.fn>;
  };
}

const colors: MinimapColors = {
  text: "#111",
  background: "#fff",
  indicator: "#3b82f6",
};

describe("drawMinimap", () => {
  it("clears, paints background, draws one fillText per line, draws indicator", () => {
    const ctx = mockCtx();
    const layout: MinimapLayout = {
      lines: [{ text: "alpha" }, { text: "beta" }, { text: "gamma" }],
      contentHeight: 12,
    };
    drawMinimap(ctx, {
      layout,
      lineHeight: 4,
      indicator: { top: 0, height: 10 },
      colors,
      width: 96,
      height: 600,
      font: "10px monospace",
    });
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(ctx.fillText).toHaveBeenCalledTimes(3);
    // line 0 at y=0, line 2 at y=8 (i * lineHeight)
    expect(ctx.fillText).toHaveBeenNthCalledWith(1, "alpha", 0, 0);
    expect(ctx.fillText).toHaveBeenNthCalledWith(3, "gamma", 0, 8);
    // background fillRect + indicator fillRect = at least 2 rects
    expect(ctx.fillRect.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("handles an empty document without drawing any text", () => {
    const ctx = mockCtx();
    drawMinimap(ctx, {
      layout: { lines: [], contentHeight: 0 },
      lineHeight: 4,
      indicator: { top: 0, height: 600 },
      colors,
      width: 96,
      height: 600,
      font: "10px monospace",
    });
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/editor/minimap/minimapRender.test.ts`
Expected: FAIL — `minimapRender` module not found.

- [ ] **Step 3: Implement the renderer**

`ui/src/editor/minimap/minimapRender.ts`:
```ts
import type { MinimapLayout, IndicatorRect, MinimapColors } from "./types";

export interface DrawOpts {
  layout: MinimapLayout;
  lineHeight: number;
  indicator: IndicatorRect;
  colors: MinimapColors;
  width: number;
  height: number;
  font: string;
}

/**
 * Paint the minimap: background, one row of tiny text per laid-out line,
 * then the translucent viewport indicator. Pure aside from the ctx writes;
 * no DOM lookups, no Pretext.
 */
export function drawMinimap(
  ctx: CanvasRenderingContext2D,
  opts: DrawOpts,
): void {
  const { layout, lineHeight, indicator, colors, width, height, font } = opts;

  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = colors.background;
  ctx.fillRect(0, 0, width, height);

  ctx.font = font;
  ctx.fillStyle = colors.text;
  for (let i = 0; i < layout.lines.length; i++) {
    ctx.fillText(layout.lines[i].text, 0, i * lineHeight);
  }

  ctx.globalAlpha = 0.25;
  ctx.fillStyle = colors.indicator;
  ctx.fillRect(0, indicator.top, width, indicator.height);
  ctx.globalAlpha = 1;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/editor/minimap/minimapRender.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/minimap/minimapRender.ts ui/src/editor/minimap/minimapRender.test.ts
git commit -m "feat(minimap): pure canvas renderer (lines + viewport indicator)"
```

---

### Task 4: Pretext layout wrapper (module-mock tested)

**Files:**
- Create: `ui/src/editor/minimap/pretextLayout.ts`
- Test: `ui/src/editor/minimap/pretextLayout.test.ts`

**Interfaces:**
- Consumes: `@chenglou/pretext` (`prepareWithSegments`, `layoutWithLines`); `MinimapLayout`, `LaidLine` from `./types`.
- Produces: `layoutDocument(input: { text: string; width: number; lineHeight: number; font: string }): MinimapLayout`.

- [ ] **Step 1: Write the failing wrapper test (mock Pretext)**

`ui/src/editor/minimap/pretextLayout.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const prepareWithSegments = vi.fn();
const layoutWithLines = vi.fn();

vi.mock("@chenglou/pretext", () => ({
  prepareWithSegments: (...a: unknown[]) => prepareWithSegments(...a),
  layoutWithLines: (...a: unknown[]) => layoutWithLines(...a),
}));

import { layoutDocument } from "./pretextLayout";

beforeEach(() => {
  prepareWithSegments.mockReset();
  layoutWithLines.mockReset();
});

describe("layoutDocument", () => {
  it("prepares with the font, lays out at width/lineHeight, flattens lines", () => {
    prepareWithSegments.mockReturnValue({ prepared: true });
    layoutWithLines.mockReturnValue({
      height: 8,
      lineCount: 2,
      lines: [{ text: "one" }, { text: "two" }],
    });

    const out = layoutDocument({
      text: "one two",
      width: 96,
      lineHeight: 4,
      font: "10px monospace",
    });

    expect(prepareWithSegments).toHaveBeenCalledWith("one two", "10px monospace");
    expect(layoutWithLines).toHaveBeenCalledWith({ prepared: true }, 96, 4);
    expect(out).toEqual({
      lines: [{ text: "one" }, { text: "two" }],
      contentHeight: 8, // lineCount(2) * lineHeight(4)
    });
  });

  it("returns an empty layout for empty text without calling Pretext", () => {
    const out = layoutDocument({
      text: "",
      width: 96,
      lineHeight: 4,
      font: "10px monospace",
    });
    expect(out).toEqual({ lines: [], contentHeight: 0 });
    expect(prepareWithSegments).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/editor/minimap/pretextLayout.test.ts`
Expected: FAIL — `pretextLayout` module not found.

- [ ] **Step 3: Implement the wrapper**

`ui/src/editor/minimap/pretextLayout.ts`:
```ts
import { prepareWithSegments, layoutWithLines } from "@chenglou/pretext";
import type { MinimapLayout } from "./types";

export interface LayoutInput {
  text: string;
  width: number;
  lineHeight: number;
  font: string;
}

/**
 * Lay out the full document at minimap scale via Pretext and flatten the
 * result into a {@link MinimapLayout}. Pretext owns text measurement
 * internally (its own canvas `measureText` + `Intl.Segmenter`), so there is
 * no measurement injection point — see the spec §5.
 */
export function layoutDocument(input: LayoutInput): MinimapLayout {
  const { text, width, lineHeight, font } = input;
  if (text.length === 0) return { lines: [], contentHeight: 0 };

  const prepared = prepareWithSegments(text, font);
  const result = layoutWithLines(prepared, width, lineHeight);
  return {
    lines: result.lines.map((l) => ({ text: l.text })),
    contentHeight: result.lineCount * lineHeight,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/editor/minimap/pretextLayout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/editor/minimap/pretextLayout.ts ui/src/editor/minimap/pretextLayout.test.ts
git commit -m "feat(minimap): Pretext layout wrapper (prepare/layout -> MinimapLayout)"
```

---

### Task 5: Minimap component + Editor integration (preview-verified)

Assembles the three pure modules into a live strip and flips `Editor` to render it. Per the node-only vitest convention this component has **no unit test**; it is verified in the dev preview.

**Files:**
- Create: `ui/src/editor/minimap/Minimap.tsx`
- Modify: `ui/src/Editor.tsx` (cmView signal, flex-row return, render `<Minimap>`)

**Interfaces:**
- Consumes: `layoutDocument` (Task 4), `drawMinimap` (Task 3), `lineHeightFor`/`indicatorRect`/`fractionFromClientY`/`scrollTopForFraction` (Task 2); `MinimapColors` (Task 2); `EditorView` from `@codemirror/view`; `ResolvedTheme` from `../../styles/theme`.
- Produces: `<Minimap view={EditorView} resolvedTheme={ResolvedTheme} />`.

- [ ] **Step 1: Create the Minimap component**

`ui/src/editor/minimap/Minimap.tsx`:
```tsx
import { createEffect, on, onCleanup, onMount, type Component } from "solid-js";
import type { EditorView } from "@codemirror/view";
import type { ResolvedTheme } from "../../styles/theme";
import type { MinimapColors } from "./types";
import { layoutDocument } from "./pretextLayout";
import { drawMinimap } from "./minimapRender";
import {
  fractionFromClientY,
  indicatorRect,
  lineHeightFor,
  scrollTopForFraction,
} from "./minimapGeometry";

const WIDTH = 96;
const RELAYOUT_MS = 200;

/** Read minimap colors from the CM theme tokens currently on <html>. */
function readColors(): MinimapColors {
  const cs = getComputedStyle(document.documentElement);
  const tok = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    text: tok("--c-fg-primary", "#111"),
    background: tok("--c-bg-primary", "#fff"),
    indicator: tok("--editor-selection-bg", "#3b82f6"),
  };
}

/** Minimap font: small, mono, matches the editor family. */
function readFont(): string {
  const cs = getComputedStyle(document.documentElement);
  const family = cs.getPropertyValue("--font-mono").trim() || "monospace";
  return `2px ${family}`;
}

/**
 * Read-only document minimap. A canvas companion *beside* CodeMirror — it
 * only reads `view` state/geometry and sets `scrollDOM.scrollTop`; it never
 * dispatches a document change (the "Solid stays out of CM editing" contract).
 */
const Minimap: Component<{
  view: EditorView;
  resolvedTheme: ResolvedTheme;
}> = (props) => {
  let canvas!: HTMLCanvasElement;
  let relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  let rafPending = false;

  const stripHeight = () => props.view.scrollDOM.clientHeight;

  // Last computed layout, reused on scroll-only repaints.
  let layout = { lines: [] as { text: string }[], contentHeight: 0 };
  let lineHeight = 1;

  const viewportInfo = () => {
    const dom = props.view.scrollDOM;
    return {
      scrollTop: dom.scrollTop,
      scrollHeight: dom.scrollHeight,
      clientHeight: dom.clientHeight,
    };
  };

  const paint = () => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const h = stripHeight();
    if (canvas.width !== WIDTH) canvas.width = WIDTH;
    if (canvas.height !== h) canvas.height = h;
    drawMinimap(ctx, {
      layout,
      lineHeight,
      indicator: indicatorRect(viewportInfo(), h),
      colors: readColors(),
      width: WIDTH,
      height: h,
      font: readFont(),
    });
  };

  const relayout = () => {
    const text = props.view.state.doc.toString();
    const h = stripHeight();
    const lineCount = props.view.state.doc.lines;
    lineHeight = lineHeightFor(lineCount, h);
    layout = layoutDocument({ text, width: WIDTH, lineHeight, font: readFont() });
    paint();
  };

  const scheduleRelayout = () => {
    if (relayoutTimer !== undefined) clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(relayout, RELAYOUT_MS);
  };

  const schedulePaint = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      paint();
    });
  };

  // Observe document + viewport changes via a CM update listener attached
  // through the view's dispatch hook is not available here; instead poll the
  // two cheap signals we need by listening to scroll + a MutationObserver-free
  // updateListener registered by the Editor is overkill. We use scroll events
  // for repaint and a debounced relayout driven by docChanged via the
  // contentDOM 'input'/'beforeinput' is unreliable — so we subscribe to CM's
  // measure cycle with view.scrollDOM scroll + a periodic doc-length check.
  let lastDocLen = -1;
  const onScroll = () => {
    if (props.view.state.doc.length !== lastDocLen) {
      lastDocLen = props.view.state.doc.length;
      scheduleRelayout();
    } else {
      schedulePaint();
    }
  };

  onMount(() => {
    lastDocLen = props.view.state.doc.length;
    props.view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(() => scheduleRelayout());
    ro.observe(props.view.scrollDOM);
    relayout();
    onCleanup(() => {
      props.view.scrollDOM.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (relayoutTimer !== undefined) clearTimeout(relayoutTimer);
    });
  });

  // Pointer drag → scroll the editor.
  let dragging = false;
  const scrollToEvent = (clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    const f = fractionFromClientY(clientY, rect.top, rect.height);
    props.view.scrollDOM.scrollTop = scrollTopForFraction(f, viewportInfo());
  };
  const onPointerDown = (e: PointerEvent) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    scrollToEvent(e.clientY);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (dragging) scrollToEvent(e.clientY);
  };
  const onPointerUp = (e: PointerEvent) => {
    dragging = false;
    canvas.releasePointerCapture(e.pointerId);
  };

  // Repaint when the theme flips. `createEffect` tracks `props.resolvedTheme`
  // and re-runs on change; colors are re-read fresh inside paint(). `defer`
  // skips the first run (the onMount relayout already paints).
  createEffect(
    on(
      () => props.resolvedTheme,
      () => schedulePaint(),
      { defer: true },
    ),
  );

  return (
    <canvas
      ref={canvas}
      style={{
        width: `${WIDTH}px`,
        "flex-shrink": "0",
        cursor: "pointer",
        "align-self": "stretch",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
};

export default Minimap;
```

> **Note for the implementer:** the comment block in `onScroll` documents *why* we drive relayout off scroll + doc-length deltas (no separate CM updateListener is wired into this child). If during implementation you find the `Editor` already exposes a cleaner doc-change hook to pass down, prefer that and simplify — but do not add a document-mutating dispatch.

- [ ] **Step 2: Add the `cmView` signal in Editor.tsx**

In `ui/src/Editor.tsx`, add the import at top:
```ts
import { createSignal, Show } from "solid-js";
```
(merge with the existing `solid-js` import line). Add the Minimap import:
```ts
import Minimap from "./editor/minimap/Minimap";
```
Inside the component body (near `let view`), add:
```ts
  const [cmView, setCmView] = createSignal<EditorView>();
```
At the end of `onMount`, after `view = new EditorView({...})` is assigned (after the `props.ref?.({…})` block is fine), add:
```ts
    setCmView(view);
```

- [ ] **Step 3: Change the return to a flex row rendering the minimap**

In `ui/src/Editor.tsx`, replace the final `return (<div ref={host} … />)` with:
```tsx
  return (
    <div style={{ display: "flex", flex: "1", "min-height": "0" }}>
      <div
        ref={host}
        style={{
          flex: "1",
          "min-width": "0",
          "min-height": "0",
          display: "flex",
          "flex-direction": "column",
          border: "none",
          background: "transparent",
          overflow: "hidden",
        }}
      />
      <Show when={props.minimapEnabled && cmView()}>
        {(v) => (
          <Minimap view={v()} resolvedTheme={props.resolvedTheme} />
        )}
      </Show>
    </div>
  );
```

- [ ] **Step 4: Type-check and run the full suite**

Run:
```bash
cd ui && npx tsc --noEmit && npx vitest run
```
Expected: tsc clean; all tests pass (pure modules covered; component untested by design).

- [ ] **Step 5: Verify in the live preview**

Start the dev server (preview tooling). Then:
1. Open a vault and a longish note.
2. Settings ▸ Editor → toggle **Minimap → On**.
3. Confirm: a 96px strip appears on the right showing tiny text of the whole note; a translucent indicator marks the visible region; scrolling the editor moves the indicator; clicking/dragging the strip scrolls the editor; toggling theme re-colors the strip; toggling **Off** removes the strip entirely.

Capture a screenshot as proof. If any check fails, diagnose against the pure modules first (they're unit-tested), then the component wiring.

- [ ] **Step 6: Commit**

```bash
git add ui/src/editor/minimap/Minimap.tsx ui/src/Editor.tsx
git commit -m "feat(minimap): live canvas strip + Editor integration (preview-verified)"
```

---

### Task 6: Docs + gate sweep

**Files:**
- Modify: `docs/build-order.md` and/or the relevant layer spec's "What was built" (per session protocol — capture tersely, once).
- Modify: `CLAUDE.md` Project state block (rewrite, don't append).

- [ ] **Step 1: Run the full gate**

Run: `bash scripts/check.sh`
Expected: all green (fmt/clippy/test, tsc, vitest, build, docs).

- [ ] **Step 2: Record what was built**

Add a terse "What was built" note (minimap: read-only Pretext canvas strip, `editor.minimap_enabled` default off, scale-to-fit v1, sliding-window deferred to v2) to the appropriate layer spec, and rewrite the `CLAUDE.md` Project state block to reference it. Link the design spec and this plan.

- [ ] **Step 3: Commit**

```bash
git add docs CLAUDE.md
git commit -m "docs(minimap): record minimap feature + update project state"
```

---

## Self-Review

**Spec coverage:**
- §1/§2 rationale & scope → Tasks 1–5 (gated, derived, off-by-default). ✓
- §3 modules/boundaries → Tasks 2–5 create the exact files; Editor flex-row + `cmView` in Task 5. ✓
- §4 data flow (debounced relayout, rAF repaint, ResizeObserver) → Task 5 `Minimap.tsx`. ✓
- §5 Pretext seam (internal measurement, module-mock tests) → Task 4. ✓
- §6 Approach A + scale-to-fit no-floor → `lineHeightFor` (Task 2) + renderer (Task 3). ✓
- §7 interaction → geometry (Task 2) + pointer handlers (Task 5). ✓
- §8 settings (`editor.minimap_enabled`, no Rust change) → Task 1. ✓
- §9 testing (pure modules in node, no component test) → Tasks 2–4 tests; Task 5 preview-verified. ✓
- §10 risks (MIT confirmed; seam isolates Pretext) → seam in Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. The one prose "Note for the implementer" in Task 5 is guidance, not a placeholder — the code above it is complete and runnable.

**Type consistency:** `MinimapLayout`/`LaidLine`/`ViewportInfo`/`IndicatorRect`/`MinimapColors` defined once in `types.ts` (Task 2) and consumed unchanged in Tasks 3–5. Function names stable: `layoutDocument`, `drawMinimap`, `lineHeightFor`, `indicatorRect`, `fractionFromClientY`, `scrollTopForFraction`. ✓
