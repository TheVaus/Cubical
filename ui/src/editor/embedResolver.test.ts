import { describe, expect, it, vi } from "vitest";

import { createEmbedResolver } from "./embedResolver";
import type { GetEmbedRequest, GetEmbedResponse } from "../api/ipc";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it("resolve() joins an already-in-flight fetch without re-firing the IPC", async () => {
    const d = deferred<GetEmbedResponse>();
    const ipc = vi
      .fn<(req: GetEmbedRequest) => Promise<GetEmbedResponse>>()
      .mockImplementation(() => d.promise);
    const r = createEmbedResolver("v1", ipc);
    r.fetch("Daily"); // first fetch — in-flight
    const pending = r.resolve("Daily"); // joins
    d.resolve(RESOLVED);
    const got = await pending;
    expect(got).toEqual(RESOLVED);
    expect(ipc).toHaveBeenCalledTimes(1);
  });

  it(
    "resolve() settles after invalidate() lands mid-flight",
    { timeout: 1000 },
    async () => {
      const first = deferred<GetEmbedResponse>();
      const second = deferred<GetEmbedResponse>();
      let call = 0;
      const ipc = vi
        .fn<(req: GetEmbedRequest) => Promise<GetEmbedResponse>>()
        .mockImplementation(() => {
          call += 1;
          return call === 1 ? first.promise : second.promise;
        });
      const r = createEmbedResolver("v1", ipc);
      const pending = r.resolve("Daily");
      // Settle the first IPC. The `.then` microtask runs first
      // (cache.set), then `.finally` runs (inFlight.delete + notify),
      // then the subscriber in resolve() wakes. If invalidate() lands
      // between the `.then` and the subscriber-wake, the subscriber
      // sees an empty cache AND no in-flight fetch — it must re-kick
      // or pending hangs forever.
      first.resolve(RESOLVED);
      // One microtask tick: the `.then` runs (cache populated), but
      // the `.finally` hasn't fired notify yet because the chain is
      // not fully drained.
      await Promise.resolve();
      // Now clear the cache before the finally-notify reaches the
      // subscriber.
      r.invalidate();
      // The original finally-notify still fires; the subscriber sees
      // undefined + no in-flight → re-kicks the second fetch.
      // Settle that one.
      second.resolve(RESOLVED);
      const got = await pending;
      expect(got).toEqual(RESOLVED);
      expect(ipc).toHaveBeenCalledTimes(2);
    },
  );

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
