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
  /**
   * ARIA role pairing. 'tablist' (default) keeps the existing tabs
   * semantics (`role="tab"` + `aria-selected` per option) byte-for-byte
   * unchanged, for switching between views/panels. 'radiogroup' is for a
   * segmented control standing in for a plain choice (e.g. an Off/On
   * setting) with no associated tabpanel — options get `role="radio"` +
   * `aria-checked` instead. Does not add roving-tabindex/arrow-key
   * navigation for either role.
   */
  role?: 'tablist' | 'radiogroup';
  onChange: (value: string) => void;
}

const SegmentedControl = (props: SegmentedControlProps) => {
  const isRadioGroup = () => (props.role ?? 'tablist') === 'radiogroup';
  return (
    <div
      class="segmented-control"
      classList={{ pill: (props.variant ?? 'tabs') === 'pill' }}
      role={isRadioGroup() ? 'radiogroup' : 'tablist'}
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
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default SegmentedControl;
