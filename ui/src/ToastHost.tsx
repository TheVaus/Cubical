import { For, type Component } from "solid-js";

import Toast from "@ds/components/feedback/Toast/Toast";

import { dismissToast, toasts } from "./toastState";

export const ToastHost: Component = () => {
  return (
    <div class="toast-host">
      <For each={toasts()}>
        {(entry) => (
          <Toast
            message={entry.message}
            tone={entry.tone}
            autoDismissMs={entry.autoDismissMs}
            onDismiss={() => dismissToast(entry.id)}
            {...(entry.action
              ? {
                  action: {
                    label: entry.action.label,
                    onClick: entry.action.run,
                  },
                }
              : {})}
          />
        )}
      </For>
    </div>
  );
};
