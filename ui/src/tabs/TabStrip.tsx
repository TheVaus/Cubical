import { For } from "solid-js";
import type { Tab, TabSet } from "./tabModel";

export interface TabStripProps {
  tabs: TabSet;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
}

function label(tab: Tab): string {
  if (tab.view.kind === "tag") return `#${tab.view.tagPath}`;
  const base = tab.view.path.slice(tab.view.path.lastIndexOf("/") + 1);
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

export default function TabStrip(props: TabStripProps) {
  let dragged: string | null = null;
  return (
    <div class="topbar__tabs" role="tablist">
      <For each={props.tabs.tabs}>
        {(tab, index) => (
          <div
            class="tab"
            classList={{ "tab--active": tab.id === props.tabs.activeId }}
            role="tab"
            aria-selected={tab.id === props.tabs.activeId}
            draggable
            onClick={() => props.onActivate(tab.id)}
            onDragStart={() => {
              dragged = tab.id;
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragged !== null && dragged !== tab.id) {
                props.onMove(dragged, index());
              }
              dragged = null;
            }}
          >
            <span class="tab__label">{label(tab)}</span>
            <button
              class="tab__close"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                props.onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
