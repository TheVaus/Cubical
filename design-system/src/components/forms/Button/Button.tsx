import type { JSX } from 'solid-js';
import './Button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost';
  /** Compact sizing for dense clusters (e.g. filter chips). Defaults to 'md'. */
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** Stretches the button to 100% of its containing block. */
  fullWidth?: boolean;
  /**
   * Overrides the accessible name. Only needed when the visible children
   * don't fully describe the action (e.g. a disclosure trigger that wants
   * "<label> — open details" while showing just "<label>").
   */
  ariaLabel?: string;
  /** For disclosure/toggle buttons that control a popover or panel. */
  ariaExpanded?: boolean;
  /** For toggle-style buttons in a single/multi-select group (e.g. a filter chip). */
  ariaPressed?: boolean;
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
        'full-width': props.fullWidth,
        sm: (props.size ?? 'md') === 'sm',
      }}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      aria-expanded={props.ariaExpanded}
      aria-pressed={props.ariaPressed}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default Button;
