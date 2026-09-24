import { describe, expect, it } from "vitest";

import type { TabSessionDto } from "../api/ipc";
import { fromTabSessionDto, toTabSessionDto } from "../tabs/session";
import { registerTabKinds } from "../tabs/tabKinds";
import { emptyTabs, openTab, tabId } from "../tabs/tabModel";
import { TAG_TAB_KIND, tagPathOf, tagView } from "./tabKind";

registerTabKinds([TAG_TAB_KIND]);

const savedBeforeTheSeam = `{
  "active_id": "tag:work/q3",
  "tabs": [
    { "id": "file:notes/a.md", "kind": "file", "path": "notes/a.md", "tag_path": null },
    { "id": "tag:work/q3", "kind": "tag", "path": null, "tag_path": "work/q3" }
  ]
}`;

describe("tag tab kind", () => {
  it("keeps the id a tag tab has always had", () => {
    expect(tabId(tagView("work"))).toBe("tag:work");
  });

  it("restores and re-saves a session written before the seam byte for byte", () => {
    const dto = JSON.parse(savedBeforeTheSeam) as TabSessionDto;
    const restored = fromTabSessionDto(dto);

    expect(restored.tabs.map((t) => t.id)).toEqual(["file:notes/a.md", "tag:work/q3"]);
    expect(restored.activeId).toBe("tag:work/q3");
    expect(JSON.stringify(toTabSessionDto(restored))).toBe(JSON.stringify(dto));
  });

  it("reads the tag path back only from a tag view", () => {
    expect(tagPathOf(tagView("x"))).toBe("x");
    expect(tagPathOf({ kind: "file", path: "a.md" })).toBeNull();
  });

  it("labels a tab with its tag", () => {
    expect(TAG_TAB_KIND.label("work")).toBe("#work");
    expect(openTab(emptyTabs, tagView("work")).tabs[0]!.view).toEqual(tagView("work"));
  });
});
