import type { TabRecordDto, TabSessionDto } from "../api/ipc";
import { FILE_KIND, tabKind } from "./tabKinds";
import {
  clampTabs,
  isFileView,
  tabId,
  type Tab,
  type TabSet,
  type TabView,
} from "./tabModel";

function toRecord(t: Tab): TabRecordDto | null {
  if (isFileView(t.view)) {
    return { id: t.id, kind: FILE_KIND, path: t.view.path, tag_path: null };
  }
  const persist = tabKind(t.view.kind)?.persist;
  if (persist === undefined) return null;
  return { id: t.id, kind: t.view.kind, ...persist.toRecord(t.view.key) };
}

export function toTabSessionDto(s: TabSet): TabSessionDto {
  return {
    active_id: s.activeId,
    tabs: s.tabs.flatMap((t) => {
      const record = toRecord(t);
      return record === null ? [] : [record];
    }),
  };
}

function restoreView(r: TabRecordDto): TabView | null {
  if (r.kind === FILE_KIND) {
    return r.path === null ? null : { kind: FILE_KIND, path: r.path };
  }
  const persist = tabKind(r.kind)?.persist;
  if (persist === undefined) return null;
  try {
    const key = persist.fromRecord(r);
    return key === null ? null : { kind: r.kind, key };
  } catch (e) {
    console.error(`tab kind ${r.kind} could not restore a saved tab`, e);
    return null;
  }
}

export function fromTabSessionDto(dto: TabSessionDto): TabSet {
  const tabs = dto.tabs.flatMap((r) => {
    const view = restoreView(r);
    return view === null ? [] : [{ id: tabId(view), view }];
  });
  const activeId = tabs.some((t) => t.id === dto.active_id)
    ? dto.active_id
    : (tabs[0]?.id ?? null);
  return clampTabs({ tabs, activeId });
}

export function createSessionSaver(
  save: (vaultPath: string, dto: TabSessionDto) => Promise<void>,
): (vaultPath: string, dto: TabSessionDto) => void {
  let last: { path: string; json: string } | null = null;
  return (vaultPath, dto) => {
    const json = JSON.stringify(dto);
    if (last !== null && last.path === vaultPath && last.json === json) return;
    const sent = { path: vaultPath, json };
    last = sent;
    void save(vaultPath, dto).catch((e: unknown) => {
      if (last === sent) last = null;
      console.error("saveTabSession failed", e);
    });
  };
}
