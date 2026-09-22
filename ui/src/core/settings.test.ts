import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/ipc", () => ({
  setSetting: vi.fn(),
}));

import { setSetting } from "../api/ipc";
import { persistSetting } from "./settings";

const mockSet = setSetting as unknown as ReturnType<typeof vi.fn>;

describe("persistSetting", () => {
  beforeEach(() => {
    mockSet.mockReset();
    mockSet.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("writes the setting when a vault is open", () => {
    persistSetting("v1", "editor.raw_source_default", true);
    expect(mockSet).toHaveBeenCalledWith(
      "v1",
      "editor.raw_source_default",
      true,
    );
  });

  it("is a no-op when no vault is open", () => {
    persistSetting(null, "editor.raw_source_default", true);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("swallows IPC rejections (does not throw)", async () => {
    mockSet.mockRejectedValueOnce(new Error("boom"));
    expect(() =>
      persistSetting("v1", "properties.typed_enabled", true),
    ).not.toThrow();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalled();
  });
});

