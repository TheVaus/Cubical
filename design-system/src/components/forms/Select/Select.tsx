import type { JSX } from 'solid-js';
import { createEffect, For, Show } from 'solid-js';
import Icon from '../../graphics/Icon/Icon';
import './Select.css';

export interface SelectOption {
  value: string;
  label?: string;
}

export interface SelectProps {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  disabled?: boolean;
  fullWidth?: boolean;
  class?: string;
  style?: JSX.CSSProperties | string;
}

const Select = (props: SelectProps) => {
  let control!: HTMLSelectElement;
  const listed = () => props.options.some((o) => o.value === props.value);
  createEffect(() => {
    void props.options;
    control.value = props.value;
  });

  return (
    <div
      class={`ds-select${props.fullWidth ? ' full-width' : ''}${props.class ? ` ${props.class}` : ''}`}
      style={props.style}
    >
      <select
        ref={control}
        class="ds-select__control"
        classList={{ sm: (props.size ?? 'md') === 'sm' }}
        disabled={props.disabled}
        aria-label={props.ariaLabel}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <Show when={!listed()}>
          <option value={props.value} hidden disabled>
            {props.value}
          </option>
        </Show>
        <For each={props.options}>
          {(o) => <option value={o.value}>{o.label ?? o.value}</option>}
        </For>
      </select>
      <Icon name="chevron-down" size={14} class="ds-select__caret" />
    </div>
  );
};

export default Select;
