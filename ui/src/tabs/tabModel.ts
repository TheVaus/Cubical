export type TabView =
  | { kind: "file"; path: string }
  | { kind: "tag"; tagPath: string }
  | { kind: "terminal"; key: string };

export interface Tab {
  id: string;
  view: TabView;
}

export interface TabSet {
  tabs: Tab[];
  activeId: string | null;
}

export const emptyTabs: TabSet = { tabs: [], activeId: null };

export function tabId(view: TabView): string {
  switch (view.kind) {
    case "file":
      return `file:${view.path}`;
    case "tag":
      return `tag:${view.tagPath}`;
    case "terminal":
      return `terminal:${view.key}`;
  }
}

export type PersistableTabView = Extract<
  TabView,
  { kind: "file" } | { kind: "tag" }
>;

export function isPersistableTab(
  t: Tab,
): t is Tab & { view: PersistableTabView } {
  return t.view.kind === "file" || t.view.kind === "tag";
}

export function activeTab(s: TabSet): Tab | null {
  return s.tabs.find((t) => t.id === s.activeId) ?? null;
}

export function openTab(s: TabSet, view: TabView): TabSet {
  const id = tabId(view);
  if (s.tabs.some((t) => t.id === id)) return { ...s, activeId: id };
  return { tabs: [...s.tabs, { id, view }], activeId: id };
}

export function closeTab(s: TabSet, id: string): TabSet {
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return s;
  const tabs = s.tabs.filter((t) => t.id !== id);
  if (s.activeId !== id) return { ...s, tabs };
  const next = tabs[i] ?? tabs[i - 1] ?? null;
  return { tabs, activeId: next ? next.id : null };
}

export function activateTab(s: TabSet, id: string): TabSet {
  return s.tabs.some((t) => t.id === id) ? { ...s, activeId: id } : s;
}

export function moveTab(s: TabSet, id: string, toIndex: number): TabSet {
  const from = s.tabs.findIndex((t) => t.id === id);
  if (from < 0) return s;
  const clamped = Math.max(0, Math.min(s.tabs.length - 1, toIndex));
  const tabs = [...s.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(clamped, 0, moved!);
  return { ...s, tabs };
}

function step(s: TabSet, delta: number): TabSet {
  if (s.tabs.length === 0) return s;
  const i = s.tabs.findIndex((t) => t.id === s.activeId);
  const base = i < 0 ? 0 : i;
  const n = s.tabs.length;
  return { ...s, activeId: s.tabs[(base + delta + n) % n]!.id };
}

export function nextTab(s: TabSet): TabSet {
  return step(s, 1);
}

export function prevTab(s: TabSet): TabSet {
  return step(s, -1);
}

export function remapTabPaths(
  s: TabSet,
  remap: (path: string) => string | null,
): TabSet {
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  const rename = new Map<string, string>();
  for (const t of s.tabs) {
    let next = t;
    if (t.view.kind === "file") {
      const to = remap(t.view.path);
      if (to !== null && to !== t.view.path) {
        const view: TabView = { kind: "file", path: to };
        next = { ...t, id: tabId(view), view };
        rename.set(t.id, next.id);
      }
    }
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    tabs.push(next);
  }
  const activeId = s.activeId === null ? null : (rename.get(s.activeId) ?? s.activeId);
  return { tabs, activeId: tabs.some((t) => t.id === activeId) ? activeId : (tabs[0]?.id ?? null) };
}

export function dropMissingTabs(
  s: TabSet,
  exists: (path: string) => boolean,
): TabSet {
  const tabs = s.tabs.filter((t) => t.view.kind !== "file" || exists(t.view.path));
  if (tabs.length === s.tabs.length) return s;
  const activeId = tabs.some((t) => t.id === s.activeId)
    ? s.activeId
    : (tabs[0]?.id ?? null);
  return { tabs, activeId };
}
