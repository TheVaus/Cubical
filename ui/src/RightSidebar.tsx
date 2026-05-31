import { For, Show, type Component, type JSX } from "solid-js";

/**
 * Collapsible right-sidebar shell.
 *
 * Owns the chrome (collapse toggle + optional segment selector) and
 * defers panel content to `children`. The segment selector is optional
 * — Session C shipped with one panel and no selector; Session I adds
 * the second panel + the segment chrome together.
 *
 * `collapsed` / `onToggle` and (optionally) `segment` / `onSegmentChange`
 * are owned by the parent so the values can be persisted as vault-local
 * settings.
 */
export interface RightSidebarSegment {
  /** Stable id — used as the React-style key and the value passed to
   *  `onSegmentChange`. */
  id: string;
  /** Display label rendered on the tab. */
  label: string;
}

export interface RightSidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  /** When provided, a tabbed selector appears above `children`. */
  segments?: RightSidebarSegment[];
  segment?: string;
  onSegmentChange?: (id: string) => void;
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
        <Show when={props.segments && props.segments.length > 1}>
          <div
            role="tablist"
            aria-label="Sidebar panels"
            style={{
              display: "flex",
              gap: "var(--space-1)",
              padding: "var(--space-2) var(--space-3)",
              "border-bottom": "1px solid var(--c-border-subtle)",
            }}
          >
            <For each={props.segments!}>
              {(s) => {
                const selected = () => props.segment === s.id;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={selected()}
                    onClick={() => props.onSegmentChange?.(s.id)}
                    style={{
                      flex: 1,
                      padding: "var(--space-1) var(--space-2)",
                      "font-family": "var(--font-body)",
                      "font-size": "var(--text-xs)",
                      "text-transform": "uppercase",
                      "letter-spacing": "0.05em",
                      color: selected()
                        ? "var(--c-fg-inverse)"
                        : "var(--c-fg-secondary)",
                      background: selected()
                        ? "var(--c-accent)"
                        : "transparent",
                      border: "1px solid var(--c-border-subtle)",
                      "border-radius": "var(--radius-sm, var(--radius-md))",
                      cursor: "pointer",
                    }}
                  >
                    {s.label}
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
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
