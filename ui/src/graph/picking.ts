export interface PickGrid {
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  buckets: Uint32Array[];
  positions: Float32Array;
  radii: Float32Array;
}

export const MIN_CELL = 1e-3;
export const TARGET_PER_CELL = 2;

export function buildPickGrid(
  positions: Float32Array,
  radii: Float32Array,
): PickGrid | null {
  const count = Math.min(Math.floor(positions.length / 2), radii.length);
  if (count === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxRadius = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    maxRadius = Math.max(maxRadius, radii[i] ?? 0);
  }
  if (!Number.isFinite(minX)) return null;

  const spanX = Math.max(maxX - minX, MIN_CELL);
  const spanY = Math.max(maxY - minY, MIN_CELL);
  const target = Math.max(1, Math.ceil(Math.sqrt(count / TARGET_PER_CELL)));
  const cell = Math.max(
    Math.max(spanX, spanY) / target,
    maxRadius * 2,
    MIN_CELL,
  );
  const cols = Math.max(1, Math.ceil(spanX / cell) + 1);
  const rows = Math.max(1, Math.ceil(spanY / cell) + 1);

  const cellOf = (i: number): number => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((positions[i * 2]! - minX) / cell)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((positions[i * 2 + 1]! - minY) / cell)));
    return cy * cols + cx;
  };

  const members: number[][] = [];
  for (let i = 0; i < cols * rows; i++) members.push([]);
  for (let i = 0; i < count; i++) {
    const x = positions[i * 2]!;
    const y = positions[i * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const index = cellOf(i);
    members[index]!.push(i);
  }

  return {
    cell,
    minX,
    minY,
    cols,
    rows,
    buckets: members.map((m) => Uint32Array.from(m)),
    positions,
    radii,
  };
}

export function hitTest(
  grid: PickGrid | null,
  worldX: number,
  worldY: number,
  slop = 0,
): number | null {
  if (grid === null) return null;
  const cx = Math.floor((worldX - grid.minX) / grid.cell);
  const cy = Math.floor((worldY - grid.minY) / grid.cell);

  let best: number | null = null;
  let bestDistance = Infinity;

  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    if (gy < 0 || gy >= grid.rows) continue;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      if (gx < 0 || gx >= grid.cols) continue;
      for (const i of grid.buckets[gy * grid.cols + gx]!) {
        const dx = grid.positions[i * 2]! - worldX;
        const dy = grid.positions[i * 2 + 1]! - worldY;
        const distance = Math.hypot(dx, dy);
        const reach = (grid.radii[i] ?? 0) + slop;
        if (distance <= reach && distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}
