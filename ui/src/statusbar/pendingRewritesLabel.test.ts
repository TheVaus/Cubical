import { describe, expect, it } from "vitest";

import { formatPendingRewrites } from "./pendingRewritesLabel";

describe("formatPendingRewrites", () => {
  it("returns null when the queue is empty", () => {
    expect(formatPendingRewrites(0)).toBeNull();
  });

  it("returns null for a defensive negative count", () => {
    expect(formatPendingRewrites(-3)).toBeNull();
  });

  it("uses the singular noun for exactly one", () => {
    expect(formatPendingRewrites(1)).toEqual({ label: "1 pending change" });
  });

  it("uses the plural noun for more than one", () => {
    expect(formatPendingRewrites(2)).toEqual({ label: "2 pending changes" });
    expect(formatPendingRewrites(42)).toEqual({ label: "42 pending changes" });
  });
});
