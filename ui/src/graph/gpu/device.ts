export type DeviceFailure =
  | "unsupported"
  | "no-adapter"
  | "no-device"
  | "no-context"
  | "lost";

export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export interface DeviceResult {
  ok: true;
  gpu: GpuContext;
}

export interface DeviceError {
  ok: false;
  reason: DeviceFailure;
  detail: string;
}

export const FAILURE_MESSAGES: Record<DeviceFailure, string> = {
  unsupported: "This build's webview does not expose WebGPU.",
  "no-adapter": "No WebGPU adapter is available on this machine.",
  "no-device": "A WebGPU adapter was found but would not open a device.",
  "no-context": "The canvas would not give a WebGPU context.",
  lost: "The WebGPU device was lost and could not be restored.",
};

function fail(reason: DeviceFailure, detail = ""): DeviceError {
  return { ok: false, reason, detail: detail || FAILURE_MESSAGES[reason] };
}

export async function acquireDevice(
  canvas: HTMLCanvasElement,
  onLost: (info: GPUDeviceLostInfo) => void,
  navigatorGpu: GPU | undefined = navigator.gpu,
): Promise<DeviceResult | DeviceError> {
  if (navigatorGpu === undefined) return fail("unsupported");

  let adapter: GPUAdapter | null;
  try {
    adapter = await navigatorGpu.requestAdapter();
  } catch (e) {
    return fail("no-adapter", e instanceof Error ? e.message : String(e));
  }
  if (adapter === null) return fail("no-adapter");

  let device: GPUDevice;
  try {
    device = await adapter.requestDevice();
  } catch (e) {
    return fail("no-device", e instanceof Error ? e.message : String(e));
  }

  const context = canvas.getContext("webgpu") as GPUCanvasContext | null;
  if (context === null) return fail("no-context");

  const format = navigatorGpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  void device.lost.then(onLost);

  return { ok: true, gpu: { device, context, format } };
}

export function sizeCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): { width: number; height: number } {
  const limit = 8192;
  const width = Math.max(1, Math.min(limit, Math.floor(cssWidth * dpr)));
  const height = Math.max(1, Math.min(limit, Math.floor(cssHeight * dpr)));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height };
}
