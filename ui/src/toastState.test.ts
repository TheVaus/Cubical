import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentToast,
  dismissToast,
  showToast,
  TOAST_AUTO_DISMISS_MS,
} from "./toastState";

describe("toastState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    dismissToast();
  });

  afterEach(() => {
    dismissToast();
    vi.useRealTimers();
  });

  it("starts empty", () => {
    expect(currentToast()).toBeNull();
  });

  it("showToast populates the slot", () => {
    showToast("Hello world");
    expect(currentToast()).toBe("Hello world");
  });

  it("auto-dismisses after the full window", () => {
    showToast("Hello world");
    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1);
    expect(currentToast()).toBe("Hello world");
    vi.advanceTimersByTime(1);
    expect(currentToast()).toBeNull();
  });

  it("dismissToast clears the slot before the timer", () => {
    showToast("Hello world");
    dismissToast();
    expect(currentToast()).toBeNull();
    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS + 1);
    expect(currentToast()).toBeNull();
  });

  it("re-showing replaces the message and resets the timer", () => {
    showToast("First");
    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1000);
    showToast("Second");
    expect(currentToast()).toBe("Second");
    vi.advanceTimersByTime(1000);
    expect(currentToast()).toBe("Second");
    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1001);
    expect(currentToast()).toBe("Second");
    vi.advanceTimersByTime(1);
    expect(currentToast()).toBeNull();
  });
});
