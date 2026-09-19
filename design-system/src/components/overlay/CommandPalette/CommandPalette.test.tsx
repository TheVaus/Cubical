// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import CommandPalette, { type CommandPaletteItem } from "./CommandPalette";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
});

const items: CommandPaletteItem[] = [
  { id: "a", label: "Alpha", onRun: () => {} },
  { id: "b", label: "Beta", onRun: () => {} },
];

const input = () => document.querySelector("input") as HTMLInputElement;

describe("CommandPalette", () => {
  it("points the input at the active option when it opens after mounting closed", () => {
    const [open, setOpen] = createSignal(false);
    dispose = render(
      () => <CommandPalette open={open()} onClose={() => {}} items={items} selectedIndex={0} />,
      document.body.appendChild(document.createElement("div")),
    );

    setOpen(true);

    const active = input().getAttribute("aria-activedescendant");
    expect(active).not.toBeNull();
    expect(document.getElementById(active!)?.textContent).toContain("Alpha");
  });

  it("does not move the selection off the list when there are no results", () => {
    const moved = vi.fn();
    dispose = render(
      () => (
        <CommandPalette open onClose={() => {}} items={[]} selectedIndex={0} onSelectedIndexChange={moved} />
      ),
      document.body.appendChild(document.createElement("div")),
    );

    input().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(moved).not.toHaveBeenCalled();
  });
});
