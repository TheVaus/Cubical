import { describe, it, expect } from "vitest";
import {
  emptyNav,
  navPush,
  navBack,
  navForward,
  navCurrent,
  canBack,
  canForward,
} from "./navHistory";

describe("navHistory", () => {
  it("starts empty with nothing current and no moves", () => {
    expect(navCurrent(emptyNav)).toBeNull();
    expect(canBack(emptyNav)).toBe(false);
    expect(canForward(emptyNav)).toBe(false);
  });

  it("pushes in order and tracks current", () => {
    let s = navPush(emptyNav, "a.md");
    s = navPush(s, "b.md");
    s = navPush(s, "c.md");
    expect(navCurrent(s)).toBe("c.md");
    expect(canBack(s)).toBe(true);
    expect(canForward(s)).toBe(false);
  });

  it("collapses a consecutive duplicate push", () => {
    let s = navPush(emptyNav, "a.md");
    s = navPush(s, "a.md");
    expect(s.stack).toEqual(["a.md"]);
    expect(s.index).toBe(0);
  });

  it("goes back and forward across the stack", () => {
    let s = navPush(navPush(navPush(emptyNav, "a.md"), "b.md"), "c.md");
    s = navBack(s);
    expect(navCurrent(s)).toBe("b.md");
    s = navBack(s);
    expect(navCurrent(s)).toBe("a.md");
    expect(canBack(s)).toBe(false);
    s = navForward(s);
    expect(navCurrent(s)).toBe("b.md");
  });

  it("truncates forward entries when pushing after going back", () => {
    let s = navPush(navPush(navPush(emptyNav, "a.md"), "b.md"), "c.md");
    s = navBack(s); // at b.md
    s = navPush(s, "d.md"); // branch: c.md dropped
    expect(s.stack).toEqual(["a.md", "b.md", "d.md"]);
    expect(navCurrent(s)).toBe("d.md");
    expect(canForward(s)).toBe(false);
  });

  it("back/forward at a boundary return an equivalent state", () => {
    const s = navPush(emptyNav, "a.md");
    expect(navBack(s).index).toBe(s.index);
    expect(navForward(s).index).toBe(s.index);
  });
});
