import { describe, expect, it } from "vitest";

import { buildPickGrid, hitTest } from "./picking";

const gridOf = (positions: number[], radii: number[]) =>
  buildPickGrid(Float32Array.from(positions), Float32Array.from(radii));

describe("pick grid", () => {
  it("has no grid for an empty graph, and hit-testing it is null", () => {
    expect(buildPickGrid(new Float32Array(0), new Float32Array(0))).toBeNull();
    expect(hitTest(null, 0, 0)).toBeNull();
  });

  it("hits a node at its centre", () => {
    const grid = gridOf([0, 0, 100, 100], [5, 5]);
    expect(hitTest(grid, 0, 0)).toBe(0);
    expect(hitTest(grid, 100, 100)).toBe(1);
  });

  it("hits exactly at the radius boundary and misses just outside", () => {
    const grid = gridOf([0, 0], [5]);
    expect(hitTest(grid, 5, 0)).toBe(0);
    expect(hitTest(grid, 5.001, 0)).toBeNull();
  });

  it("misses empty space", () => {
    const grid = gridOf([0, 0, 100, 100], [5, 5]);
    expect(hitTest(grid, 50, 50)).toBeNull();
  });

  it("takes the nearest node when two overlap", () => {
    const grid = gridOf([0, 0, 4, 0], [10, 10]);
    expect(hitTest(grid, 3, 0)).toBe(1);
    expect(hitTest(grid, 1, 0)).toBe(0);
  });

  it("respects the slop that makes a small node easier to hover", () => {
    const grid = gridOf([0, 0], [2]);
    expect(hitTest(grid, 4, 0)).toBeNull();
    expect(hitTest(grid, 4, 0, 3)).toBe(0);
  });

  it("finds a node whose cell differs from the query's cell", () => {
    const grid = gridOf(
      Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? i * 3 : i * 3)),
      Array.from({ length: 100 }, () => 4),
    );
    expect(grid).not.toBeNull();
    for (let i = 0; i < 100; i++) {
      const x = grid!.positions[i * 2]!;
      const y = grid!.positions[i * 2 + 1]!;
      expect(hitTest(grid, x, y)).toBe(i);
    }
  });

  it("keeps every node hittable at its own centre on a dense random field", () => {
    const n = 500;
    const positions: number[] = [];
    const radii: number[] = [];
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < n; i++) {
      positions.push(rand() * 2000 - 1000, rand() * 2000 - 1000);
      radii.push(1 + rand() * 6);
    }
    const grid = buildPickGrid(
      Float32Array.from(positions),
      Float32Array.from(radii),
    );
    for (let i = 0; i < n; i++) {
      expect(hitTest(grid, positions[i * 2]!, positions[i * 2 + 1]!)).not.toBeNull();
    }
  });

  it("survives every node sharing one position", () => {
    const grid = gridOf([1, 1, 1, 1, 1, 1], [3, 3, 3]);
    expect(hitTest(grid, 1, 1)).not.toBeNull();
  });

  it("ignores non-finite positions rather than building a broken grid", () => {
    const grid = gridOf([Number.NaN, 0, 10, 10], [4, 4]);
    expect(grid).not.toBeNull();
    expect(hitTest(grid, 10, 10)).toBe(1);
  });

  it("returns null far outside the populated area rather than clamping to an edge node", () => {
    const grid = gridOf([0, 0, 10, 10], [3, 3]);
    expect(hitTest(grid, 1e6, 1e6)).toBeNull();
    expect(hitTest(grid, -1e6, -1e6)).toBeNull();
  });
});
