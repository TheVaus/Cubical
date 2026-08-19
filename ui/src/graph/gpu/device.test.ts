import { describe, expect, it } from "vitest";

import { FAILURE_MESSAGES, acquireDevice } from "./device";

const canvas = () => ({}) as HTMLCanvasElement;
const noop = () => {};

describe("acquiring a device on a webview that cannot", () => {
  it("reports unsupported when the webview exposes no WebGPU at all", async () => {
    const result = await acquireDevice(canvas(), noop, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unsupported");
      expect(result.detail).toBe(FAILURE_MESSAGES.unsupported);
    }
  });

  it("reports no-adapter when the machine offers none", async () => {
    const gpu = {
      requestAdapter: async () => null,
    } as unknown as GPU;
    const result = await acquireDevice(canvas(), noop, gpu);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-adapter");
  });

  it("carries the thrown message rather than swallowing it", async () => {
    const gpu = {
      requestAdapter: async () => {
        throw new Error("adapter exploded");
      },
    } as unknown as GPU;
    const result = await acquireDevice(canvas(), noop, gpu);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe("adapter exploded");
  });

  it("reports no-device when an adapter will not open one", async () => {
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => {
          throw new Error("device refused");
        },
      }),
    } as unknown as GPU;
    const result = await acquireDevice(canvas(), noop, gpu);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-device");
  });

  it("reports no-context when the canvas will not give a webgpu context", async () => {
    const gpu = {
      requestAdapter: async () => ({
        requestDevice: async () => ({
          lost: new Promise(() => {}),
          addEventListener: noop,
        }),
      }),
    } as unknown as GPU;
    const element = { getContext: () => null } as unknown as HTMLCanvasElement;
    const result = await acquireDevice(element, noop, gpu);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no-context");
  });

  it("has a message for every failure it can report", () => {
    for (const message of Object.values(FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
