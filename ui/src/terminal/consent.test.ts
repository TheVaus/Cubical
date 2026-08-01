import { describe, expect, it } from "vitest";

import type { AgentInstructionsStatus } from "../api/ipc";
import { createConsentGate } from "./consent";

const status = (offered: boolean): AgentInstructionsStatus => ({
  offered,
  canonical_path: "/vault/.cubical/agent-instructions.md",
  existing_pointers: [],
});

describe("createConsentGate", () => {
  it("offers once for a vault that has never been asked", () => {
    const gate = createConsentGate();

    expect(gate.claim("v1", status(false))).toBe(true);
  });

  it("never asks twice in one session", () => {
    const gate = createConsentGate();
    gate.claim("v1", status(false));

    expect(gate.claim("v1", status(false))).toBe(false);
  });

  it("stays quiet for a vault already answered on disk", () => {
    const gate = createConsentGate();

    expect(gate.claim("v1", status(true))).toBe(false);
  });

  it("asks per vault, not globally", () => {
    const gate = createConsentGate();
    gate.claim("v1", status(false));

    expect(gate.claim("v2", status(false))).toBe(true);
  });
});
