/**
 * Smoke tests for the `get_property` IPC wrapper in `./ipc.ts`.
 *
 * Pins the on-wire envelope shape — the command passes arguments under a
 * single `req` key, matching the Rust handler in
 * `crates/cubical-app/src/lib.rs` (parameter name `req: GetPropertyRequest`).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { getProperty, type GetPropertyRequest } from "./ipc";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe("getProperty ipc wrapper", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("forwards to `get_property` with `{ req: { vault_id, note_raw, property } }`", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "resolved", value: "2019" });
    const req: GetPropertyRequest = {
      vault_id: "v1",
      note_raw: "Gandalf",
      property: "age",
    };
    const res = await getProperty(req);
    expect(res).toEqual({ kind: "resolved", value: "2019" });
    expect(mockInvoke).toHaveBeenCalledWith("get_property", {
      req: { vault_id: "v1", note_raw: "Gandalf", property: "age" },
    });
  });

  it("passes through the note_unresolved variant", async () => {
    mockInvoke.mockResolvedValueOnce({ kind: "note_unresolved", value: null });
    const res = await getProperty({
      vault_id: "v1",
      note_raw: "Ghost",
      property: "age",
    });
    expect(res).toEqual({ kind: "note_unresolved", value: null });
  });
});
