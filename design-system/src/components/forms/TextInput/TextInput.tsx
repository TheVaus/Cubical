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
}

const TextInput = (props: TextInputProps) => {
  return (
    <input
      class="text-input"
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      style={props.style}
      ref={(el) => props.ref?.(el)}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
};

export default TextInput;
