import type { JSX } from 'solid-js';
import './DatePicker.css';

export interface DatePickerProps {
  type?: 'date' | 'datetime-local';
  value: string;
  onInput?: ((value: string) => void) | undefined;
  onChange?: ((value: string) => void) | undefined;
  onFocus?: (() => void) | undefined;
  onBlur?: (() => void) | undefined;
  onKeyDown?: ((e: KeyboardEvent) => void) | undefined;
  size?: 'sm' | 'md';
  ariaLabel?: string;
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
