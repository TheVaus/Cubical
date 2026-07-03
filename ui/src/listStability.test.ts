import { describe, expect, it } from "vitest";
import { stabilizeByKey } from "./listStability";

interface Row {
  path: string;
  name: string;
}

describe("stabilizeByKey", () => {
  it("reuses the previous object reference when the keyed item is unchanged", () => {
    const prev: Row[] = [{ path: "a.md", name: "a.md" }];
    const next: Row[] = [{ path: "a.md", name: "a.md" }];

    const result = stabilizeByKey(
      prev,
      next,
      (r) => r.path,
      (a, b) => a.name === b.name,
    );

    expect(result[0]).toBe(prev[0]);
    expect(result[0]).not.toBe(next[0]);
  });

  it("returns the new object when the keyed item's content changed", () => {
    const prev: Row[] = [{ path: "a.md", name: "a.md" }];
    const next: Row[] = [{ path: "a.md", name: "renamed.md" }];

    const result = stabilizeByKey(
      prev,
      next,
      (r) => r.path,
      (a, b) => a.name === b.name,
    );

    expect(result[0]).toBe(next[0]);
    expect(result[0]?.name).toBe("renamed.md");
  });

  it("returns the new object when the key has no match in the previous list", () => {
    const prev: Row[] = [];
    const next: Row[] = [{ path: "a.md", name: "a.md" }];

    const result = stabilizeByKey(
      prev,
      next,
      (r) => r.path,
      (a, b) => a.name === b.name,
    );

    expect(result[0]).toBe(next[0]);
  });

  it("preserves next's order even when prev has a different order", () => {
    const prev: Row[] = [
      { path: "b.md", name: "b.md" },
      { path: "a.md", name: "a.md" },
    ];
    const next: Row[] = [
      { path: "a.md", name: "a.md" },
      { path: "b.md", name: "b.md" },
    ];

    const result = stabilizeByKey(
      prev,
      next,
      (r) => r.path,
      (a, b) => a.name === b.name,
    );

    expect(result.map((r) => r.path)).toEqual(["a.md", "b.md"]);
    expect(result[0]).toBe(prev[1]);
    expect(result[1]).toBe(prev[0]);
  });
});
