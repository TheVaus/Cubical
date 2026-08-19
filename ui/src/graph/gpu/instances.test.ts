import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "../../api/ipc";
import {
  BASE_RADIUS,
  EDGE_STRIDE_BYTES,
  FLAG_DIMMED,
  NODE_STRIDE_BYTES,
  buildEdgeInstances,
  buildNodeInstances,
  degrees,
  edgeInstanceCount,
  packRgba,
  radiusFor,
  type Palette,
} from "./instances";

const palette: Palette = {
  note: 0x11223344,
  attachment: 0x22334455,
  ghost: 0x33445566,
  tag: 0x44556677,
  edge: 0x55667788,
};

const node = (id: number): GraphNode => ({
  id,
  kind: "note",
  key: `n${id}.md`,
  label: `n${id}`,
});

const edge = (source: number, target: number): GraphEdge => ({
  source,
  target,
  kind: "link",
});

describe("colour packing", () => {
  it("packs to the byte order the shader unpacks", () => {
    expect(packRgba(255, 0, 0, 1)).toBe(0xff0000ff);
    expect(packRgba(0, 255, 0, 0)).toBe(0x00ff0000);
  });

  it("clamps rather than wrapping around", () => {
    expect(packRgba(300, -20, 0, 2)).toBe(0xff0000ff);
  });
});

describe("node radius", () => {
  it("grows on a square-root curve, so hubs read as hubs without swamping", () => {
    expect(radiusFor(0)).toBeCloseTo(BASE_RADIUS);
    expect(radiusFor(3)).toBeCloseTo(BASE_RADIUS * 2);
    expect(radiusFor(15)).toBeCloseTo(BASE_RADIUS * 4);
  });

  it("gives an isolated node a visible radius rather than zero", () => {
    expect(radiusFor(0)).toBeGreaterThan(0);
  });
});

describe("degrees", () => {
  it("counts both endpoints of every edge", () => {
    expect(Array.from(degrees(3, [edge(0, 1), edge(0, 2)]))).toEqual([2, 1, 1]);
  });

  it("ignores an endpoint past the node count", () => {
    expect(Array.from(degrees(2, [edge(0, 9)]))).toEqual([1, 0]);
  });
});

describe("node instances", () => {
  it("writes one stride per node, with position, radius, colour and flags", () => {
    const positions = new Float32Array([1, 2, 3, 4]);
    const data = buildNodeInstances(
      [node(0), node(1)],
      positions,
      degrees(2, [edge(0, 1)]),
      palette,
    );
    expect(data.byteLength).toBe(2 * NODE_STRIDE_BYTES);

    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    expect(f32[0]).toBe(1);
    expect(f32[1]).toBe(2);
    expect(f32[2]).toBeCloseTo(radiusFor(1));
    expect(u32[3]).toBe(palette.note);
    expect(u32[4]).toBe(0);
    expect(f32[5]).toBe(3);
    expect(f32[6]).toBe(4);
  });

  it("carries the per-node flags byte the hover pass rewrites", () => {
    const data = buildNodeInstances(
      [node(0), node(1)],
      new Float32Array([0, 0, 1, 1]),
      degrees(2, []),
      palette,
      Uint8Array.from([0, FLAG_DIMMED]),
    );
    const u32 = new Uint32Array(data);
    expect(u32[4]).toBe(0);
    expect(u32[9]).toBe(FLAG_DIMMED);
  });

  it("stops at whichever of nodes or positions is shorter", () => {
    const data = buildNodeInstances(
      [node(0), node(1), node(2)],
      new Float32Array([0, 0]),
      degrees(3, []),
      palette,
    );
    expect(data.byteLength).toBe(NODE_STRIDE_BYTES);
  });

  it("builds nothing from an empty graph", () => {
    expect(
      buildNodeInstances([], new Float32Array(0), new Uint32Array(0), palette)
        .byteLength,
    ).toBe(0);
  });
});

describe("edge instances", () => {
  it("writes both endpoints per edge", () => {
    const data = buildEdgeInstances(
      [edge(0, 1)],
      new Float32Array([1, 2, 3, 4]),
      palette,
    );
    expect(data.byteLength).toBe(EDGE_STRIDE_BYTES);
    const f32 = new Float32Array(data);
    expect(Array.from(f32.slice(0, 4))).toEqual([1, 2, 3, 4]);
    expect(new Uint32Array(data)[4]).toBe(palette.edge);
  });

  it("drops an edge whose endpoint has no position, and counts what is left", () => {
    const edges = [edge(0, 1), edge(0, 9)];
    const positions = new Float32Array([0, 0, 1, 1]);
    expect(edgeInstanceCount(edges, positions)).toBe(1);
    expect(buildEdgeInstances(edges, positions, palette).byteLength).toBe(
      EDGE_STRIDE_BYTES,
    );
  });

  it("indexes flags by the original edge index, not the kept-edge index", () => {
    const edges = [edge(0, 9), edge(0, 1)];
    const positions = new Float32Array([0, 0, 1, 1]);
    const flags = Uint8Array.from([0, FLAG_DIMMED]);
    const u32 = new Uint32Array(
      buildEdgeInstances(edges, positions, palette, flags),
    );
    expect(u32[5]).toBe(FLAG_DIMMED);
  });
});
