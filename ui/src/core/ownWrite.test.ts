import { describe, it, expect } from "vitest";
import { isOwnWriteEcho } from "./ownWrite";

describe("isOwnWriteEcho", () => {
  it("is true when the open file's own write echoes back (paths + hashes match)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "abc123",
        lastWrittenHash: "abc123",
      }),
    ).toBe(true);
  });

  it("is false when a different file changed", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/B.md",
        selectedPath: "notes/A.md",
        incomingHash: "abc123",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });

  it("is false when the event carries no hash", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: null,
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });

  it("is false for a genuine external edit (hashes differ)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "external999",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });

  it("is false when nothing has been written yet (lastWrittenHash null)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: "notes/A.md",
        incomingHash: "abc123",
        lastWrittenHash: null,
      }),
    ).toBe(false);
  });

  it("is false when no file is open (selectedPath null)", () => {
    expect(
      isOwnWriteEcho({
        changedPath: "notes/A.md",
        selectedPath: null,
        incomingHash: "abc123",
        lastWrittenHash: "abc123",
      }),
    ).toBe(false);
  });
});
