import type { JSX } from 'solid-js';
import './Button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  type?: 'button' | 'submit';
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
      }}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default Button;
