import type { GraphSnapshot } from "../api/ipc";
import {
  boundsOf,
  fitTo,
  pan,
  screenToWorld,
  worldToScreen,
  zoomAt,
  type Camera,
  type Viewport,
} from "./camera";
import { acquireDevice, createRenderer, sizeCanvas, type Renderer } from "./gpu";
import { FAILURE_MESSAGES } from "./gpu/device";
import { radiusFor } from "./gpu/instances";
import { buildAdjacency, type Adjacency } from "./graphModel";
import { createInstanceSource, degrees, radiiFor } from "./instanceSource";
import { buildPickGrid, hitTest, type PickGrid } from "./picking";
import { createPointerControls } from "./pointer";

export interface RenderLoopDeps {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  snapshot: () => GraphSnapshot | null;
  positions: () => Float32Array;
  theme: () => string;
  visible: () => Uint8Array;
  onFailure: (message: string | null) => void;
  onHover: (node: number | null, screen: [number, number] | null) => void;
  onActivate: (node: number) => void;
}

export interface RenderLoop {
  request: () => void;
  refilter: () => void;
  destroy: () => void;
}

export const HOVER_SLOP = 4;

export function createGraphRenderLoop(deps: RenderLoopDeps): RenderLoop {
  let renderer: Renderer | null = null;
  let disposed = false;
  let retried = false;
  let frame = 0;
  let camera: Camera = { x: 0, y: 0, zoom: 1 };
  let fitted = false;
  let lastPositions: Float32Array | null = null;
  let lastTheme = "";
  let viewport: Viewport = { width: 1, height: 1 };
  let adjacency: Adjacency = buildAdjacency(0, []);
  let grid: PickGrid | null = null;
  let hovered: number | null = null;
  let degree = degrees(0, []);
  const instances = createInstanceSource(deps.host);

  const controls = createPointerControls({
    element: deps.canvas,
    viewport: () => viewport,
    camera: () => camera,
    setCamera: (next) => {
      camera = next;
      request();
    },
    pan,
    zoomAt,
    onProbe: (screenX, screenY) => {
      const [worldX, worldY] = screenToWorld(camera, viewport, screenX, screenY);
      const hit = hitTest(
        grid,
        worldX,
        worldY,
        HOVER_SLOP / Math.max(camera.zoom, 1e-6),
      );
      if (hit === null) return null;
      return deps.visible()[hit] === 0 ? null : hit;
    },
    onHover: (node) => {
      if (node === hovered) return;
      hovered = node;
      deps.onHover(node, screenOf(node));
      reflag();
      request();
    },
    onActivate: (node) => deps.onActivate(node),
  });

  const request = () => {
    if (disposed || frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render();
    });
  };

  const resize = () => {
    const rect = deps.host.getBoundingClientRect();
    viewport = sizeCanvas(
      deps.canvas,
      rect.width,
      rect.height,
      window.devicePixelRatio || 1,
    );
    request();
  };

  const observer = new ResizeObserver(resize);
  observer.observe(deps.host);

  const uploadInstances = (snapshot: GraphSnapshot, positions: Float32Array) => {
    if (renderer === null) return;
    const payload = instances.build(
      snapshot,
      positions,
      adjacency,
      degree,
      hovered,
      deps.visible(),
    );
    renderer.setInstances(
      payload.nodes,
      payload.nodeCount,
      payload.edges,
      payload.edgeCount,
    );
  };

  const reflag = () => {
    const snapshot = deps.snapshot();
    if (snapshot === null || lastPositions === null) return;
    uploadInstances(snapshot, lastPositions);
  };

  const screenOf = (node: number | null): [number, number] | null => {
    if (node === null || lastPositions === null) return null;
    const x = lastPositions[node * 2];
    const y = lastPositions[node * 2 + 1];
    if (x === undefined || y === undefined) return null;
    return worldToScreen(camera, viewport, x, y);
  };

  const refilter = () => {
    if (hovered !== null && deps.visible()[hovered] === 0) {
      hovered = null;
      deps.onHover(null, null);
    }
    reflag();
    request();
  };

  const render = () => {
    if (renderer === null || disposed) return;
    const snapshot = deps.snapshot();
    const positions = deps.positions();
    if (snapshot === null) return;

    const theme = deps.theme();
    if (positions !== lastPositions || theme !== lastTheme) {
      const structureChanged = positions !== lastPositions;
      if (theme !== lastTheme) instances.invalidateTheme();
      lastPositions = positions;
      lastTheme = theme;
      if (structureChanged) {
        adjacency = buildAdjacency(snapshot.nodes.length, snapshot.edges);
        degree = degrees(snapshot.nodes.length, snapshot.edges);
        grid = buildPickGrid(
          positions,
          radiiFor(
            degree,
            Math.min(snapshot.nodes.length, Math.floor(positions.length / 2)),
            radiusFor,
          ),
        );
      }
      uploadInstances(snapshot, positions);
      if (!fitted && positions.length > 0) {
        camera = fitTo(boundsOf(positions), viewport);
        fitted = true;
      }
    }
    if (hovered !== null) deps.onHover(hovered, screenOf(hovered));
    renderer.draw(camera, viewport);
  };

  const onLost = (info: GPUDeviceLostInfo) => {
    if (disposed || info.reason === "destroyed") return;
    renderer?.destroy();
    renderer = null;
    if (retried) {
      deps.onFailure(FAILURE_MESSAGES.lost);
      return;
    }
    retried = true;
    void init();
  };

  const init = async () => {
    const result = await acquireDevice(deps.canvas, onLost, navigator.gpu);
    if (disposed) return;
    if (!result.ok) {
      deps.onFailure(result.detail);
      return;
    }
    deps.onFailure(null);
    renderer = createRenderer(result.gpu);
    lastPositions = null;
    lastTheme = "";
    resize();
  };

  void init();

  return {
    request,
    refilter,
    destroy: () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      controls.destroy();
      renderer?.destroy();
      renderer = null;
    },
  };
}
