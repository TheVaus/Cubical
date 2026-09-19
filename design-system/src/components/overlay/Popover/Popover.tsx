import { Show, type JSX } from 'solid-js';
import { closeOnEscape } from '../escapeStack';
import './Popover.css';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  placement?: PopoverPlacement;
  class?: string;
  children: JSX.Element;
}

const Popover = (props: PopoverProps) => {
  closeOnEscape(() => props.open, () => props.onClose());

  const placement = () => props.placement ?? 'bottom-start';
  const panelClass = () =>
    `ds-popover__panel ds-popover__panel--${placement()}${props.class ? ` ${props.class}` : ''}`;

  return (
    <Show when={props.open}>
      <div class="ds-popover__backdrop" onClick={() => props.onClose()} />
      <div
        class={panelClass()}
        data-overlay="popover"
        role="dialog"
        aria-label={props.ariaLabel}
      >
        {props.children}
      </div>
    </Show>
  );
};

export default Popover;
