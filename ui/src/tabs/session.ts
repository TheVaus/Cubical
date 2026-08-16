import type { TabSessionDto } from "../api/ipc";
import {
  clampTabs,
  isPersistableTab,
  tabId,
  type TabSet,
  type TabView,
} from "./tabModel";

export function toTabSessionDto(s: TabSet): TabSessionDto {
  return {
    active_id: s.activeId,
    tabs: s.tabs.filter(isPersistableTab).map((t) => ({
      id: t.id,
      kind: t.view.kind,
      path: t.view.kind === "file" ? t.view.path : null,
      tag_path: t.view.kind === "tag" ? t.view.tagPath : null,
    })),
  };
}

export function fromTabSessionDto(dto: TabSessionDto): TabSet {
  const tabs = dto.tabs.flatMap((r) => {
    const view: TabView | null =
      r.kind === "file" && r.path !== null
        ? { kind: "file", path: r.path }
        : r.kind === "tag" && r.tag_path !== null
          ? { kind: "tag", tagPath: r.tag_path }
          : null;
    return view === null ? [] : [{ id: tabId(view), view }];
  });
  const activeId = tabs.some((t) => t.id === dto.active_id)
    ? dto.active_id
    : (tabs[0]?.id ?? null);
  return clampTabs({ tabs, activeId });
}
