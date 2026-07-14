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
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
}

const IconButton = (props: IconButtonProps) => {
  return (
    <button
      type="button"
      class="icon-btn"
      classList={{ active: props.active }}
      aria-label={props.label}
      aria-expanded={props.ariaExpanded}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default IconButton;
