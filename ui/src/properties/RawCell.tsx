import { type Component } from "solid-js";

/**
 * Read-only fallback cell (L2 Session F, spec §2.4).
 *
 * Renders an unknown scalar or nested mapping as a JSON dump. The
 * Properties UI deliberately does not model these in L2 — editing
 * nested mappings, anchors, and YAML tags is post-L2 polish. The
 * "Open as raw" link flips the editor into raw mode so the user can
 * hand-edit the value.
 *
 * Judgement call (design-system migration Task 3): kept bespoke rather
 * than `@ds Button variant="ghost" size="sm"`. Measured against the
 * app's loaded `Button.css`, `.btn.ghost.sm` computes to
 * `padding: 4px 8px`, `border-radius: 4px`, `height: 28px`, and a
 * hover background — plus it inherits the default foreground color
 * with no underline. That's a padded, rounded chrome button. The
 * outgoing link is zero-padding, `color: var(--c-accent)`,
 * `text-decoration: underline`, no border/background. Adopting ghost
 * Button would make this read as a button, not an inline text link —
 * the exact regression the brief flags to avoid — so it stays a
 * bespoke `<button>` styled as a link.
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
      <button
        type="button"
        onClick={() => props.onOpenRaw()}
        style={{
          "flex-shrink": 0,
          padding: "0",
          "font-family": "var(--font-body)",
          "font-size": "var(--text-xs)",
          color: "var(--c-accent)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          "text-decoration": "underline",
        }}
      >
        Open as raw
      </button>
    </div>
  );
};

export default RawCell;
