// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render } from "solid-js/web";

import { registerBlocks } from "../../shell/registerBlocks";
import PluginsPane from "./PluginsPane";
import type { SettingsState } from "../settingsState";

registerBlocks();

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function settingsWith(corePlugins: Record<string, boolean>): SettingsState {
  return {
    corePlugins: () => corePlugins,
    setCorePlugin: () => undefined,
  } as unknown as SettingsState;
}

function mount(corePlugins: Record<string, boolean>): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => <PluginsPane settings={settingsWith(corePlugins)} />,
    host,
  );
  return host;
}

describe("PluginsPane dependencies", () => {
  it("says nothing about dependencies when they are all satisfied", () => {
    const host = mount({});
    expect(host.querySelector(".set-row__desc--blocked")).toBeNull();
  });

  it("names the plugin that makes Equations inactive", () => {
    const host = mount({ "property-refs": false });
    const blocked = host.querySelector(".set-row__desc--blocked");
    expect(blocked?.textContent).toContain("Property references");
  });

  it("does not mark a plugin blocked when an unrelated one is off", () => {
    const host = mount({ math: false });
    expect(host.querySelector(".set-row__desc--blocked")).toBeNull();
  });
});

describe("PluginsPane rows", () => {
  it("lists every plugin the shell assembled, in registry order", () => {
    const host = mount({});
    const labels = [...host.querySelectorAll(".set-row__lab")].map(
      (el) => el.textContent,
    );
    expect(labels).toEqual([
      "Query",
      "Property references",
      "Math",
      "Equations",
      "Terminal",
      "Graph view",
    ]);
  });
});
