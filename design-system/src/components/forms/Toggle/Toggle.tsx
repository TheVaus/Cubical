import { Show } from 'solid-js';

import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  showLabel?: boolean;
}

const Toggle = (props: ToggleProps) => {
  const toggle = () => {
    if (!props.disabled) props.onChange(!props.checked);
  };
  const button = () => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class="toggle"
      classList={{ checked: props.checked }}
      disabled={props.disabled}
      onClick={toggle}
    >
      <span class="toggle-thumb" />
    </button>
  );
  return (
    <Show when={props.showLabel} fallback={button()}>
      <span class="toggle-field" classList={{ disabled: props.disabled }}>
        {button()}
        <span class="toggle-label" onClick={toggle}>
          {props.label}
        </span>
      </span>
    </Show>
  );
};

export default Toggle;
