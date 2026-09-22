// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { registerTabKinds } from "./tabKinds";
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

registerTabKinds([{ kind: "page", label: (k) => `#${k}`, evictable: true }]);

const twoTabs = openTab(
  openTab(emptyTabs, { kind: "file", path: "d/Daily.md" }),
  { kind: "page", key: "work" },
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

  it("labels a kind no block registered by its key, then its kind", () => {
    const s = openTab(openTab(emptyTabs, { kind: "gone", key: "k1" }), { kind: "solo", key: "" });
    const host = mount(() => (
      <TabStrip tabs={s} onActivate={() => {}} onClose={() => {}} onMove={() => {}} />
    ));
    const labels = [...host.querySelectorAll(".tab__label")].map((n) => n.textContent);
    expect(labels).toEqual(["k1", "solo"]);
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
