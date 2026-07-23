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
