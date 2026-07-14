import type { JSX } from 'solid-js';
import './IconButton.css';

export interface IconButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  /** Overrides the tooltip text when it should read differently from the accessible name. */
  title?: string;
  /** For disclosure/toggle buttons that control a popover or panel. */
  ariaExpanded?: boolean;
  /** For toggle buttons that switch a mode on and off (e.g. a panel toggle). */
  ariaPressed?: boolean;
  /**
   * Renders the glyph in the mono face. For ASCII/punctuation glyphs
   * (`</>`, `{}`) that only read as symbols in a mono font.
   */
  mono?: boolean;
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
}

const IconButton = (props: IconButtonProps) => {
  return (
    <button
      type="button"
      class="icon-btn"
      classList={{ active: props.active, mono: props.mono }}
      aria-label={props.label}
      aria-expanded={props.ariaExpanded}
      aria-pressed={props.ariaPressed}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default IconButton;
