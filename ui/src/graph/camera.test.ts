import { describe, expect, it } from "vitest";

import {
  boundsOf,
  clampZoom,
  fitTo,
  MAX_ZOOM,
  MIN_ZOOM,
  ORIGIN,
  pan,
  screenToWorld,
  viewUniform,
  worldToScreen,
  zoomAt,
  type Camera,
  type Viewport,
} from "./camera";

const view: Viewport = { width: 800, height: 600 };
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 4);

describe("camera transforms", () => {
  it("puts the camera position at the centre of the viewport", () => {
    const c: Camera = { x: 100, y: 50, zoom: 2 };
    const [sx, sy] = worldToScreen(c, view, 100, 50);
    near(sx, 400);
    near(sy, 300);
  });

  it("round-trips screen to world and back at any zoom", () => {
    for (const zoom of [0.25, 1, 3.5]) {
      const c: Camera = { x: -30, y: 90, zoom };
      const [wx, wy] = screenToWorld(c, view, 123, 456);
      const [sx, sy] = worldToScreen(c, view, wx, wy);
      near(sx, 123);
      near(sy, 456);
    }
  });

  it("pans by exactly the screen delta, in world units", () => {
    const c: Camera = { x: 0, y: 0, zoom: 2 };
    const [beforeX, beforeY] = worldToScreen(c, view, 10, 10);
    const moved = pan(c, 40, -20);
    const [afterX, afterY] = worldToScreen(moved, view, 10, 10);
    near(afterX, beforeX + 40);
    near(afterY, beforeY - 20);
  });

  it("keeps the world point under the cursor fixed while zooming", () => {
    const c: Camera = { x: 12, y: -7, zoom: 1.5 };
    const cursor: [number, number] = [610, 122];
    const before = screenToWorld(c, view, ...cursor);

    const zoomed = zoomAt(c, view, ...cursor, 2.5);
    const after = screenToWorld(zoomed, view, ...cursor);

    near(after[0], before[0]);
    near(after[1], before[1]);
    near(zoomed.zoom, 1.5 * 2.5);
  });

  it("clamps zoom at both ends rather than inverting or vanishing", () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-4)).toBe(MIN_ZOOM);
    expect(clampZoom(1e9)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(zoomAt(ORIGIN, view, 0, 0, 1e9).zoom).toBe(MAX_ZOOM);
    expect(zoomAt(ORIGIN, view, 0, 0, 1e-9).zoom).toBe(MIN_ZOOM);
  });
});

describe("bounds and fit", () => {
  it("finds the bounding box of a flat position array", () => {
    const b = boundsOf(new Float32Array([0, 0, 10, -4, -6, 8]));
    expect(b).toEqual({ minX: -6, minY: -4, maxX: 10, maxY: 8 });
  });

  it("has no bounds for an empty graph", () => {
    expect(boundsOf(new Float32Array(0))).toBeNull();
  });

  it("ignores non-finite positions rather than poisoning the box", () => {
    const b = boundsOf(new Float32Array([0, 0, Number.NaN, Infinity, 4, 4]));
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 4 });
  });

  it("centres the graph and fits it inside the padding", () => {
    const c = fitTo({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, view, 40);
    near(c.x, 50);
    near(c.y, 50);

    const [left] = worldToScreen(c, view, 0, 0);
    const [right] = worldToScreen(c, view, 100, 0);
    expect(left).toBeGreaterThanOrEqual(39.9);
    expect(right).toBeLessThanOrEqual(view.width - 39.9);
  });

  it("falls back to the origin when there is nothing to fit", () => {
    expect(fitTo(null, view)).toEqual(ORIGIN);
  });

  it("survives a single node, where the span is zero", () => {
    const c = fitTo({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, view);
    expect(Number.isFinite(c.x)).toBe(true);
    expect(c.zoom).toBeLessThanOrEqual(MAX_ZOOM);
    expect(c.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
  });
});

describe("view uniform", () => {
  it("maps the camera centre to clip-space origin", () => {
    const c: Camera = { x: 20, y: 30, zoom: 2 };
    const u = viewUniform(c, view);
    near((20 - u[2]!) * u[0]!, 0);
    near((30 - u[3]!) * u[1]!, 0);
  });

  it("maps a world point to the same clip coordinate the screen math implies", () => {
    const c: Camera = { x: 20, y: 30, zoom: 2 };
    const u = viewUniform(c, view);
    const clipX = (75 - u[2]!) * u[0]!;
    const [screenX] = worldToScreen(c, view, 75, 0);
    near(clipX, (screenX / view.width) * 2 - 1);
  });

  it("flips y, because clip space points up and the screen points down", () => {
    const u = viewUniform(ORIGIN, view);
    expect(u[0]!).toBeGreaterThan(0);
    expect(u[1]!).toBeLessThan(0);
  });

  it("carries zoom so the shader can size a node in pixels", () => {
    expect(viewUniform({ x: 0, y: 0, zoom: 3 }, view)[4]).toBe(3);
  });

  it("does not divide by zero on a zero-sized viewport", () => {
    const u = viewUniform(ORIGIN, { width: 0, height: 0 });
    expect(u.every((v) => Number.isFinite(v))).toBe(true);
  });
});
