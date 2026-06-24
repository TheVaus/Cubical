import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/ipc", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

import { getSetting, setSetting } from "../api/ipc";
import { persistSetting, seedSetting } from "./settings";

const mockGet = getSetting as unknown as ReturnType<typeof vi.fn>;
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
    // Let the rejected promise settle so the .catch runs.
    await Promise.resolve();
    expect(console.error).toHaveBeenCalled();
  });
});

describe("seedSetting", () => {
  beforeEach(() => {
    mockGet.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("applies the stored value when the key is present", async () => {
    mockGet.mockResolvedValueOnce("YYYY/MM/DD");
    const apply = vi.fn();
    await seedSetting("v1", "properties.date_format_default", "YYYY-MM-DD", apply);
    expect(apply).toHaveBeenCalledWith("YYYY/MM/DD");
  });

  it("applies the fallback when the key is absent (null)", async () => {
    mockGet.mockResolvedValueOnce(null);
    const apply = vi.fn();
    await seedSetting("v1", "properties.tags_key_as_tags", true, apply);
    expect(apply).toHaveBeenCalledWith(true);
  });

  it("applies a falsy stored value rather than the fallback", async () => {
    // `false ?? fallback` must yield `false`, not the fallback — a bug
    // a `||` would introduce.
    mockGet.mockResolvedValueOnce(false);
    const apply = vi.fn();
    await seedSetting("v1", "properties.typed_enabled", true, apply);
    expect(apply).toHaveBeenCalledWith(false);
  });

  it("falls back and logs when the read rejects", async () => {
    mockGet.mockRejectedValueOnce(new Error("io"));
    const apply = vi.fn();
    await seedSetting("v1", "ui.right_sidebar_collapsed", false, apply);
    expect(apply).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
});
