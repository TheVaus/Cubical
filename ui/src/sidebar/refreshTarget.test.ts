import { describe, expect, it } from "vitest";
import { createTargetTracker } from "./refreshTarget";

describe("createTargetTracker", () => {
  it("treats the first sight of a target as a cold load", () => {
    expect(createTargetTracker().start("v1", "a.md")).toEqual({
      type: "fetch:start",
    });
  });

  it("treats a repeat of the same target as a warm refresh", () => {
    const t = createTargetTracker();
    t.start("v1", "a.md");
    expect(t.start("v1", "a.md")).toEqual({ type: "refresh:start" });
    expect(t.start("v1", "a.md")).toEqual({ type: "refresh:start" });
  });

  it("goes cold again when any part of the target changes", () => {
    const t = createTargetTracker();
    t.start("v1", "a.md");
    expect(t.start("v1", "b.md")).toEqual({ type: "fetch:start" });
    expect(t.start("v2", "b.md")).toEqual({ type: "fetch:start" });
  });

  it("goes cold when returning to a target it saw earlier", () => {
    const t = createTargetTracker();
    t.start("v1", "a.md");
    t.start("v1", "b.md");
    expect(t.start("v1", "a.md")).toEqual({ type: "fetch:start" });
  });

  it("separates parts so a path containing the join is not confusable", () => {
    const t = createTargetTracker();
    t.start("v1", "a b.md");
    expect(t.start("v1 a", "b.md")).toEqual({ type: "fetch:start" });
  });
});
