import { createSignal } from "solid-js";

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
