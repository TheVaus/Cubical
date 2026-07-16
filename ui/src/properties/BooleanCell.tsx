import { type Component } from "solid-js";

import Toggle from "@ds/components/forms/Toggle/Toggle";

/**
 * Boolean-valued frontmatter cell (L2 Session F, spec §2.4).
 *
 * A two-state switch. A toggle has no in-progress draft state, so the
 * click commits immediately — no focus-guard is needed.
 *
 * DS `Toggle`'s `label` prop is its accessible name only — it renders
 * no visible text — so the true/false text stays as a visible sibling
 * `<span>`, matching the outgoing single-button layout's inline label.
 */
export interface BooleanCellProps {
  value: boolean;
  onCommit: (next: boolean) => void;
}

const BooleanCell: Component<BooleanCellProps> = (props) => {
  return (
    <div
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "var(--space-2)",
        padding: "var(--space-1) var(--space-2)",
      }}
    >
      <Toggle
        checked={props.value}
        onChange={props.onCommit}
        label={props.value ? "true" : "false"}
      />
      <span
        style={{
          "font-family": "var(--font-body)",
          "font-size": "var(--text-sm)",
          color: "var(--c-fg-secondary)",
        }}
      >
        {props.value ? "true" : "false"}
      </span>
    </div>
  );
};

export default BooleanCell;
