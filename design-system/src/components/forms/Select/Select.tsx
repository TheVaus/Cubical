import type { JSX } from 'solid-js';
import { For } from 'solid-js';
import Icon from '../../graphics/Icon/Icon';
import './Select.css';

export interface SelectOption {
  value: string;
  /** Defaults to `value` when omitted. */
  label?: string;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  /** DS convention: the option's value string, not the change event. */
  onChange: (value: string) => void;
  /** Compact sizing to match TextInput sm (e.g. inline property cells). Defaults to 'md'. */
  size?: 'sm' | 'md';
  ariaLabel?: string;
  disabled?: boolean;
  /** width: 100% on the wrapper and the select. */
  fullWidth?: boolean;
  class?: string;
  /** Escape hatch for instance-specific layout overrides (token-driven values only). */
  style?: JSX.CSSProperties | string;
}

const Select = (props: SelectProps) => {
  return (
    <div
      class={`ds-select${props.fullWidth ? ' full-width' : ''}${props.class ? ` ${props.class}` : ''}`}
      style={props.style}
    >
      <select
        class="ds-select__control"
        classList={{ sm: (props.size ?? 'md') === 'sm' }}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <For each={props.options}>
          {(o) => <option value={o.value}>{o.label ?? o.value}</option>}
        </For>
      </select>
      <Icon name="chevron-down" size={14} class="ds-select__caret" />
    </div>
  );
};

export default Select;
