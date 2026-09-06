import { For, Show } from 'solid-js';
import Icon, { type IconName } from '../../graphics/Icon/Icon';
import './SegmentedControl.css';

export interface SegmentedOption {
  label: string;
  icon?: IconName;
  value: string;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  variant?: 'tabs' | 'pill';
  role?: 'tablist' | 'radiogroup';
  ariaLabel?: string;
  class?: string;
  onChange: (value: string) => void;
}

const SegmentedControl = (props: SegmentedControlProps) => {
  const isRadioGroup = () => (props.role ?? 'tablist') === 'radiogroup';
  return (
    <div
      class={`segmented-control${props.class ? ` ${props.class}` : ''}`}
      classList={{ pill: (props.variant ?? 'tabs') === 'pill' }}
      role={isRadioGroup() ? 'radiogroup' : 'tablist'}
      aria-label={props.ariaLabel}
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role={isRadioGroup() ? 'radio' : 'tab'}
            aria-selected={isRadioGroup() ? undefined : props.value === option.value}
            aria-checked={isRadioGroup() ? props.value === option.value : undefined}
            class="segmented-option"
            classList={{ selected: props.value === option.value }}
            onClick={() => props.onChange(option.value)}
          >
            <Show when={option.icon}>
              <Icon name={option.icon!} size={14} />
            </Show>
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default SegmentedControl;
