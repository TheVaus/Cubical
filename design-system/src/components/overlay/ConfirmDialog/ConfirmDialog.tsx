import { createEffect, onCleanup, Show, type JSX } from 'solid-js';
import Button from '../../forms/Button/Button';
import Modal from '../Modal/Modal';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  ariaLabel?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: JSX.Element;
}

const ConfirmDialog = (props: ConfirmDialogProps) => {
  const busy = () => props.busy ?? false;
  createEffect(() => {
    if (!props.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (!busy()) props.onCancel();
    };
    window.addEventListener('keydown', handler, { capture: true });
    onCleanup(() => window.removeEventListener('keydown', handler, { capture: true }));
  });

  return (
    <Modal
      open={props.open}
      size="sm"
      placement="center"
      title={props.title}
      ariaLabel={props.ariaLabel ?? 'Confirm'}
      onClose={() => {
        if (!busy()) props.onCancel();
      }}
    >
      <div class="ds-confirm">
        <div class="ds-confirm__body">{props.children}</div>
        <div class="ds-confirm__actions">
          <Button variant="secondary" disabled={busy()} onClick={() => props.onCancel()}>
            {props.cancelLabel ?? 'Cancel'}
          </Button>
          <Show
            when={(props.tone ?? 'danger') === 'danger'}
            fallback={
              <Button variant="primary" disabled={busy()} onClick={() => props.onConfirm()}>
                {props.confirmLabel}
              </Button>
            }
          >
            <Button variant="danger" disabled={busy()} onClick={() => props.onConfirm()}>
              {props.confirmLabel}
            </Button>
          </Show>
        </div>
      </div>
    </Modal>
  );
};

export default ConfirmDialog;
