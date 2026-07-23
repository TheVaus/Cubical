import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { dataviewQuery, type DataviewQueryRequest } from "./ipc";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe("dataviewQuery ipc wrapper", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("forwards to the `dataview_query` command with `{ req: { vault_id, source } }`", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "count", count: 3 });
    const req: DataviewQueryRequest = { vault_id: "v1", source: "COUNT" };
    const res = await dataviewQuery(req);
    expect(res).toEqual({ kind: "count", count: 3 });
    expect(mockInvoke).toHaveBeenCalledWith("dataview_query", {
      req: { vault_id: "v1", source: "COUNT" },
    });
  });

  it("passes through the list variant with note refs", async () => {
    mockInvoke.mockResolvedValueOnce({
      kind: "list",
      notes: [{ path: "a.md", title: "a" }],
    });
    const res = await dataviewQuery({ vault_id: "v1", source: "LIST" });
    expect(res).toEqual({ kind: "list", notes: [{ path: "a.md", title: "a" }] });
  });

  it("passes through the error variant", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "error", message: "boom" });
    const res = await dataviewQuery({ vault_id: "v1", source: "FETCH x" });
    expect(res).toEqual({ kind: "error", message: "boom" });
  });
});
