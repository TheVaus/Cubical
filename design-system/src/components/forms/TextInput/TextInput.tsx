import type { JSX } from 'solid-js';
import './TextInput.css';

export interface TextInputProps {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  ref?: (el: HTMLInputElement) => void;
  ariaLabel?: string;
  style?: JSX.CSSProperties;
  size?: 'sm' | 'md';
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  inputMode?: string;
}

const TextInput = (props: TextInputProps) => {
  return (
    <input
      class="text-input"
      classList={{ sm: (props.size ?? 'md') === 'sm' }}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      style={props.style}
      inputmode={props.inputMode as JSX.HTMLAttributes<HTMLInputElement>['inputmode']}
      ref={(el) => props.ref?.(el)}
      onInput={(e) => props.onInput(e.currentTarget.value)}
      onFocus={() => props.onFocus?.()}
      onBlur={() => props.onBlur?.()}
      onKeyDown={(e) => props.onKeyDown?.(e)}
    />
  );
};

export default TextInput;
