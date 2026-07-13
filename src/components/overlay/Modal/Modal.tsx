import { JSX, Show, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import './Modal.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: JSX.Element;
}

const Modal = (props: ModalProps) => {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  onMount(() => document.addEventListener('keydown', handleKey));
  onCleanup(() => document.removeEventListener('keydown', handleKey));

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-scrim" onClick={() => props.onClose()}>
          <div class="modal-panel stack" onClick={(e) => e.stopPropagation()}>
            <Show when={props.title}>
              <div class="modal-title">{props.title}</div>
            </Show>
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default Modal;
