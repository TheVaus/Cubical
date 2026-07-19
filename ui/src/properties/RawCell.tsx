import { type Component } from "solid-js";

import Link from "@ds/components/forms/Link/Link";

/**
 * Read-only fallback cell (L2 Session F, spec §2.4).
 *
 * Renders an unknown scalar or nested mapping as a JSON dump. The
 * Properties UI deliberately does not model these in L2 — editing
 * nested mappings, anchors, and YAML tags is post-L2 polish. The
 * "Open as raw" link flips the editor into raw mode so the user can
 * hand-edit the value.
 *
 * Uses the DS `Link` (issue #35) — a ghost Button would still read as
 * a chrome button, not an inline text link.
 */
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
