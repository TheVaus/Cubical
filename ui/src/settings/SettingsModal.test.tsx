// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot } from "solid-js";
import { render } from "solid-js/web";

vi.mock("../api/ipc", () => ({
  getSetting: vi.fn(() => Promise.resolve(null)),
  setSetting: vi.fn(() => Promise.resolve()),
}));

import { registerBlocks } from "../shell/registerBlocks";
import { createInfoControl } from "./InfoButton";
import EditorPane from "./panes/EditorPane";
import SettingsModal from "./SettingsModal";
import { createSettingsState } from "./settingsState";
import { settingsNav } from "./tabs";

registerBlocks();

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

window.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  addListener: () => undefined,
  removeListener: () => undefined,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia;

const settings = createRoot(() =>
  createSettingsState({ vaultId: () => "v1" }),
);

function mountEditorPane(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => <EditorPane settings={settings} info={createInfoControl()} />,
    host,
  );
  return host;
}

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  dispose = render(
    () => (
      <SettingsModal
        open={true}
        onClose={() => undefined}
        settings={settings}
        vaultPath={null}
        busy={false}
        onOpenAnotherVault={() => undefined}
      />
    ),
    host,
  );
  return host;
}

describe("the settings nav", () => {
  it("places the statusbar's contributed tab between Plugins and Vault", () => {
    expect(settingsNav().map((t) => t.id)).toEqual([
      "appearance",
      "editor",
      "wikilinks",
      "plugins",
      "statusbar",
      "vault",
      "shortcuts",
    ]);
  });

  it("offers every contributed section a way in", () => {
    mount();
    const labels = settingsNav().map((t) => t.label);
    expect(labels).toContain("Status bar");
    expect(new Set(settingsNav().map((t) => t.id)).size).toBe(
      settingsNav().length,
    );
  });
});

describe("the editor pane's slot", () => {
  it("renders the properties block's rows inside the Editor pane", () => {
    const host = mountEditorPane();
    const labels = [...host.querySelectorAll(".set-row__lab")].map(
      (el) => el.textContent,
    );
    expect(labels).toContain("Open notes in raw source by default");
    expect(labels).toContain("Typed properties");
  });

  it("puts the contributed rows after the pane's own, not before", () => {
    const host = mountEditorPane();
    const labels = [...host.querySelectorAll(".set-row__lab")].map(
      (el) => el.textContent,
    );
    expect(labels.indexOf("Typed properties")).toBeGreaterThan(
      labels.indexOf("Colorize raw source"),
    );
  });
});
