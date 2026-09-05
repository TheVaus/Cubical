import { createEffect, onCleanup, Show, type JSX } from 'solid-js';
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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };
  createEffect(() => {
    if (!props.open) return;
    document.addEventListener('keydown', onKey);
    onCleanup(() => {
      document.removeEventListener('keydown', onKey);
    });
  });

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
