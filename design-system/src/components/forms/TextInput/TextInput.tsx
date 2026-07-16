import type { JSX } from 'solid-js';
import './TextInput.css';

export interface TextInputProps {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  /** Forwards the underlying <input> element, e.g. for imperative focus management. */
  ref?: (el: HTMLInputElement) => void;
  /** Overrides the accessible name when no visible <label> element is present. */
  ariaLabel?: string;
  /** Escape hatch for instance-specific layout overrides (token-driven values only). */
  style?: JSX.CSSProperties;
  /** Compact sizing for dense clusters (e.g. inline-edit table cells). Defaults to 'md'. */
  size?: 'sm' | 'md';
  onFocus?: () => void;
  onBlur?: () => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  /** Rendered as the `inputmode` attribute, e.g. for numeric-leaning inline edit fields. */
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
