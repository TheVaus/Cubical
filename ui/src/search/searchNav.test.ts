import { describe, expect, test } from "vitest";
import { isSearchNavKey, nextSearchNavIndex } from "./searchNav";

describe("nextSearchNavIndex", () => {
  test("ArrowDown from nothing focused lands on the first group", () => {
    expect(nextSearchNavIndex("ArrowDown", -1, 3)).toBe(0);
  });

  test("ArrowDown advances one group", () => {
    expect(nextSearchNavIndex("ArrowDown", 0, 3)).toBe(1);
  });

  test("ArrowDown clamps at the last group", () => {
    expect(nextSearchNavIndex("ArrowDown", 2, 3)).toBe(2);
  });

  test("ArrowUp from nothing focused lands on the last group", () => {
    expect(nextSearchNavIndex("ArrowUp", -1, 3)).toBe(2);
  });

  test("ArrowUp retreats one group", () => {
    expect(nextSearchNavIndex("ArrowUp", 2, 3)).toBe(1);
  });

  test("ArrowUp clamps at the first group", () => {
    expect(nextSearchNavIndex("ArrowUp", 0, 3)).toBe(0);
  });

  test("Home jumps to the first group", () => {
    expect(nextSearchNavIndex("Home", 2, 3)).toBe(0);
  });

  test("End jumps to the last group", () => {
    expect(nextSearchNavIndex("End", 0, 3)).toBe(2);
  });

  test("an empty list yields nothing focused for any key", () => {
    expect(nextSearchNavIndex("ArrowDown", -1, 0)).toBe(-1);
    expect(nextSearchNavIndex("ArrowUp", -1, 0)).toBe(-1);
    expect(nextSearchNavIndex("Home", -1, 0)).toBe(-1);
    expect(nextSearchNavIndex("End", -1, 0)).toBe(-1);
  });
});

describe("isSearchNavKey", () => {
  test("recognizes the four navigation keys", () => {
    expect(isSearchNavKey("ArrowDown")).toBe(true);
    expect(isSearchNavKey("ArrowUp")).toBe(true);
    expect(isSearchNavKey("Home")).toBe(true);
    expect(isSearchNavKey("End")).toBe(true);
  });

  test("rejects other keys", () => {
    expect(isSearchNavKey("Enter")).toBe(false);
    expect(isSearchNavKey("a")).toBe(false);
    expect(isSearchNavKey("ArrowLeft")).toBe(false);
  });
});
