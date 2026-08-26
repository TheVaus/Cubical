import { describe, expect, it } from "vitest";

import type { GraphEdge } from "../api/ipc";
import { FLAG_DIMMED, FLAG_FOCUSED, FLAG_HIDDEN } from "./gpu/instances";
import { buildAdjacency } from "./graphModel";
import { edgeFlags, nodeFlags } from "./hover";

const edge = (source: number, target: number): GraphEdge => ({
  source,
  target,
  kind: "link",
});

const edges = [edge(0, 1), edge(1, 2), edge(2, 3)];
const adjacency = buildAdjacency(4, edges);

describe("hover node flags", () => {
  it("dims nothing when nothing is hovered", () => {
    expect(Array.from(nodeFlags(4, adjacency, null))).toEqual([0, 0, 0, 0]);
  });

  it("marks the hovered node focused and leaves its neighbours undimmed", () => {
    const flags = nodeFlags(4, adjacency, 1);
    expect(flags[1]).toBe(FLAG_FOCUSED);
    expect(flags[0]).toBe(0);
    expect(flags[2]).toBe(0);
  });

  it("dims everything beyond the immediate neighbours", () => {
    expect(nodeFlags(4, adjacency, 1)[3]).toBe(FLAG_DIMMED);
  });

  it("dims every other node when the hovered one is isolated", () => {
    const isolated = buildAdjacency(3, []);
    const flags = nodeFlags(3, isolated, 0);
    expect(flags[0]).toBe(FLAG_FOCUSED);
    expect(flags[1]).toBe(FLAG_DIMMED);
    expect(flags[2]).toBe(FLAG_DIMMED);
  });

  it("produces one byte per node, which is what the instance rewrite needs", () => {
    expect(nodeFlags(4, adjacency, 2)).toHaveLength(4);
  });
});

describe("hover edge flags", () => {
  it("dims nothing when nothing is hovered", () => {
    expect(Array.from(edgeFlags(edges, null))).toEqual([0, 0, 0]);
  });

  it("keeps only the edges touching the hovered node", () => {
    const flags = edgeFlags(edges, 1);
    expect(flags[0]).toBe(0);
    expect(flags[1]).toBe(0);
    expect(flags[2]).toBe(FLAG_DIMMED);
  });

  it("dims every edge when the hovered node touches none", () => {
    expect(Array.from(edgeFlags(edges, 9))).toEqual([
      FLAG_DIMMED,
      FLAG_DIMMED,
      FLAG_DIMMED,
    ]);
  });
});

describe("filter visibility", () => {
  const visible = Uint8Array.from([1, 1, 0, 1]);

  it("hides a filtered-out node outright rather than dimming it", () => {
    expect(nodeFlags(4, adjacency, null, visible)[2]).toBe(FLAG_HIDDEN);
  });

  it("leaves visible nodes untouched when nothing is hovered", () => {
    const flags = nodeFlags(4, adjacency, null, visible);
    expect(flags[0]).toBe(0);
    expect(flags[3]).toBe(0);
  });

  it("keeps hidden beating focused, so a filtered node cannot be hover-revealed", () => {
    expect(nodeFlags(4, adjacency, 2, visible)[2]).toBe(FLAG_HIDDEN);
  });

  it("still focuses and dims among the nodes that remain visible", () => {
    const flags = nodeFlags(4, adjacency, 1, visible);
    expect(flags[1]).toBe(FLAG_FOCUSED);
    expect(flags[0]).toBe(0);
    expect(flags[3]).toBe(FLAG_DIMMED);
  });

  it("hides an edge when either endpoint is filtered out", () => {
    const flags = edgeFlags(edges, null, visible);
    expect(flags[0]).toBe(0);
    expect(flags[1]).toBe(FLAG_HIDDEN);
    expect(flags[2]).toBe(FLAG_HIDDEN);
  });
});
