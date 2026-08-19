import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode, GraphSnapshot } from "../api/ipc";
import { positionsByKey, reconcilePositions } from "./reconcile";

const node = (id: number, key: string, kind: GraphNode["kind"] = "note"): GraphNode => ({
  id,
  kind,
  key,
  label: key,
});

const edge = (source: number, target: number): GraphEdge => ({
  source,
  target,
  kind: "link",
});

const snap = (nodes: GraphNode[], edges: GraphEdge[] = []): GraphSnapshot => ({
  nodes,
  edges,
});

const before = snap([node(0, "a.md"), node(1, "b.md"), node(2, "c.md")]);
const positions = Float32Array.from([10, 20, 30, 40, 50, 60]);
const known = positionsByKey(before, positions);

describe("reconciling a changed vault against frozen positions", () => {
  it("leaves every surviving node exactly where it was", () => {
    const after = snap([node(0, "a.md"), node(1, "b.md"), node(2, "c.md")]);
    expect(Array.from(reconcilePositions(after, known))).toEqual([
      10, 20, 30, 40, 50, 60,
    ]);
  });

  it("keeps positions attached to identity, not to index", () => {
    const reordered = snap([node(0, "c.md"), node(1, "a.md"), node(2, "b.md")]);
    expect(Array.from(reconcilePositions(reordered, known))).toEqual([
      50, 60, 10, 20, 30, 40,
    ]);
  });

  it("drops a removed note without disturbing the rest", () => {
    const after = snap([node(0, "a.md"), node(1, "c.md")]);
    expect(Array.from(reconcilePositions(after, known))).toEqual([10, 20, 50, 60]);
  });

  it("places a new isolated node without moving anything else", () => {
    const after = snap([
      node(0, "a.md"),
      node(1, "b.md"),
      node(2, "c.md"),
      node(3, "new.md"),
    ]);
    const out = reconcilePositions(after, known);
    expect(Array.from(out.slice(0, 6))).toEqual([10, 20, 30, 40, 50, 60]);
    expect(Number.isFinite(out[6]!)).toBe(true);
    expect(Number.isFinite(out[7]!)).toBe(true);
  });

  it("places a new linked node near the neighbours it links to", () => {
    const after = snap(
      [node(0, "a.md"), node(1, "b.md"), node(2, "c.md"), node(3, "new.md")],
      [edge(3, 0)],
    );
    const out = reconcilePositions(after, known, 0);
    expect(out[6]).toBeCloseTo(10);
    expect(out[7]).toBeCloseTo(20);
  });

  it("averages several placed neighbours rather than picking one", () => {
    const after = snap(
      [node(0, "a.md"), node(1, "b.md"), node(2, "c.md"), node(3, "new.md")],
      [edge(3, 0), edge(3, 1)],
    );
    const out = reconcilePositions(after, known, 0);
    expect(out[6]).toBeCloseTo(20);
    expect(out[7]).toBeCloseTo(30);
  });

  it("treats a rename as one moved node, not a duplicate", () => {
    const after = snap([node(0, "a.md"), node(1, "renamed.md"), node(2, "c.md")]);
    const out = reconcilePositions(after, known);
    expect(out).toHaveLength(6);
    expect(Array.from(out.slice(0, 2))).toEqual([10, 20]);
    expect(Array.from(out.slice(4, 6))).toEqual([50, 60]);
  });

  it("keeps a tag and a note of the same key apart", () => {
    const mixed = snap([node(0, "work", "tag"), node(1, "work", "note")]);
    const map = positionsByKey(mixed, Float32Array.from([1, 1, 9, 9]));
    expect(Array.from(reconcilePositions(mixed, map))).toEqual([1, 1, 9, 9]);
  });

  it("is deterministic: the same new node lands in the same place twice", () => {
    const after = snap([node(0, "a.md"), node(1, "fresh.md")]);
    expect(Array.from(reconcilePositions(after, known))).toEqual(
      Array.from(reconcilePositions(after, known)),
    );
  });

  it("places every node when nothing at all is known yet", () => {
    const out = reconcilePositions(before, new Map());
    expect(out).toHaveLength(6);
    expect(Array.from(out).every((v) => Number.isFinite(v))).toBe(true);
  });

  it("reconciles an emptied vault to no positions", () => {
    expect(reconcilePositions(snap([]), known)).toHaveLength(0);
  });
});
