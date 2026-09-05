import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearPerfSamples,
  installPerfConsole,
  isOverFrameBudget,
  measurePerf,
  measurePerfAsync,
  perfEnabled,
  perfEnabledFor,
  perfSamples,
  pushSample,
  recordPerf,
  roundMs,
  setPerfEnabled,
  PERF_FRAME_BUDGET_MS,
  PERF_SAMPLE_LIMIT,
  type PerfSample,
} from "./perf";

const sample = (name: string): PerfSample => ({ name, durationMs: 1, at: 0 });

describe("perf policy", () => {
  it("keeps two decimal places so a sub-millisecond cost is still visible", () => {
    expect(roundMs(0.123456)).toBe(0.12);
    expect(roundMs(12.3456)).toBe(12.35);
  });

  it("counts a frame's worth of work as over budget", () => {
    expect(isOverFrameBudget(PERF_FRAME_BUDGET_MS)).toBe(true);
    expect(isOverFrameBudget(PERF_FRAME_BUDGET_MS - 0.01)).toBe(false);
  });

  it("is on in dev and off in production unless the flag is set", () => {
    expect(perfEnabledFor(true, null)).toBe(true);
    expect(perfEnabledFor(false, null)).toBe(false);
    expect(perfEnabledFor(false, "1")).toBe(true);
    expect(perfEnabledFor(false, "0")).toBe(false);
  });

  it("drops the oldest sample past the limit", () => {
    const full = Array.from({ length: PERF_SAMPLE_LIMIT }, (_, i) => sample(`s${i}`));
    const next = pushSample(full, sample("newest"));
    expect(next).toHaveLength(PERF_SAMPLE_LIMIT);
    expect(next[next.length - 1]?.name).toBe("newest");
    expect(next[0]?.name).toBe("s1");
  });
});

describe("perf recording", () => {
  beforeEach(() => {
    setPerfEnabled(true);
    clearPerfSamples();
  });

  afterEach(() => {
    setPerfEnabled(false);
  });

  it("records a named sample", () => {
    recordPerf("scan", 3);
    expect(perfSamples().map((s) => s.name)).toEqual(["scan"]);
  });

  it("records nothing while disabled", () => {
    setPerfEnabled(false);
    recordPerf("scan", 3);
    expect(perfSamples()).toEqual([]);
  });

  it("logs only what blew the frame budget", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    recordPerf("fast", 1);
    expect(debug).not.toHaveBeenCalled();
    recordPerf("slow", PERF_FRAME_BUDGET_MS + 1);
    expect(debug).toHaveBeenCalledOnce();
    debug.mockRestore();
  });

  it("measurePerf returns the value and times the call", () => {
    expect(measurePerf("work", () => 42)).toBe(42);
    expect(perfSamples().map((s) => s.name)).toEqual(["work"]);
  });

  it("measurePerf records even when the call throws", () => {
    expect(() =>
      measurePerf("work", () => {
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(perfSamples().map((s) => s.name)).toEqual(["work"]);
  });

  it("measurePerf stays out of the way while disabled", () => {
    setPerfEnabled(false);
    expect(measurePerf("work", () => 42)).toBe(42);
    expect(perfSamples()).toEqual([]);
  });

  it("measurePerfAsync resolves through and records once settled", async () => {
    await expect(measurePerfAsync("io", async () => "done")).resolves.toBe("done");
    expect(perfSamples().map((s) => s.name)).toEqual(["io"]);
  });

  it("measurePerfAsync records a rejection too", async () => {
    await expect(
      measurePerfAsync("io", () => Promise.reject(new Error("nope"))),
    ).rejects.toThrow("nope");
    expect(perfSamples().map((s) => s.name)).toEqual(["io"]);
  });

  it("hands the console a live view, not a snapshot", () => {
    const target = {} as Window;
    installPerfConsole(target);
    recordPerf("scan", 3);
    expect(target.__CUBICAL_PERF__?.samples().map((s) => s.name)).toEqual(["scan"]);
    expect(target.__CUBICAL_PERF__?.enabled()).toBe(true);
    target.__CUBICAL_PERF__?.clear();
    expect(target.__CUBICAL_PERF__?.samples()).toEqual([]);
  });

  it("clears what it collected when it is turned off", () => {
    recordPerf("scan", 3);
    setPerfEnabled(false);
    expect(perfEnabled()).toBe(false);
    expect(perfSamples()).toEqual([]);
  });
});
