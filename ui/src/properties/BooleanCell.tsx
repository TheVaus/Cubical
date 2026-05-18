import { type Component } from "solid-js";

/**
 * Boolean-valued frontmatter cell (L2 Session F, spec §2.4).
 *
 * A two-state switch. A toggle has no in-progress draft state, so the
 * click commits immediately — no focus-guard is needed.
 */
export interface BooleanCellProps {
  value: boolean;
  onCommit: (next: boolean) => void;
}

const BooleanCell: Component<BooleanCellProps> = (props) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.value}
      onClick={() => props.onCommit(!props.value)}
      style={{
        display: "inline-flex",
        "align-items": "center",
        gap: "var(--space-2)",
        padding: "var(--space-1) var(--space-2)",
        "font-family": "var(--font-body)",
        "font-size": "var(--text-sm)",
        color: "var(--c-fg-primary)",
        background: "transparent",
        border: "none",
        cursor: "pointer",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "relative",
          display: "inline-block",
          width: "2rem",
          height: "1.125rem",
          background: props.value ? "var(--c-accent)" : "var(--c-bg-tertiary)",
          border: "1px solid var(--c-border-subtle)",
          "border-radius": "var(--radius-full)",
          transition: "background var(--transition-fast)",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: "1px",
            left: props.value ? "calc(100% - 1.0rem)" : "1px",
            width: "0.875rem",
            height: "0.875rem",
            background: "var(--c-bg-primary)",
            "border-radius": "var(--radius-full)",
            "box-shadow": "var(--shadow-sm)",
            transition: "left var(--transition-fast)",
          }}
        />
      </span>
      <span style={{ color: "var(--c-fg-secondary)" }}>
        {props.value ? "true" : "false"}
      </span>
    </button>
  );
};

export default BooleanCell;
