import type { GraphEdge, GraphNode, GraphSnapshot } from "../api/ipc";

export interface Adjacency {
  offsets: Uint32Array;
  neighbours: Uint32Array;
}

export function buildAdjacency(
  nodeCount: number,
  edges: GraphEdge[],
): Adjacency {
  const counts = new Uint32Array(nodeCount);
  const usable: GraphEdge[] = [];
  for (const e of edges) {
    if (e.source >= nodeCount || e.target >= nodeCount) continue;
    usable.push(e);
    counts[e.source]! += 1;
    counts[e.target]! += 1;
  }

  const offsets = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) {
    offsets[i + 1] = offsets[i]! + counts[i]!;
  }

  const cursor = Uint32Array.from(offsets.subarray(0, nodeCount));
  const neighbours = new Uint32Array(offsets[nodeCount]!);
  for (const e of usable) {
    neighbours[cursor[e.source]!++] = e.target;
    neighbours[cursor[e.target]!++] = e.source;
  }

  return { offsets, neighbours };
}

export function neighboursOf(
  adjacency: Adjacency,
  node: number,
): Uint32Array {
  if (node < 0 || node + 1 >= adjacency.offsets.length) {
    return new Uint32Array(0);
  }
  return adjacency.neighbours.subarray(
    adjacency.offsets[node]!,
    adjacency.offsets[node + 1]!,
  );
}

export function focusSet(adjacency: Adjacency, node: number): Set<number> {
  const set = new Set<number>([node]);
  for (const n of neighboursOf(adjacency, node)) set.add(n);
  return set;
}

export function nodeAt(
  snapshot: GraphSnapshot | null,
  index: number | null,
): GraphNode | null {
  if (snapshot === null || index === null) return null;
  return snapshot.nodes[index] ?? null;
}

export function openablePath(node: GraphNode | null): string | null {
  if (node === null) return null;
  if (node.kind === "note" || node.kind === "attachment") return node.key;
  return null;
}
