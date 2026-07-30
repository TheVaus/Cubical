import { tabId, type TabView } from "../tabs/tabModel";

export const CONSOLE_VIEW: TabView = { kind: "console" };

export const CONSOLE_TAB_ID = tabId(CONSOLE_VIEW);

export function isConsoleView(view: TabView): boolean {
  return view.kind === "console";
}
