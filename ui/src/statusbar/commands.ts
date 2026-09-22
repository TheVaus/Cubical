import type { BindingDefault } from "../core/commandRegistry";
import type { Command } from "../core/commands";

export const STATUSBAR_COMMAND: BindingDefault = {
  id: "statusbar.toggle",
  title: "Toggle status bar",
  scope: "global",
};

export function statusbarCommand(toggle: () => void): Command {
  const { id } = STATUSBAR_COMMAND;
  return { id, run: toggle };
}
