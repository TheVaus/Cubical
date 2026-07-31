import { describe, expect, it } from "vitest";

import { createTerminalSessions } from "./sessions";

describe("createTerminalSessions", () => {
  it("maps a tab to the pty it owns", () => {
    const sessions = createTerminalSessions();
    sessions.register("terminal:1", "term-99-1");

    expect(sessions.idFor("terminal:1")).toBe("term-99-1");
    expect(sessions.idFor("terminal:2")).toBeNull();
  });

  it("forgets a tab once its pty is gone", () => {
    const sessions = createTerminalSessions();
    sessions.register("terminal:1", "term-99-1");
    sessions.forget("terminal:1");

    expect(sessions.idFor("terminal:1")).toBeNull();
    expect(sessions.size()).toBe(0);
  });

  it("keeps each terminal separate", () => {
    const sessions = createTerminalSessions();
    sessions.register("terminal:1", "term-99-1");
    sessions.register("terminal:2", "term-99-2");
    sessions.forget("terminal:1");

    expect(sessions.idFor("terminal:2")).toBe("term-99-2");
    expect(sessions.size()).toBe(1);
  });
});
