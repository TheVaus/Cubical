import { type Component } from "solid-js";

import Toggle from "@ds/components/forms/Toggle/Toggle";

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
