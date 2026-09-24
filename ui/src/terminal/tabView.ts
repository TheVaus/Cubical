import type { TabKind } from "../tabs/tabKinds";
import { tabId, type Tab, type TabView } from "../tabs/tabModel";

export const TERMINAL_TAB_KIND: TabKind = {
  kind: "terminal",
  label: () => "Terminal",
  evictable: false,
};

export function terminalView(key: string): TabView {
  return { kind: TERMINAL_TAB_KIND.kind, key };
}

export function terminalTabId(key: string): string {
  return tabId(terminalView(key));
}

export function isTerminalView(view: TabView): boolean {
  return view.kind === TERMINAL_TAB_KIND.kind;
}

export function terminalTabIds(tabs: Tab[]): string[] {
  return tabs.filter((t) => isTerminalView(t.view)).map((t) => t.id);
}
