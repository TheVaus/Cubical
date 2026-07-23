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

  it("version() bumps on every cache mutation (fetch settle, error, invalidate)", async () => {
    const ipc = makeIpc(RESOLVED);
    const r = createEmbedResolver("v1", ipc);
    expect(r.version()).toBe(0);

    await r.resolve("Daily");
    const afterFetch = r.version();
    expect(afterFetch).toBeGreaterThan(0);

    await r.resolve("Daily");
    expect(r.version()).toBe(afterFetch);

    const failing = createEmbedResolver("v1", makeIpc(new Error("boom")));
    const v0 = failing.version();
    await failing.resolve("Ghost");
    expect(failing.version()).toBeGreaterThan(v0);

    const beforeInvalidate = r.version();
    r.invalidate();
    expect(r.version()).toBeGreaterThan(beforeInvalidate);
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
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("resolve() joins an already-in-flight fetch without re-firing the IPC", async () => {
    const d = deferred<GetEmbedResponse>();
    const ipc = vi
      .fn<(req: GetEmbedRequest) => Promise<GetEmbedResponse>>()
      .mockImplementation(() => d.promise);
    const r = createEmbedResolver("v1", ipc);
    r.fetch("Daily");
    const pending = r.resolve("Daily");
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
      first.resolve(RESOLVED);
      await Promise.resolve();
      r.invalidate();
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

describe("observability interface (Contract 4a)", () => {
  it("debug() reports an empty initial state", () => {
    const r = createEmbedResolver("v1", makeIpc(RESOLVED));
    const dbg = r.debug();
    expect(dbg.cacheSize).toBe(0);
    expect(dbg.inFlight).toEqual([]);
    expect(dbg.lastFetchAt.size).toBe(0);
    expect(dbg.lastSettleAt.size).toBe(0);
    expect(dbg.lastError.size).toBe(0);
  });

  it("debug() reflects in-flight state during a pending fetch", () => {
    const d = deferred<GetEmbedResponse>();
    const ipc = vi.fn().mockReturnValue(d.promise);
    const r = createEmbedResolver("v1", ipc);
    r.fetch("Daily");
    const dbg = r.debug();
    expect(dbg.inFlight).toEqual(["Daily"]);
    expect(dbg.lastFetchAt.get("Daily")).toBeGreaterThan(0);
    expect(dbg.lastSettleAt.has("Daily")).toBe(false);
    d.resolve(RESOLVED);
  });

  it("debug() reflects settled state after fetch completion", async () => {
    const r = createEmbedResolver("v1", makeIpc(RESOLVED));
    await r.resolve("Daily");
    const dbg = r.debug();
    expect(dbg.cacheSize).toBe(1);
    expect(dbg.inFlight).toEqual([]);
    expect(dbg.lastSettleAt.get("Daily")).toBeGreaterThan(0);
    expect(dbg.lastError.has("Daily")).toBe(false);
  });

  it("debug() records lastError on IPC rejection", async () => {
    const r = createEmbedResolver("v1", makeIpc(new Error("boom")));
    await r.resolve("Daily");
    const dbg = r.debug();
    expect(dbg.lastError.get("Daily")).toBe("boom");
  });

  it("onEvent emits fetch-started, fetch-settled in order for a successful fetch", async () => {
    const r = createEmbedResolver("v1", makeIpc(RESOLVED));
    const log: { kind: string; key: string | undefined }[] = [];
    const unsub = r.onEvent((e) => log.push({ kind: e.kind, key: e.key }));
    await r.resolve("Daily");
    unsub();
    expect(log).toEqual([
      { kind: "fetch-started", key: "Daily" },
      { kind: "fetch-settled", key: "Daily" },
    ]);
  });

  it("onEvent emits fetch-errored for a failing fetch", async () => {
    const r = createEmbedResolver("v1", makeIpc(new Error("boom")));
    const log: {
      kind: string;
      key: string | undefined;
      error: string | undefined;
    }[] = [];
    const unsub = r.onEvent((e) =>
      log.push({ kind: e.kind, key: e.key, error: e.error }),
    );
    await r.resolve("Daily");
    unsub();
    expect(log).toEqual([
      { kind: "fetch-started", key: "Daily", error: undefined },
      { kind: "fetch-errored", key: "Daily", error: "boom" },
    ]);
  });

  it("onEvent emits invalidate when invalidate() is called", () => {
    const r = createEmbedResolver("v1", makeIpc(RESOLVED));
    const log: { kind: string }[] = [];
    r.onEvent((e) => log.push({ kind: e.kind }));
    r.invalidate();
    expect(log).toEqual([{ kind: "invalidate" }]);
  });

  it("abort() aborts in-flight fetches and the late IPC response is discarded", async () => {
    const d = deferred<GetEmbedResponse>();
    const ipc = vi.fn().mockReturnValue(d.promise);
    const r = createEmbedResolver("v1", ipc);
    const log: { kind: string; key: string | undefined }[] = [];
    r.onEvent((e) => log.push({ kind: e.kind, key: e.key }));
    r.fetch("Daily");
    r.abort();
    d.resolve(RESOLVED);
    await Promise.resolve();
    await Promise.resolve();
    expect(r.get("Daily")).toBeUndefined();
    expect(log.some((e) => e.kind === "abort")).toBe(true);
  });

  it("abort() does not hang pending resolve() calls — they re-kick after the next event", async () => {
    let pendingResolve!: (resp: GetEmbedResponse) => void;
    const ipc = vi
      .fn<(req: GetEmbedRequest) => Promise<GetEmbedResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            pendingResolve = res;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(RESOLVED));
    const r = createEmbedResolver("v1", ipc);

    const resolvePromise = r.resolve("Daily");

    r.abort();

    pendingResolve(RESOLVED);
    await Promise.resolve();
    await Promise.resolve();

    const result = await resolvePromise;
    expect(result).toEqual(RESOLVED);
    expect(ipc).toHaveBeenCalledTimes(2);
  });
});
