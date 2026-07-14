import { Show, type Component } from "solid-js";

import IconButton from "@ds/components/forms/IconButton/IconButton";

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
        <IconButton label="Dismiss" onClick={dismissToast}>
          ×
        </IconButton>
      </div>
    </Show>
  );
};

export { showToast, dismissToast, currentToast } from "./toastState";
