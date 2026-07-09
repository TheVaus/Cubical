import { describe, expect, it } from "vitest";

import { toggleInfo, type InfoId } from "./settingsInfo";

describe("toggleInfo", () => {
  it("opens a popover from the closed state", () => {
    expect(toggleInfo(null, "dataview")).toBe("dataview");
  });

  it("closes when the same id is clicked again", () => {
    expect(toggleInfo("dataview", "dataview")).toBeNull();
  });

  it("switches directly from one popover to another", () => {
    const next: InfoId | null = toggleInfo("dataview", "typed-props");
    expect(next).toBe("typed-props");
  });
});

describe("settingsInfo shortcuts id", () => {
  it("toggles the shortcuts info id open and closed", () => {
    const id: InfoId = "shortcuts";
    expect(toggleInfo(null, id)).toBe("shortcuts");
    expect(toggleInfo("shortcuts", id)).toBeNull();
  });
});
