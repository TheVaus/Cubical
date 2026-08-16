// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { ToastHost } from "./ToastHost";
import { TOAST_AUTO_DISMISS_MS, dismissToast, showToast } from "./toastState";

let dispose: (() => void) | undefined;

const mount = () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(() => <ToastHost />, host);
  return host;
};

beforeEach(() => {
  vi.useFakeTimers();
  dismissToast();
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  dismissToast();
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
    expect(toast).not.toBeNull();
    expect(toast?.textContent).toContain("Saved");
    expect(toast?.getAttribute("role")).toBe("status");
  });

  it("clears when the dismiss control is pressed", () => {
    const host = mount();
    showToast("Saved");

    host.querySelector<HTMLButtonElement>(".toast-dismiss")?.click();

    expect(host.querySelector(".toast")).toBeNull();
  });

  it("gives a replacement message its own full window", () => {
    const host = mount();
    showToast("first");
    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 100);

    showToast("second");
    vi.advanceTimersByTime(TOAST_AUTO_DISMISS_MS - 100);

    expect(host.querySelector(".toast")?.textContent).toContain("second");

    vi.advanceTimersByTime(200);
    expect(host.querySelector(".toast")).toBeNull();
  });
});
