import type { JSX } from 'solid-js';
import './Button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** Compact sizing for dense clusters (e.g. filter chips). Defaults to 'md'. */
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** Stretches the button to 100% of its containing block. */
  fullWidth?: boolean;
  /**
   * Lays the button out as a full-width, left-aligned column instead of
   * the default centered single-line row. For list-style action rows
   * that need multi-line content (e.g. a clickable search/file result
   * with a title plus a secondary line) rather than a short label.
   */
  block?: boolean;
  /**
   * Overrides the accessible name. Only needed when the visible children
   * don't fully describe the action (e.g. a disclosure trigger that wants
   * "<label> — open details" while showing just "<label>").
   */
  ariaLabel?: string;
  /** Native tooltip text, for a button whose visible label needs a longer hover explanation. */
  title?: string;
  /** For disclosure/toggle buttons that control a popover or panel. */
  ariaExpanded?: boolean;
  /** For toggle-style buttons in a single/multi-select group (e.g. a filter chip). */
  ariaPressed?: boolean;
  /** Escape hatch for instance-specific style overrides (token-driven values only). */
  style?: JSX.CSSProperties;
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
}

const Button = (props: ButtonProps) => {
  return (
    <button
      type={props.type ?? 'button'}
      class="btn"
      classList={{
        primary: (props.variant ?? 'secondary') === 'primary',
        secondary: (props.variant ?? 'secondary') === 'secondary',
        ghost: (props.variant ?? 'secondary') === 'ghost',
        danger: (props.variant ?? 'secondary') === 'danger',
        'full-width': props.fullWidth,
        sm: (props.size ?? 'md') === 'sm',
        block: props.block,
      }}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      aria-expanded={props.ariaExpanded}
      aria-pressed={props.ariaPressed}
      title={props.title}
      style={props.style}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default Button;
