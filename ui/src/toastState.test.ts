import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dismissAllToasts,
  dismissToast,
  enqueueToast,
  resolveAutoDismissMs,
  showErrorToast,
  showToast,
  toasts,
  TOAST_AUTO_DISMISS_MS,
  TOAST_QUEUE_LIMIT,
  type ToastEntry,
} from "./toastState";

const entry = (id: number): ToastEntry => ({
  id,
  message: `m${id}`,
  tone: "neutral",
  autoDismissMs: TOAST_AUTO_DISMISS_MS,
});

describe("resolveAutoDismissMs", () => {
  it("gives every ordinary tone the default window", () => {
    for (const tone of ["neutral", "success", "warning"] as const) {
      expect(resolveAutoDismissMs(tone)).toBe(TOAST_AUTO_DISMISS_MS);
    }
  });

  it("never auto-dismisses an error", () => {
    expect(resolveAutoDismissMs("error")).toBeNull();
  });

  it("lets a caller's duration win, including for an error", () => {
    expect(resolveAutoDismissMs("success", 12_000)).toBe(12_000);
    expect(resolveAutoDismissMs("error", 12_000)).toBe(12_000);
  });

  it("treats an explicit zero as a duration, not as absent", () => {
    expect(resolveAutoDismissMs("error", 0)).toBe(0);
  });
});

describe("enqueueToast", () => {
  it("appends to the end", () => {
    expect(enqueueToast([entry(1)], entry(2)).map((t) => t.id)).toEqual([1, 2]);
  });

  it("drops the oldest past the limit", () => {
    const full = Array.from({ length: TOAST_QUEUE_LIMIT }, (_, i) => entry(i + 1));
    const next = enqueueToast(full, entry(99));
    expect(next).toHaveLength(TOAST_QUEUE_LIMIT);
    expect(next[next.length - 1]?.id).toBe(99);
    expect(next[0]?.id).toBe(2);
  });
});

describe("toast queue", () => {
  afterEach(() => dismissAllToasts());

  it("starts empty", () => {
    expect(toasts()).toEqual([]);
  });

  it("stacks rather than replacing", () => {
    showToast("First");
    showToast("Second");
    expect(toasts().map((t) => t.message)).toEqual(["First", "Second"]);
  });

  it("dismisses one entry by id and leaves the rest", () => {
    const first = showToast("First");
    showToast("Second");
    dismissToast(first);
    expect(toasts().map((t) => t.message)).toEqual(["Second"]);
  });

  it("marks an error as persistent so a later toast cannot bury it", () => {
    showErrorToast("Write failed");
    showToast("Saved");
    const [error] = toasts();
    expect(error?.tone).toBe("error");
    expect(error?.autoDismissMs).toBeNull();
  });

  it("carries an action through to the entry", () => {
    const run = vi.fn();
    showToast("Note moved to trash", { action: { label: "Undo", run } });
    toasts()[0]?.action?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("hands back ids that do not repeat", () => {
    const ids = [showToast("a"), showToast("b"), showToast("c")];
    expect(new Set(ids).size).toBe(3);
  });
});
