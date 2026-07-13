import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}

const Toggle = (props: ToggleProps) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class="toggle"
      classList={{ checked: props.checked }}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-thumb" />
    </button>
  );
};

export default Toggle;
