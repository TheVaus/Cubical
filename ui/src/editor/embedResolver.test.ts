import { describe, expect, it, vi } from "vitest";

import { createEmbedResolver } from "./embedResolver";
import type { GetEmbedRequest, GetEmbedResponse } from "../api/ipc";

function makeIpc(
  resp: GetEmbedResponse | Error,
): (req: GetEmbedRequest) => Promise<GetEmbedResponse> {
  return vi.fn().mockImplementation(() =>
    resp instanceof Error ? Promise.reject(resp) : Promise.resolve(resp),
  );
}

const RESOLVED: GetEmbedResponse = {
  kind: "note",
  target_path: "notes/Daily.md",
  content: "hello world\n",
};

describe("createEmbedResolver", () => {
  it("returns undefined for an uncached target", () => {
    const r = createEmbedResolver("v1", makeIpc(RESOLVED));
    expect(r.get("Daily")).toBeUndefined();
  });

  it("populates the cache after fetch", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    await r.resolve("Daily");
    expect(r.get("Daily")).toEqual(RESOLVED);
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc).toHaveBeenCalledWith({ vault_id: "v1", target_raw: "Daily" });
  });

  it("dedupes concurrent fetches for the same target", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    r.fetch("Daily");
    r.fetch("Daily");
    await r.resolve("Daily");
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it("caches IPC failures as an unresolved entry", async () => {
    const ipc = makeIpc(new Error("boom"));
    const r = createEmbedResolver("v1", ipc);
    const entry = await r.resolve("Ghost");
    expect(entry).toEqual({
      kind: "unresolved",
      target_path: null,
      content: null,
    });
    expect(r.get("Ghost")).toEqual(entry);
  });

  it("notifies subscribers on fetch completion and on invalidate", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    const fn = vi.fn();
    const unsub = r.onUpdate(fn);
    await r.resolve("Daily");
    expect(fn).toHaveBeenCalledTimes(1);
    r.invalidate();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.get("Daily")).toBeUndefined();
    unsub();
    r.invalidate();
    expect(fn).toHaveBeenCalledTimes(2); // unsubscribed — no extra call
  });

  it("keeps separate cache entries per anchor", async () => {
    const ipc = vi.fn().mockImplementation((req: GetEmbedRequest) =>
      Promise.resolve({
        ...RESOLVED,
        content: `for ${req.target_raw}`,
      }),
    );
    const r = createEmbedResolver("v1", ipc);
    await r.resolve("Daily");
    await r.resolve("Daily#Intro");
    expect(r.get("Daily")?.content).toBe("for Daily");
    expect(r.get("Daily#Intro")?.content).toBe("for Daily#Intro");
  });
});
