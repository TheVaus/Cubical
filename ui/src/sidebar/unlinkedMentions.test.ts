import { describe, expect, it } from "vitest";

import type { Mention } from "../api/ipc";
import {
  mentionKey,
  reduceMentionsState,
  type MentionsViewState,
} from "./unlinkedMentionsState";

const sample: Mention = {
  source_path: "notes/Project.md",
  context: "I worked on the Daily today",
  position: 16,
  byte_len: 5,
  needle: "Daily",
};

describe("mentionKey", () => {
  it("combines source path and position so duplicates in one file are distinguishable", () => {
    expect(mentionKey(sample)).toBe("notes/Project.md@16");
    expect(mentionKey({ ...sample, position: 80 })).not.toBe(mentionKey(sample));
  });
});

describe("reduceMentionsState", () => {
  const idle: MentionsViewState = { kind: "idle" };

  it("starts loading on fetch:start", () => {
    const next = reduceMentionsState(idle, { type: "fetch:start" });
    expect(next).toEqual({ kind: "loading" });
  });

  it("captures empty result as 'empty'", () => {
    const next = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:success", mentions: [] },
    );
    expect(next).toEqual({ kind: "empty" });
  });

  it("captures non-empty result as 'loaded'", () => {
    const next = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:success", mentions: [sample] },
    );
    expect(next).toEqual({ kind: "loaded", mentions: [sample] });
  });

  it("captures errors", () => {
    const next = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:error", message: "boom" },
    );
    expect(next).toEqual({ kind: "error", message: "boom" });
  });

  it("returns to idle when the open file is cleared", () => {
    const next = reduceMentionsState(
      { kind: "loaded", mentions: [sample] },
      { type: "file:cleared" },
    );
    expect(next).toEqual({ kind: "idle" });
  });

  it("removes the linked mention from a loaded state via mention:linked", () => {
    const a: Mention = { ...sample, position: 16 };
    const b: Mention = { ...sample, position: 80 };
    const next = reduceMentionsState(
      { kind: "loaded", mentions: [a, b] },
      { type: "mention:linked", key: mentionKey(a) },
    );
    expect(next).toEqual({ kind: "loaded", mentions: [b] });
  });

  it("drops to 'empty' when the last mention is linked away", () => {
    const next = reduceMentionsState(
      { kind: "loaded", mentions: [sample] },
      { type: "mention:linked", key: mentionKey(sample) },
    );
    expect(next).toEqual({ kind: "empty" });
  });
});
