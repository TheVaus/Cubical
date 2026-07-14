import { type JSX, createSignal, Show } from 'solid-js';
import './Tooltip.css';

export interface TooltipProps {
  label: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: JSX.Element;
}

const Tooltip = (props: TooltipProps) => {
  const [visible, setVisible] = createSignal(false);

  return (
    <span
      class="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusIn={() => setVisible(true)}
      onFocusOut={() => setVisible(false)}
    >
      {props.children}
      <Show when={visible()}>
        <span class="tooltip" classList={{ [props.placement ?? 'top']: true }} role="tooltip">
          {props.label}
        </span>
      </Show>
    </span>
  );
};

export default Tooltip;
