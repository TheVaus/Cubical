import { describe, expect, it } from "vitest";

import type { GraphEdge, GraphNode } from "../api/ipc";
import {
  DEFAULT_FILTER,
  buildAdjacency,
  countVisible,
  focusSet,
  neighboursOf,
  nodeAt,
  openablePath,
  visibleNodes,
} from "./graphModel";

const edge = (source: number, target: number): GraphEdge => ({
  source,
  target,
  kind: "link",
});

const node = (id: number, kind: GraphNode["kind"], key: string): GraphNode => ({
  id,
  kind,
  key,
  label: key,
});

const sorted = (a: Uint32Array) => Array.from(a).sort((x, y) => x - y);

describe("adjacency", () => {
  it("is undirected: both endpoints list each other", () => {
    const adj = buildAdjacency(3, [edge(0, 1), edge(0, 2)]);
    expect(sorted(neighboursOf(adj, 0))).toEqual([1, 2]);
    expect(sorted(neighboursOf(adj, 1))).toEqual([0]);
    expect(sorted(neighboursOf(adj, 2))).toEqual([0]);
  });

  it("gives an isolated node no neighbours", () => {
    const adj = buildAdjacency(2, []);
    expect(neighboursOf(adj, 0)).toHaveLength(0);
  });

  it("keeps a parallel edge as two entries, matching the drawn edges", () => {
    const adj = buildAdjacency(2, [edge(0, 1), edge(0, 1)]);
    expect(sorted(neighboursOf(adj, 0))).toEqual([1, 1]);
  });

  it("handles a self-loop without corrupting the offsets", () => {
    const adj = buildAdjacency(2, [edge(0, 0), edge(0, 1)]);
    expect(sorted(neighboursOf(adj, 0))).toEqual([0, 0, 1]);
    expect(sorted(neighboursOf(adj, 1))).toEqual([0]);
  });

  it("drops an edge pointing past the node count", () => {
    const adj = buildAdjacency(2, [edge(0, 5), edge(0, 1)]);
    expect(sorted(neighboursOf(adj, 0))).toEqual([1]);
  });

  it("returns empty rather than throwing for an out-of-range node", () => {
    const adj = buildAdjacency(2, [edge(0, 1)]);
    expect(neighboursOf(adj, 99)).toHaveLength(0);
    expect(neighboursOf(adj, -1)).toHaveLength(0);
  });

  it("keeps every node's slice within its own bounds on a larger graph", () => {
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 99; i++) edges.push(edge(i, i + 1));
    const adj = buildAdjacency(100, edges);
    let total = 0;
    for (let i = 0; i < 100; i++) total += neighboursOf(adj, i).length;
    expect(total).toBe(edges.length * 2);
    expect(adj.offsets[100]).toBe(edges.length * 2);
  });
});

describe("focus set", () => {
  it("is the node plus its immediate neighbours, and nothing further", () => {
    const adj = buildAdjacency(4, [edge(0, 1), edge(1, 2), edge(2, 3)]);
    expect([...focusSet(adj, 1)].sort()).toEqual([0, 1, 2]);
  });

  it("is just the node itself when it is isolated", () => {
    const adj = buildAdjacency(2, []);
    expect([...focusSet(adj, 0)]).toEqual([0]);
  });
});

describe("node lookup and openability", () => {
  it("resolves an index to its node, and null off the end", () => {
    const snapshot = { nodes: [node(0, "note", "a.md")], edges: [] };
    expect(nodeAt(snapshot, 0)?.key).toBe("a.md");
    expect(nodeAt(snapshot, 9)).toBeNull();
    expect(nodeAt(snapshot, null)).toBeNull();
    expect(nodeAt(null, 0)).toBeNull();
  });

  it("opens notes and attachments by path", () => {
    expect(openablePath(node(0, "note", "a.md"))).toBe("a.md");
    expect(openablePath(node(1, "attachment", "img.png"))).toBe("img.png");
  });

  it("does not open a ghost or a tag, which have no file behind them", () => {
    expect(openablePath(node(2, "ghost", "nowhere"))).toBeNull();
    expect(openablePath(node(3, "tag", "work"))).toBeNull();
    expect(openablePath(null)).toBeNull();
  });
});

describe("view filter", () => {
  const snapshot = {
    nodes: [
      node(0, "note", "characters/Frodo.md"),
      node(1, "note", "concepts/Tags.md"),
      node(2, "tag", "work"),
      node(3, "ghost", "nowhere"),
      node(4, "attachment", "assets/map.png"),
    ],
    edges: [],
  };

  it("shows everything by default", () => {
    expect(Array.from(visibleNodes(snapshot, DEFAULT_FILTER))).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("hides a whole kind when its toggle is off", () => {
    const filter = {
      ...DEFAULT_FILTER,
      kinds: { ...DEFAULT_FILTER.kinds, tag: false, ghost: false },
    };
    expect(Array.from(visibleNodes(snapshot, filter))).toEqual([1, 1, 0, 0, 1]);
  });

  it("scopes by a path fragment, case-insensitively", () => {
    const filter = { ...DEFAULT_FILTER, scope: "CHARACTERS/" };
    expect(Array.from(visibleNodes(snapshot, filter))).toEqual([1, 0, 0, 0, 0]);
  });

  it("ignores a blank or whitespace-only scope rather than hiding everything", () => {
    expect(countVisible(visibleNodes(snapshot, { ...DEFAULT_FILTER, scope: "   " }))).toBe(5);
  });

  it("combines kind and scope as an intersection", () => {
    const scopedOnly = { ...DEFAULT_FILTER, scope: "concepts/" };
    expect(Array.from(visibleNodes(snapshot, scopedOnly))).toEqual([
      0, 1, 0, 0, 0,
    ]);

    const alsoKindFiltered = {
      kinds: { ...DEFAULT_FILTER.kinds, note: false },
      scope: "concepts/",
    };
    expect(Array.from(visibleNodes(snapshot, alsoKindFiltered))).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it("can hide everything, and says so rather than throwing", () => {
    const filter = {
      kinds: { note: false, attachment: false, tag: false, ghost: false },
      scope: "",
    };
    expect(countVisible(visibleNodes(snapshot, filter))).toBe(0);
  });

  it("has an empty mask when there is no snapshot", () => {
    expect(visibleNodes(null, DEFAULT_FILTER)).toHaveLength(0);
  });

  it("keeps the mask index-aligned with the node array, which the flags rewrite relies on", () => {
    const mask = visibleNodes(snapshot, { ...DEFAULT_FILTER, scope: "concepts" });
    expect(mask).toHaveLength(snapshot.nodes.length);
    expect(mask[1]).toBe(1);
  });
});

describe("scope keeps the layers hanging off what it kept", () => {
  const snapshot = {
    nodes: [
      node(0, "note", "notes/Kept.md"),
      node(1, "note", "other/Dropped.md"),
      node(2, "tag", "work"),
      node(3, "ghost", "nowhere"),
      node(4, "tag", "unrelated"),
    ],
    edges: [edge(0, 2), edge(0, 3), edge(1, 4)],
  };

  it("keeps a tag attached to a scoped-in note, though its key cannot match a path", () => {
    const mask = visibleNodes(snapshot, { ...DEFAULT_FILTER, scope: "notes/" });
    expect(mask[0]).toBe(1);
    expect(mask[2]).toBe(1);
    expect(mask[3]).toBe(1);
  });

  it("still drops a tag attached only to a scoped-out note", () => {
    const mask = visibleNodes(snapshot, { ...DEFAULT_FILTER, scope: "notes/" });
    expect(mask[1]).toBe(0);
    expect(mask[4]).toBe(0);
  });

  it("does not resurrect a kind whose toggle is off", () => {
    const mask = visibleNodes(snapshot, {
      kinds: { ...DEFAULT_FILTER.kinds, tag: false },
      scope: "notes/",
    });
    expect(mask[2]).toBe(0);
    expect(mask[3]).toBe(1);
  });

  it("does not pull in another note just because it is linked", () => {
    const linked = {
      nodes: [node(0, "note", "notes/A.md"), node(1, "note", "other/B.md")],
      edges: [edge(0, 1)],
    };
    expect(Array.from(visibleNodes(linked, { ...DEFAULT_FILTER, scope: "notes/" }))).toEqual([1, 0]);
  });
});
