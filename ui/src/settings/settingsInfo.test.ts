import { describe, expect, it } from "vitest";

import { toggleInfo } from "./settingsInfo";

describe("toggleInfo", () => {
  it("opens a popover from the closed state", () => {
    expect(toggleInfo(null, "a")).toBe("a");
  });

  it("closes when the same id is clicked again", () => {
    expect(toggleInfo("a", "a")).toBeNull();
  });

  it("switches directly from one popover to another", () => {
    expect(toggleInfo("a", "b")).toBe("b");
  });

  it("accepts an id a block contributes without substrate naming it", () => {
    expect(toggleInfo(null, "typed-props")).toBe("typed-props");
    expect(toggleInfo("shortcuts", "typed-props")).toBe("typed-props");
  });
});
