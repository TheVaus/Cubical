import { describe, it, expect } from "vitest";

import type { DanglingLinkGroup } from "../api/ipc";
import {
  candidateKey,
  candidateRankLabel,
  occurrenceSummary,
  reattachActionLabel,
  reduceIntegrityState,
  type IntegrityViewState,
} from "./integrityState";

const group = (over: Partial<DanglingLinkGroup> = {}): DanglingLinkGroup => ({
  target_raw: "plan",
  missing_path: "notes/plan.md",
  total: 2,
  occurrences: [{ source_path: "src.md", count: 2 }],
  candidates: [{ path: "archive/roadmap.md", rank: "frontmatter_title" }],
  ...over,
});

describe("reduceIntegrityState", () => {
  it("moves to loading on fetch start", () => {
    const next = reduceIntegrityState({ kind: "idle" }, { type: "fetch:start" });
    expect(next.kind).toBe("loading");
  });

  it("reports empty when no groups came back", () => {
    const next = reduceIntegrityState(
      { kind: "loading" },
      { type: "fetch:success", groups: [], truncated: false },
    );
    expect(next.kind).toBe("empty");
  });

  it("keeps groups and the truncation flag on success", () => {
    const next = reduceIntegrityState(
      { kind: "loading" },
      { type: "fetch:success", groups: [group()], truncated: true },
    );
    expect(next).toMatchObject({ kind: "loaded", truncated: true });
    if (next.kind !== "loaded") throw new Error("expected loaded");
    expect(next.groups).toHaveLength(1);
  });

  it("carries the message on error and resets on vault clear", () => {
    const errored = reduceIntegrityState(
      { kind: "loading" },
      { type: "fetch:error", message: "boom" },
    );
    expect(errored).toEqual({ kind: "error", message: "boom" });
    const cleared = reduceIntegrityState(errored, { type: "vault:cleared" });
    expect(cleared.kind).toBe("idle");
  });

  it("returns the state unchanged for an unknown action", () => {
    const state: IntegrityViewState = { kind: "empty" };
    const unknown = { type: "nope" } as unknown as Parameters<
      typeof reduceIntegrityState
    >[1];
    expect(reduceIntegrityState(state, unknown)).toBe(state);
  });
});

describe("integrity labels", () => {
  it("spells out every candidate rank", () => {
    expect(candidateRankLabel("exact_path")).toBe("same path");
    expect(candidateRankLabel("exact_basename")).toBe("same name");
    expect(candidateRankLabel("case_insensitive_path")).toBe(
      "same path, different case",
    );
    expect(candidateRankLabel("case_insensitive_basename")).toBe(
      "same name, different case",
    );
    expect(candidateRankLabel("frontmatter_title")).toBe("title matches");
  });

  it("summarises occurrences with singular and plural forms", () => {
    expect(occurrenceSummary(group())).toBe("2 links in 1 note");
    expect(
      occurrenceSummary(
        group({
          total: 1,
          occurrences: [{ source_path: "a.md", count: 1 }],
        }),
      ),
    ).toBe("1 link in 1 note");
    expect(
      occurrenceSummary(
        group({
          total: 3,
          occurrences: [
            { source_path: "a.md", count: 2 },
            { source_path: "b.md", count: 1 },
          ],
        }),
      ),
    ).toBe("3 links in 2 notes");
  });

  it("names the exact repair in the action label and keys candidates", () => {
    const g = group();
    expect(reattachActionLabel(g, g.candidates[0]!)).toBe(
      "Reattach [[plan]] to archive/roadmap.md",
    );
    expect(candidateKey(g, g.candidates[0]!)).toBe("plan→archive/roadmap.md");
  });
});
