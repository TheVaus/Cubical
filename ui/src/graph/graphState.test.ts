import { afterEach, describe, expect, it } from "vitest";
import { createRoot, createSignal } from "solid-js";

import type { GraphSnapshot, LayoutComplete, LayoutFrame } from "../api/ipc";
import { createGraphState, type GraphState } from "./graphState";

const flush = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function snapshotOf(nodes: number): GraphSnapshot {
  return {
    nodes: Array.from({ length: nodes }, (_, i) => ({
      id: i,
      kind: "note" as const,
      key: `n${i}.md`,
      label: `n${i}`,
    })),
    edges: [],
  };
}

interface Harness {
  state: GraphState;
  fileChanged: (vaultId: string) => void;
  snapshots: () => GraphSnapshot;
  subscribed: () => boolean;
  holdSnapshot: () => void;
  releaseSnapshot: () => void;
  setVaultId: (id: string | null) => void;
  cancelled: string[];
  snapshotsFor: string[];
  emit: (frame: LayoutFrame) => void;
  settle: (done: LayoutComplete) => void;
  fail: (e: Error) => void;
  dispose: () => void;
}

function harness(opts?: { nodes?: number }): Harness {
  let nodes = opts?.nodes ?? 2;
  let notify: ((payload: { vault_id: string }) => void) | null = null;
  let held = false;
  let release: (() => void) | null = null;
  const cancelled: string[] = [];
  const snapshotsFor: string[] = [];
  let emit: (frame: LayoutFrame) => void = () => {};
  let settle: (done: LayoutComplete) => void = () => {};
  let fail: (e: Error) => void = () => {};

  let h!: Harness;
  const d = createRoot((d) => {
    const [vaultId, setVaultId] = createSignal<string | null>("v1");
    const state = createGraphState({
      vaultId,
      snapshot: async (id) => {
        snapshotsFor.push(id);
        if (held) await new Promise<void>((r) => (release = r));
        return snapshotOf(nodes);
      },
      subscribe: async (handler) => {
        notify = handler;
        return () => {
          notify = null;
        };
      },
      debounceMs: 5,
      layout: (_id, _snap, onFrame) =>
        new Promise<LayoutComplete>((resolve, reject) => {
          emit = onFrame;
          settle = resolve;
          fail = reject;
        }),
      cancel: async (id) => {
        cancelled.push(id);
      },
    });
    h = {
      state,
      fileChanged: (vaultId) => notify?.({ vault_id: vaultId }),
      snapshots: () => snapshotOf(nodes),
      subscribed: () => notify !== null,
      holdSnapshot: () => {
        held = true;
      },
      releaseSnapshot: () => {
        held = false;
        release?.();
        release = null;
      },
      setVaultId,
      cancelled,
      snapshotsFor,
      emit: (f) => emit(f),
      settle: (c) => settle(c),
      fail: (e) => fail(e),
      dispose: d,
    };
    return d;
  });
  dispose = d;
  return h;
}

describe("graph state", () => {
  it("starts idle and holds nothing", () => {
    const h = harness();
    expect(h.state.status()).toBe("idle");
    expect(h.state.snapshot()).toBeNull();
    expect(h.state.positions()).toHaveLength(0);
  });

  it("moves through loading and laying-out to ready", async () => {
    const h = harness();
    h.state.start();
    expect(h.state.status()).toBe("loading");

    await flush();
    expect(h.state.status()).toBe("laying-out");
    expect(h.state.snapshot()?.nodes).toHaveLength(2);

    h.settle({ iterations: 300, positions: [1, 2, 3, 4] });
    await flush();
    expect(h.state.status()).toBe("ready");
    expect(Array.from(h.state.positions())).toEqual([1, 2, 3, 4]);
    expect(h.state.iteration()).toBe(300);
  });

  it("records streamed frames as they arrive", async () => {
    const h = harness();
    h.state.start();
    await flush();

    h.emit({ iteration: 10, positions: [5, 6, 7, 8] });
    expect(Array.from(h.state.positions())).toEqual([5, 6, 7, 8]);
    expect(h.state.iteration()).toBe(10);
  });

  it("cancels the running layout when stopped mid-convergence", async () => {
    const h = harness();
    h.state.start();
    await flush();
    h.emit({ iteration: 10, positions: [1, 2, 3, 4] });

    h.state.stop();
    await flush();

    expect(h.cancelled).toEqual(["v1"]);
    expect(h.state.status()).toBe("idle");
    expect(h.state.positions()).toHaveLength(0);
    expect(h.state.snapshot()).toBeNull();
  });

  it("cancels the running layout when the view unmounts", async () => {
    const h = harness();
    h.state.start();
    await flush();

    h.dispose();
    dispose = undefined;
    await flush();

    expect(h.cancelled).toEqual(["v1"]);
  });

  it("ignores frames from a superseded run", async () => {
    const h = harness();
    h.state.start();
    await flush();
    const stale = h.emit;

    h.state.stop();
    await flush();
    stale({ iteration: 99, positions: [9, 9] });

    expect(h.state.positions()).toHaveLength(0);
    expect(h.state.iteration()).toBe(0);
  });

  it("resets completely and cancels the old vault when the vault changes", async () => {
    const h = harness();
    h.state.start();
    await flush();
    h.emit({ iteration: 10, positions: [1, 2, 3, 4] });

    h.setVaultId("v2");
    h.state.start();
    await flush();

    expect(h.cancelled).toEqual(["v1"]);
    expect(h.snapshotsFor).toEqual(["v1", "v2"]);
    expect(h.state.iteration()).toBe(0);
    expect(h.state.status()).toBe("laying-out");
  });

  it("does not start without a vault, and cancels nothing", async () => {
    const h = harness();
    h.setVaultId(null);
    h.state.start();
    await flush();

    expect(h.state.status()).toBe("idle");
    expect(h.snapshotsFor).toEqual([]);
    expect(h.cancelled).toEqual([]);
  });

  it("surfaces a failure as an error rather than a stuck spinner", async () => {
    const h = harness();
    h.state.start();
    await flush();

    h.fail(new Error("index is gone"));
    await flush();

    expect(h.state.status()).toBe("error");
    expect(h.state.error()).toBe("index is gone");
  });
});

describe("liveness", () => {
  const settle = () => new Promise((r) => setTimeout(r, 40));

  async function ready(h: ReturnType<typeof harness>) {
    h.state.start();
    await flush();
    h.settle({ iterations: 300, positions: [1, 2, 3, 4] });
    await flush();
  }

  it("refetches once for a burst of changes rather than once per event", async () => {
    const h = harness();
    await ready(h);
    const before = h.snapshotsFor.length;

    for (let i = 0; i < 10; i++) h.fileChanged("v1");
    await settle();

    expect(h.snapshotsFor.length).toBe(before + 1);
  });

  it("keeps the existing positions rather than relaying out", async () => {
    const h = harness();
    await ready(h);
    expect(Array.from(h.state.positions())).toEqual([1, 2, 3, 4]);

    h.fileChanged("v1");
    await settle();

    expect(Array.from(h.state.positions())).toEqual([1, 2, 3, 4]);
    expect(h.state.status()).toBe("ready");
  });

  it("ignores a change in another vault", async () => {
    const h = harness();
    await ready(h);
    const before = h.snapshotsFor.length;

    h.fileChanged("v2");
    await settle();

    expect(h.snapshotsFor.length).toBe(before);
  });

  it("refetches nothing after stop, because there is no snapshot to reconcile", async () => {
    const h = harness();
    await ready(h);
    const before = h.snapshotsFor.length;

    h.state.stop();
    h.fileChanged("v1");
    await settle();

    expect(h.snapshotsFor.length).toBe(before);
  });

  it("detaches the watcher subscription when the view is disposed", async () => {
    const h = harness();
    await ready(h);
    expect(h.subscribed()).toBe(true);

    h.dispose();
    dispose = undefined;
    await settle();

    expect(h.subscribed()).toBe(false);
  });

  it("abandons an in-flight refetch rather than letting it resurrect a deleted node", async () => {
    const h = harness();
    await ready(h);

    h.holdSnapshot();
    h.fileChanged("v1");
    await settle();

    h.state.stop();
    h.releaseSnapshot();
    await settle();

    expect(h.state.snapshot()).toBeNull();
  });
});
