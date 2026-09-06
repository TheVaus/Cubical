import type { JSX } from 'solid-js';
import './Button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  type?: 'button' | 'submit';
  fullWidth?: boolean;
  block?: boolean;
  ariaLabel?: string;
  title?: string;
  ariaExpanded?: boolean;
  ariaPressed?: boolean;
  ariaHaspopup?: JSX.AriaAttributes['aria-haspopup'];
  role?: JSX.AriaAttributes['role'];
  tabIndex?: number;
  class?: string;
  style?: JSX.CSSProperties;
  ref?: (el: HTMLButtonElement) => void;
  onClick?: (e: MouseEvent) => void;
  onFocus?: () => void;
  children: JSX.Element;
}

const Button = (props: ButtonProps) => {
  return (
    <button
      type={props.type ?? 'button'}
      class={`btn${props.class ? ` ${props.class}` : ""}`}
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
      aria-haspopup={props.ariaHaspopup}
      title={props.title}
      role={props.role}
      tabindex={props.tabIndex}
      style={props.style}
      ref={(el) => props.ref?.(el)}
      onClick={(e) => props.onClick?.(e)}
      onFocus={() => props.onFocus?.()}
    >
      {props.children}
    </button>
  );
};

export default Button;
