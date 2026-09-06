import { Show, onCleanup, onMount } from 'solid-js';
import Button from '../../forms/Button/Button';
import './Toast.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastProps {
  tone?: Tone;
  message: string;
  onDismiss: () => void;
  autoDismissMs?: number | null;
  action?: ToastAction;
}

const DEFAULT_AUTO_DISMISS_MS = 4000;

const Toast = (props: ToastProps) => {
  onMount(() => {
    const ms = props.autoDismissMs === undefined ? DEFAULT_AUTO_DISMISS_MS : props.autoDismissMs;
    if (ms === null) return;
    const id = setTimeout(() => props.onDismiss(), ms);
    onCleanup(() => clearTimeout(id));
  });

  const tone = () => props.tone ?? 'neutral';

  return (
    <div
      class="toast"
      classList={{ [tone()]: true }}
      role={tone() === 'error' ? 'alert' : 'status'}
    >
      <span class="toast-message">{props.message}</span>
      <Show when={props.action}>
        {(action) => (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              action().onClick();
              props.onDismiss();
            }}
          >
            {action().label}
          </Button>
        )}
      </Show>
      <button type="button" class="toast-dismiss" aria-label="Dismiss" onClick={() => props.onDismiss()}>
        ×
      </button>
    </div>
  );
};

export default Toast;
