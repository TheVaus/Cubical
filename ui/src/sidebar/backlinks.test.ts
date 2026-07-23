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

describe("Backlinks effect — self-trigger loop guard", () => {

  it("does not retrigger itself when reading state via untrack", () => {
    createRoot((dispose) => {
      const [state, setState] = createSignal<BacklinksViewState>({
        kind: "idle",
      });
      let runs = 0;
      createComputed(() => {
        runs++;
        if (runs > 5) throw new Error("effect looped on itself");
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
            throw new Error("looped");
          }
          setState(reduceBacklinksState(state(), { type: "file:cleared" }));
        });
        dispose();
      });
    }).toThrow("looped");
  });
});
