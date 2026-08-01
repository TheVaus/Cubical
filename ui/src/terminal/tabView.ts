import { tabId, type Tab, type TabView } from "../tabs/tabModel";

export function terminalView(key: string): TabView {
  return { kind: "terminal", key };
}

export function terminalTabId(key: string): string {
  return tabId(terminalView(key));
}

export function isTerminalView(view: TabView): boolean {
  return view.kind === "terminal";
}

export function terminalTabIds(tabs: Tab[]): string[] {
  return tabs.filter((t) => isTerminalView(t.view)).map((t) => t.id);
}
