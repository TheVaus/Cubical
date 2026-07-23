import { type Component } from "solid-js";

import Link from "@ds/components/forms/Link/Link";

export interface RawCellProps {
  value: unknown;
  onOpenRaw: () => void;
}

const RawCell: Component<RawCellProps> = (props) => {
  return (
    <div
      style={{
        display: "flex",
        "align-items": "baseline",
        gap: "var(--space-2)",
        "min-width": 0,
      }}
    >
      <code
        style={{
          flex: 1,
          "min-width": 0,
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
          "font-family": "var(--font-mono)",
          "font-size": "var(--text-xs)",
          color: "var(--c-fg-secondary)",
        }}
      >
        {JSON.stringify(props.value)}
      </code>
      <Link
        size="xs"
        onClick={() => props.onOpenRaw()}
        style={{ "flex-shrink": 0 }}
      >
        Open as raw
      </Link>
    </div>
  );
};

export default RawCell;
