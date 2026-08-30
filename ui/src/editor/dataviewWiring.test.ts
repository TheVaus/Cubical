import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

import { createDataviewRunner, type DataviewRunner } from "./dataview";
import { createDataviewWiring } from "./dataviewWiring";
import type { DataviewResult } from "../api/ipc";

const flush = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

interface Harness {
  runner: () => DataviewRunner | null;
  setEnabled: (on: boolean) => void;
  setVaultId: (id: string | null) => void;
  ipc: ReturnType<typeof vi.fn>;
}

function harness(opts?: { enabled?: boolean; vaultId?: string | null }): Harness {
  let h!: Harness;
  const ipc = vi.fn(
    async (): Promise<DataviewResult> => ({ kind: "count", count: 1 }),
  );
  dispose = createRoot((d) => {
    const [enabled, setEnabled] = createSignal(opts?.enabled ?? true);
    const [vaultId, setVaultId] = createSignal<string | null>(
      opts?.vaultId === undefined ? "v1" : opts.vaultId,
    );
    const runner = createDataviewWiring({
      vaultId,
      corePlugins: () => ({ dataview: enabled() }),
      onOpen: () => {},
      create: (id, onOpen) => createDataviewRunner(id, onOpen, ipc),
    });
    h = { runner, setEnabled, setVaultId, ipc };
    return d;
  });
  return h;
}

describe("dataview wiring", () => {
  it("has no runner without a vault", () => {
    expect(harness({ vaultId: null }).runner()).toBeNull();
  });

  it("has no runner while the plugin is off", () => {
    expect(harness({ enabled: false }).runner()).toBeNull();
  });

  it("stops issuing queries once the plugin is switched off", async () => {
    const h = harness();
    const runner = h.runner();
    runner?.fetch("tag:#a");
    await flush();
    expect(h.ipc).toHaveBeenCalledTimes(1);

    h.setEnabled(false);
    expect(h.runner()).toBeNull();
    h.runner()?.invalidate();
    await flush();
    expect(h.ipc).toHaveBeenCalledTimes(1);
  });

  it("drops the cache so switching back on re-queries", async () => {
    const h = harness();
    h.runner()?.fetch("tag:#a");
    await flush();
    const first = h.runner();

    h.setEnabled(false);
    h.setEnabled(true);
    const second = h.runner();
    expect(second).not.toBe(first);
    expect(second?.get("tag:#a")).toBeUndefined();

    second?.fetch("tag:#a");
    await flush();
    expect(h.ipc).toHaveBeenCalledTimes(2);
  });

  it("builds a runner for the vault that is open now", () => {
    const h = harness();
    const first = h.runner();
    h.setVaultId("v2");
    expect(h.runner()).not.toBe(first);
  });
});
