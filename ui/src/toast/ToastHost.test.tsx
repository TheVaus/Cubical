// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { ToastHost } from "./ToastHost";
import {
  TOAST_AUTO_DISMISS_MS,
  TOAST_QUEUE_LIMIT,
  dismissAllToasts,
  showErrorToast,
  showToast,
} from "./toastState";

let dispose: (() => void) | undefined;

const mount = () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <ToastHost />, host);
  return host;
};

const texts = (host: HTMLElement): string[] =>
  [...host.querySelectorAll(".toast-message")].map((n) => n.textContent ?? "");

beforeEach(() => {
  vi.useFakeTimers();
  dismissAllToasts();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  dismissAllToasts();
  vi.useRealTimers();
});

describe("ToastHost", () => {
  it("shows nothing until there is a message", () => {
    const host = mount();
    expect(host.querySelector(".toast")).toBeNull();
  });

  it("renders the message through the design-system Toast", () => {
    const host = mount();
    showToast("Saved");

    const toast = host.querySelector(".toast");
    expect(toast?.textContent).toContain("Saved");
    expect(toast?.getAttribute("role")).toBe("status");
  });

  it("clears when the dismiss control is pressed", () => {
    const host = mount();
    showToast("Saved");

    host.querySelector<HTMLButtonElement>(".toast-dismiss")?.click();

    expect(host.querySelector(".toast")).toBeNull();
  });

  it("auto-dismisses an ordinary toast after its window", () => {
    const host = mount();
    showToast("Saved");

    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 1);
    expect(host.querySelector(".toast")).not.toBeNull();

    vi.advanceTimersByTime(1);
    expect(host.querySelector(".toast")).toBeNull();
  });

  it("stacks a second message instead of replacing the first", () => {
    const host = mount();
    showToast("first");
    showToast("second");

    expect(texts(host)).toEqual(["first", "second"]);
  });

  it("keeps an error on screen after the ordinary window, and marks it as an alert", () => {
    const host = mount();
    showErrorToast("Write failed");
    showToast("Saved");

    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS * 3);

    expect(texts(host)).toEqual(["Write failed"]);
    expect(host.querySelector(".toast")?.getAttribute("role")).toBe("alert");
  });

  it("drops the oldest once the queue is full", () => {
    const host = mount();
    for (let i = 1; i <= TOAST_QUEUE_LIMIT + 1; i += 1) showToast(`m${i}`);

    expect(texts(host)).toHaveLength(TOAST_QUEUE_LIMIT);
    expect(texts(host)[0]).toBe("m2");
  });

  it("runs an action and dismisses the toast that offered it", () => {
    const host = mount();
    const run = vi.fn();
    showToast("Moved to trash", { action: { label: "Undo", run } });

    const action = [...host.querySelectorAll<HTMLButtonElement>(".toast .btn")].find(
      (b) => b.textContent === "Undo",
    );
    action?.click();

    expect(run).toHaveBeenCalledOnce();
    expect(host.querySelector(".toast")).toBeNull();
  });
});
