import { createEffect, onCleanup, Show, type JSX } from 'solid-js';
import './Popover.css';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  /** Defaults to "bottom-start". */
  placement?: PopoverPlacement;
  /** Extra class on the panel (width, internal layout, etc.). */
  class?: string;
  children: JSX.Element;
}

/**
 * Controlled, anchor-relative popover. The consumer wraps its trigger in a
 * `position: relative` element; when `open`, this renders a transparent
 * full-viewport backdrop plus an absolutely-positioned panel placed relative
 * to that anchor.
 *
 * Dismiss mechanism (load-bearing — see `ui/src/VaultSwitcher.tsx` for the
 * original writeup): the backdrop sits below the panel but above the rest of
 * the UI, and its own `onClick` calls `onClose`. Because the backdrop
 * intercepts the click, a single click can never reach both the backdrop and
 * the trigger — this structurally prevents the close-then-reopen race a
 * document-level listener would cause. Escape-to-dismiss is an additional
 * affordance, not a replacement.
 */
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
      <div class={panelClass()} role="dialog" aria-label={props.ariaLabel}>
        {props.children}
      </div>
    </Show>
  );
};

export default Popover;
