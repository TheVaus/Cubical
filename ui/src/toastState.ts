import { createSignal } from "solid-js";

/**
 * Pure state machine for the L3 Session J.2 toast surface.
 *
 * `showToast(message)` populates the slot and arms a 4 s auto-dismiss
 * timer; a second call before the timer fires replaces the message and
 * resets the timer. `dismissToast()` clears the slot immediately.
 *
 * Singleton — the app has one `<ToastHost>` mounted in `App.tsx` and
 * every consumer routes through `showToast`. Lives in its own module
 * so the test runner can import it under `environment: "node"` without
 * triggering Solid's JSX runtime (which needs `window`).
 *
 * See `docs/layer-3-spec.md` §9.16.
 */

export const TOAST_AUTO_DISMISS_MS = 4000;

const [currentMessage, setCurrentMessage] = createSignal<string | null>(null);
let dismissTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string): void {
  if (dismissTimer !== undefined) clearTimeout(dismissTimer);
  setCurrentMessage(message);
  dismissTimer = setTimeout(() => {
    dismissTimer = undefined;
    setCurrentMessage(null);
  }, TOAST_AUTO_DISMISS_MS);
}

export function dismissToast(): void {
  if (dismissTimer !== undefined) {
    clearTimeout(dismissTimer);
    dismissTimer = undefined;
  }
  setCurrentMessage(null);
}

export const currentToast = currentMessage;
