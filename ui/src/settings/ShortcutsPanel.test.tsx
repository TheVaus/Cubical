// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import {
  activeCommands,
  registerCommands,
  registeredCommands,
} from "../core/commandRegistry";
import { GRAPH_COMMAND } from "../graph/registration";
import { STATUSBAR_COMMAND } from "../statusbar/commands";
import ShortcutsPanel from "./ShortcutsPanel";

registerCommands([GRAPH_COMMAND, STATUSBAR_COMMAND]);

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const press = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));

describe("recording a shortcut", () => {
  it("waits past a lone modifier for the key it modifies", () => {
    const onChange = vi.fn();
    dispose = render(
      () => <ShortcutsPanel overrides={{}} onChange={onChange} />,
      document.body.appendChild(document.createElement("div")),
    );
    const first = registeredCommands()[0]!;
    const edit = document.querySelector(
      `button[aria-label="Change the shortcut for ${first.title}"]`,
    ) as HTMLButtonElement;
    edit.click();

    press({ key: "Meta", metaKey: true });
    press({ key: "Shift", metaKey: true, shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();

    press({ key: "j", metaKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    const spec = onChange.mock.calls[0]![0][first.id] as string;
    expect(spec.toLowerCase()).toMatch(/j$/);
    expect(spec.toLowerCase()).not.toContain("meta");
  });
});

describe("a switched-off block's command", () => {
  const graphOff = activeCommands((p) => p !== GRAPH_COMMAND.plugin);
  const mount = (
    overrides: Record<string, string>,
    onChange: (next: Record<string, string>) => void,
  ) => {
    dispose = render(
      () => (
        <ShortcutsPanel
          overrides={overrides}
          commands={graphOff}
          onChange={onChange}
        />
      ),
      document.body.appendChild(document.createElement("div")),
    );
  };
  const editButton = (title: string) =>
    document.querySelector(
      `button[aria-label="Change the shortcut for ${title}"]`,
    ) as HTMLButtonElement | null;

  it("has no row while its block is off", () => {
    mount({}, vi.fn());
    expect(editButton(GRAPH_COMMAND.title)).toBeNull();
    expect(editButton("New note")).not.toBeNull();
  });

  it("keeps its override when another row is rebound", () => {
    const onChange = vi.fn();
    mount({ "graph.open": "Mod-Shift-j" }, onChange);
    editButton("New note")!.click();
    press({ key: "y", metaKey: true, shiftKey: true });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]["graph.open"]).toBe("Mod-Shift-j");
  });

  it("still owns its key, so re-enabling cannot surface a duplicate", () => {
    const onChange = vi.fn();
    mount({}, onChange);
    editButton("New note")!.click();
    press({ key: "g", metaKey: true, shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      `${GRAPH_COMMAND.title} (switched off)`,
    );
  });

  it("shows an unbound command as not set", () => {
    mount({}, vi.fn());
    const row = editButton(STATUSBAR_COMMAND.title)!.closest(".kb-row")!;
    expect(row.querySelector("kbd")).toBeNull();
    expect(row.textContent).toContain("Not set");
  });
});
