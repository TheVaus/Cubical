import { onCleanup } from "solid-js";

import { isOverlayOpen } from "../overlayState";
import { resolveGlobal, type Command, type KeyBinding } from "./commands";

export function handleGlobalKey(
  bindings: readonly KeyBinding[],
  commands: Record<string, Command>,
  e: KeyboardEvent,
  overlayOpen: boolean,
): Command | undefined {
  if (overlayOpen) return undefined;
  const c = resolveGlobal(bindings, commands, e);
  if (!c) return undefined;
  e.preventDefault();
  return c;
}

export function attachGlobalKeys(
  bindings: () => readonly KeyBinding[],
  commands: Record<string, Command>,
): void {
  const onKey = (e: KeyboardEvent) => {
    handleGlobalKey(bindings(), commands, e, isOverlayOpen())?.run();
  };
  window.addEventListener("keydown", onKey);
  onCleanup(() => window.removeEventListener("keydown", onKey));
}
