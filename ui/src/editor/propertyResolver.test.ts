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
