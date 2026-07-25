import { activateTab, type TabSet } from "./tabModel";

export interface ActivationDeps {
  current: () => TabSet;
  flush: () => Promise<void>;
  setTabs: (fn: (s: TabSet) => TabSet) => void;
  resetDocState: () => void;
  loadContent: () => Promise<void>;
}

export async function activateWithFlush(
  deps: ActivationDeps,
  id: string,
): Promise<void> {
  const s = deps.current();
  if (s.activeId === id) return;
  if (!s.tabs.some((t) => t.id === id)) return;
  await deps.flush();
  deps.resetDocState();
  deps.setTabs((s) => activateTab(s, id));
  await deps.loadContent();
}
