// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import Popover from "@ds/components/overlay/Popover/Popover";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

describe("Popover", () => {
  it("renders nothing when open is false", () => {
    const host = mount(() => (
      <Popover open={false} onClose={() => {}} ariaLabel="Test popover">
        <p>content</p>
      </Popover>
    ));
    expect(host.querySelector(".ds-popover__panel")).toBeNull();
    expect(host.querySelector(".ds-popover__backdrop")).toBeNull();
  });

  it("renders the panel and backdrop when open is true", () => {
    const host = mount(() => (
      <Popover open={true} onClose={() => {}} ariaLabel="Test popover">
        <p>content</p>
      </Popover>
    ));
    expect(host.querySelector(".ds-popover__panel")).not.toBeNull();
    expect(host.querySelector(".ds-popover__backdrop")).not.toBeNull();
    expect(host.textContent).toContain("content");
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    const host = mount(() => (
      <Popover open={true} onClose={onClose} ariaLabel="Test popover">
        <p>content</p>
      </Popover>
    ));
    const backdrop = host.querySelector(".ds-popover__backdrop");
    expect(backdrop).not.toBeNull();
    backdrop!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    mount(() => (
      <Popover open={true} onClose={onClose} ariaLabel="Test popover">
        <p>content</p>
      </Popover>
    ));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose for non-Escape keys", () => {
    const onClose = vi.fn();
    mount(() => (
      <Popover open={true} onClose={onClose} ariaLabel="Test popover">
        <p>content</p>
      </Popover>
    ));
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("gives the panel role=dialog and the provided aria-label", () => {
    const host = mount(() => (
      <Popover open={true} onClose={() => {}} ariaLabel="Switch vault">
        <p>content</p>
      </Popover>
    ));
    const panel = host.querySelector(".ds-popover__panel");
    expect(panel?.getAttribute("role")).toBe("dialog");
    expect(panel?.getAttribute("aria-label")).toBe("Switch vault");
  });

  it("applies the extra class prop to the panel", () => {
    const host = mount(() => (
      <Popover
        open={true}
        onClose={() => {}}
        ariaLabel="Test popover"
        class="my-extra-class"
      >
        <p>content</p>
      </Popover>
    ));
    const panel = host.querySelector(".ds-popover__panel");
    expect(panel?.classList.contains("my-extra-class")).toBe(true);
  });

  it("reacts to a reactive open signal (toggles panel presence)", () => {
    const [open, setOpen] = createSignal(false);
    const host = mount(() => (
      <Popover open={open()} onClose={() => {}} ariaLabel="Test popover">
        <p>content</p>
      </Popover>
    ));
    expect(host.querySelector(".ds-popover__panel")).toBeNull();
    setOpen(true);
    expect(host.querySelector(".ds-popover__panel")).not.toBeNull();
  });
});
