import { Show, type Component } from "solid-js";

import { currentToast, dismissToast } from "./toastState";

/**
 * Single-slot toast renderer. The state lives in `toastState.ts`; this
 * component is the visual shell mounted once in `App.tsx`.
 */
export const ToastHost: Component = () => {
  return (
    <Show when={currentToast() !== null}>
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: "var(--space-5)",
          left: "50%",
          transform: "translateX(-50%)",
          display: "flex",
          "align-items": "center",
          gap: "var(--space-3)",
          padding: "var(--space-2) var(--space-4)",
          background: "var(--c-bg-tertiary)",
          color: "var(--c-fg-primary)",
          border: "1px solid var(--c-border-subtle)",
          "border-radius": "var(--radius-md)",
          "box-shadow": "var(--shadow-md)",
          "font-size": "var(--text-sm)",
          "font-family": "var(--font-body)",
          "z-index": 20,
          "max-width": "32rem",
        }}
      >
        <span>{currentToast()}</span>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismissToast}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--c-fg-secondary)",
            cursor: "pointer",
            "font-size": "var(--text-base)",
            "line-height": "1",
            padding: "0 var(--space-1)",
          }}
        >
          ×
        </button>
      </div>
    </Show>
  );
};

export { showToast, dismissToast, currentToast } from "./toastState";
