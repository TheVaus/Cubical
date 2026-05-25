import { describe, expect, it } from "vitest";

import type { Backlink } from "../api/ipc";
import {
  backlinkKey,
  basenameWithoutExtension,
  type BacklinksViewState,
  reduceBacklinksState,
} from "./backlinks";

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
});
