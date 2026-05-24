import { describe, expect, it, vi } from "vitest";

import { createWikiLinkResolver } from "./wikilinkResolver";
import type { ResolveLinkRequest, ResolveLinkResponse } from "../api/ipc";

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
});
