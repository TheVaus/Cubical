import { For, type JSXElement } from "solid-js";

import type { TabSet } from "../tabs/tabModel";
import { TerminalPanel } from "./TerminalPanel";
import { terminalTabIds } from "./tabView";

export function TerminalTabPanes(props: {
  tabs: () => TabSet;
  vaultId: () => string | null;
  resolvedTheme: () => "light" | "dark";
  onOpened: (tabId: string, terminalId: string) => void;
  onClosed: (tabId: string) => void;
}): JSXElement {
  return (
    <For each={terminalTabIds(props.tabs().tabs)}>
      {(id) => (
        <div
          style={{
            display: id === props.tabs().activeId ? "contents" : "none",
          }}
        >
          <TerminalPanel
            vaultId={props.vaultId()!}
            resolvedTheme={props.resolvedTheme()}
            onOpened={(terminalId) => props.onOpened(id, terminalId)}
            onClosed={() => props.onClosed(id)}
          />
        </div>
      )}
    </For>
  );
}
