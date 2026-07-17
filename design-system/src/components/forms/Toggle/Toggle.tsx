import { Show } from 'solid-js';

import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch; also the visible text when `showLabel` is set. */
  label: string;
  /**
   * Render `label` as visible text beside the switch, inside the control's
   * own hit area so clicking the text toggles too. Defaults to false — the
   * label stays accessible-name-only and the switch renders alone (prior
   * behavior). Because the visible text is `label`, label-in-name holds
   * without extra ARIA plumbing.
   */
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
