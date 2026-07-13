import { onCleanup, onMount } from 'solid-js';
import './Toast.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface ToastProps {
  tone?: Tone;
  message: string;
  onDismiss: () => void;
  autoDismissMs?: number;
}

const Toast = (props: ToastProps) => {
  onMount(() => {
    const ms = props.autoDismissMs ?? 4000;
    const id = setTimeout(() => props.onDismiss(), ms);
    onCleanup(() => clearTimeout(id));
  });

  return (
    <div class="toast" classList={{ [props.tone ?? 'neutral']: true }} role="status">
      <span>{props.message}</span>
      <button type="button" class="toast-dismiss" aria-label="Dismiss" onClick={() => props.onDismiss()}>
        ×
      </button>
    </div>
  );
};

export default Toast;
