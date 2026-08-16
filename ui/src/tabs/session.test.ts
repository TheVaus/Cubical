import { describe, expect, it } from "vitest";
import type { TabSessionDto } from "../api/ipc";
import { fromTabSessionDto, toTabSessionDto } from "./session";
import { emptyTabs, MAX_TABS, openTab, type TabSet } from "./tabModel";

const fileRow = (n: number) => ({
  id: `file:n${n}.md`,
  kind: "file" as const,
  path: `n${n}.md`,
  tag_path: null,
});

const dtoOf = (count: number, activeId: string | null): TabSessionDto => ({
  active_id: activeId,
  tabs: Array.from({ length: count }, (_, i) => fileRow(i)),
});

describe("fromTabSessionDto", () => {
  it("restores file and tag tabs", () => {
    const s = fromTabSessionDto({
      active_id: "tag:work",
      tabs: [
        fileRow(0),
        { id: "tag:work", kind: "tag", path: null, tag_path: "work" },
      ],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["file:n0.md", "tag:work"]);
    expect(s.activeId).toBe("tag:work");
  });

  it("skips rows whose payload does not match their kind", () => {
    const s = fromTabSessionDto({
      active_id: null,
      tabs: [{ id: "file:x", kind: "file", path: null, tag_path: null }],
    });
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("caps a session saved with more tabs than the current maximum", () => {
    const s = fromTabSessionDto(dtoOf(MAX_TABS + 12, "file:n0.md"));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:n0.md");
  });

  it("keeps the saved active tab when capping drops its position", () => {
    const s = fromTabSessionDto(dtoOf(MAX_TABS + 12, "file:n15.md"));
    expect(s.tabs).toHaveLength(MAX_TABS);
    expect(s.activeId).toBe("file:n15.md");
  });
});

describe("toTabSessionDto", () => {
  it("persists file and tag tabs but not terminals", () => {
    let s: TabSet = openTab(emptyTabs, { kind: "file", path: "a.md" });
    s = openTab(s, { kind: "terminal", key: "1" });
    s = openTab(s, { kind: "tag", tagPath: "work" });

    const dto = toTabSessionDto(s);

    expect(dto.tabs.map((r) => r.id)).toEqual(["file:a.md", "tag:work"]);
    expect(dto.tabs[1]).toEqual({
      id: "tag:work",
      kind: "tag",
      path: null,
      tag_path: "work",
    });
  });

  it("round-trips through fromTabSessionDto", () => {
    let s: TabSet = openTab(emptyTabs, { kind: "file", path: "a.md" });
    s = openTab(s, { kind: "tag", tagPath: "work" });
    expect(fromTabSessionDto(toTabSessionDto(s))).toEqual(s);
  });
});
