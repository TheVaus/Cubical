import type { GraphEdge } from "../api/ipc";
import { FLAG_DIMMED, FLAG_FOCUSED, FLAG_HIDDEN } from "./gpu/instances";
import type { Adjacency } from "./graphModel";
import { focusSet } from "./graphModel";

export function nodeFlags(
  nodeCount: number,
  adjacency: Adjacency,
  hovered: number | null,
  visible?: Uint8Array,
): Uint8Array {
  const flags = new Uint8Array(nodeCount);
  const focus = hovered === null ? null : focusSet(adjacency, hovered);
  for (let i = 0; i < nodeCount; i++) {
    if (visible !== undefined && visible[i] === 0) {
      flags[i] = FLAG_HIDDEN;
      continue;
    }
    if (focus !== null) flags[i] = focus.has(i) ? 0 : FLAG_DIMMED;
  }
  if (
    hovered !== null &&
    hovered >= 0 &&
    hovered < nodeCount &&
    flags[hovered] !== FLAG_HIDDEN
  ) {
    flags[hovered] = FLAG_FOCUSED;
  }
  return flags;
}

export function edgeFlags(
  edges: GraphEdge[],
  hovered: number | null,
  visible?: Uint8Array,
): Uint8Array {
  const flags = new Uint8Array(edges.length);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (
      visible !== undefined &&
      (visible[e.source] === 0 || visible[e.target] === 0)
    ) {
      flags[i] = FLAG_HIDDEN;
      continue;
    }
    if (hovered === null) continue;
    flags[i] = e.source === hovered || e.target === hovered ? 0 : FLAG_DIMMED;
  }
  return flags;
}
