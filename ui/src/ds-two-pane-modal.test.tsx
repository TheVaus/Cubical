// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import TwoPaneModal from "@ds/components/overlay/TwoPaneModal/TwoPaneModal";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

function mount(el: () => any) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(el, host);
  return host;
}

const ITEMS = [
  { id: "appearance", icon: "palette" as const, label: "Appearance" },
  { id: "editor", icon: "file-text" as const, label: "Editor" },
];

const panel = () => document.querySelector(".ds-two-pane-modal__panel");
const navItems = () =>
  Array.from(document.querySelectorAll(".ds-two-pane-modal__navitem"));

describe("TwoPaneModal", () => {
  it("renders nothing when open is false", () => {
    mount(() => (
      <TwoPaneModal
        open={false}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body content</p>
      </TwoPaneModal>
    ));
    expect(panel()).toBeNull();
    expect(document.querySelector(".ds-two-pane-modal__scrim")).toBeNull();
  });

  it("renders nav items, body, and dialog ARIA on the panel", () => {
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body content</p>
      </TwoPaneModal>
    ));
    const p = panel();
    expect(p).not.toBeNull();
    expect(p!.getAttribute("role")).toBe("dialog");
    expect(p!.getAttribute("aria-modal")).toBe("true");
    expect(p!.getAttribute("aria-label")).toBe("Settings");
    expect(document.querySelector(".ds-two-pane-modal__scrim")!.getAttribute("role")).toBeNull();
    expect(navItems().map((n) => n.textContent)).toEqual(["Appearance", "Editor"]);
    expect(document.querySelector(".ds-two-pane-modal__body")!.textContent).toContain("body content");
  });

  it("prefers ariaLabel over title for the accessible name", () => {
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        ariaLabel="App preferences"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    expect(panel()!.getAttribute("aria-label")).toBe("App preferences");
  });

  it("marks only the active nav item", () => {
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="editor"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    const [appearance, editor] = navItems();
    expect(editor!.classList.contains("ds-two-pane-modal__navitem--active")).toBe(true);
    expect(editor!.getAttribute("aria-current")).toBe("true");
    expect(appearance!.classList.contains("ds-two-pane-modal__navitem--active")).toBe(false);
    expect(appearance!.getAttribute("aria-current")).toBeNull();
  });

  it("calls onSelect with the item id when a nav item is clicked", () => {
    const onSelect = vi.fn();
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={() => {}}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={onSelect}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    (navItems()[1] as HTMLButtonElement).click();
    expect(onSelect).toHaveBeenCalledWith("editor");
  });

  it("closes on scrim click but not on panel click", () => {
    const onClose = vi.fn();
    mount(() => (
      <TwoPaneModal
        open={true}
        onClose={onClose}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    (panel() as HTMLElement).click();
    expect(onClose).not.toHaveBeenCalled();
    (document.querySelector(".ds-two-pane-modal__scrim") as HTMLElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape while open, and detaches the handler once closed", () => {
    const onClose = vi.fn();
    const [open, setOpen] = createSignal(true);
    mount(() => (
      <TwoPaneModal
        open={open()}
        onClose={onClose}
        title="Settings"
        items={ITEMS}
        activeId="appearance"
        onSelect={() => {}}
      >
        <p>body</p>
      </TwoPaneModal>
    ));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    setOpen(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
