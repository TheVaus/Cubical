import { createMemo, type Accessor } from "solid-js";

import {
  activeCommands as activeCommandsFor,
  resolveBindings,
  sameBindings,
  sameCommands,
  type BindingDefault,
} from "../core/commandRegistry";
import type { KeyBinding } from "../core/commands";
import { corePluginActive } from "./corePlugins";

export interface ShortcutBindings {
  activeCommands: Accessor<readonly BindingDefault[]>;
  effectiveBindings: Accessor<KeyBinding[]>;
}

export function createShortcutBindings(
  overrides: Accessor<Record<string, string>>,
  corePlugins: Accessor<Record<string, boolean>>,
): ShortcutBindings {
  const activeCommands = createMemo<readonly BindingDefault[]>(
    () => activeCommandsFor((id) => corePluginActive(corePlugins(), id)),
    [],
    { equals: sameCommands },
  );
  const effectiveBindings = createMemo(
    () => resolveBindings(overrides(), activeCommands()),
    [],
    { equals: sameBindings },
  );
  return { activeCommands, effectiveBindings };
}
