import type { JSX } from 'solid-js';
import './DatePicker.css';

export interface DatePickerProps {
  type?: 'date' | 'datetime-local';
  value: string;
  /** DS convention: the input's value string, not the event. */
  onInput?: ((value: string) => void) | undefined;
  /** Native `change` (e.g. a date picked from the OS picker); value string. */
  onChange?: ((value: string) => void) | undefined;
  onFocus?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
  onKeyDown?: ((e: KeyboardEvent) => void) | undefined;
  /** Compact sizing to match TextInput sm (e.g. inline property cells). Defaults to 'md'. */
  size?: 'sm' | 'md';
  ariaLabel?: string;
  /** Forwards the underlying <input> element, e.g. for imperative focus management. */
  ref?: ((el: HTMLInputElement) => void) | undefined;
  class?: string;
  style?: JSX.CSSProperties | string;
}

const DatePicker = (props: DatePickerProps) => {
  return (
    <input
      type={props.type ?? 'date'}
      class={`ds-datepicker${props.class ? ` ${props.class}` : ''}`}
      classList={{ sm: (props.size ?? 'md') === 'sm' }}
      value={props.value}
      aria-label={props.ariaLabel}
      style={props.style}
      ref={(el) => props.ref?.(el)}
      onInput={(e) => props.onInput?.(e.currentTarget.value)}
      onChange={(e) => props.onChange?.(e.currentTarget.value)}
      onFocus={() => props.onFocus?.()}
      onBlur={() => props.onBlur?.()}
      onKeyDown={(e) => props.onKeyDown?.(e)}
    />
  );
};

export default DatePicker;
