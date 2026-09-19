// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";

import { COMMAND_DEFAULTS } from "../core/commands";
import ShortcutsPanel from "./ShortcutsPanel";

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
    const first = COMMAND_DEFAULTS[0]!;
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
