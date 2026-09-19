// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import Modal from "./Modal/Modal";
import Popover from "./Popover/Popover";
import TwoPaneModal from "./TwoPaneModal/TwoPaneModal";
import ConfirmDialog from "./ConfirmDialog/ConfirmDialog";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const mount = (el: () => any) => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
};

const escape = () =>
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

describe("Escape with overlays stacked", () => {
  it("closes only the popover opened inside a modal", () => {
    const modalClosed = vi.fn();
    const popoverClosed = vi.fn();
    mount(() => (
      <TwoPaneModal open onClose={modalClosed} title="Settings" items={[]} activeId="" onSelect={() => {}}>
        <Popover open onClose={popoverClosed} ariaLabel="Info">
          <p>info</p>
        </Popover>
      </TwoPaneModal>
    ));

    escape();

    expect(popoverClosed).toHaveBeenCalledTimes(1);
    expect(modalClosed).not.toHaveBeenCalled();
  });

  it("reaches the modal once the popover has closed", () => {
    const modalClosed = vi.fn();
    const [popover, setPopover] = createSignal(true);
    mount(() => (
      <TwoPaneModal open onClose={modalClosed} title="Settings" items={[]} activeId="" onSelect={() => {}}>
        <Popover open={popover()} onClose={() => setPopover(false)} ariaLabel="Info">
          <p>info</p>
        </Popover>
      </TwoPaneModal>
    ));

    escape();
    escape();

    expect(popover()).toBe(false);
    expect(modalClosed).toHaveBeenCalledTimes(1);
  });

  it("does not let a busy confirm dialog pass Escape to the modal behind it", () => {
    const modalClosed = vi.fn();
    const cancelled = vi.fn();
    mount(() => (
      <TwoPaneModal open onClose={modalClosed} title="Settings" items={[]} activeId="" onSelect={() => {}}>
        <ConfirmDialog open busy title="Delete" confirmLabel="Delete" onConfirm={() => {}} onCancel={cancelled}>
          <p>sure?</p>
        </ConfirmDialog>
      </TwoPaneModal>
    ));

    escape();

    expect(cancelled).not.toHaveBeenCalled();
    expect(modalClosed).not.toHaveBeenCalled();
  });
});

describe("a closed overlay", () => {
  it("ignores Escape", () => {
    const closed = vi.fn();
    mount(() => (
      <Modal open={false} onClose={closed} ariaLabel="Closed">
        <p>hidden</p>
      </Modal>
    ));

    escape();

    expect(closed).not.toHaveBeenCalled();
  });

  it("leaves Escape to the rest of the app", () => {
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    mount(() => (
      <Modal open={false} onClose={() => {}} ariaLabel="Closed">
        <p>hidden</p>
      </Modal>
    ));

    escape();
    window.removeEventListener("keydown", outer);

    expect(outer).toHaveBeenCalledTimes(1);
  });
});
