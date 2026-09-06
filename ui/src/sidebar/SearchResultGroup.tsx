import { For, Show, type Component } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import IconButton from "@ds/components/forms/IconButton/IconButton";
import Icon from "@ds/components/graphics/Icon/Icon";

import { formatRelativeTime } from "./relativeTime";
import type { FileGroup, ResultCard } from "./resultGroups";

export interface SearchResultGroupProps {
  group: FileGroup;
  collapsed: boolean;
  tabStop: boolean;
  registerRef: (el: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onToggle: () => void;
  onOpen: () => void;
}

const SearchResultGroup: Component<SearchResultGroupProps> = (props) => (
  <div
    style={{ "min-width": 0, "border-bottom": "1px solid var(--c-border-subtle)" }}
  >
    <div
      style={{
        display: "flex",
        "align-items": "center",
        gap: "var(--space-2)",
        "min-width": 0,
        padding: "var(--space-2) var(--space-3)",
      }}
    >
      <IconButton
        label={props.collapsed ? "Expand file" : "Collapse file"}
        ariaExpanded={!props.collapsed}
        onClick={props.onToggle}
      >
        <Icon
          name={props.collapsed ? "chevron-right" : "chevron-down"}
          size={10}
        />
      </IconButton>
      <Button
        variant="ghost"
        size="sm"
        ref={props.registerRef}
        tabIndex={props.tabStop ? 0 : -1}
        onFocus={props.onFocus}
        onClick={props.onOpen}
        title={props.group.path}
        style={{
          display: "block",
          flex: 1,
          "min-width": 0,
          "text-align": "left",
          "font-size": "var(--text-sm)",
          color: "var(--c-fg-primary)",
          padding: 0,
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}
      >
        {props.group.title}
      </Button>
      <span
        style={{
          "flex-shrink": 0,
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-muted)",
        }}
      >
        {formatRelativeTime(props.group.mtime_secs)}
      </span>
      <span
        style={{
          "flex-shrink": 0,
          "min-width": "1.25rem",
          "text-align": "center",
          padding: "0 var(--space-1)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-secondary)",
          background: "var(--c-bg-secondary)",
          border: "1px solid var(--c-border-subtle)",
          "border-radius": "var(--radius-sm, var(--radius-md))",
        }}
      >
        {props.group.cards.length}
      </span>
    </div>

    <Show when={!props.collapsed}>
      <div style={{ padding: "0 var(--space-3) var(--space-2)", "min-width": 0 }}>
        <For each={props.group.cards}>
          {(card) => <SnippetCard card={card} onClick={props.onOpen} />}
        </For>
      </div>
    </Show>
  </div>
);

const SnippetCard: Component<{ card: ResultCard; onClick: () => void }> = (
  props,
) => (
  <div
    role="button"
    tabindex={-1}
    onClick={props.onClick}
    style={{
      "min-width": 0,
      padding: "var(--space-2)",
      "margin-top": "var(--space-1)",
      "font-size": "var(--text-xs)",
      "line-height": 1.5,
      color: "var(--c-fg-secondary)",
      background: "var(--c-bg-primary)",
      border: "1px solid var(--c-border-subtle)",
      "border-radius": "var(--radius-sm, var(--radius-md))",
      cursor: "pointer",
      "overflow-wrap": "anywhere",
    }}
  >
    <For each={props.card.segments}>
      {(seg) =>
        seg.mark ? (
          <mark
            style={{
              background: "var(--c-accent)",
              color: "var(--c-fg-inverse)",
              "border-radius": "var(--radius-sm, 2px)",
              padding: "0 2px",
            }}
          >
            {seg.text}
          </mark>
        ) : (
          <span>{seg.text}</span>
        )
      }
    </For>
  </div>
);

export default SearchResultGroup;
