import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relativeTime";

const NOW_MS = 1780790400 * 1000;

describe("formatRelativeTime", () => {
  it("shows 'just now' for very recent times", () => {
    expect(formatRelativeTime(1780790400 - 30, NOW_MS)).toBe("just now");
  });

  it("shows minutes, hours, days, weeks", () => {
    expect(formatRelativeTime(1780790400 - 5 * 60, NOW_MS)).toBe("5m ago");
    expect(formatRelativeTime(1780790400 - 3 * 3600, NOW_MS)).toBe("3h ago");
    expect(formatRelativeTime(1780790400 - 2 * 86400, NOW_MS)).toBe("2d ago");
    expect(formatRelativeTime(1780790400 - 3 * 7 * 86400, NOW_MS)).toBe("3w ago");
  });

  it("shows months and years for older times", () => {
    expect(formatRelativeTime(1780790400 - 60 * 86400, NOW_MS)).toBe("2mo ago");
    expect(formatRelativeTime(1780790400 - 800 * 86400, NOW_MS)).toBe("2y ago");
  });

  it("clamps future times to 'just now'", () => {
    expect(formatRelativeTime(1780790400 + 5000, NOW_MS)).toBe("just now");
  });
});
