export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 40;

export const ORIGIN: Camera = { x: 0, y: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function screenToWorld(
  camera: Camera,
  viewport: Viewport,
  screenX: number,
  screenY: number,
): [number, number] {
  const zoom = clampZoom(camera.zoom);
  return [
    camera.x + (screenX - viewport.width / 2) / zoom,
    camera.y + (screenY - viewport.height / 2) / zoom,
  ];
}

export function worldToScreen(
  camera: Camera,
  viewport: Viewport,
  worldX: number,
  worldY: number,
): [number, number] {
  const zoom = clampZoom(camera.zoom);
  return [
    (worldX - camera.x) * zoom + viewport.width / 2,
    (worldY - camera.y) * zoom + viewport.height / 2,
  ];
}

export function pan(camera: Camera, dxScreen: number, dyScreen: number): Camera {
  const zoom = clampZoom(camera.zoom);
  return {
    x: camera.x - dxScreen / zoom,
    y: camera.y - dyScreen / zoom,
    zoom,
  };
}

export function zoomAt(
  camera: Camera,
  viewport: Viewport,
  screenX: number,
  screenY: number,
  factor: number,
): Camera {
  const [worldX, worldY] = screenToWorld(camera, viewport, screenX, screenY);
  const zoom = clampZoom(camera.zoom * factor);
  return {
    x: worldX - (screenX - viewport.width / 2) / zoom,
    y: worldY - (screenY - viewport.height / 2) / zoom,
    zoom,
  };
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOf(positions: Float32Array): Bounds | null {
  if (positions.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < positions.length; i += 2) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function fitTo(
  bounds: Bounds | null,
  viewport: Viewport,
  padding = 40,
): Camera {
  if (bounds === null) return ORIGIN;
  const x = (bounds.minX + bounds.maxX) / 2;
  const y = (bounds.minY + bounds.maxY) / 2;
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const usableW = Math.max(viewport.width - padding * 2, 1);
  const usableH = Math.max(viewport.height - padding * 2, 1);
  const zoom = clampZoom(Math.min(usableW / spanX, usableH / spanY));
  return { x, y, zoom };
}

export function viewUniform(
  camera: Camera,
  viewport: Viewport,
): Float32Array {
  const zoom = clampZoom(camera.zoom);
  const width = Math.max(viewport.width, 1);
  const height = Math.max(viewport.height, 1);
  return new Float32Array([
    (2 * zoom) / width,
    (-2 * zoom) / height,
    camera.x,
    camera.y,
    zoom,
    0,
    0,
    0,
  ]);
}
