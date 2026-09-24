import type { BindingDefault } from "../core/commandRegistry";
import type { Command } from "../core/commands";
import type { OmniItem } from "./ranker";
import { OMNIBAR_COMMAND } from "./registration";

export function paletteCommands(
  active: readonly BindingDefault[],
  handlers: Record<string, Command>,
): OmniItem[] {
  const items: OmniItem[] = [];
  for (const c of active) {
    if (c.id === OMNIBAR_COMMAND.id) continue;
    const handler = handlers[c.id];
    if (!handler || (handler.when && !handler.when())) continue;
    items.push({ kind: "command", id: c.id, title: c.title });
  }
  return items;
}
