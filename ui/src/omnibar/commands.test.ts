import { describe, expect, it } from "vitest";
import { OMNI_COMMANDS } from "./commands";

describe("omni commands registry", () => {
  it("includes the status-bar toggle", () => {
    expect(OMNI_COMMANDS.some((c) => c.id === "statusbar.toggle")).toBe(true);
  });

  it("every command id and title is unique and non-empty", () => {
    expect(OMNI_COMMANDS.length).toBeGreaterThan(0);
    for (const c of OMNI_COMMANDS) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(0);
    }
    expect(new Set(OMNI_COMMANDS.map((c) => c.id)).size).toBe(
      OMNI_COMMANDS.length,
    );
    expect(new Set(OMNI_COMMANDS.map((c) => c.title)).size).toBe(
      OMNI_COMMANDS.length,
    );
  });
});
