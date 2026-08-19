import type { GraphSnapshot } from "../api/ipc";
import { boundsOf, fitTo, pan, zoomAt, type Camera, type Viewport } from "./camera";
import {
  acquireDevice,
  buildEdgeInstances,
  buildNodeInstances,
  createRenderer,
  degrees,
  edgeInstanceCount,
  readPalette,
  sizeCanvas,
  type Renderer,
} from "./gpu";
import { FAILURE_MESSAGES } from "./gpu/device";
import { createPointerControls } from "./pointer";

export interface RenderLoopDeps {
  canvas: HTMLCanvasElement;
  host: HTMLElement;
  snapshot: () => GraphSnapshot | null;
  positions: () => Float32Array;
  theme: () => string;
  onFailure: (message: string | null) => void;
}

export interface RenderLoop {
  request: () => void;
  destroy: () => void;
}

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

  const render = () => {
    if (renderer === null || disposed) return;
    const snapshot = deps.snapshot();
    const positions = deps.positions();
    if (snapshot === null) return;

    const theme = deps.theme();
    if (positions !== lastPositions || theme !== lastTheme) {
      lastPositions = positions;
      lastTheme = theme;
      const palette = readPalette(deps.host);
      const degree = degrees(snapshot.nodes.length, snapshot.edges);
      renderer.setInstances(
        buildNodeInstances(snapshot.nodes, positions, degree, palette),
        Math.min(snapshot.nodes.length, Math.floor(positions.length / 2)),
        buildEdgeInstances(snapshot.edges, positions, palette),
        edgeInstanceCount(snapshot.edges, positions),
      );
      if (!fitted && positions.length > 0) {
        camera = fitTo(boundsOf(positions), viewport);
        fitted = true;
      }
    }
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
    const result = await acquireDevice(deps.canvas, onLost);
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
