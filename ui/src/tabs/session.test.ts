import { describe, expect, it, vi } from "vitest";
import type { TabSessionDto } from "../api/ipc";
import {
  createSessionSaver,
  fromTabSessionDto,
  toTabSessionDto,
} from "./session";
import { registerTabKinds } from "./tabKinds";
import { emptyTabs, MAX_TABS, openTab, type TabSet } from "./tabModel";

registerTabKinds([
  {
    kind: "page",
    label: (k) => k,
    evictable: true,
    persist: {
      toRecord: (k) => ({ path: null, tag_path: k }),
      fromRecord: (r) => r.tag_path,
    },
  },
  { kind: "live", label: () => "Live", evictable: false },
  {
    kind: "broken",
    label: (k) => k,
    evictable: true,
    persist: {
      toRecord: (k) => ({ path: k, tag_path: null }),
      fromRecord: () => {
        throw new Error("corrupt");
      },
    },
  },
]);

const fileRow = (n: number) => ({
  id: `file:n${n}.md`,
  kind: "file",
  path: `n${n}.md`,
  tag_path: null,
});

const pageRow = (key: string) => ({
  id: `page:${key}`,
  kind: "page",
  path: null,
  tag_path: key,
});

const dtoOf = (count: number, activeId: string | null): TabSessionDto => ({
  active_id: activeId,
  tabs: Array.from({ length: count }, (_, i) => fileRow(i)),
});

describe("fromTabSessionDto", () => {
  it("restores file tabs and tabs of a persisted contributed kind", () => {
    const s = fromTabSessionDto({
      active_id: "page:work",
      tabs: [fileRow(0), pageRow("work")],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["file:n0.md", "page:work"]);
    expect(s.activeId).toBe("page:work");
  });

  it("skips rows whose payload does not match their kind", () => {
    const s = fromTabSessionDto({
      active_id: null,
      tabs: [{ id: "file:x", kind: "file", path: null, tag_path: null }],
    });
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("drops a kind no block registered and restores the rest", () => {
    const s = fromTabSessionDto({
      active_id: "gone:x",
      tabs: [
        fileRow(0),
        { id: "gone:x", kind: "gone", path: "x", tag_path: "x" },
        pageRow("work"),
      ],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["file:n0.md", "page:work"]);
    expect(s.activeId).toBe("file:n0.md");
  });

  it("drops a registered kind that is not persisted", () => {
    const s = fromTabSessionDto({
      active_id: null,
      tabs: [{ id: "live:1", kind: "live", path: null, tag_path: null }, fileRow(1)],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["file:n1.md"]);
  });

  it("survives a block whose decoder throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = fromTabSessionDto({
      active_id: null,
      tabs: [{ id: "broken:a", kind: "broken", path: "a", tag_path: null }, fileRow(2)],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(["file:n2.md"]);
    spy.mockRestore();
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
  it("persists files and persisted kinds, never a kind without a codec", () => {
    let s: TabSet = openTab(emptyTabs, { kind: "file", path: "a.md" });
    s = openTab(s, { kind: "live", key: "1" });
    s = openTab(s, { kind: "page", key: "work" });
    s = openTab(s, { kind: "unregistered", key: "z" });

    const dto = toTabSessionDto(s);

    expect(dto.tabs).toEqual([
      { id: "file:a.md", kind: "file", path: "a.md", tag_path: null },
      pageRow("work"),
    ]);
  });

  it("round-trips through fromTabSessionDto", () => {
    let s: TabSet = openTab(emptyTabs, { kind: "file", path: "a.md" });
    s = openTab(s, { kind: "page", key: "work" });
    expect(fromTabSessionDto(toTabSessionDto(s))).toEqual(s);
  });
});

describe("createSessionSaver", () => {
  const dto = (active: string): TabSessionDto => ({
    active_id: active,
    tabs: [fileRow(0), fileRow(1)],
  });

  it("skips a save whose snapshot matches the last one for that vault", () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = createSessionSaver(save);
    saver("/v", dto("file:n0.md"));
    saver("/v", dto("file:n0.md"));
    saver("/v", dto("file:n1.md"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("saves the same snapshot again for a different vault", () => {
    const save = vi.fn(() => Promise.resolve());
    const saver = createSessionSaver(save);
    saver("/a", dto("file:n0.md"));
    saver("/b", dto("file:n0.md"));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("retries a snapshot whose save failed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const save = vi
      .fn<(p: string, d: TabSessionDto) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk"))
      .mockResolvedValue(undefined);
    const saver = createSessionSaver(save);
    saver("/v", dto("file:n0.md"));
    await Promise.resolve();
    await Promise.resolve();
    saver("/v", dto("file:n0.md"));
    expect(save).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
