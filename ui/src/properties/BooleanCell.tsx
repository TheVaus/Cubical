import { type Component } from "solid-js";

import Toggle from "@ds/components/forms/Toggle/Toggle";

/**
 * Boolean-valued frontmatter cell (L2 Session F, spec §2.4).
 *
 * A two-state switch. A toggle has no in-progress draft state, so the
 * click commits immediately — no focus-guard is needed.
 *
 * `showLabel` renders the true/false text as part of the switch's own hit
 * area, so clicking the text flips the value too — matching the outgoing
 * single-button layout, where switch + label were one `role="switch"`
 * control. (An earlier layout kept the text as an inert sibling `<span>`,
 * which broke that whole-control click.)
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
        padding: "var(--space-1) var(--space-2)",
      }}
    >
      <Toggle
        checked={props.value}
        onChange={props.onCommit}
        label={props.value ? "true" : "false"}
        showLabel
      />
    </div>
  );
};

export default BooleanCell;
