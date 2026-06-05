import { describe, expect, it, vi } from "vitest";

import { createWikiLinkResolver } from "./wikilinkResolver";
import type { ResolveLinkRequest, ResolveLinkResponse } from "../api/ipc";

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
  resp: ResolveLinkResponse | Error,
): (req: ResolveLinkRequest) => Promise<ResolveLinkResponse> {
  return vi.fn().mockImplementation(() =>
    resp instanceof Error ? Promise.reject(resp) : Promise.resolve(resp),
  );
}

const RESOLVED: ResolveLinkResponse = {
  target_path: "notes/Daily.md",
  anchor: null,
};

function stubIpc(responses: Record<string, ResolveLinkResponse>): {
  fn: (req: ResolveLinkRequest) => Promise<ResolveLinkResponse>;
  calls: ResolveLinkRequest[];
} {
  const calls: ResolveLinkRequest[] = [];
  const fn = (req: ResolveLinkRequest): Promise<ResolveLinkResponse> => {
    calls.push(req);
    const resp = responses[req.target_raw];
    if (!resp) throw new Error(`no stub for ${req.target_raw}`);
    return Promise.resolve(resp);
  };
  return { fn, calls };
}

/** Drain queued microtasks (3 ticks is enough for then→finally chains). */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createWikiLinkResolver", () => {
  it("returns undefined for a target not yet fetched", () => {
    const { fn } = stubIpc({});
    const r = createWikiLinkResolver("v1", fn);
    expect(r.get("note")).toBeUndefined();
  });

  it("fires the IPC on fetch and exposes the result via get", async () => {
    const { fn, calls } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    await settle();
    expect(calls).toEqual([{ vault_id: "v1", target_raw: "note" }]);
    expect(r.get("note")).toEqual({ target_path: "note.md", anchor: null });
  });

  it("dedupes concurrent fetches for the same target", async () => {
    const { fn, calls } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    r.fetch("note");
    r.fetch("note");
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("notifies subscribers when a fetch completes", async () => {
    const { fn } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    const onUpdate = vi.fn();
    r.onUpdate(onUpdate);
    r.fetch("note");
    await settle();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("invalidate() clears the cache and notifies subscribers", async () => {
    const { fn } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    await settle();
    expect(r.get("note")).toBeDefined();
    const onUpdate = vi.fn();
    r.onUpdate(onUpdate);
    r.invalidate();
    expect(r.get("note")).toBeUndefined();
    expect(onUpdate).toHaveBeenCalled();
  });

  it("unsubscribe handle stops further notifications", async () => {
    const { fn } = stubIpc({
      a: { target_path: "a.md", anchor: null },
      b: { target_path: "b.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    const onUpdate = vi.fn();
    const unsub = r.onUpdate(onUpdate);
    r.fetch("a");
    await settle();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    unsub();
    r.fetch("b");
    await settle();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("a fetch failure caches a null-target_path result (don't retry forever)", async () => {
    const failing = (_req: ResolveLinkRequest): Promise<ResolveLinkResponse> =>
      Promise.reject(new Error("boom"));
    const r = createWikiLinkResolver("v1", failing);
    r.fetch("note");
    await settle();
    expect(r.get("note")).toEqual({ target_path: null, anchor: null });
  });

  it("resolve() returns the cached entry synchronously on a warm cache", async () => {
    const { fn } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note");
    await settle();
    const got = await r.resolve("note");
    expect(got).toEqual({ target_path: "note.md", anchor: null });
  });

  it("resolve() awaits the in-flight fetch on a cold cache", async () => {
    const { fn, calls } = stubIpc({
      note: { target_path: "note.md", anchor: null },
    });
    const r = createWikiLinkResolver("v1", fn);
    // No prior fetch — resolve() should kick one off and await it.
    const got = await r.resolve("note");
    expect(got).toEqual({ target_path: "note.md", anchor: null });
    expect(calls).toEqual([{ vault_id: "v1", target_raw: "note" }]);
  });

  it("resolve() joins an already-in-flight fetch without re-firing the IPC", async () => {
    let resolveIpc: (v: ResolveLinkResponse) => void = () => {};
    const fn = (_req: ResolveLinkRequest): Promise<ResolveLinkResponse> =>
      new Promise((r) => {
        resolveIpc = r;
      });
    const r = createWikiLinkResolver("v1", fn);
    r.fetch("note"); // first fetch — in-flight
    const pending = r.resolve("note"); // joins
    resolveIpc({ target_path: "note.md", anchor: null });
    const got = await pending;
    expect(got).toEqual({ target_path: "note.md", anchor: null });
  });

  it("resolve() still settles when invalidate() lands mid-flight", async () => {
    let resolveIpc: (v: ResolveLinkResponse) => void = () => {};
    let calls = 0;
    const fn = (_req: ResolveLinkRequest): Promise<ResolveLinkResponse> => {
      calls += 1;
      return new Promise((r) => {
        resolveIpc = r;
      });
    };
    const r = createWikiLinkResolver("v1", fn);
    const pending = r.resolve("note");
    // Invalidate mid-flight — cache is empty, the in-flight fetch
    // is still pending. When it returns, resolve() should still
    // settle on the eventual entry.
    r.invalidate();
    resolveIpc({ target_path: "note.md", anchor: null });
    const got = await pending;
    expect(got).toEqual({ target_path: "note.md", anchor: null });
    expect(calls).toBe(1);
  });
});

describe("observability interface (Contract 4a)", () => {
  it("debug() reports an empty initial state", () => {
    const r = createWikiLinkResolver("v1", makeIpc(RESOLVED));
    const dbg = r.debug();
    expect(dbg.cacheSize).toBe(0);
    expect(dbg.inFlight).toEqual([]);
    expect(dbg.lastFetchAt.size).toBe(0);
    expect(dbg.lastSettleAt.size).toBe(0);
    expect(dbg.lastError.size).toBe(0);
  });

  it("debug() reflects in-flight state during a pending fetch", () => {
    const d = deferred<ResolveLinkResponse>();
    const ipc = vi.fn().mockReturnValue(d.promise);
    const r = createWikiLinkResolver("v1", ipc);
    r.fetch("Daily");
    const dbg = r.debug();
    expect(dbg.inFlight).toEqual(["Daily"]);
    expect(dbg.lastFetchAt.get("Daily")).toBeGreaterThan(0);
    expect(dbg.lastSettleAt.has("Daily")).toBe(false);
    d.resolve(RESOLVED);
  });

  it("debug() reflects settled state after fetch completion", async () => {
    const r = createWikiLinkResolver("v1", makeIpc(RESOLVED));
    await r.resolve("Daily");
    const dbg = r.debug();
    expect(dbg.cacheSize).toBe(1);
    expect(dbg.inFlight).toEqual([]);
    expect(dbg.lastSettleAt.get("Daily")).toBeGreaterThan(0);
    expect(dbg.lastError.has("Daily")).toBe(false);
  });

  it("debug() records lastError on IPC rejection", async () => {
    const r = createWikiLinkResolver("v1", makeIpc(new Error("boom")));
    await r.resolve("Daily");
    const dbg = r.debug();
    expect(dbg.lastError.get("Daily")).toBe("boom");
  });

  it("onEvent emits fetch-started, fetch-settled in order for a successful fetch", async () => {
    const r = createWikiLinkResolver("v1", makeIpc(RESOLVED));
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
    const r = createWikiLinkResolver("v1", makeIpc(new Error("boom")));
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
    const r = createWikiLinkResolver("v1", makeIpc(RESOLVED));
    const log: { kind: string }[] = [];
    r.onEvent((e) => log.push({ kind: e.kind }));
    r.invalidate();
    expect(log).toEqual([{ kind: "invalidate" }]);
  });

  it("abort() aborts in-flight fetches and the late IPC response is discarded", async () => {
    const d = deferred<ResolveLinkResponse>();
    const ipc = vi.fn().mockReturnValue(d.promise);
    const r = createWikiLinkResolver("v1", ipc);
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
    let pendingResolve!: (resp: ResolveLinkResponse) => void;
    const ipc = vi
      .fn<(req: ResolveLinkRequest) => Promise<ResolveLinkResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise((res) => {
            pendingResolve = res;
          }),
      )
      .mockImplementationOnce(() => Promise.resolve(RESOLVED));
    const r = createWikiLinkResolver("v1", ipc);

    // Kick the first fetch via resolve(); it's pending.
    const resolvePromise = r.resolve("Daily");

    // Abort while the first fetch is in flight.
    r.abort();

    // The first fetch's late response is discarded (handle.aborted).
    pendingResolve(RESOLVED);
    await Promise.resolve();
    await Promise.resolve();

    // The resolve() subscriber should have re-kicked a fresh fetch
    // (via the notify() abort() now emits). That second fetch was
    // wired to resolve immediately with RESOLVED.
    const result = await resolvePromise;
    expect(result).toEqual(RESOLVED);
    expect(ipc).toHaveBeenCalledTimes(2);
  });
});
