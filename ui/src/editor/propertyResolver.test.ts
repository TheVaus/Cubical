import { describe, it, expect, vi } from "vitest";

import { createPropertyResolver } from "./propertyResolver";

describe("propertyResolver", () => {
  it("fetches once and caches per (note, property)", async () => {
    const ipc = vi.fn().mockResolvedValue({ kind: "resolved", value: "2019" });
    const r = createPropertyResolver("v1", ipc);
    const a = await r.resolve("Gandalf", "age");
    const b = await r.resolve("Gandalf", "age");
    expect(a.value).toBe("2019");
    expect(b.value).toBe("2019");
    expect(ipc).toHaveBeenCalledTimes(1);
    expect(ipc).toHaveBeenCalledWith({
      vault_id: "v1",
      note_raw: "Gandalf",
      property: "age",
    });
  });

  it("keeps distinct cache entries per property", async () => {
    const ipc = vi
      .fn()
      .mockResolvedValueOnce({ kind: "resolved", value: "1" })
      .mockResolvedValueOnce({ kind: "resolved", value: "2" });
    const r = createPropertyResolver("v1", ipc);
    const age = await r.resolve("N", "age");
    const hp = await r.resolve("N", "hp");
    expect(age.value).toBe("1");
    expect(hp.value).toBe("2");
    expect(ipc).toHaveBeenCalledTimes(2);
  });

  it("bumps version and clears cache on invalidate", async () => {
    const ipc = vi.fn().mockResolvedValue({ kind: "resolved", value: "x" });
    const r = createPropertyResolver("v1", ipc);
    await r.resolve("N", "p");
    const v0 = r.version();
    r.invalidate();
    expect(r.version()).toBeGreaterThan(v0);
    expect(r.get("N", "p")).toBeUndefined();
  });

  it("caches a rejected fetch as note_unresolved (no re-fetch storm)", async () => {
    const ipc = vi.fn().mockRejectedValue(new Error("boom"));
    const r = createPropertyResolver("v1", ipc);
    const res = await r.resolve("N", "p");
    expect(res.kind).toBe("note_unresolved");
    expect(r.get("N", "p")).toEqual({ kind: "note_unresolved", value: null });
  });
});

describe("propertyResolver staleness", () => {
  it("serves the cached value while refreshing a stale entry in the background", async () => {
    const ipc = vi
      .fn()
      .mockResolvedValueOnce({ kind: "resolved", value: 41 })
      .mockResolvedValueOnce({ kind: "resolved", value: 42 });
    const r = createPropertyResolver("v1", ipc);
    await r.resolve("Gandalf", "age");
    expect(r.get("Gandalf", "age")?.value).toBe(41);

    r.markStale();

    // The stale read still answers with the old value — no "loading" flash …
    expect(r.get("Gandalf", "age")?.value).toBe(41);
    // … and it kicks off exactly one refresh.
    await vi.waitFor(() => expect(ipc).toHaveBeenCalledTimes(2));
    expect(r.get("Gandalf", "age")?.value).toBe(42);
  });

  it("refreshes a stale entry only once", async () => {
    const ipc = vi.fn().mockResolvedValue({ kind: "resolved", value: 1 });
    const r = createPropertyResolver("v1", ipc);
    await r.resolve("N", "p");
    r.markStale();
    r.get("N", "p");
    r.get("N", "p");
    r.get("N", "p");
    await vi.waitFor(() => expect(ipc).toHaveBeenCalledTimes(2));
    expect(ipc).toHaveBeenCalledTimes(2);
  });

  it("notifies subscribers when a stale refresh lands", async () => {
    const ipc = vi
      .fn()
      .mockResolvedValueOnce({ kind: "resolved", value: 1 })
      .mockResolvedValueOnce({ kind: "resolved", value: 2 });
    const r = createPropertyResolver("v1", ipc);
    await r.resolve("N", "p");
    const seen = vi.fn();
    r.onUpdate(seen);
    r.markStale();
    // markStale notifies once so the view rebuilds and reads through get()…
    expect(seen).toHaveBeenCalledTimes(1);
    r.get("N", "p");
    // …and the landing refresh notifies again with the new value.
    await vi.waitFor(() => expect(seen).toHaveBeenCalledTimes(2));
    expect(r.get("N", "p")?.value).toBe(2);
  });
});
