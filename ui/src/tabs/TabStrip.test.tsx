// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { emptyTabs, openTab } from "./tabModel";
import TabStrip from "./TabStrip";

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

const twoTabs = openTab(
  openTab(emptyTabs, { kind: "file", path: "d/Daily.md" }),
  { kind: "tag", tagPath: "work" },
);

describe("TabStrip", () => {
  it("renders a label per tab and marks the active one", () => {
    const host = mount(() => (
      <TabStrip tabs={twoTabs} onActivate={() => {}} onClose={() => {}} onMove={() => {}} />
    ));
    const labels = [...host.querySelectorAll(".tab__label")].map((n) => n.textContent);
    expect(labels).toEqual(["Daily", "#work"]);
    const tabs = host.querySelectorAll(".tab");
    expect(tabs[0]!.classList.contains("tab--active")).toBe(false);
    expect(tabs[1]!.classList.contains("tab--active")).toBe(true);
  });

  it("activates on click", () => {
    const onActivate = vi.fn();
    const host = mount(() => (
      <TabStrip tabs={twoTabs} onActivate={onActivate} onClose={() => {}} onMove={() => {}} />
    ));
    (host.querySelectorAll(".tab")[0] as HTMLElement).click();
    expect(onActivate).toHaveBeenCalledWith("file:d/Daily.md");
  });

  it("closes without activating", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const host = mount(() => (
      <TabStrip tabs={twoTabs} onActivate={onActivate} onClose={onClose} onMove={() => {}} />
    ));
    (host.querySelectorAll(".tab__close")[0] as HTMLElement).click();
    expect(onClose).toHaveBeenCalledWith("file:d/Daily.md");
    expect(onActivate).not.toHaveBeenCalled();
  });
});
