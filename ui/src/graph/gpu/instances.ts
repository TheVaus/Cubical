import type { GraphEdge, GraphNode, GraphNodeKind } from "../../api/ipc";

export const NODE_STRIDE_BYTES = 20;
export const EDGE_STRIDE_BYTES = 24;

export const FLAG_DIMMED = 1;
export const FLAG_FOCUSED = 2;

export const BASE_RADIUS = 3;

export type Palette = Record<GraphNodeKind, number> & { edge: number };

export function packRgba(r: number, g: number, b: number, a: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    ((c(r) << 24) | (c(g) << 16) | (c(b) << 8) | c(a * 255)) >>> 0
  );
}

export function radiusFor(degree: number): number {
  return BASE_RADIUS * Math.sqrt(degree + 1);
}

export function degrees(nodeCount: number, edges: GraphEdge[]): Uint32Array {
  const out = new Uint32Array(nodeCount);
  for (const e of edges) {
    if (e.source < nodeCount) out[e.source]! += 1;
    if (e.target < nodeCount) out[e.target]! += 1;
  }
  return out;
}

export function buildNodeInstances(
  nodes: GraphNode[],
  positions: Float32Array,
  degree: Uint32Array,
  palette: Palette,
  flags?: Uint8Array,
): ArrayBuffer {
  const count = Math.min(nodes.length, Math.floor(positions.length / 2));
  const data = new ArrayBuffer(count * NODE_STRIDE_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  for (let i = 0; i < count; i++) {
    const w = i * 5;
    f32[w] = positions[i * 2]!;
    f32[w + 1] = positions[i * 2 + 1]!;
    f32[w + 2] = radiusFor(degree[i] ?? 0);
    u32[w + 3] = palette[nodes[i]!.kind];
    u32[w + 4] = flags?.[i] ?? 0;
  }
  return data;
}

export function buildEdgeInstances(
  edges: GraphEdge[],
  positions: Float32Array,
  palette: Palette,
  flags?: Uint8Array,
): ArrayBuffer {
  const nodeCount = Math.floor(positions.length / 2);
  const kept: number[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    if (e.source < nodeCount && e.target < nodeCount) kept.push(i);
  }
  const data = new ArrayBuffer(kept.length * EDGE_STRIDE_BYTES);
  const f32 = new Float32Array(data);
  const u32 = new Uint32Array(data);
  for (let i = 0; i < kept.length; i++) {
    const source = kept[i]!;
    const e = edges[source]!;
    const w = i * 6;
    f32[w] = positions[e.source * 2]!;
    f32[w + 1] = positions[e.source * 2 + 1]!;
    f32[w + 2] = positions[e.target * 2]!;
    f32[w + 3] = positions[e.target * 2 + 1]!;
    u32[w + 4] = palette.edge;
    u32[w + 5] = flags?.[source] ?? 0;
  }
  return data;
}

export function edgeInstanceCount(
  edges: GraphEdge[],
  positions: Float32Array,
): number {
  const nodeCount = Math.floor(positions.length / 2);
  return edges.filter((e) => e.source < nodeCount && e.target < nodeCount)
    .length;
}
