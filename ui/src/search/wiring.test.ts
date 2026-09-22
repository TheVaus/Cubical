import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";

import { createSearchState } from "./searchState";
import { createSearchWiring } from "./wiring";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.useRealTimers();
});

function harness(initial: boolean) {
  vi.useFakeTimers();
  const readStatus = vi.fn(async () => ({
    state: "building" as const,
    indexed_files: 0,
    total_files: 1,
    last_commit_secs: null,
  }));
  const runSearch = vi.fn();
  let out!: {
    state: ReturnType<typeof createSearchWiring>;
    setEnabled: (on: boolean) => void;
  };
  dispose = createRoot((d) => {
    const [enabled, setEnabled] = createSignal(initial);
    const state = createSearchWiring({
      vaultId: () => "v1",
      refreshSignal: () => 0,
      corePlugins: () => ({ search: enabled() }),
      create: (deps) =>
        createSearchState({
          ...deps,
          runSearch: runSearch as never,
          readStatus: readStatus as never,
        }),
    });
    out = { state, setEnabled };
    return d;
  });
  return { ...out, readStatus };
}

describe("search wiring", () => {
  it("builds no search state while the plugin is off", async () => {
    const h = harness(false);
    expect(h.state()).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.readStatus).not.toHaveBeenCalled();
  });

  it("stops polling the index status once the plugin is switched off", async () => {
    const h = harness(true);
    expect(h.state()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    const polled = h.readStatus.mock.calls.length;
    expect(polled).toBeGreaterThan(0);

    h.setEnabled(false);
    expect(h.state()).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.readStatus).toHaveBeenCalledTimes(polled);
  });

  it("starts from an empty query when switched back on", () => {
    const h = harness(true);
    h.state()?.input("alpha");
    h.setEnabled(false);
    h.setEnabled(true);
    expect(h.state()?.queryText()).toBe("");
  });
});
