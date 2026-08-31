import type { JSX } from 'solid-js';
import './TextInput.css';

export interface TextInputProps {
  value: string;
  onInput?: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  ref?: (el: HTMLInputElement) => void;
  ariaLabel?: string;
  class?: string;
  style?: JSX.CSSProperties;
  size?: 'sm' | 'md';
  min?: number;
  max?: number;
  step?: number;
  autofocus?: boolean;
  readOnly?: boolean;
  spellcheck?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  onChange?: (value: string) => void;
  onClick?: (e: MouseEvent) => void;
  inputMode?: string;
}

const TextInput = (props: TextInputProps) => {
  return (
    <input
      class={`text-input${props.class ? ` ${props.class}` : ''}`}
      classList={{ sm: (props.size ?? 'md') === 'sm' }}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      min={props.min}
      max={props.max}
      step={props.step}
      autofocus={props.autofocus}
      readOnly={props.readOnly}
      spellcheck={props.spellcheck}
      style={props.style}
      inputmode={props.inputMode as JSX.HTMLAttributes<HTMLInputElement>['inputmode']}
      ref={(el) => props.ref?.(el)}
      onInput={(e) => props.onInput?.(e.currentTarget.value)}
      onFocus={() => props.onFocus?.()}
      onBlur={() => props.onBlur?.()}
      onKeyDown={(e) => props.onKeyDown?.(e)}
      onChange={(e) => props.onChange?.(e.currentTarget.value)}
      onClick={(e) => props.onClick?.(e)}
    />
  );
};

export default TextInput;
