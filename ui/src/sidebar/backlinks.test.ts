import { describe, expect, it } from "vitest";
import { createComputed, createRoot, createSignal, untrack } from "solid-js";

import type { Backlink } from "../api/ipc";
import {
  backlinkKey,
  basenameWithoutExtension,
  type BacklinksViewState,
  reduceBacklinksState,
} from "./backlinksState";

const sample: Backlink = {
  source_path: "notes/foo.md",
  context: "leading text [[Target]] trailing text",
  position: 13,
};

describe("backlinkKey", () => {
  it("combines source path and position", () => {
    expect(backlinkKey(sample)).toBe("notes/foo.md@13");
  });

  it("distinguishes two links from the same file", () => {
    const a: Backlink = { ...sample, position: 10 };
    const b: Backlink = { ...sample, position: 20 };
    expect(backlinkKey(a)).not.toBe(backlinkKey(b));
  });
});

describe("basenameWithoutExtension", () => {
  it("strips directory and .md extension", () => {
    expect(basenameWithoutExtension("notes/sub/Foo.md")).toBe("Foo");
  });

  it("returns bare name unchanged when no path or extension", () => {
    expect(basenameWithoutExtension("Foo")).toBe("Foo");
  });

  it("preserves dots inside the basename", () => {
    expect(basenameWithoutExtension("v1.2.notes.md")).toBe("v1.2.notes");
  });

  it("handles a trailing slash gracefully", () => {
    expect(basenameWithoutExtension("notes/")).toBe("");
  });
});

describe("reduceBacklinksState", () => {
  const idle: BacklinksViewState = { kind: "idle" };

  it("starts loading on fetch:start", () => {
    const next = reduceBacklinksState(idle, { type: "fetch:start" });
    expect(next).toEqual({ kind: "loading" });
  });

  it("captures empty result as 'empty'", () => {
    const next = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:success", backlinks: [] },
    );
    expect(next).toEqual({ kind: "empty" });
  });

  it("captures non-empty result as 'loaded'", () => {
    const next = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:success", backlinks: [sample] },
    );
    expect(next).toEqual({ kind: "loaded", backlinks: [sample] });
  });

  it("captures errors", () => {
    const next = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:error", message: "boom" },
    );
    expect(next).toEqual({ kind: "error", message: "boom" });
  });

  it("returns to idle when the open file is cleared", () => {
    const next = reduceBacklinksState(
      { kind: "loaded", backlinks: [sample] },
      { type: "file:cleared" },
    );
    expect(next).toEqual({ kind: "idle" });
  });

  it("reuses a backlink's object reference across refetches when unchanged", () => {
    const first = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:success", backlinks: [sample] },
    );
    // A fresh object with identical fields — as a real refetch would
    // produce, since every IPC response deserializes new objects.
    const refetched: Backlink = { ...sample };
    const second = reduceBacklinksState(first, {
      type: "fetch:success",
      backlinks: [refetched],
    });

    expect(first.kind).toBe("loaded");
    expect(second.kind).toBe("loaded");
    if (first.kind === "loaded" && second.kind === "loaded") {
      expect(second.backlinks[0]).toBe(first.backlinks[0]);
      expect(second.backlinks[0]).not.toBe(refetched);
    }
  });

  it("gives a fresh reference to a backlink whose context actually changed", () => {
    const first = reduceBacklinksState(
      { kind: "loading" },
      { type: "fetch:success", backlinks: [sample] },
    );
    const edited: Backlink = { ...sample, context: "new surrounding text" };
    const second = reduceBacklinksState(first, {
      type: "fetch:success",
      backlinks: [edited],
    });

    expect(second.kind).toBe("loaded");
    if (second.kind === "loaded") {
      expect(second.backlinks[0]).toBe(edited);
    }
  });
});

/**
 * Regression test for the L3 Session C "Loading…" / `Maximum call stack
 * size exceeded` bug.
 *
 * The Backlinks panel's `createEffect` reads `state()` to feed the
 * reducer's prior-state arg AND writes `setState(...)`. Because
 * `reduceBacklinksState` always returns a fresh object reference (even
 * for shape-identical transitions like idle → idle), a tracked `state()`
 * read forms a self-trigger loop: each effect run writes a new state,
 * which retriggers the effect, which writes again, until the JS stack
 * overflows. After file selection the loop continues and each iteration
 * kicks off a new `getBacklinks` fetch whose `.then` is then discarded
 * by the next iteration's token bump — the panel stays at "Loading…"
 * forever.
 *
 * The fix is to wrap the `state()` reads in `untrack(state)` so the
 * effect does not subscribe to its own writes. This test reproduces the
 * effect's read/write shape with a re-entry counter and proves that the
 * untracked variant settles in one run.
 */
describe("Backlinks effect — self-trigger loop guard", () => {
  // Uses `createComputed` (synchronous, runs immediately on creation)
  // instead of `createEffect` (deferred) so the test reproduces the
  // production timing — a parent-render dependency tree where the
  // effect fires synchronously within the render — without needing a
  // jsdom + render harness.

  it("does not retrigger itself when reading state via untrack", () => {
    createRoot((dispose) => {
      const [state, setState] = createSignal<BacklinksViewState>({
        kind: "idle",
      });
      let runs = 0;
      createComputed(() => {
        runs++;
        if (runs > 5) throw new Error("effect looped on itself");
        // Same shape as the production effect's idle branch — minus the
        // tracked self-read.
        setState(
          reduceBacklinksState(untrack(state), { type: "file:cleared" }),
        );
      });
      expect(runs).toBe(1);
      dispose();
    });
  });

  it("loops without the untrack guard (proves the regression is real)", () => {
    expect(() => {
      createRoot((dispose) => {
        const [state, setState] = createSignal<BacklinksViewState>({
          kind: "idle",
        });
        let runs = 0;
        createComputed(() => {
          runs++;
          if (runs > 50) {
            // Bail before Solid throws RangeError so the assertion can
            // fire on a clean Error rather than a host stack overflow.
            throw new Error("looped");
          }
          // Tracked read — the production bug shape.
          setState(reduceBacklinksState(state(), { type: "file:cleared" }));
        });
        dispose();
      });
    }).toThrow("looped");
  });
});
