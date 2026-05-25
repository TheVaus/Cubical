import { Show, type Component, type JSX } from "solid-js";

/**
 * Collapsible right-sidebar shell.
 *
 * Panel-agnostic on purpose: Session C ships exactly one occupant
 * (Backlinks), Session I will add Unlinked Mentions and a tab/segment
 * selector. The shell itself only handles the collapsed/expanded
 * frame and the toggle button; the contents are `children`.
 *
 * `collapsed` and `onToggle` are owned by the parent so the value can
 * be persisted as a vault-local setting.
 */
export interface RightSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  children: JSX.Element;
}

const COLLAPSED_WIDTH = "2rem";
const EXPANDED_WIDTH = "18rem";

const RightSidebar: Component<RightSidebarProps> = (props) => {
  return (
    <aside
      aria-label="Right sidebar"
      style={{
        flex: `0 0 ${props.collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH}`,
        display: "flex",
        "flex-direction": "column",
        border: "1px solid var(--c-border-subtle)",
        "border-radius": "var(--radius-md)",
        background: "var(--c-bg-secondary)",
        "min-height": 0,
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": props.collapsed ? "center" : "flex-end",
          padding: "var(--space-2)",
          "border-bottom": props.collapsed
            ? "none"
            : "1px solid var(--c-border-subtle)",
        }}
      >
        <button
          type="button"
          onClick={props.onToggle}
          aria-label={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-pressed={!props.collapsed}
          title={props.collapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "1.75rem",
            height: "1.75rem",
            "font-family": "var(--font-mono)",
            "font-size": "var(--text-sm)",
            "line-height": "1",
            color: "var(--c-fg-secondary)",
            background: "transparent",
            border: "1px solid var(--c-border-subtle)",
            "border-radius": "var(--radius-sm, var(--radius-md))",
            cursor: "pointer",
            transition:
              "color var(--transition-fast), background var(--transition-fast)",
          }}
        >
          {props.collapsed ? "‹" : "›"}
        </button>
      </header>
      <Show when={!props.collapsed}>
        <div
          style={{
            flex: 1,
            "min-height": 0,
            display: "flex",
            "flex-direction": "column",
          }}
        >
          {props.children}
        </div>
      </Show>
    </aside>
  );
};

export default RightSidebar;
