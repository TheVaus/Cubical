import { describe, expect, it } from "vitest";

import {
  exitNotice,
  initialTerminalState,
  isFinished,
  reduceTerminal,
} from "./exitState";

describe("exitNotice", () => {
  it("names the signal when the child was killed", () => {
    expect(exitNotice({ code: null, signal: "SIGTERM" })).toContain("SIGTERM");
  });

  it("names the code when the child exited on its own", () => {
    expect(exitNotice({ code: 7, signal: null })).toContain("7");
  });

  it("falls back to a plain notice when the backend could not tell", () => {
    expect(exitNotice(null)).toBe("Process ended.");
    expect(exitNotice({ code: null, signal: null })).toBe("Process ended.");
  });
});

describe("reduceTerminal", () => {
  it("runs once the pty is open", () => {
    const s = reduceTerminal(initialTerminalState, { type: "opened" });

    expect(s.phase).toBe("running");
    expect(isFinished(s)).toBe(false);
  });

  it("surfaces a failure to start", () => {
    const s = reduceTerminal(initialTerminalState, {
      type: "open-failed",
      message: "no pty",
    });

    expect(s.phase).toBe("failed");
    expect(s.notice).toContain("no pty");
  });

  it("shows the exit notice when the child ends", () => {
    const running = reduceTerminal(initialTerminalState, { type: "opened" });
    const s = reduceTerminal(running, {
      type: "exited",
      exit: { code: 0, signal: null },
    });

    expect(s.phase).toBe("exited");
    expect(s.notice).toContain("0");
  });

  it("is terminal — a late event cannot revive a finished session", () => {
    const exited = reduceTerminal(initialTerminalState, {
      type: "exited",
      exit: null,
    });

    expect(reduceTerminal(exited, { type: "opened" })).toBe(exited);
  });
});
