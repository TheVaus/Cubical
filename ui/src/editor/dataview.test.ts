import { describe, it, expect, vi } from "vitest";
import { createDataviewRunner, dataviewExtension } from "./dataview";
import type { DataviewResult } from "../api/ipc";

/** Flush the full promise chain (then → catch → finally) + timers. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("dataviewExtension", () => {
  it("is a non-empty extension array", () => {
    expect(Array.isArray(dataviewExtension)).toBe(true);
    expect((dataviewExtension as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("createDataviewRunner", () => {
  const count3: DataviewResult = { kind: "count", count: 3 };

  it("caches results and dedupes concurrent fetches", async () => {
    const ipc = vi.fn().mockResolvedValue(count3);
    const runner = createDataviewRunner("v1", () => {}, ipc);

    expect(runner.get("COUNT")).toBeUndefined();
    runner.fetch("COUNT");
    runner.fetch("COUNT"); // in-flight dedupe
    await flush();

    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc).toHaveBeenCalledWith({ vault_id: "v1", source: "COUNT" });
    expect(runner.get("COUNT")).toEqual(count3);
  });

  it("bumps version and notifies subscribers on settle", async () => {
    const ipc = vi.fn().mockResolvedValue(count3);
    const runner = createDataviewRunner("v1", () => {}, ipc);
    const before = runner.version();
    const onUpdate = vi.fn();
    runner.onUpdate(onUpdate);

    runner.fetch("COUNT");
    await flush();

    expect(onUpdate).toHaveBeenCalled();
    expect(runner.version()).toBeGreaterThan(before);
  });

  it("stores an error variant when the IPC rejects", async () => {
    const ipc = vi.fn().mockRejectedValue(new Error("boom"));
    const runner = createDataviewRunner("v1", () => {}, ipc);
    runner.fetch("LIST");
    await flush();
    const r = runner.get("LIST");
    expect(r?.kind).toBe("error");
    if (r?.kind === "error") expect(r.message).toBe("boom");
  });

  it("clears the cache on invalidate", async () => {
    const ipc = vi.fn().mockResolvedValue(count3);
    const runner = createDataviewRunner("v1", () => {}, ipc);
    runner.fetch("COUNT");
    await flush();
    expect(runner.get("COUNT")).toEqual(count3);
    runner.invalidate();
    expect(runner.get("COUNT")).toBeUndefined();
  });

  it("routes open() to the onOpen callback", () => {
    const onOpen = vi.fn();
    const runner = createDataviewRunner("v1", onOpen, vi.fn());
    runner.open("notes/a.md");
    expect(onOpen).toHaveBeenCalledWith("notes/a.md");
  });
});
