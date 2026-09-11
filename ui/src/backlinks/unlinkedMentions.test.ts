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

  it("reuses a mention's object reference across refetches when unchanged", () => {
    const first = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:success", mentions: [sample] },
    );
    const refetched: Mention = { ...sample };
    const second = reduceMentionsState(first, {
      type: "fetch:success",
      mentions: [refetched],
    });

    expect(first.kind).toBe("loaded");
    expect(second.kind).toBe("loaded");
    if (first.kind === "loaded" && second.kind === "loaded") {
      expect(second.mentions[0]).toBe(first.mentions[0]);
      expect(second.mentions[0]).not.toBe(refetched);
    }
  });

  it("gives a fresh reference to a mention whose context actually changed", () => {
    const first = reduceMentionsState(
      { kind: "loading" },
      { type: "fetch:success", mentions: [sample] },
    );
    const edited: Mention = { ...sample, context: "new surrounding text" };
    const second = reduceMentionsState(first, {
      type: "fetch:success",
      mentions: [edited],
    });

    expect(second.kind).toBe("loaded");
    if (second.kind === "loaded") {
      expect(second.mentions[0]).toBe(edited);
    }
  });
});

describe("reduceMentionsState — refresh keeps the panel steady", () => {
  const loadedWith = (m: Mention[]): MentionsViewState =>
    reduceMentionsState({ kind: "loading" }, { type: "fetch:success", mentions: m });

  it("leaves a loaded list untouched while a refresh is in flight", () => {
    const loaded = loadedWith([sample]);
    expect(reduceMentionsState(loaded, { type: "refresh:start" })).toBe(loaded);
  });

  it("leaves an empty result untouched while a refresh is in flight", () => {
    const empty = loadedWith([]);
    expect(reduceMentionsState(empty, { type: "refresh:start" })).toBe(empty);
  });

  it("falls back to loading when a refresh starts with nothing on screen", () => {
    expect(
      reduceMentionsState({ kind: "idle" }, { type: "refresh:start" }).kind,
    ).toBe("loading");
    expect(
      reduceMentionsState({ kind: "error", message: "boom" }, { type: "refresh:start" }).kind,
    ).toBe("loading");
  });

  it("preserves row identity across a whole refresh cycle", () => {
    const loaded = loadedWith([sample]);
    const during = reduceMentionsState(loaded, { type: "refresh:start" });
    const after = reduceMentionsState(during, {
      type: "fetch:success",
      mentions: [{ ...sample }],
    });

    expect(after.kind).toBe("loaded");
    if (loaded.kind === "loaded" && after.kind === "loaded") {
      expect(after.mentions[0]).toBe(loaded.mentions[0]);
    }
  });

  it("still blanks to loading when the target file changes", () => {
    expect(
      reduceMentionsState(loadedWith([sample]), { type: "fetch:start" }).kind,
    ).toBe("loading");
  });
});
