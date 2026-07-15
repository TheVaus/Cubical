import { For } from 'solid-js';
import './SegmentedControl.css';

export interface SegmentedOption {
  label: string;
  value: string;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  /**
   * Visual style. 'tabs' (default) is the underline-tab look for switching
   * views; 'pill' is a bordered chip group for compact inline settings.
   */
  variant?: 'tabs' | 'pill';
  onChange: (value: string) => void;
}

const SegmentedControl = (props: SegmentedControlProps) => {
  return (
    <div
      class="segmented-control"
      classList={{ pill: (props.variant ?? 'tabs') === 'pill' }}
      role="tablist"
    >
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.value === option.value}
            class="segmented-option"
            classList={{ selected: props.value === option.value }}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default SegmentedControl;
