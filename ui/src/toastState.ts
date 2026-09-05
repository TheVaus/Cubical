import { createSignal } from "solid-js";

export const TOAST_AUTO_DISMISS_MS = 4000;
export const TOAST_QUEUE_LIMIT = 4;

export type ToastTone = "neutral" | "success" | "warning" | "error";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  tone?: ToastTone;
  action?: ToastAction;
  durationMs?: number;
}

export interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  autoDismissMs: number | null;
  action?: ToastAction;
}

export function resolveAutoDismissMs(
  tone: ToastTone,
  durationMs?: number,
): number | null {
  if (durationMs !== undefined) return durationMs;
  return tone === "error" ? null : TOAST_AUTO_DISMISS_MS;
}

export function enqueueToast(
  queue: readonly ToastEntry[],
  entry: ToastEntry,
): ToastEntry[] {
  const next = [...queue, entry];
  return next.slice(Math.max(0, next.length - TOAST_QUEUE_LIMIT));
}

const [entries, setEntries] = createSignal<readonly ToastEntry[]>([]);
let lastId = 0;

export function showToast(message: string, options: ToastOptions = {}): number {
  const tone = options.tone ?? "neutral";
  lastId += 1;
  const entry: ToastEntry = {
    id: lastId,
    message,
    tone,
    autoDismissMs: resolveAutoDismissMs(tone, options.durationMs),
    ...(options.action ? { action: options.action } : {}),
  };
  setEntries((prev) => enqueueToast(prev, entry));
  return entry.id;
}

export function showErrorToast(message: string, action?: ToastAction): number {
  return showToast(message, { tone: "error", ...(action ? { action } : {}) });
}

export function dismissToast(id: number): void {
  setEntries((prev) => prev.filter((t) => t.id !== id));
}

export function dismissAllToasts(): void {
  setEntries([]);
}

export const toasts = entries;
