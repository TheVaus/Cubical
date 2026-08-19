import type { GraphEdge } from "../api/ipc";
import { FLAG_DIMMED, FLAG_FOCUSED } from "./gpu/instances";
import type { Adjacency } from "./graphModel";
import { focusSet } from "./graphModel";

export function nodeFlags(
  nodeCount: number,
  adjacency: Adjacency,
  hovered: number | null,
): Uint8Array {
  const flags = new Uint8Array(nodeCount);
  if (hovered === null) return flags;
  const focus = focusSet(adjacency, hovered);
  for (let i = 0; i < nodeCount; i++) {
    flags[i] = focus.has(i) ? 0 : FLAG_DIMMED;
  }
  if (hovered >= 0 && hovered < nodeCount) flags[hovered] = FLAG_FOCUSED;
  return flags;
}

export function edgeFlags(
  edges: GraphEdge[],
  hovered: number | null,
): Uint8Array {
  const flags = new Uint8Array(edges.length);
  if (hovered === null) return flags;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    flags[i] = e.source === hovered || e.target === hovered ? 0 : FLAG_DIMMED;
  }
  return flags;
}
