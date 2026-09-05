import { describe, expect, it, vi } from "vitest";

import type { Command, KeyBinding } from "./commands";
import { handleGlobalKey } from "./globalKeys";

const bindings: readonly KeyBinding[] = [
  { key: "Mod-k", command: "omnibar.toggle", scope: "global" },
];

const cmd = (id: string, when?: () => boolean): Command =>
  when ? { id, title: id, run: () => {}, when } : { id, title: id, run: () => {} };

const commands = (when?: () => boolean): Record<string, Command> => ({
  "omnibar.toggle": cmd("omnibar.toggle", when),
});

const keyEvent = (key: string): KeyboardEvent =>
  ({
    key,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent;

describe("handleGlobalKey", () => {
  it("resolves a bound chord to its command", () => {
    const e = keyEvent("k");
    expect(handleGlobalKey(bindings, commands(), e, false)?.id).toBe(
      "omnibar.toggle",
    );
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("resolves nothing while an overlay is open", () => {
    const e = keyEvent("k");
    expect(handleGlobalKey(bindings, commands(), e, true)).toBeUndefined();
  });

  it("leaves the event to the overlay while one is open", () => {
    const e = keyEvent("k");
    handleGlobalKey(bindings, commands(), e, true);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("resolves nothing for an unbound chord", () => {
    const e = keyEvent("j");
    expect(handleGlobalKey(bindings, commands(), e, false)).toBeUndefined();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("respects a command's when guard", () => {
    const e = keyEvent("k");
    expect(
      handleGlobalKey(bindings, commands(() => false), e, false),
    ).toBeUndefined();
  });
});
