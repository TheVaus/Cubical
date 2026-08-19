import type { GraphSnapshot } from "../api/ipc";
import { buildAdjacency, neighboursOf } from "./graphModel";

export const NEW_NODE_SPREAD = 30;

export function positionKey(snapshot: GraphSnapshot, index: number): string {
  const node = snapshot.nodes[index];
  return node === undefined ? "" : `${node.kind}:${node.key}`;
}

export function positionsByKey(
  snapshot: GraphSnapshot,
  positions: Float32Array,
): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>();
  const count = Math.min(snapshot.nodes.length, Math.floor(positions.length / 2));
  for (let i = 0; i < count; i++) {
    map.set(positionKey(snapshot, i), [positions[i * 2]!, positions[i * 2 + 1]!]);
  }
  return map;
}

function jitter(seed: number, spread: number): [number, number] {
  const a = Math.sin(seed * 12.9898) * 43758.5453;
  const b = Math.sin(seed * 78.233) * 24634.6345;
  return [(a - Math.floor(a) - 0.5) * spread, (b - Math.floor(b) - 0.5) * spread];
}

export function reconcilePositions(
  next: GraphSnapshot,
  known: Map<string, [number, number]>,
  spread = NEW_NODE_SPREAD,
): Float32Array {
  const count = next.nodes.length;
  const out = new Float32Array(count * 2);
  const placed = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const at = known.get(positionKey(next, i));
    if (at === undefined) continue;
    out[i * 2] = at[0];
    out[i * 2 + 1] = at[1];
    placed[i] = 1;
  }

  const adjacency = buildAdjacency(count, next.edges);
  for (let i = 0; i < count; i++) {
    if (placed[i] === 1) continue;
    let sumX = 0;
    let sumY = 0;
    let seen = 0;
    for (const n of neighboursOf(adjacency, i)) {
      if (placed[n] !== 1) continue;
      sumX += out[n * 2]!;
      sumY += out[n * 2 + 1]!;
      seen += 1;
    }
    const [dx, dy] = jitter(i + 1, spread);
    if (seen > 0) {
      out[i * 2] = sumX / seen + dx;
      out[i * 2 + 1] = sumY / seen + dy;
    } else {
      out[i * 2] = dx;
      out[i * 2 + 1] = dy;
    }
  }

  return out;
}
