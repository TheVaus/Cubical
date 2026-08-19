import type { Camera, Viewport } from "./camera";

export interface PointerDeps {
  element: HTMLElement;
  viewport: () => Viewport;
  camera: () => Camera;
  setCamera: (camera: Camera) => void;
  pan: (camera: Camera, dx: number, dy: number) => Camera;
  zoomAt: (
    camera: Camera,
    viewport: Viewport,
    x: number,
    y: number,
    factor: number,
  ) => Camera;
}

export interface PointerControls {
  destroy: () => void;
}

export const WHEEL_SENSITIVITY = 0.0015;
export const MAX_WHEEL_STEP = 4;

export function wheelFactor(deltaY: number, ctrlKey: boolean): number {
  if (!Number.isFinite(deltaY)) return 1;
  const scaled = (ctrlKey ? deltaY * 4 : deltaY) * WHEEL_SENSITIVITY;
  const limit = Math.log(MAX_WHEEL_STEP);
  return Math.exp(Math.min(limit, Math.max(-limit, -scaled)));
}

export function devicePoint(
  event: { clientX: number; clientY: number },
  rect: { left: number; top: number },
  dpr: number,
): [number, number] {
  return [(event.clientX - rect.left) * dpr, (event.clientY - rect.top) * dpr];
}

export function createPointerControls(deps: PointerDeps): PointerControls {
  const { element } = deps;
  let dragging: number | null = null;
  let lastX = 0;
  let lastY = 0;

  const dpr = () => window.devicePixelRatio || 1;

  const onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = e.pointerId;
    lastX = e.clientX;
    lastY = e.clientY;
    element.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (dragging !== e.pointerId) return;
    const scale = dpr();
    deps.setCamera(
      deps.pan(deps.camera(), (e.clientX - lastX) * scale, (e.clientY - lastY) * scale),
    );
    lastX = e.clientX;
    lastY = e.clientY;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (dragging !== e.pointerId) return;
    dragging = null;
    if (element.hasPointerCapture(e.pointerId)) {
      element.releasePointerCapture(e.pointerId);
    }
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = devicePoint(e, element.getBoundingClientRect(), dpr());
    deps.setCamera(
      deps.zoomAt(deps.camera(), deps.viewport(), x, y, wheelFactor(e.deltaY, e.ctrlKey)),
    );
  };

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerUp);
  element.addEventListener("pointercancel", onPointerUp);
  element.addEventListener("wheel", onWheel, { passive: false });

  return {
    destroy: () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerUp);
      element.removeEventListener("wheel", onWheel);
    },
  };
}
