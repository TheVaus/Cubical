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
