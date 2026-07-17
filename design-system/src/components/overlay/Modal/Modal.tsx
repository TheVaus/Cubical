import { type JSX, Show, createUniqueId, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import './Modal.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /**
   * Accessible name when there is no visible `title`. Ignored when `title`
   * is set (the title labels the dialog via `aria-labelledby`).
   */
  ariaLabel?: string;
  /** Panel width. `md` (default) = 560px content modal; `sm` = compact confirm. */
  size?: 'sm' | 'md';
  /** Vertical placement. `top` (default) sits below the top edge; `center` centers. */
  placement?: 'top' | 'center';
  children: JSX.Element;
}

const Modal = (props: ModalProps) => {
  const titleId = createUniqueId();

  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  onMount(() => document.addEventListener('keydown', handleKey));
  onCleanup(() => document.removeEventListener('keydown', handleKey));

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="modal-scrim"
          classList={{ center: props.placement === 'center' }}
          onClick={() => props.onClose()}
        >
          <div
            class="modal-panel"
            classList={{ sm: props.size === 'sm' }}
            role="dialog"
            aria-modal="true"
            aria-labelledby={props.title ? titleId : undefined}
            aria-label={props.title ? undefined : props.ariaLabel}
            onClick={(e) => e.stopPropagation()}
          >
            <Show when={props.title}>
              <div class="modal-title" id={titleId}>
                {props.title}
              </div>
            </Show>
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default Modal;
