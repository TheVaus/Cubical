import type { JSX } from 'solid-js';
import './IconButton.css';

export interface IconButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  ariaExpanded?: boolean;
  ariaPressed?: boolean;
  mono?: boolean;
  size?: 'sm' | 'md';
  ariaHaspopup?: JSX.AriaAttributes['aria-haspopup'];
  style?: JSX.CSSProperties;
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
}

const IconButton = (props: IconButtonProps) => {
  return (
    <button
      type="button"
      class="icon-btn"
      classList={{
        active: props.active,
        mono: props.mono,
        sm: (props.size ?? 'md') === 'sm',
      }}
      aria-label={props.label}
      aria-expanded={props.ariaExpanded}
      aria-pressed={props.ariaPressed}
      aria-haspopup={props.ariaHaspopup}
      title={props.title ?? props.label}
      disabled={props.disabled}
      style={props.style}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default IconButton;
