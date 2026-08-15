import { Show, type Component } from "solid-js";

import Toast from "@ds/components/feedback/Toast/Toast";

import {
  TOAST_AUTO_DISMISS_MS,
  currentToast,
  dismissToast,
} from "./toastState";

export const ToastHost: Component = () => {
  return (
    <Show when={currentToast()} keyed>
      {(message) => (
        <div class="toast-host">
          <Toast
            message={message}
            onDismiss={dismissToast}
            autoDismissMs={TOAST_AUTO_DISMISS_MS}
          />
        </div>
      )}
    </Show>
  );
};
