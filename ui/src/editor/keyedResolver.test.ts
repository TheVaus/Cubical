import { afterEach, describe, expect, it, vi } from "vitest";

import { createKeyedResolver } from "./keyedResolver";

const flush = () => new Promise((r) => setTimeout(r, 0));

function stringResolver(value = "v") {
  return createKeyedResolver<string, string>({
    cacheKey: (k) => k,
    load: () => Promise.resolve(value),
    onFailure: () => "failed",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("subscriber isolation", () => {
  it("notifies every subscriber even when an earlier one throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = stringResolver();
    const after = vi.fn();
    r.onUpdate(() => {
      throw new Error("bad subscriber");
    });
    r.onUpdate(after);

    r.fetch("a");
    await flush();

    expect(after).toHaveBeenCalledTimes(1);
    expect(r.get("a")).toBe("v");
  });

  it("keeps invalidate working when a subscriber throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = stringResolver();
    const after = vi.fn();
    r.onUpdate(() => {
      throw new Error("bad subscriber");
    });
    r.onUpdate(after);

    r.invalidate();

    expect(after).toHaveBeenCalledTimes(1);
  });

  it("isolates event subscribers from each other too", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = stringResolver();
    const after = vi.fn();
    r.onEvent(() => {
      throw new Error("bad event subscriber");
    });
    r.onEvent(after);

    r.fetch("a");

    expect(after).toHaveBeenCalled();
  });

  it("lets a subscriber unsubscribe from inside its own notification", async () => {
    const r = stringResolver();
    const later = vi.fn();
    const unsub = r.onUpdate(() => unsub());
    r.onUpdate(later);

    r.fetch("a");
    await flush();

    expect(later).toHaveBeenCalledTimes(1);
  });
});

describe("re-fetch invalidation policy", () => {
  it("re-runs cached keys instead of clearing them", async () => {
    let answer = "first";
    const load = vi.fn(() => Promise.resolve(answer));
    const r = createKeyedResolver<string, string>({
      cacheKey: (k) => k,
      load,
      onFailure: () => "failed",
      invalidation: "refetch",
      same: (a, b) => a === b,
    });

    r.fetch("q");
    await flush();
    expect(r.get("q")).toBe("first");

    answer = "second";
    r.invalidate();
    expect(r.get("q")).toBe("first");
    await flush();
    expect(r.get("q")).toBe("second");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not bump version when a re-run returns the same value", async () => {
    const r = createKeyedResolver<string, string>({
      cacheKey: (k) => k,
      load: () => Promise.resolve("same"),
      onFailure: () => "failed",
      invalidation: "refetch",
      same: (a, b) => a === b,
    });

    r.fetch("q");
    await flush();
    const version = r.version();

    r.invalidate();
    await flush();

    expect(r.version()).toBe(version);
  });
});

function deferredLoader() {
  const pending: { key: string; settle: (v: string) => void }[] = [];
  const load = vi.fn(
    (key: string) =>
      new Promise<string>((settle) => pending.push({ key, settle })),
  );
  return { pending, load };
}

describe("staleness and in-flight races", () => {
  it("bumps the version on markStale so version-keyed widgets re-render", async () => {
    const r = stringResolver();
    r.fetch("a");
    await flush();
    const before = r.version();

    r.markStale();

    expect(r.version()).toBeGreaterThan(before);
  });

  it("does not let a pre-invalidate answer fill a cleared cache", async () => {
    const { pending, load } = deferredLoader();
    const r = createKeyedResolver<string, string>({
      cacheKey: (k) => k,
      load,
      onFailure: () => "failed",
    });

    r.fetch("a");
    r.invalidate();
    pending[0]!.settle("old");
    await flush();

    expect(r.get("a")).toBeUndefined();
  });

  it("starts a fresh request after a clear invalidate and keeps its answer", async () => {
    const { pending, load } = deferredLoader();
    const r = createKeyedResolver<string, string>({
      cacheKey: (k) => k,
      load,
      onFailure: () => "failed",
    });

    r.fetch("a");
    r.invalidate();
    r.fetch("a");
    expect(load).toHaveBeenCalledTimes(2);

    pending[0]!.settle("old");
    await flush();
    expect(r.debug().inFlight).toEqual(["a"]);

    pending[1]!.settle("new");
    await flush();
    expect(r.get("a")).toBe("new");
  });

  it("re-runs a refetch-mode key invalidated while its request was in flight", async () => {
    const { pending, load } = deferredLoader();
    const r = createKeyedResolver<string, string>({
      cacheKey: (k) => k,
      load,
      onFailure: () => "failed",
      invalidation: "refetch",
      same: (a, b) => a === b,
    });

    r.fetch("q");
    pending[0]!.settle("first");
    await flush();

    r.invalidate();
    r.invalidate();
    expect(load).toHaveBeenCalledTimes(2);

    pending[1]!.settle("mid");
    await flush();
    expect(load).toHaveBeenCalledTimes(3);

    pending[2]!.settle("latest");
    await flush();
    expect(r.get("q")).toBe("latest");
    expect(r.debug().inFlight).toEqual([]);
  });

  it("refetches after settle when markStale lands during a request", async () => {
    const { pending, load } = deferredLoader();
    const r = createKeyedResolver<string, string>({
      cacheKey: (k) => k,
      load,
      onFailure: () => "failed",
    });

    r.fetch("a");
    r.markStale();
    pending[0]!.settle("old");
    await flush();

    r.get("a");
    expect(load).toHaveBeenCalledTimes(2);
  });
});
